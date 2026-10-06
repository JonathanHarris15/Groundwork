import { beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { AccountDirectory } from "../src/accounts";
import { applyStripeEvent, createBilling, escapeStripeSearch, planFromSubscription, resetStripeEventDedupe, syncStripeMembership, type StripeMembershipClient } from "../src/billing";

const prices = { byom: "price_byom", included: "price_included" };

beforeEach(() => {
	resetStripeEventDedupe();
});

function event(type: Stripe.Event["type"], object: object, id = "evt_test"): Stripe.Event {
	return { id, type, data: { object } } as Stripe.Event;
}

function stripeFake(opts: {
	customers?: Array<{ id: string }>;
	subscriptions?: Array<{ status: string; items?: { data: Array<{ price: string | { id: string } }> } }>;
	onSearch?: (query: string) => void;
}): StripeMembershipClient {
	return {
		customers: {
			async search({ query }) {
				opts.onSearch?.(query);
				return { data: opts.customers ?? [] };
			},
		},
		subscriptions: {
			async list({ status }) {
				return { data: (opts.subscriptions ?? []).filter((sub) => sub.status === status) };
			},
		},
	};
}

describe("checkout promotion codes", () => {
	it("opens Checkout with a promotion-code field and does not require a card when the total is zero", async () => {
		const accounts = new AccountDirectory();
		let created: Record<string, unknown> | undefined;
		const stripe = {
			customers: {
				async create() {
					return { id: "cus_new" };
				},
			},
			checkout: {
				sessions: {
					async create(params: Record<string, unknown>) {
						created = params;
						return { url: "https://checkout.stripe.test/session", amount_total: 0 };
					},
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await expect(billing.checkout("ada", "ada@example.com", "byom", "https://groundwork.test")).resolves.toBe(
			"https://checkout.stripe.test/session",
		);
		expect(created).toMatchObject({
			mode: "subscription",
			customer: "cus_new",
			allow_promotion_codes: true,
			payment_method_collection: "if_required",
			line_items: [{ price: "price_byom", quantity: 1 }],
		});
		await expect(accounts.customerId("ada")).resolves.toBe("cus_new");
	});

	it("keeps a 100% off forever subscription on our price and sets the plan", async () => {
		const subscription = {
			status: "active",
			customer: "cus_ada",
			metadata: { uid: "ada" },
			items: { data: [{ price: { id: "price_included", unit_amount: 1500, currency: "usd" } }] },
			discounts: [{ coupon: { percent_off: 100, duration: "forever" } }],
		};
		expect(planFromSubscription(subscription, prices)).toBe("included");
		const accounts = new AccountDirectory();
		await applyStripeEvent(accounts, event("customer.subscription.updated", subscription, "evt_free_forever"), prices);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included" });

		const checkedOut = new AccountDirectory();
		await applyStripeEvent(
			checkedOut,
			event(
				"checkout.session.completed",
				{
					metadata: { uid: "ada", plan: "byom" },
					client_reference_id: "ada",
					customer: "cus_ada",
					amount_total: 0,
					payment_status: "paid",
				},
				"evt_zero_checkout",
			),
		);
		await expect(checkedOut.get("ada")).resolves.toMatchObject({ plan: "byom" });
	});
});

describe("stripe plan updates", () => {
	it("ignores a replayed webhook event id", async () => {
		resetStripeEventDedupe();
		const accounts = new AccountDirectory();
		const evt = event(
			"checkout.session.completed",
			{
				metadata: { uid: "ada", plan: "included" },
				client_reference_id: "ada",
				customer: "cus_123",
			},
			"evt_replay",
		);
		await applyStripeEvent(accounts, evt);
		await applyStripeEvent(accounts, evt);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included" });
	});

	it("starts the paid plan when checkout completes", async () => {
		resetStripeEventDedupe();
		const accounts = new AccountDirectory();
		await accounts.seen("ada", { email: "ada@example.com", name: "Ada" });
		await applyStripeEvent(
			accounts,
			event("checkout.session.completed", {
				metadata: { uid: "ada", plan: "included" },
				client_reference_id: "ada",
				customer: "cus_123",
			}),
		);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included", hasBilling: true, email: "ada@example.com", displayName: "Ada" });
		await expect(accounts.customerId("ada")).resolves.toBe("cus_123");
	});

	it("uses the subscription price when checkout metadata is stale", async () => {
		const accounts = new AccountDirectory();
		await accounts.attachCustomer("ada", "cus_9");
		await accounts.setPlan("ada", "byom");
		await applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_9",
				metadata: { plan: "byom" },
				status: "active",
				items: { data: [{ price: { id: "price_included" } }] },
			}),
			prices,
		);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included" });
	});

	it("keeps a paid plan from an active price even without metadata", async () => {
		const accounts = new AccountDirectory();
		await accounts.attachCustomer("ada", "cus_9");
		await applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_9",
				metadata: {},
				status: "past_due",
				items: { data: [{ price: "price_byom" }] },
			}),
			prices,
		);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "byom" });
	});

	it("does not demote an active subscription whose price is not one of ours", async () => {
		const accounts = new AccountDirectory();
		await accounts.setPlan("ada", "included");
		await accounts.attachCustomer("ada", "cus_123");
		await applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_123",
				metadata: {},
				status: "active",
				items: { data: [{ price: { id: "price_other" } }] },
			}),
			prices,
		);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included" });
	});

	it("downgrades to free when Stripe marks a subscription unpaid", async () => {
		const accounts = new AccountDirectory();
		await accounts.setPlan("ada", "included");
		await accounts.attachCustomer("ada", "cus_123");
		await applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_123",
				metadata: { uid: "ada", plan: "included" },
				status: "unpaid",
				items: { data: [{ price: "price_included" }] },
			}),
			prices,
		);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "free" });
	});

	it("returns the account to free when the subscription ends", async () => {
		const accounts = new AccountDirectory();
		await accounts.setPlan("ada", "included");
		await accounts.attachCustomer("ada", "cus_123");
		await applyStripeEvent(
			accounts,
			event("customer.subscription.deleted", {
				customer: "cus_123",
				metadata: { uid: "ada", plan: "included" },
				status: "canceled",
			}),
		);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "free", hasBilling: true });
	});
});

