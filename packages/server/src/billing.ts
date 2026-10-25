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
	 * What Stripe collected on a Checkout Session.
	 * Invoice `amount_paid` when the session has an invoice, otherwise `amount_total` on a paid session.
	 * Zero is a comp. Null means the collected amount is not known. The list price is never used.
	 */
	checkoutAmount?(sessionId: string): Promise<CheckoutCollected | null>;
	/** Accounts carrying the GROUNDWORKTESTER promotion, when Stripe can say so. */
	couponHolders?(): Promise<Array<{ uid: string; code: string }>>;
	/** Write active and trialing memberships onto the accounts Stripe already knows. */
	syncMemberships?(): Promise<void>;
}

/** Named plan plus the census snapshot. `membership` is null for `past_due`, which keeps the plan and drops the snapshot. */
export type LiveEntitlement = { plan: "byom" | "included"; membership: StoredMembership | null };

/** What to do with the account when one subscription ends and Stripe may still have another. */
export type ReplacementMembership = LiveEntitlement | "keep" | null;

export interface BillingHooks {
	onUpgrade?(uid: string, plan: "byom" | "included"): Promise<void>;
	/**
	 * Another entitled subscription for this customer.
	 * `keep` means one is still entitled but its price is not one of ours, so the stored plan stays.
	 * `null` means Stripe has no entitled subscription left.
	 */
	replacement?(customerId: string): Promise<ReplacementMembership>;
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

export interface SubscriptionItemLike {
	quantity?: number | null;
	price?: string | { id?: string | null; unit_amount?: number | null; currency?: string | null } | null;
	/** Legacy Subscription Item field. Same id as `price` on current subscriptions. */
	plan?: string | { id?: string | null; amount?: number | null; currency?: string | null } | null;
	pricing?: {
		unit_amount?: number | null;
		currency?: string | null;
		price_details?: { price?: string | { id?: string | null } | null } | null;
	} | null;
}

export interface SubscriptionLike {
	status?: string | null;
	metadata?: { uid?: string | null; plan?: string | null } | null;
	items?: { data?: Array<SubscriptionItemLike> | null } | null;
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
		const id = itemPriceId(item);
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
	// Omit the coupon when there isn't one. Firestore rejects a stored `undefined`.
	const membership: StoredMembership = { status: subscription.status, plan, amountUsd: recurringAmountUsd(subscription) };
	if (couponCode) membership.couponCode = couponCode;
	return membership;
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
		const charge = itemCharge(item);
		if (!charge) continue;
		if (charge.currency && charge.currency.toLowerCase() !== "usd") continue;
		sawAmount = true;
		const quantity = item?.quantity ?? 1;
		cents += charge.cents * (quantity > 0 ? quantity : 1);
	}
	if (!sawAmount) return null;
	cents = Math.round(cents * (1 - Math.max(0, percentOff) / 100));
	cents = Math.max(0, cents - Math.max(0, amountOffCents));
	return Math.round(cents) / 100;
}

export interface MembershipSubscription extends SubscriptionLike {
	id?: string;
	customer?: string | { id?: string | null } | null;
}

export interface PaidMembershipClient {
	subscriptions: {
		list(args: { status: "active" | "trialing"; limit: number; starting_after?: string; expand?: string[] }): Promise<{ data: MembershipSubscription[]; has_more: boolean }>;
	};
}

const MEMBERSHIP_EXPANDS: string[][] = [
	["data.items.data.price", "data.discounts", "data.discounts.promotion_code", "data.discounts.source.coupon"],
	["data.discounts", "data.discounts.coupon", "data.discounts.promotion_code"],
	["data.discount", "data.discount.coupon", "data.discount.promotion_code"],
	[],
];

