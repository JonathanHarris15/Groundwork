import { describe, expect, it } from "vitest";
import { configureMeasurementTags, emitObsidianConnected, emitPurchase, emitSignUp, type Ga4EventClient } from "../src/ga4-events";
import type { Attribution } from "../src/tracking";

function mockClient(attribution: Attribution = { utm_source: "ads", gclid: "Cjwtest" }) {
	const calls: unknown[][] = [];
	const gtag = (...args: unknown[]) => {
		calls.push(args);
	};
	let signedUp = false;
	const purchases: string[] = [];
	const client: Ga4EventClient = {
		gtag,
		attribution: () => attribution,
		signUpAlreadyFired: () => signedUp,
		markSignUpFired: () => {
			signedUp = true;
		},
		recordedPurchases: () => purchases,
		rememberPurchase: (id) => {
			purchases.push(id);
		},
	};
	return { calls, client, gtag };
}

describe("GA4 events", () => {
	it("fires sign_up, obsidian_connected, and purchase with the gtag mock", () => {
		const { calls, client, gtag } = mockClient();
		configureMeasurementTags(gtag, { ga4: "G-F4236HGZSM", ads: null }, { campaign_source: "ads", gclid: "Cjwtest" });
		expect(emitSignUp(client, true, "Google")).toBe(true);
		expect(emitSignUp(client, true, "local")).toBe(false);
		expect(emitSignUp(client, false, "Google")).toBe(false);
		expect(emitPurchase(client, "cs_test_1", "byom")).toBe(true);
		expect(emitPurchase(client, "cs_test_1", "byom")).toBe(false);
		expect(emitPurchase(client, "sub_123", "included")).toBe(true);
		expect(emitPurchase(client, "{CHECKOUT_SESSION_ID}", "included")).toBe(false);
		expect(emitPurchase(client, "cs_test_3", "free")).toBe(false);
		expect(emitObsidianConnected(client, true)).toBe(true);
		expect(emitObsidianConnected(client, false)).toBe(false);

		expect(calls.map((entry) => entry[1])).toEqual([
			"G-F4236HGZSM",
			"sign_up",
			"purchase",
			"purchase",
			"obsidian_connected",
		]);
		expect(calls[1]?.[2]).toEqual({ utm_source: "ads", gclid: "Cjwtest", method: "Google" });
		expect(calls[2]?.[2]).toEqual({
			utm_source: "ads",
			gclid: "Cjwtest",
			transaction_id: "cs_test_1",
			value: 4,
			currency: "USD",
		});
		expect(calls[3]?.[2]).toMatchObject({ transaction_id: "sub_123", value: 15, currency: "USD" });
		expect(calls[4]?.[2]).toEqual({ utm_source: "ads", gclid: "Cjwtest" });
		expect(JSON.stringify(calls)).not.toContain("conversion");
		expect(JSON.stringify(calls)).not.toContain("AW-");
	});

	it("sends value 0 when a promotion covers the charge, and still records the transaction", () => {
		const { calls, client } = mockClient();
		expect(emitPurchase(client, "cs_free", "included", 0)).toBe(true);
		expect(calls[0]?.[2]).toEqual({
			utm_source: "ads",
			gclid: "Cjwtest",
			transaction_id: "cs_free",
			value: 0,
			currency: "USD",
		});
		expect(emitPurchase(client, "cs_free", "included", 0)).toBe(false);
		expect(emitPurchase(client, "cs_neg", "included", -1)).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("does not fire an Ads conversion when the AW- id and labels are empty", () => {
		const calls: unknown[][] = [];
		const gtag = (...args: unknown[]) => {
			calls.push(args);
		};
		configureMeasurementTags(gtag, { ga4: "G-F4236HGZSM", ads: null }, {});
		configureMeasurementTags(gtag, { ga4: null, ads: null }, {});
		expect(calls).toEqual([["config", "G-F4236HGZSM", {}]]);
	});
});
