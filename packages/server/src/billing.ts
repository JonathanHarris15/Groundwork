import type { PlanId } from "@groundwork/core";
import Stripe from "stripe";
import type { AccountDirectory } from "./accounts";

export interface Billing {
	readonly configured: boolean;
	checkout(uid: string, email: string | undefined, plan: PlanId, origin: string): Promise<string>;
	portal(uid: string, origin: string): Promise<string>;
	/** Apply a verified Stripe webhook. `raw` is the request body exactly as Stripe sent it. */
	applyEvent(raw: string, signature: string | undefined): Promise<void>;
	/**
	 * Set the account plan from the live Stripe subscription.
	 * A Stripe outage must not fail the request.
	 */
	sync?(uid: string, email?: string): Promise<void>;
}

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
	items?: { data?: Array<{ price?: string | { id?: string | null } | null }> } | null;
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
export function planFromSubscription(subscription: SubscriptionLike, prices: { byom: string; included: string }): "byom" | "included" | "unknown" | null {
	if (!subscriptionIsEntitled(subscription.status)) return null;
	let included = false;
	let byom = false;
	for (const item of subscription.items?.data ?? []) {
		const id = priceId(item?.price);
		if (!id) continue;
		if (id === prices.included) included = true;
		else if (id === prices.byom) byom = true;
	}
	if (included) return "included";
	if (byom) return "byom";
	return "unknown";
}

export function loadBilling(accounts: AccountDirectory): Billing {
	const key = process.env.STRIPE_SECRET_KEY?.trim();
	const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
	const prices = {
		byom: process.env.STRIPE_PRICE_BYOM?.trim(),
		included: process.env.STRIPE_PRICE_INCLUDED?.trim(),
	};
	if (!key || !webhookSecret || !prices.byom || !prices.included) return unconfigured();
	return createBilling(new Stripe(key), prices as { byom: string; included: string }, webhookSecret, accounts);
}

export interface StripeMembershipClient {
	customers: {
		search(args: { query: string; limit: number }): Promise<{ data: Array<{ id: string }> }>;
	};
	subscriptions: {
		list(args: { customer: string; status: "active" | "trialing" | "past_due"; limit: number }): Promise<{ data: SubscriptionLike[] }>;
	};
}

export function createBilling(stripe: Stripe, prices: { byom: string; included: string }, webhookSecret: string, accounts: AccountDirectory): Billing {
	const freshUntil = new Map<string, number>();
	return {
		configured: true,
		async checkout(uid, email, plan, origin) {
			if (!isPaid(plan)) throw badRequest("That plan is free. Choose it without checkout.");
			const customer = await customerFor(stripe, accounts, uid, email);
			const session = await stripe.checkout.sessions.create({
				mode: "subscription",
				customer,
				client_reference_id: uid,
				line_items: [{ price: prices[plan], quantity: 1 }],
				success_url: `${origin}/?billing=success`,
				cancel_url: `${origin}/?billing=cancel`,
				metadata: { uid, plan },
				subscription_data: { metadata: { uid, plan } },
			});
			if (!session.url) throw new Error("Stripe did not return a checkout link.");
			return session.url;
		},
		async portal(uid, origin) {
			const customer = await accounts.customerId(uid);
			if (!customer) throw badRequest("No billing account yet. Choose a paid plan first.");
			const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${origin}/` });
			return session.url;
		},
		async applyEvent(raw, signature) {
			if (!signature) throw badRequest("Missing Stripe signature.");
			const event = stripe.webhooks.constructEvent(raw, signature, webhookSecret);
			freshUntil.clear();
			await applyStripeEvent(accounts, event, prices);
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
export async function applyStripeEvent(accounts: AccountDirectory, event: Stripe.Event, prices?: { byom: string; included: string }): Promise<void> {
	if (event.id && !rememberStripeEvent(event.id)) return;
	if (event.type === "checkout.session.completed") {
		const session = event.data.object;
		const uid = session.metadata?.uid || session.client_reference_id || undefined;
		const plan = session.metadata?.plan;
		const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
		if (uid && customer) await accounts.attachCustomer(uid, customer);
		if (uid && isPaid(plan)) await accounts.setPlan(uid, plan);
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
			return;
		}
		if (prices) {
			const plan = planFromSubscription(subscription, prices);
			if (plan === "byom" || plan === "included") await accounts.setPlan(uid, plan);
			return;
		}
		const plan = subscription.metadata?.plan;
		if (isPaid(plan)) await accounts.setPlan(uid, plan);
	}
}

/**
 * Read the membership Stripe has for this account and store that plan.
 * The customer is the one already saved, or the Stripe customer whose metadata uid matches.
 * Customers are never matched by email.
 * No subscription and a stored paid plan becomes free. Free, or no plan yet, is left as it is.
 * An active subscription whose price we do not recognize is left as it is.
 */
export async function syncStripeMembership(
	stripe: StripeMembershipClient,
	prices: { byom: string; included: string },
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
	for (const status of ["active", "trialing", "past_due"] as const) {
		const page = await stripe.subscriptions.list({ customer: customerId, status, limit: 10 });
		for (const subscription of page.data) {
			const plan = planFromSubscription({ ...subscription, status: subscription.status ?? status }, prices);
			if (plan === "included") recognized = "included";
			else if (plan === "byom" && recognized !== "included") recognized = "byom";
			else if (plan === "unknown") unknown = true;
		}
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

function isPaid(plan: unknown): plan is "byom" | "included" {
	return plan === "byom" || plan === "included";
}

function badRequest(message: string): Error {
	return Object.assign(new Error(message), { status: 400 });
}