/**
 * Copy active and trialing subscriptions onto accounts.
 * A payer Stripe lists is written even when the account document does not exist yet, so they show up on the admin list.
 * Accounts Stripe does not list lose a stale membership. An entitled subscription whose price we do not recognize keeps the stored one.
 */
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
				const entitlement = entitlementFromSubscription({ ...subscription, status: subscription.status ?? status }, prices);
				if (entitlement === "unknown") {
					seen.add(uid);
					continue;
				}
				if (!entitlement) continue;
				const current = await accounts.get(uid);
				if (current.plan !== entitlement.plan) await accounts.setPlan(uid, entitlement.plan);
				await accounts.rememberMembership(uid, entitlement.membership);
				if (entitlement.membership?.couponCode) await accounts.markCoupon(uid, entitlement.membership.couponCode);
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
		list(args: { customer: string; status: "active" | "trialing" | "past_due"; limit: number; expand?: string[] }): Promise<{ data: SubscriptionLike[] }>;
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
			await applyStripeEvent(accounts, event, prices, {
				...hooks,
				replacement: (customerId) => liveEntitlement(stripe, prices, customerId),
			});
			if (event.type === "checkout.session.completed") {
				const session = event.data.object;
				const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
				if (subId && stripe.subscriptions?.retrieve) {
					try {
						const subscription = await stripe.subscriptions.retrieve(subId, {
							expand: ["discounts", "discounts.promotion_code", "discounts.source.coupon"],
						});
						await applyLiveSubscription(accounts, subscription, prices, hooks);
					} catch (err) {
						console.error("Could not store the checkout membership.", err);
					}
				}
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
				const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["invoice"] });
				let invoice = session.invoice;
				if (typeof invoice === "string") {
					try {
						invoice = await stripe.invoices.retrieve(invoice);
					} catch {
						return null;
					}
				}
				return collectedPurchase({
					id: session.id,
					status: session.status,
					payment_status: session.payment_status,
					amount_total: session.amount_total,
					currency: session.currency,
					invoice: invoice && typeof invoice === "object" ? { id: invoice.id, amount_paid: invoice.amount_paid, currency: invoice.currency } : null,
				});
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
	try {
		await dispatchStripeEvent(accounts, event, prices, hooks);
	} catch (err) {
		if (event.id) seenStripeEvents.delete(event.id);
		throw err;
	}
}

async function dispatchStripeEvent(accounts: AccountDirectory, event: Stripe.Event, prices?: MembershipPrices, hooks?: BillingHooks): Promise<void> {
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
	if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
		const subscription = event.data.object;
		const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
		const uid = subscription.metadata?.uid || (await accounts.findByCustomer(customer))?.uid;
		if (!uid) return;
		const entitled = event.type !== "customer.subscription.deleted" && subscriptionIsEntitled(subscription.status);
		// `created` can arrive as `incomplete` before checkout finishes. Do not wipe the plan that checkout just set.
		if (!entitled) {
			if (event.type === "customer.subscription.created") return;
			const next = await hooks?.replacement?.(customer);
			if (next === "keep") return;
			if (next) {
				const before = await accounts.get(uid);
				if (before.plan !== next.plan) {
					await accounts.setPlan(uid, next.plan);
					await hooks?.onUpgrade?.(uid, next.plan);
				}
				await accounts.rememberMembership(uid, next.membership);
				if (next.membership?.couponCode) await accounts.markCoupon(uid, next.membership.couponCode);
				await rememberTesterCoupon(accounts, uid, subscription);
				return;
			}
			await accounts.setPlan(uid, "free");
			await accounts.rememberMembership(uid, null);
			await rememberTesterCoupon(accounts, uid, subscription);
			return;
		}
		await applyLiveSubscription(accounts, subscription, prices, hooks);
	}
}

/**
 * Store the plan and membership Stripe currently has.
 * Active and trialing count, including a subscription that cancels at period end.
 * `past_due` keeps the paid plan and drops the census snapshot, matching the webhook.
 */
export async function applyLiveSubscription(
	accounts: AccountDirectory,
	subscription: MembershipSubscription & { metadata?: { uid?: string | null; plan?: string | null } | null },
	prices?: MembershipPrices,
	hooks?: BillingHooks,
): Promise<void> {
	if (!subscriptionIsEntitled(subscription.status)) return;
	const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
	const uid = subscription.metadata?.uid?.trim() || (customer ? (await accounts.findByCustomer(customer))?.uid : undefined);
	if (!uid) return;
	const entitlement = entitlementFromSubscription(subscription, prices);
	await rememberTesterCoupon(accounts, uid, subscription);
	if (!entitlement || entitlement === "unknown") return;
	const before = await accounts.get(uid);
	if (before.plan !== entitlement.plan) {
		await accounts.setPlan(uid, entitlement.plan);
		await hooks?.onUpgrade?.(uid, entitlement.plan);
	}
	await accounts.rememberMembership(uid, entitlement.membership);
	if (entitlement.membership?.couponCode) await accounts.markCoupon(uid, entitlement.membership.couponCode);
}

