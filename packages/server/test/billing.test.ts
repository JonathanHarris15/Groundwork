import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { AccountDirectory } from "../src/accounts";
import { applyStripeEvent } from "../src/billing";

function event(type: Stripe.Event["type"], object: object): Stripe.Event {
	return { type, data: { object } } as Stripe.Event;
}

describe("stripe plan updates", () => {
	it("starts the paid plan when checkout completes", () => {
		const accounts = new AccountDirectory();
		accounts.seen("ada", { email: "ada@example.com", name: "Ada" });
		applyStripeEvent(
			accounts,
			event("checkout.session.completed", {
				metadata: { uid: "ada", plan: "included" },
				client_reference_id: "ada",
				customer: "cus_123",
			}),
		);
		expect(accounts.get("ada")).toMatchObject({ plan: "included", hasBilling: true, email: "ada@example.com", displayName: "Ada" });
		expect(accounts.customerId("ada")).toBe("cus_123");
	});

	it("keeps a paid plan while the subscription is active", () => {
		const accounts = new AccountDirectory();
		accounts.attachCustomer("ada", "cus_9");
		applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_9",
				metadata: { plan: "byom" },
				status: "active",
			}),
		);
		expect(accounts.get("ada").plan).toBe("byom");
	});

	it("follows a portal switch onto the subscription price", () => {
		const accounts = new AccountDirectory();
		accounts.attachCustomer("ada", "cus_9");
		accounts.setPlan("ada", "included");
		applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_9",
				metadata: { plan: "included" },
				status: "active",
				items: { data: [{ price: { id: "price_byom" } }] },
			}),
			{ byom: "price_byom", included: "price_included" },
		);
		expect(accounts.get("ada").plan).toBe("byom");
	});

	it("follows a portal switch back onto Groundwork", () => {
		const accounts = new AccountDirectory();
		accounts.attachCustomer("ada", "cus_9");
		accounts.setPlan("ada", "byom");
		applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_9",
				metadata: { plan: "byom" },
				status: "active",
				items: { data: [{ price: "price_included" }] },
			}),
			{ byom: "price_byom", included: "price_included" },
		);
		expect(accounts.get("ada").plan).toBe("included");
	});

	it("returns the account to free when the subscription ends", () => {
		const accounts = new AccountDirectory();
		accounts.setPlan("ada", "included");
		accounts.attachCustomer("ada", "cus_123");
		applyStripeEvent(
			accounts,
			event("customer.subscription.deleted", {
				customer: "cus_123",
				metadata: { uid: "ada", plan: "included" },
				status: "canceled",
			}),
		);
		expect(accounts.get("ada")).toMatchObject({ plan: "free", hasBilling: true });
	});

	it("drops a switched subscription to free once it is no longer active", () => {
		const accounts = new AccountDirectory();
		accounts.attachCustomer("ada", "cus_9");
		accounts.setPlan("ada", "byom");
		applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_9",
				metadata: { plan: "included" },
				status: "canceled",
				items: { data: [{ price: { id: "price_byom" } }] },
			}),
			{ byom: "price_byom", included: "price_included" },
		);
		expect(accounts.get("ada").plan).toBe("free");
	});
});
