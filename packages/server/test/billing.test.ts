import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { AccountDirectory } from "../src/accounts";
import { applyStripeEvent } from "../src/billing";

function event(type: Stripe.Event["type"], object: object): Stripe.Event {
	return { type, data: { object } } as Stripe.Event;
}

describe("stripe plan updates", () => {
	it("starts the paid plan when checkout completes", async () => {
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

	it("keeps a paid plan while the subscription is active", async () => {
		const accounts = new AccountDirectory();
		await accounts.attachCustomer("ada", "cus_9");
		await applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_9",
				metadata: { plan: "byom" },
				status: "active",
			}),
		);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "byom" });
	});

	it("does not demote an active subscription when Stripe omits plan metadata", async () => {
		const accounts = new AccountDirectory();
		await accounts.setPlan("ada", "included");
		await accounts.attachCustomer("ada", "cus_123");
		await applyStripeEvent(
			accounts,
			event("customer.subscription.updated", {
				customer: "cus_123",
				metadata: {},
				status: "active",
			}),
		);
		await expect(accounts.get("ada")).resolves.toMatchObject({ plan: "included" });
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