const TESTER_COUPON = "GROUNDWORKTESTER";

/**
 * The plan a subscription grants.
 * A known price wins. When the price is not one of ours, checkout metadata (`plan`) is the membership,
 * so a Bring your own model payer is not left on free after a price change.
 * `unknown` means the subscription is entitled and neither the price nor the metadata names a plan.
 */
export function entitlementFromSubscription(subscription: SubscriptionLike, prices?: MembershipPrices): LiveEntitlement | "unknown" | null {
	if (!subscriptionIsEntitled(subscription.status)) return null;
	const priced = prices ? planFromSubscription(subscription, prices) : null;
	const hinted = subscription.metadata?.plan === "byom" || subscription.metadata?.plan === "included" ? subscription.metadata.plan : null;
	const plan = priced === "byom" || priced === "included" ? priced : hinted;
	if (plan !== "byom" && plan !== "included") return "unknown";
	const status = subscription.status === "active" || subscription.status === "trialing" ? subscription.status : null;
	if (!status) return { plan, membership: null };
	const pricedMembership = prices && (priced === plan) ? membershipFromSubscription(subscription, prices) : null;
	if (pricedMembership?.plan === plan) return { plan, membership: pricedMembership };
	const couponCode = promotionCodesFrom(subscription).find((code) => code.toUpperCase() === TESTER_COUPON);
	const membership: StoredMembership = { status, plan, amountUsd: recurringAmountUsd(subscription) };
	if (couponCode) membership.couponCode = couponCode;
	return { plan, membership };
}

/** Entitled subscriptions still on this customer, preferring Groundwork over Bring your own model. */
async function liveEntitlement(stripe: Stripe, prices: MembershipPrices, customerId: string): Promise<ReplacementMembership> {
	let named: LiveEntitlement | null = null;
	let unknown = false;
	for (const status of ["active", "trialing", "past_due"] as const) {
		const page = await stripe.subscriptions.list({
			customer: customerId,
			status,
			limit: 10,
			expand: ["data.items.data.price"],
		});
		for (const subscription of page.data) {
			const entitlement = entitlementFromSubscription({ ...subscription, status: subscription.status ?? status }, prices);
			if (entitlement === "unknown") unknown = true;
			else if (entitlement && (entitlement.plan === "included" || named?.plan !== "included")) named = entitlement;
		}
	}
	if (named) return named;
	if (unknown) return "keep";
	return null;
}

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
	let recognized: LiveEntitlement | null = null;
	let unknown = false;
	try {
		for (const status of ["active", "trialing", "past_due"] as const) {
			const page = await stripe.subscriptions.list({ customer: customerId, status, limit: 10, expand: ["data.items.data.price"] });
			for (const subscription of page.data) {
				const shaped = { ...subscription, status: subscription.status ?? status };
				const entitlement = entitlementFromSubscription(shaped, prices);
				if (entitlement === "unknown") unknown = true;
				else if (entitlement && (entitlement.plan === "included" || recognized?.plan !== "included")) recognized = entitlement;
			}
		}
	} catch (err) {
		if (!isMissingStripeCustomer(err)) throw err;
		await accounts.clearCustomer(uid);
		if (isPaid(current.plan)) await accounts.setPlan(uid, "free");
		return;
	}
	if (recognized) {
		if (recognized.plan !== current.plan) await accounts.setPlan(uid, recognized.plan);
		await accounts.rememberMembership(uid, recognized.membership);
		if (recognized.membership?.couponCode) await accounts.markCoupon(uid, recognized.membership.couponCode);
		return;
	}
	// An empty list right after checkout used to wipe a plan the webhook had just stored.
	if (!unknown && isPaid(current.plan) && !(await accounts.liveMembership(uid))) await accounts.setPlan(uid, "free");
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