describe("stripe membership sync", () => {
	it("finds the customer by uid and prefers the included price", async () => {
		const accounts = new AccountDirectory();
		await accounts.seen("ada", { email: "ada@example.com" });
		let query = "";
		await syncStripeMembership(
			stripeFake({
				customers: [{ id: "cus_ada" }],
				subscriptions: [
					{ status: "active", items: { data: [{ price: { id: "price_byom" } }] } },
					{ status: "trialing", items: { data: [{ price: "price_included" }] } },
				],
				onSearch: (value) => {
					query = value;
				},
			}),
			prices,
			accounts,
			"ada",
		);
		expect(query).toBe(`metadata['uid']:'ada'`);
		expect(query).not.toContain("ada@example.com");
		await expect(accounts.customerId("ada")).resolves.toBe("cus_ada");
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included" });
	});

	it("drops a stored paid plan when Stripe has no subscription, and leaves free alone", async () => {
		const paid = new AccountDirectory();
		await paid.setPlan("ada", "byom");
		await syncStripeMembership(stripeFake({ customers: [] }), prices, paid, "ada");
		await expect(paid.get("ada")).resolves.toMatchObject({ plan: "free" });

		const free = new AccountDirectory();
		await free.setPlan("ada", "free");
		await syncStripeMembership(stripeFake({ customers: [] }), prices, free, "ada");
		await expect(free.get("ada")).resolves.toMatchObject({ plan: "free", needsPlan: false });

		const unset = new AccountDirectory();
		await unset.seen("ada", {});
		await syncStripeMembership(stripeFake({ customers: [] }), prices, unset, "ada");
		await expect(unset.get("ada")).resolves.toMatchObject({ plan: null, needsPlan: true });
	});

	it("leaves a paid plan alone when the only subscription price is unrecognized", async () => {
		const accounts = new AccountDirectory();
		await accounts.setPlan("ada", "included");
		await accounts.attachCustomer("ada", "cus_ada");
		await syncStripeMembership(
			stripeFake({ subscriptions: [{ status: "active", items: { data: [{ price: { id: "price_legacy" } }] } }] }),
			prices,
			accounts,
			"ada",
		);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included" });
	});

	it("escapes a uid before searching Stripe", () => {
		expect(escapeStripeSearch("ada'o\\b")).toBe("ada\\'o\\\\b");
	});

	it("refuses webhooks without a signature", async () => {
		const accounts = new AccountDirectory();
		const stripe = {
			webhooks: {
				constructEvent() {
					throw new Error("should not run");
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await expect(billing.applyEvent("{}", undefined)).rejects.toMatchObject({ status: 400 });
	});

	it("verifies the Stripe signature before applying an event", async () => {
		const accounts = new AccountDirectory();
		let verified = false;
		const stripe = {
			webhooks: {
				constructEvent(raw: string, sig: string, secret: string) {
					expect(sig).toBe("sig");
					expect(secret).toBe("whsec_test");
					verified = true;
					return event("checkout.session.completed", {
						metadata: { uid: "ada", plan: "byom" },
						customer: "cus_1",
					});
				},
			},
		} as unknown as Stripe;
		resetStripeEventDedupe();
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await billing.applyEvent('{"id":"evt"}', "sig");
		expect(verified).toBe(true);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "byom" });
	});

	it("caches a successful read and retries after Stripe fails", async () => {
		const accounts = new AccountDirectory();
		let searches = 0;
		const stripe = {
			customers: {
				async search() {
					searches++;
					if (searches === 1) throw new Error("stripe down");
					return { data: [{ id: "cus_ada" }] };
				},
			},
			subscriptions: {
				async list() {
					return { data: [{ status: "active", items: { data: [{ price: { id: "price_byom" } }] } }] };
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec", accounts);
		await billing.sync!("ada");
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: null });
		await billing.sync!("ada");
		await billing.sync!("ada");
		expect(searches).toBe(2);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "byom" });
	});
});
