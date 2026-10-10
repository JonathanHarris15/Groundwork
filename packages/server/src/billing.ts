import type { PlanId, StoredMembership } from "@groundwork/core";
import Stripe from "stripe";
import type { AccountDirectory } from "./accounts";
import { loadGa4PurchaseReporter } from "./ga4-purchase-runtime";
import { noopCheckoutPurchaseReporter, type CheckoutPurchaseReporter } from "./ga4-purchase";
import { cleanGaClientId, cleanGaSessionId, cleanGclid } from "./tracking";

/** Analytics ids captured in the browser at the moment Checkout starts. */
export interface CheckoutGaContext {
	gaClientId: string | null;
	gaSessionId: string | null;
	gclid: string | null;
	consent: "granted" | "denied" | null;
}

export interface Billing {
	readonly configured: boolean;
	checkout(uid: string, email: string | undefined, plan: PlanId, origin: string, ga?: CheckoutGaContext): Promise<string>;
	portal(uid: string, origin: string): Promise<string>;
	/** Apply a verified Stripe webhook. `raw` is the request body exactly as Stripe sent it. */
	applyEvent(raw: string, signature: string | undefined): Promise<void>;
	/**
	 * Set the account plan from the live Stripe subscription.
	 * A Stripe outage must not fail the request.
	 */
	sync?(uid: string, email?: string): Promise<void>;
	/**
	 * Dollars paid on a Checkout Session, from amount_total. Zero is a real payment.
	 * The browser must not turn this into a GA4 purchase. The webhook reports the purchase.
	 */
	checkoutAmount?(sessionId: string): Promise<number | null>;
	/** Accounts carrying the GROUNDWORKTESTER promotion, when Stripe can say so. */
	couponHolders?(): Promise<Array<{ uid: string; code: string }>>;
	/** Write active and trialing memberships onto the accounts Stripe already knows. */
	syncMemberships?(): Promise<void>;
}

export interface BillingHooks {
	onUpgrade?(uid: string, plan: "byom" | "included"): Promise<void>;
}

/** Stripe-standard grace: past_due keeps paid entitlements until canceled, unpaid, or deleted. */
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);
const SYNC_TTL_MS = 60_000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const seenStripeEvents = new Map<string, number>();

function rememberStripeEvent(id: string): boolean {
	const now = Date.now();
	for (const [key, until] of seenStripeEvents) {
		if (until <= now) seenStripeEvents.delete(key);
	}
	if (seenStripeEvents.has(id)) return false;
	seenStripeEvents.set(id, now + EVENT_TTL_MS);
	return true;
}

/** Test hook: clear dedupe memory between cases. */
export function resetStripeEventDedupe(): void {
	seenStripeEvents.clear();
}

export interface SubscriptionLike {
	status?: string | null;
	items?: { data?: Array<{ quantity?: number | null; price?: string | { id?: string | null; unit_amount?: number | null; currency?: string | null } | null }> } | null;
	discount?: unknown;
	discounts?: unknown;
}

/** A subscription the learner is still paying for, including one that is past due. */
export function subscriptionIsEntitled(status: string | null | undefined): boolean {
	return !!status && ENTITLED_STATUSES.has(status);
}

/**
 * The plan implied by the subscription's price.
 * `null` means the subscription is not an active membership.
 * `unknown` means it is active, but the price is not one of ours — leave the stored plan alone.
 * Included wins when a subscription carries both prices.
 */
export interface MembershipPrices {
	byom: string;
	included: string;
	/** Older price ids that still grant the same plan. Checkout uses only the current ids. */
	previous?: { byom?: readonly string[]; included?: readonly string[] };
}

export function planFromSubscription(subscription: SubscriptionLike, prices: MembershipPrices): "byom" | "included" | "unknown" | null {
	if (!subscriptionIsEntitled(subscription.status)) return null;
	const includedIds = new Set([prices.included, ...(prices.previous?.included ?? [])]);
	const byomIds = new Set([prices.byom, ...(prices.previous?.byom ?? [])]);
	let included = false;
	let byom = false;
	for (const item of subscription.items?.data ?? []) {
		const id = priceId(item?.price);
		if (!id) continue;
		if (includedIds.has(id)) included = true;
		else if (byomIds.has(id)) byom = true;
	}
	if (included) return "included";
	if (byom) return "byom";
	return "unknown";
}

/**
 * Active or trialing BYOM or Groundwork subscription, with the price after discounts.
 * A 100% off coupon is $0. An unexpanded discount id does not fall back to the list price.
 */
