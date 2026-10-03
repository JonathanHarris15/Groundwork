import type { PlanId } from "@groundwork/core";
import Stripe from "stripe";
import type { AccountDirectory } from "./accounts";

export interface Billing {
	readonly configured: boolean;
	checkout(uid: string, email: string | undefined, plan: PlanId, origin: string): Promise<string>;
	portal(uid: string, origin: string): Promise<string>;
	/** Apply a verified Stripe webhook. `raw` is the request body exactly as Stripe sent it. */
	applyEvent(raw: string, signature: string | undefined): Promise<void>;
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

export function createBilling(stripe: Stripe, prices: { byom: string; included: string }, webhookSecret: string, accounts: AccountDirectory): Billing {
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
			const customer = accounts.customerId(uid);
			if (!customer) throw badRequest("No billing account yet. Choose a paid plan first.");
			const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${origin}/` });
			return session.url;
		},
		async applyEvent(raw, signature) {
			if (!signature) throw badRequest("Missing Stripe signature.");
			const event = stripe.webhooks.constructEvent(raw, signature, webhookSecret);
			applyStripeEvent(accounts, event, prices);
		},
	};
}

export function applyStripeEvent(accounts: AccountDirectory, event: Stripe.Event, prices?: { byom: string; included: string }): void {
	if (event.type === "checkout.session.completed") {
		const session = event.data.object;
		const uid = session.metadata?.uid || session.client_reference_id || undefined;
		const plan = session.metadata?.plan;
		const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
		if (uid && customer) accounts.attachCustomer(uid, customer);
		if (uid && isPaid(plan)) accounts.setPlan(uid, plan);
		return;
	}
	if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
		const subscription = event.data.object;
		const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
		const uid = subscription.metadata?.uid || accounts.findByCustomer(customer)?.uid;
		if (!uid) return;
		const plan = planOnSubscription(subscription, prices);
		const active = event.type === "customer.subscription.updated" && (subscription.status === "active" || subscription.status === "trialing");
		if (active && plan) accounts.setPlan(uid, plan);
		else accounts.setPlan(uid, "free");
	}
}

/** Portal switches replace the price and leave the checkout plan name on the subscription. */
function planOnSubscription(subscription: Stripe.Subscription, prices?: { byom: string; included: string }): "byom" | "included" | undefined {
	const fromPrice = planFromPrice(subscription, prices);
	if (fromPrice) return fromPrice;
	return isPaid(subscription.metadata?.plan) ? subscription.metadata.plan : undefined;
}

function planFromPrice(subscription: Stripe.Subscription, prices?: { byom: string; included: string }): "byom" | "included" | undefined {
	if (!prices) return undefined;
	const ids = new Set(subscriptionPriceIds(subscription));
	const byom = ids.has(prices.byom);
	const included = ids.has(prices.included);
	if (byom && !included) return "byom";
	if (included && !byom) return "included";
	return undefined;
}

function subscriptionPriceIds(subscription: Stripe.Subscription): string[] {
	const items = subscription.items?.data ?? [];
	const ids: string[] = [];
	for (const item of items) {
		const price = item.price;
		if (typeof price === "string") ids.push(price);
		else if (price?.id) ids.push(price.id);
	}
	return ids;
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
	const existing = accounts.customerId(uid);
	if (existing) return existing;
	const customer = await stripe.customers.create({ email, metadata: { uid } });
	accounts.attachCustomer(uid, customer.id);
	return customer.id;
}

function isPaid(plan: unknown): plan is "byom" | "included" {
	return plan === "byom" || plan === "included";
}

function badRequest(message: string): Error {
	return Object.assign(new Error(message), { status: 400 });
}
