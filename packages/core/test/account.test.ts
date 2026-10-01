import { describe, expect, it } from "vitest";
import { isUserKeyProvider, PLANS, USER_KEY_PROVIDERS } from "../src/account/plans";
import { choosePlan, emptyAccount, spendHosted, viewAccount } from "../src/account/usage";

describe("plans", () => {
	it("gives the free plan $3 of hosted credit and keeps Jev off the key list", () => {
		expect(PLANS.free.hostedCreditUsd).toBe(3);
		expect(PLANS.free.priceUsdPerMonth).toBe(0);
		expect(PLANS.byom.priceUsdPerMonth).toBe(9);
		expect(PLANS.byom.hostedCreditUsd).toBe(0);
		expect(PLANS.byom.ownModel).toBe(true);
		expect(PLANS.included.priceUsdPerMonth).toBe(20);
		expect(PLANS.included.hostedCreditUsd).toBe(8);
		expect(USER_KEY_PROVIDERS).not.toContain("jev");
		expect(USER_KEY_PROVIDERS).not.toContain("typesafe");
		expect(isUserKeyProvider("openrouter")).toBe(true);
		expect(isUserKeyProvider("jev")).toBe(false);
	});
});

describe("hosted credit", () => {
	const now = new Date("2026-10-01T12:00:00Z");

	it("starts without a plan", () => {
		const view = viewAccount(emptyAccount("u", now), now);
		expect(view.needsPlan).toBe(true);
		expect(view.remainingUsd).toBe(0);
	});

	it("draws the free $3 and stops at the cap", () => {
		const chosen = choosePlan(emptyAccount("u", now), "free", now);
		const first = spendHosted(chosen, 1.25, now);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(viewAccount(first.account, now).remainingUsd).toBe(1.75);
		const over = spendHosted(first.account, 2, now);
		expect(over.ok).toBe(false);
		if (over.ok) return;
		expect(over.reason).toMatch(/used up/);
	});

	it("does not charge a bring-your-own-model account for hosted models", () => {
		const chosen = choosePlan(emptyAccount("u", now), "byom", now);
		const spent = spendHosted(chosen, 0.1, now);
		expect(spent.ok).toBe(false);
	});

	it("resets spend when the month changes", () => {
		const chosen = choosePlan(emptyAccount("u", now), "included", now);
		const spent = spendHosted(chosen, 8, now);
		expect(spent.ok).toBe(true);
		if (!spent.ok) return;
		const nextMonth = viewAccount(spent.account, new Date("2026-11-02T00:00:00Z"));
		expect(nextMonth.spentUsd).toBe(0);
		expect(nextMonth.remainingUsd).toBe(8);
	});
});