export function membershipFromSubscription(subscription: SubscriptionLike, prices: MembershipPrices): StoredMembership | null {
	if (subscription.status !== "active" && subscription.status !== "trialing") return null;
	const plan = planFromSubscription(subscription, prices);
	if (plan !== "byom" && plan !== "included") return null;
	const couponCode = promotionCodesFrom(subscription).find((code) => code.toUpperCase() === TESTER_COUPON);
	return { status: subscription.status, plan, amountUsd: recurringAmountUsd(subscription), couponCode };
}

/**
 * Recurring USD after coupons. Null when a discount was not expanded, so a list price is not treated as revenue.
 * GROUNDWORKTESTER is 100% off. Stripe often sends that code without `percent_off`, and the list price is not revenue.
 */
export function recurringAmountUsd(subscription: SubscriptionLike): number | null {
	const tester = hasTesterCoupon(subscription);
	if (unresolvedDiscount(subscription)) return tester ? 0 : null;
	const { percentOff, amountOffCents } = discountAdjustment(subscription);
	if (percentOff >= 100) return 0;
	if (tester && percentOff <= 0 && amountOffCents <= 0) return 0;
	let cents = 0;
	let sawAmount = false;
	for (const item of subscription.items?.data ?? []) {
		const price = item?.price;
		if (!price || typeof price === "string") continue;
		if (price.currency && price.currency.toLowerCase() !== "usd") continue;
		if (typeof price.unit_amount !== "number" || !Number.isFinite(price.unit_amount)) continue;
		sawAmount = true;
		const quantity = item?.quantity ?? 1;
		cents += price.unit_amount * (quantity > 0 ? quantity : 1);
	}
	if (!sawAmount) return null;
	cents = Math.round(cents * (1 - Math.max(0, percentOff) / 100));
	cents = Math.max(0, cents - Math.max(0, amountOffCents));
	return Math.round(cents) / 100;
}

export interface MembershipSubscription extends SubscriptionLike {
	id?: string;
	customer?: string | { id?: string | null } | null;
	metadata?: { uid?: string | null } | null;
}

export interface PaidMembershipClient {
	subscriptions: {
		list(args: { status: "active" | "trialing"; limit: number; starting_after?: string; expand?: string[] }): Promise<{ data: MembershipSubscription[]; has_more: boolean }>;
	};
}

const MEMBERSHIP_EXPANDS: string[][] = [
	["data.discounts", "data.discounts.promotion_code", "data.discounts.source.coupon"],
	["data.discounts", "data.discounts.coupon", "data.discounts.promotion_code"],
	["data.discount", "data.discount.coupon", "data.discount.promotion_code"],
	[],
];

/** Copy active and trialing subscriptions onto accounts. Accounts Stripe does not list lose a stale membership. */
export async function refreshPaidMemberships(stripe: PaidMembershipClient, prices: MembershipPrices, accounts: AccountDirectory): Promise<void> {
	const seen = new Set<string>();
	let expandAt = 0;
	for (const status of ["active", "trialing"] as const) {
		let startingAfter: string | undefined;
		for (let page = 0; page < 20; page++) {
			let listed: { data: MembershipSubscription[]; has_more: boolean } | null = null;
			let lastError: unknown;
			for (let attempt = expandAt; attempt < MEMBERSHIP_EXPANDS.length; attempt++) {
				try {
					const expand = MEMBERSHIP_EXPANDS[attempt];
					listed = await stripe.subscriptions.list({
						status,
						limit: 100,
						starting_after: startingAfter,
						...(expand && expand.length ? { expand } : {}),
					});
					expandAt = attempt;
					break;
				} catch (err) {
					lastError = err;
				}
			}
			if (!listed) throw lastError instanceof Error ? lastError : new Error("Could not list Stripe subscriptions.");
			for (const subscription of listed.data) {
				const uid = await membershipUid(accounts, subscription);
				if (!uid) continue;
				const snapshot = membershipFromSubscription({ ...subscription, status: subscription.status ?? status }, prices);
				if (!snapshot) continue;
				await accounts.rememberMembership(uid, snapshot);
				if (snapshot.couponCode) await accounts.markCoupon(uid, snapshot.couponCode);
				seen.add(uid);
			}
			if (!listed.has_more || !listed.data.length) break;
			startingAfter = listed.data[listed.data.length - 1]?.id;
			if (!startingAfter) break;
		}
	}
	for (const row of await accounts.list()) {
		if (!row.record.membership || seen.has(row.record.uid)) continue;
		await accounts.rememberMembership(row.record.uid, null);
	}
}