function itemPriceId(item: SubscriptionItemLike | null | undefined): string | undefined {
	if (!item) return undefined;
	return priceId(item.price) ?? priceId(item.plan) ?? priceId(item.pricing?.price_details?.price);
}

function itemCharge(item: SubscriptionItemLike | null | undefined): { cents: number; currency: string | null } | null {
	if (!item) return null;
	const price = item.price;
	if (price && typeof price === "object" && typeof price.unit_amount === "number" && Number.isFinite(price.unit_amount)) {
		return { cents: price.unit_amount, currency: price.currency ?? null };
	}
	const plan = item.plan;
	if (plan && typeof plan === "object" && typeof plan.amount === "number" && Number.isFinite(plan.amount)) {
		return { cents: plan.amount, currency: plan.currency ?? null };
	}
	const pricing = item.pricing;
	if (pricing && typeof pricing.unit_amount === "number" && Number.isFinite(pricing.unit_amount)) {
		return { cents: pricing.unit_amount, currency: pricing.currency ?? null };
	}
	return null;
}

/** Checkout `amount_total` is cents. A 100% off promotion is 0, which is still a purchase on the server. */
export function paidAmountUsd(amountTotal: number | null | undefined): number | null {
	if (typeof amountTotal !== "number" || !Number.isFinite(amountTotal) || amountTotal < 0) return null;
	return amountTotal / 100;
}

/** Collected amount for one Checkout Session. The browser fires only when `amount` is above 0. */
export interface CheckoutCollected {
	amount: number;
	currency: string;
	transactionId: string;
}

export interface CheckoutAmountSource {
	id?: string | null;
	status?: string | null;
	payment_status?: string | null;
	amount_total?: number | null;
	currency?: string | null;
	invoice?: string | { id?: string | null; amount_paid?: number | null; currency?: string | null } | null;
}

const ZERO_DECIMAL = new Set("bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf".split(" "));
const THREE_DECIMAL = new Set("bhd jod kwd omr tnd".split(" "));

/**
 * Amount Stripe collected.
 * An expanded invoice uses `amount_paid` and ignores `amount_total`, so a list price on the session is not revenue.
 * An invoice id that was not loaded is unknown.
 * With no invoice, only `payment_status: paid` may use `amount_total`. `no_payment_required` collected nothing.
 */
export function collectedPurchase(session: CheckoutAmountSource): CheckoutCollected | null {
	const sessionId = session.id?.trim() ?? "";
	if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
	if (session.status !== "complete") return null;
	const invoice = session.invoice;
	if (typeof invoice === "string") return null;
	if (invoice && typeof invoice === "object") {
		const paid = moneyFromMinor(invoice.amount_paid, invoice.currency ?? session.currency);
		if (!paid) return null;
		const invoiceId = invoice.id?.trim() ?? "";
		const transactionId = /^in_[A-Za-z0-9_]+$/.test(invoiceId) ? invoiceId : sessionId;
		return { amount: paid.amount, currency: paid.currency, transactionId };
	}
	if (session.payment_status === "no_payment_required") {
		return { amount: 0, currency: isoCurrency(session.currency) ?? "", transactionId: sessionId };
	}
	if (session.payment_status !== "paid") return null;
	const paid = moneyFromMinor(session.amount_total, session.currency);
	if (!paid) return null;
	return { amount: paid.amount, currency: paid.currency, transactionId: sessionId };
}

function moneyFromMinor(minor: number | null | undefined, currency: string | null | undefined): { amount: number; currency: string } | null {
	if (typeof minor !== "number" || !Number.isFinite(minor) || minor < 0) return null;
	const code = isoCurrency(currency);
	if (!code) return null;
	const lower = code.toLowerCase();
	const exp = ZERO_DECIMAL.has(lower) ? 0 : THREE_DECIMAL.has(lower) ? 3 : 2;
	const scale = 10 ** exp;
	return { amount: Math.round(minor) / scale, currency: code };
}

function isoCurrency(currency: string | null | undefined): string | null {
	const code = currency?.trim().toUpperCase() ?? "";
	return /^[A-Z]{3}$/.test(code) ? code : null;
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
