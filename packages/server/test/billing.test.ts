import { beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { AccountDirectory } from "../src/accounts";
import { applyStripeEvent, checkoutSuccessUrl, createBilling, escapeStripeSearch, isMissingStripeCustomer, membershipFromSubscription, paidAmountUsd, planFromSubscription, recurringAmountUsd, refreshPaidMemberships, resetStripeEventDedupe, syncStripeMembership, type PaidMembershipClient, type StripeMembershipClient } from "../src/billing";

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
			success_url: checkoutSuccessUrl("https://groundwork.test", "byom"),
		});
		expect(created?.success_url).toContain("session_id={CHECKOUT_SESSION_ID}");
		expect(created?.success_url).toContain("plan=byom");
		await expect(accounts.customerId("ada")).resolves.toBe("cus_new");
	});

	it("stores the analytics client id on the Checkout Session and leaves client_reference_id as the account", async () => {
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
						return { url: "https://checkout.stripe.test/session" };
					},
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await billing.checkout("ada", "ada@example.com", "included", "https://groundwork.test", {
			gaClientId: "123.456",
			gaSessionId: "1700000001",
			gclid: "CjwKCtestclick",
			consent: "granted",
		});
		expect(created).toMatchObject({
			client_reference_id: "ada",
			metadata: {
				uid: "ada",
				plan: "included",
				ga_client_id: "123.456",
				ga_session_id: "1700000001",
				gclid: "CjwKCtestclick",
				ga_consent: "granted",
			},
		});
		await billing.checkout("ada", "ada@example.com", "byom", "https://groundwork.test", {
			gaClientId: "<script>",
			gaSessionId: "nope",
			gclid: "bad id",
			consent: null,
		});
		expect(created?.metadata).toEqual({ uid: "ada", plan: "byom" });
	});

	it("reports a completed checkout from the webhook, and retries the report if the first send fails", async () => {
		const accounts = new AccountDirectory();
		const calls: string[] = [];
		let fail = true;
		const stripe = {
			webhooks: {
				constructEvent(raw: string) {
					return JSON.parse(raw) as Stripe.Event;
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts, {
			async report(row) {
				calls.push(row.id ?? "");
				if (fail) {
					fail = false;
					throw new Error("GA4 Measurement Protocol request failed.");
				}
			},
		});
		const body = JSON.stringify({
			id: "evt_purchase",
			type: "checkout.session.completed",
			data: {
				object: {
					id: "cs_live_abc",
					status: "complete",
					payment_status: "no_payment_required",
					amount_total: 0,
					currency: "usd",
					metadata: { uid: "ada", plan: "included" },
					client_reference_id: "ada",
					customer: "cus_ada",
				},
			},
		});
		await expect(billing.applyEvent(body, "sig")).rejects.toThrow(/Measurement Protocol/);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included" });
		await billing.applyEvent(body, "sig");
		expect(calls).toEqual(["cs_live_abc", "cs_live_abc"]);
	});

	it("reads the amount paid from the Checkout session, including a free promotion", async () => {
		const accounts = new AccountDirectory();
		const stripe = {
			checkout: {
				sessions: {
					async retrieve(id: string) {
						if (id === "cs_free") return { amount_total: 0 };
						if (id === "cs_paid") return { amount_total: 1500 };
						throw new Error("missing");
					},
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await expect(billing.checkoutAmount?.("cs_free")).resolves.toBe(0);
		await expect(billing.checkoutAmount?.("cs_paid")).resolves.toBe(15);
		await expect(billing.checkoutAmount?.("cs_missing")).resolves.toBeNull();
		await expect(billing.checkoutAmount?.("not-a-session")).resolves.toBeNull();
		expect(paidAmountUsd(0)).toBe(0);
		expect(paidAmountUsd(undefined)).toBeNull();
		expect(paidAmountUsd(-1)).toBeNull();
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
		expect(
			planFromSubscription(
				{ ...subscription, items: { data: [{ price: { id: "price_included_old" } }] } },
				{ ...prices, previous: { included: ["price_included_old"] } },
			),
		).toBe("included");
		const accounts = new AccountDirectory();
		await applyStripeEvent(accounts, event("customer.subscription.updated", subscription, "evt_free_forever"), prices);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included" });
		expect((await accounts.list()).find((row) => row.record.uid === "ada")?.record.membership).toMatchObject({ status: "active", plan: "included", amountUsd: 0 });

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

function missingCustomer(message = "No such customer: 'cus_test'"): Error {
	return Object.assign(new Error(message), { code: "resource_missing", param: "customer", status: 404 });
}

describe("test-mode customer ids after a live key", () => {
	it("recognizes a missing customer and leaves a missing price alone", () => {
		expect(isMissingStripeCustomer(missingCustomer())).toBe(true);
		expect(
			isMissingStripeCustomer(
				missingCustomer("No such customer: 'cus_test'; a similar object exists in test mode, but a live mode key was used to make this request."),
			),
		).toBe(true);
		expect(isMissingStripeCustomer(Object.assign(new Error("No such customer: 'cus_test'"), { code: "resource_missing" }))).toBe(true);
		expect(
			isMissingStripeCustomer(Object.assign(new Error("No such price: 'price_byom'"), { code: "resource_missing", param: "line_items[0][price]" })),
		).toBe(false);
		expect(isMissingStripeCustomer(new Error("stripe down"))).toBe(false);
	});

	it("clears a missing customer, creates a live one, and retries checkout once", async () => {
		const accounts = new AccountDirectory();
		await accounts.seen("ada", { email: "ada@example.com" });
		await accounts.attachCustomer("ada", "cus_test");
		const sessions: string[] = [];
		let created = 0;
		const stripe = {
			customers: {
				async create(params: { email?: string; metadata?: { uid?: string } }) {
					created++;
					expect(params).toMatchObject({ email: "ada@example.com", metadata: { uid: "ada" } });
					return { id: "cus_live" };
				},
			},
			checkout: {
				sessions: {
					async create(params: { customer?: string }) {
						sessions.push(params.customer ?? "");
						if (params.customer === "cus_test") throw missingCustomer();
						return { url: "https://checkout.stripe.test/live" };
					},
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await expect(billing.checkout("ada", "ada@example.com", "included", "https://groundwork.test")).resolves.toBe(
			"https://checkout.stripe.test/live",
		);
		expect(sessions).toEqual(["cus_test", "cus_live"]);
		expect(created).toBe(1);
		await expect(accounts.customerId("ada")).resolves.toBe("cus_live");
	});

	it("does not replace the customer when a different Stripe resource is missing", async () => {
		const accounts = new AccountDirectory();
		await accounts.attachCustomer("ada", "cus_test");
		let created = 0;
		const stripe = {
			customers: {
				async create() {
					created++;
					return { id: "cus_live" };
				},
			},
			checkout: {
				sessions: {
					async create() {
						throw Object.assign(new Error("No such price: 'price_byom'"), { code: "resource_missing", param: "line_items[0][price]" });
					},
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await expect(billing.checkout("ada", "ada@example.com", "byom", "https://groundwork.test")).rejects.toThrow(/No such price/);
		expect(created).toBe(0);
		await expect(accounts.customerId("ada")).resolves.toBe("cus_test");
	});

	it("stops after one replacement when the new customer is also missing", async () => {
		const accounts = new AccountDirectory();
		await accounts.attachCustomer("ada", "cus_test");
		let created = 0;
		let sessions = 0;
		const stripe = {
			customers: {
				async create() {
					created++;
					return { id: "cus_live" };
				},
			},
			checkout: {
				sessions: {
					async create() {
						sessions++;
						throw missingCustomer();
					},
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await expect(billing.checkout("ada", "ada@example.com", "byom", "https://groundwork.test")).rejects.toMatchObject({ code: "resource_missing" });
		expect(sessions).toBe(2);
		expect(created).toBe(1);
		await expect(accounts.customerId("ada")).resolves.toBe("cus_live");
	});

	it("opens the portal on a fresh customer when the stored one is missing", async () => {
		const accounts = new AccountDirectory();
		await accounts.seen("ada", { email: "ada@example.com" });
		await accounts.attachCustomer("ada", "cus_test");
		const used: string[] = [];
		const stripe = {
			customers: {
				async create() {
					return { id: "cus_live" };
				},
			},
			billingPortal: {
				sessions: {
					async create(params: { customer?: string }) {
						used.push(params.customer ?? "");
						if (params.customer === "cus_test") throw missingCustomer();
						return { url: "https://billing.stripe.test/portal" };
					},
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await expect(billing.portal("ada", "https://groundwork.test")).resolves.toBe("https://billing.stripe.test/portal");
		expect(used).toEqual(["cus_test", "cus_live"]);
		await expect(accounts.customerId("ada")).resolves.toBe("cus_live");
	});

	it("still refuses the portal when the account has never had a customer", async () => {
		const accounts = new AccountDirectory();
		let created = 0;
		const stripe = {
			customers: {
				async create() {
					created++;
					return { id: "cus_live" };
				},
			},
			billingPortal: {
				sessions: {
					async create() {
						throw new Error("should not run");
					},
				},
			},
		} as unknown as Stripe;
		const billing = createBilling(stripe, prices, "whsec_test", accounts);
		await expect(billing.portal("ada", "https://groundwork.test")).rejects.toMatchObject({
			status: 400,
			message: "No billing account yet. Choose a paid plan first.",
		});
		expect(created).toBe(0);
	});

	it("drops a sandbox paid plan when the stored customer is missing, and does not keep erroring", async () => {
		const accounts = new AccountDirectory();
		await accounts.setPlan("ada", "included");
		await accounts.attachCustomer("ada", "cus_test");
		let lists = 0;
		let searches = 0;
		const stripe = stripeFake({});
		stripe.subscriptions.list = async () => {
			lists++;
			throw missingCustomer();
		};
		const search = stripe.customers.search;
		stripe.customers.search = async (args) => {
			searches++;
			return search(args);
		};
		await syncStripeMembership(stripe, prices, accounts, "ada");
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "free", hasBilling: false });
		await expect(accounts.customerId("ada")).resolves.toBeUndefined();
		await syncStripeMembership(stripe, prices, accounts, "ada");
		expect(lists).toBe(1);
		expect(searches).toBe(1);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "free" });

		const logged: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			const again = new AccountDirectory();
			await again.setPlan("ada", "byom");
			await again.attachCustomer("ada", "cus_test");
			const billing = createBilling(
				{
					customers: {
						async search() {
							return { data: [] };
						},
					},
					subscriptions: {
						async list() {
							throw missingCustomer();
						},
					},
				} as unknown as Stripe,
				prices,
				"whsec",
				again,
			);
			await billing.sync!("ada");
			await expect(again.get("ada")).resolves.toMatchObject({ plan: "free", hasBilling: false });
			expect(logged).toEqual([]);
		} finally {
			console.error = original;
		}
	});
});

describe("paid membership snapshots", () => {
	it("prices a subscription after a percent or amount discount and refuses an unexpanded discount id", () => {
		const included = { status: "active", items: { data: [{ price: { id: "price_included", unit_amount: 2000, currency: "usd" }, quantity: 1 }] } };
		expect(recurringAmountUsd(included)).toBe(20);
		expect(recurringAmountUsd({ ...included, discounts: [{ coupon: { percent_off: 100, name: "GROUNDWORKTESTER" }, promotion_code: { code: "GROUNDWORKTESTER" } }] })).toBe(0);
		expect(recurringAmountUsd({ ...included, items: { data: [{ price: { id: "price_byom", unit_amount: 600, currency: "usd" } }] }, discount: { coupon: { amount_off: 100 } } })).toBe(5);
		expect(recurringAmountUsd({ ...included, discounts: ["di_unexpanded"] })).toBeNull();
		expect(membershipFromSubscription({
			status: "active",
			items: { data: [{ price: { id: "price_included", unit_amount: 2000, currency: "usd" } }] },
			discounts: [{ coupon: { percent_off: 100 }, promotion_code: { code: "GROUNDWORKTESTER" } }],
		}, prices)).toEqual({ status: "active", plan: "included", amountUsd: 0, couponCode: "GROUNDWORKTESTER" });
		expect(membershipFromSubscription({
			status: "active",
			items: { data: [{ price: { id: "price_included", unit_amount: 2000, currency: "usd" } }] },
			discounts: [{ promotion_code: { code: "GROUNDWORKTESTER" }, source: { coupon: "coupon_id", type: "coupon" } }],
		}, prices)).toEqual({ status: "active", plan: "included", amountUsd: 0, couponCode: "GROUNDWORKTESTER" });
		expect(membershipFromSubscription({ ...included, status: "past_due" }, prices)).toBeNull();
		expect(membershipFromSubscription({ ...included, status: "trialing", items: { data: [{ price: { id: "price_byom", unit_amount: 600, currency: "usd" } }] } }, prices)).toMatchObject({ status: "trialing", plan: "byom", amountUsd: 6 });
	});

	it("stores active and trialing memberships and clears one Stripe no longer lists", async () => {
		const accounts = new AccountDirectory();
		await accounts.seen("ada", { email: "ada@example.com" });
		await accounts.seen("bea", { email: "bea@example.com" });
		await accounts.seen("cio", { email: "cio@example.com" });
		await accounts.attachCustomer("bea", "cus_bea");
		await accounts.rememberMembership("cio", { status: "active", plan: "included", amountUsd: 20 });
		const expands: string[][] = [];
		const stripe: PaidMembershipClient = {
			subscriptions: {
				async list(args) {
					expands.push(args.expand ?? []);
					const data = args.status === "active"
						? [{
							id: "sub_ada",
							status: "active",
							metadata: { uid: "ada" },
							items: { data: [{ price: { id: "price_included", unit_amount: 2000, currency: "usd" } }] },
							discounts: [{ coupon: { percent_off: 100, name: "GROUNDWORKTESTER" }, promotion_code: { code: "GROUNDWORKTESTER" } }],
						}]
						: [{
							id: "sub_bea",
							status: "trialing",
							customer: "cus_bea",
							metadata: {},
							items: { data: [{ quantity: 1, price: { id: "price_byom", unit_amount: 600, currency: "usd" } }] },
						}];
					return { data, has_more: false };
				},
			},
		};
		await refreshPaidMemberships(stripe, prices, accounts);
		const listed = await accounts.list();
		expect(listed.find((row) => row.record.uid === "ada")?.record.membership).toEqual({ status: "active", plan: "included", amountUsd: 0, couponCode: "GROUNDWORKTESTER" });
		expect(listed.find((row) => row.record.uid === "ada")?.record.couponCode).toBe("GROUNDWORKTESTER");
		expect(listed.find((row) => row.record.uid === "bea")?.record.membership).toEqual({ status: "trialing", plan: "byom", amountUsd: 6 });
		expect(listed.find((row) => row.record.uid === "cio")?.record.membership).toBeUndefined();
		expect(expands[0]).toContain("data.discounts.promotion_code");
		expect(expands[0]).toContain("data.discounts.source.coupon");
	});
});