async function membershipUid(accounts: AccountDirectory, subscription: MembershipSubscription): Promise<string | undefined> {
	const fromMetadata = subscription.metadata?.uid?.trim();
	if (fromMetadata) return fromMetadata;
	const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
	if (!customer) return undefined;
	return (await accounts.findByCustomer(customer))?.uid;
}

function unresolvedDiscount(subscription: SubscriptionLike): boolean {
	return discountEntries(subscription).some((entry) => typeof entry === "string");
}

function discountEntries(subscription: SubscriptionLike): unknown[] {
	if (Array.isArray(subscription.discounts)) return subscription.discounts;
	if (subscription.discount) return [subscription.discount];
	return [];
}

function discountAdjustment(subscription: SubscriptionLike): { percentOff: number; amountOffCents: number } {
	let percentOff = 0;
	let amountOffCents = 0;
	for (const entry of discountEntries(subscription)) {
		const coupon = couponRecord(entry);
		if (!coupon) continue;
		if (typeof coupon.percent_off === "number" && coupon.percent_off > percentOff) percentOff = coupon.percent_off;
		if (typeof coupon.amount_off === "number" && coupon.amount_off > 0) amountOffCents += coupon.amount_off;
	}
	return { percentOff, amountOffCents };
}

function hasTesterCoupon(subscription: SubscriptionLike): boolean {
	return promotionCodesFrom(subscription).some((code) => code.toUpperCase() === TESTER_COUPON);
}

function couponRecord(entry: unknown): Record<string, unknown> | null {
	if (!entry || typeof entry !== "object") return null;
	const record = entry as Record<string, unknown>;
	if (record.coupon && typeof record.coupon === "object") return record.coupon as Record<string, unknown>;
	const source = record.source;
	if (source && typeof source === "object") {
		const coupon = (source as Record<string, unknown>).coupon;
		if (coupon && typeof coupon === "object") return coupon as Record<string, unknown>;
	}
	if ("percent_off" in record || "amount_off" in record) return record;
	return null;
}

export function loadBilling(accounts: AccountDirectory, hooks?: BillingHooks): Billing {
	const key = process.env.STRIPE_SECRET_KEY?.trim();
	const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
	const byom = process.env.STRIPE_PRICE_BYOM?.trim();
	const included = process.env.STRIPE_PRICE_INCLUDED?.trim();
	if (!key || !webhookSecret || !byom || !included) return unconfigured();
	const prices: MembershipPrices = {
		byom,
		included,
		previous: {
			byom: extraPrices("STRIPE_PRICE_BYOM_PREVIOUS"),
			included: extraPrices("STRIPE_PRICE_INCLUDED_PREVIOUS"),
		},
	};
	return createBilling(new Stripe(key), prices, webhookSecret, accounts, loadGa4PurchaseReporter(), hooks);
}

export interface StripeMembershipClient {
	customers: {
		search(args: { query: string; limit: number }): Promise<{ data: Array<{ id: string }> }>;
	};
	subscriptions: {
		list(args: { customer: string; status: "active" | "trialing" | "past_due"; limit: number }): Promise<{ data: SubscriptionLike[] }>;
	};
}

export function createBilling(
	stripe: Stripe,
	prices: MembershipPrices,
	webhookSecret: string,
	accounts: AccountDirectory,
	reporter: CheckoutPurchaseReporter = noopCheckoutPurchaseReporter,
	hooks?: BillingHooks,
): Billing {
	const freshUntil = new Map<string, number>();
	let membershipsFreshUntil = 0;
	return {
		configured: true,
		async checkout(uid, email, plan, origin, ga) {
			if (!isPaid(plan)) throw badRequest("That plan is free. Choose it without checkout.");
			return withStripeCustomer(stripe, accounts, uid, email, false, (customer) =>
				checkoutSession(stripe, prices, customer, uid, plan, origin, ga),
			);
		},
		async portal(uid, origin) {
			const account = await accounts.get(uid);
			return withStripeCustomer(stripe, accounts, uid, account.email ?? undefined, true, async (customer) => {
				const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${origin}/` });
				return session.url;
			});
		},
		async applyEvent(raw, signature) {
			if (!signature) throw badRequest("Missing Stripe signature.");
			const event = stripe.webhooks.constructEvent(raw, signature, webhookSecret);
			freshUntil.clear();
			await applyStripeEvent(accounts, event, prices, hooks);
			if (event.type === "checkout.session.completed") {
				const session = event.data.object;
				await reporter.report({
					id: session.id,
					status: session.status,
					payment_status: session.payment_status,
					amount_total: session.amount_total,
					currency: session.currency,
					metadata: session.metadata,
					client_reference_id: session.client_reference_id,
				});
			}
		},
		async checkoutAmount(sessionId) {
			if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
			try {
				const session = await stripe.checkout.sessions.retrieve(sessionId);
				return paidAmountUsd(session.amount_total);
			} catch {
				return null;
			}
		},
		async couponHolders() {
			return listTesterCoupons(stripe, accounts);
		},
		async syncMemberships() {
			const now = Date.now();
			if (membershipsFreshUntil > now) return;
			membershipsFreshUntil = now + SYNC_TTL_MS;
			try {
				await refreshPaidMemberships(stripe, prices, accounts);
			} catch (err) {
				membershipsFreshUntil = 0;
				console.error("Could not read Stripe subscriptions.", err);
			}
		},
		async sync(uid) {
			const now = Date.now();
			if ((freshUntil.get(uid) ?? 0) > now) return;
			freshUntil.set(uid, now + SYNC_TTL_MS);
			try {
				await syncStripeMembership(stripe, prices, accounts, uid);
			} catch (err) {
				freshUntil.delete(uid);
				console.error("Groundwork could not read the Stripe subscription.", err);
			}
		},
	};
}

/**
 * The price on the subscription is the membership. Checkout metadata is only a hint:
 * it stays at whatever plan was chosen when the session was created, even after a
 * price change in the billing portal.
 * When `prices` is omitted, an entitled subscription still falls back to metadata.
 */
export async function applyStripeEvent(accounts: AccountDirectory, event: Stripe.Event, prices?: MembershipPrices, hooks?: BillingHooks): Promise<void> {
	if (event.id && !rememberStripeEvent(event.id)) return;
	if (event.type === "checkout.session.completed") {
		const session = event.data.object;
		const uid = session.metadata?.uid || session.client_reference_id || undefined;
		const plan = session.metadata?.plan;
		const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
		if (uid && customer) await accounts.attachCustomer(uid, customer);
		if (uid) await rememberTesterCoupon(accounts, uid, session);
		if (uid && isPaid(plan)) {
			const before = await accounts.get(uid);
			await accounts.setPlan(uid, plan);
			if (before.plan !== plan) await hooks?.onUpgrade?.(uid, plan);
		}
		return;
	}
	if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
		const subscription = event.data.object;
		const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
		const uid = subscription.metadata?.uid || (await accounts.findByCustomer(customer))?.uid;
		if (!uid) return;
		const entitled = event.type === "customer.subscription.updated" && subscriptionIsEntitled(subscription.status);
		if (!entitled) {
			await accounts.setPlan(uid, "free");
			await accounts.rememberMembership(uid, null);
			await rememberTesterCoupon(accounts, uid, subscription);
			return;
		}
		const planned = prices ? planFromSubscription(subscription, prices) : subscription.metadata?.plan;
		if (planned === "byom" || planned === "included") {
			const before = await accounts.get(uid);
			await accounts.setPlan(uid, planned);
			if (before.plan !== planned) await hooks?.onUpgrade?.(uid, planned);
		}
		await rememberTesterCoupon(accounts, uid, subscription);
		if (prices) {
			const snapshot = membershipFromSubscription(subscription, prices);
			if (snapshot) await accounts.rememberMembership(uid, snapshot);
			else if (subscription.status !== "active" && subscription.status !== "trialing") await accounts.rememberMembership(uid, null);
		}
	}
}

const TESTER_COUPON = "GROUNDWORKTESTER";

/** Promotion codes and coupon names on a Checkout Session or Subscription. */
export function promotionCodesFrom(value: unknown): string[] {
	const found = new Set<string>();
	const visit = (node: unknown, depth: number) => {
		if (depth > 8 || !node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item, depth + 1);
			return;
		}
		const record = node as Record<string, unknown>;
		if (typeof record.code === "string" && record.code.trim()) found.add(record.code.trim());
		if (typeof record.name === "string" && record.name.toUpperCase() === TESTER_COUPON) found.add(record.name.trim());
		for (const [key, child] of Object.entries(record)) {
			if (key === "metadata") continue;
			if (child && typeof child === "object") visit(child, depth + 1);
		}
	};
	if (!value || typeof value !== "object") return [];
	const root = value as Record<string, unknown>;
	visit(root.discounts, 0);
	visit(root.discount, 0);
	visit(root.total_details, 0);
	return [...found];
}

async function rememberTesterCoupon(accounts: AccountDirectory, uid: string, value: unknown): Promise<void> {
	const match = promotionCodesFrom(value).find((code) => code.toUpperCase() === TESTER_COUPON);
	if (match) await accounts.markCoupon(uid, TESTER_COUPON);
}

async function listTesterCoupons(stripe: Stripe, accounts: AccountDirectory): Promise<Array<{ uid: string; code: string }>> {
	const found = new Map<string, string>();
	let promoId = "";
	try {
		const promos = await stripe.promotionCodes.list({ code: TESTER_COUPON, limit: 1 });
		promoId = promos.data[0]?.id ?? "";
	} catch (err) {
		console.error("Could not look up the tester promotion.", err);
	}
	let startingAfter: string | undefined;
	for (let page = 0; page < 20; page++) {
		const listed = await stripe.subscriptions.list({ status: "all", limit: 100, starting_after: startingAfter });
		for (const subscription of listed.data) {
			const codes = promotionCodesFrom(subscription);
			const mentionsPromo = promoId ? JSON.stringify(subscription.discounts ?? "").includes(promoId) : false;
			if (!codes.some((code) => code.toUpperCase() === TESTER_COUPON) && !mentionsPromo) continue;
			const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
			const uid = subscription.metadata?.uid || (await accounts.findByCustomer(customer))?.uid;
			if (uid) found.set(uid, TESTER_COUPON);
		}
		if (!listed.has_more || !listed.data.length) break;
		startingAfter = listed.data[listed.data.length - 1]?.id;
	}
	return [...found.entries()].map(([uid, code]) => ({ uid, code }));
}

/**
 * Read the membership Stripe has for this account and store that plan.
 * The customer is the one already saved, or the Stripe customer whose metadata uid matches.
 * Customers are never matched by email.
 * No subscription and a stored paid plan becomes free. Free, or no plan yet, is left as it is.
 * An active subscription whose price we do not recognize is left as it is.
 * A stored customer Stripe does not have (a test-mode id after the live switch) is not a subscription.
 * That id is cleared and a paid plan becomes free. Sync does not create a replacement customer.
 */
export async function syncStripeMembership(
	stripe: StripeMembershipClient,
	prices: MembershipPrices,
	accounts: AccountDirectory,
	uid: string,
): Promise<void> {
	let customerId = await accounts.customerId(uid);
	if (!customerId) {
		const found = await stripe.customers.search({ query: `metadata['uid']:'${escapeStripeSearch(uid)}'`, limit: 1 });
		customerId = found.data[0]?.id;
		if (customerId) await accounts.attachCustomer(uid, customerId);
	}
	const current = await accounts.get(uid);
	if (!customerId) {
		if (isPaid(current.plan)) await accounts.setPlan(uid, "free");
		return;
	}
	let recognized: "byom" | "included" | null = null;
	let unknown = false;
	try {
		for (const status of ["active", "trialing", "past_due"] as const) {
			const page = await stripe.subscriptions.list({ customer: customerId, status, limit: 10 });
			for (const subscription of page.data) {
				const plan = planFromSubscription({ ...subscription, status: subscription.status ?? status }, prices);
				if (plan === "included") recognized = "included";
				else if (plan === "byom" && recognized !== "included") recognized = "byom";
				else if (plan === "unknown") unknown = true;
			}
		}
	} catch (err) {
		if (!isMissingStripeCustomer(err)) throw err;
		await accounts.clearCustomer(uid);
		if (isPaid(current.plan)) await accounts.setPlan(uid, "free");
		return;
	}
	if (recognized) {
		if (recognized !== current.plan) await accounts.setPlan(uid, recognized);
		return;
	}
	if (!unknown && isPaid(current.plan)) await accounts.setPlan(uid, "free");
}

/** Stripe search quotes a string with single quotes. */
export function escapeStripeSearch(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function unconfigured(): Billing {
	const missing = "Stripe isn't connected yet. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_BYOM, and STRIPE_PRICE_INCLUDED on the server.";
	return {
		configured: false,
		async checkout() {
			throw Object.assign(new Error(missing), { status: 503 });
		},
		async portal() {
			throw Object.assign(new Error(missing), { status: 503 });
		},
		async applyEvent() {
			throw Object.assign(new Error(missing), { status: 503 });
		},
	};
}

/**
 * A test-mode customer id is `resource_missing` once the secret key is live.
 * A missing price uses the same code and must not be treated as a missing customer.
 */
export function isMissingStripeCustomer(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const error = err as { code?: unknown; param?: unknown; message?: unknown };
	if (error.code !== "resource_missing") return false;
	const message = typeof error.message === "string" ? error.message : "";
	if (/no such customer/i.test(message)) return true;
	const param = typeof error.param === "string" ? error.param : "";
	return param === "customer" || param.endsWith("[customer]");
}

function extraPrices(name: string): string[] {
	return (process.env[name] ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

async function checkoutSession(
	stripe: Stripe,
	prices: MembershipPrices,
	customer: string,
	uid: string,
	plan: "byom" | "included",
	origin: string,
	ga?: CheckoutGaContext,
): Promise<string> {
	const session = await stripe.checkout.sessions.create({
		mode: "subscription",
		customer,
		client_reference_id: uid,
		line_items: [{ price: prices[plan], quantity: 1 }],
		success_url: checkoutSuccessUrl(origin, plan),
		cancel_url: `${origin}/?billing=cancel`,
		metadata: { uid, plan, ...gaMetadata(ga) },
		subscription_data: { metadata: { uid, plan } },
		allow_promotion_codes: true,
		// A 100% off code makes the total $0. Stripe then skips the card.
		payment_method_collection: "if_required",
	});
	if (!session.url) throw new Error("Stripe did not return a checkout link.");
	return session.url;
}

/**
 * Run a Stripe call with the stored customer.
 * When that customer does not exist in this Stripe mode, clear it, create a live one, and retry once.
 * Portal refuses to invent a customer when the account has never had one.
 */
async function withStripeCustomer(
	stripe: Stripe,
	accounts: AccountDirectory,
	uid: string,
	email: string | undefined,
	portal: boolean,
	run: (customerId: string) => Promise<string>,
): Promise<string> {
	const existing = await accounts.customerId(uid);
	if (!existing) {
		if (portal) throw badRequest("No billing account yet. Choose a paid plan first.");
		return run(await customerFor(stripe, accounts, uid, email));
	}
	try {
		return await run(existing);
	} catch (err) {
		if (!isMissingStripeCustomer(err)) throw err;
	}
	await accounts.clearCustomer(uid);
	return run(await customerFor(stripe, accounts, uid, email));
}

async function customerFor(stripe: Stripe, accounts: AccountDirectory, uid: string, email: string | undefined): Promise<string> {
	const existing = await accounts.customerId(uid);
	if (existing) return existing;
	const customer = await stripe.customers.create({ email, metadata: { uid } });
	await accounts.attachCustomer(uid, customer.id);
	return customer.id;
}

function priceId(price: string | { id?: string | null } | null | undefined): string | undefined {
	if (typeof price === "string" && price) return price;
	if (price && typeof price === "object" && typeof price.id === "string" && price.id) return price.id;
	return undefined;
}

/** Checkout `amount_total` is cents. A 100% off promotion is 0, which is still a purchase. */
export function paidAmountUsd(amountTotal: number | null | undefined): number | null {
	if (typeof amountTotal !== "number" || !Number.isFinite(amountTotal) || amountTotal < 0) return null;
	return amountTotal / 100;
}

/** Stripe replaces `{CHECKOUT_SESSION_ID}` so a refresh of the success page can be deduped. */
export function checkoutSuccessUrl(origin: string, plan: "byom" | "included"): string {
	return `${origin}/?billing=success&session_id={CHECKOUT_SESSION_ID}&plan=${plan}`;
}

function gaMetadata(ga: CheckoutGaContext | undefined): Record<string, string> {
	if (!ga) return {};
	const out: Record<string, string> = {};
	const clientId = cleanGaClientId(ga.gaClientId);
	const sessionId = cleanGaSessionId(ga.gaSessionId);
	const gclid = cleanGclid(ga.gclid);
	if (clientId) out.ga_client_id = clientId;
	if (sessionId) out.ga_session_id = sessionId;
	if (gclid) out.gclid = gclid;
	if (ga.consent === "granted" || ga.consent === "denied") out.ga_consent = ga.consent;
	return out;
}

function isPaid(plan: unknown): plan is "byom" | "included" {
	return plan === "byom" || plan === "included";
}

function badRequest(message: string): Error {
	return Object.assign(new Error(message), { status: 400 });
}
