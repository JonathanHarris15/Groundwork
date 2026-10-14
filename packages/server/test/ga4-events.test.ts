import { describe, expect, it } from "vitest";
import { configureMeasurementTags, emitObsidianConnected, emitSignUp, type Ga4EventClient } from "../src/ga4-events";
import { PRODUCTION_GA4_MEASUREMENT_ID, PRODUCTION_GOOGLE_ADS_ID, SIGN_UP_ADS_CONVERSION_SEND_TO, type Attribution } from "../src/tracking";

function mockClient(attribution: Attribution = { utm_source: "ads", gclid: "Cjwtest" }, sendTo: string | null = null) {
	const calls: unknown[][] = [];
	const gtag = (...args: unknown[]) => {
		calls.push(args);
	};
	let signedUp = false;
	const client: Ga4EventClient = {
		gtag,
		attribution: () => attribution,
		signUpAlreadyFired: () => signedUp,
		markSignUpFired: () => {
			signedUp = true;
		},
		signUpConversionSendTo: () => sendTo,
	};
	return { calls, client, gtag };
}

describe("GA4 events", () => {
	it("fires sign_up and obsidian_connected with the gtag mock, and does not emit purchase", () => {
		const { calls, client, gtag } = mockClient();
		configureMeasurementTags(gtag, { ga4: PRODUCTION_GA4_MEASUREMENT_ID, ads: null }, { campaign_source: "ads", gclid: "Cjwtest" });
		expect(emitSignUp(client, true, "Google")).toBe(true);
		expect(emitSignUp(client, true, "local")).toBe(false);
		expect(emitSignUp(client, false, "Google")).toBe(false);
		expect(emitObsidianConnected(client, true)).toBe(true);
		expect(emitObsidianConnected(client, false)).toBe(false);

		expect(calls.map((entry) => entry[1])).toEqual([PRODUCTION_GA4_MEASUREMENT_ID, "sign_up", "obsidian_connected"]);
		expect(calls[1]?.[2]).toEqual({ utm_source: "ads", gclid: "Cjwtest", method: "Google" });
		expect(calls[2]?.[2]).toEqual({ utm_source: "ads", gclid: "Cjwtest" });
		expect(JSON.stringify(calls)).not.toContain("purchase");
		expect(JSON.stringify(calls)).not.toContain("conversion");
		expect(JSON.stringify(calls)).not.toContain("send_page_view");
	});

	it("fires the Ads conversion once with sign_up, and not on a later sign-in", () => {
		const { calls, client } = mockClient({ utm_source: "ads", gclid: "Cjwtest" }, SIGN_UP_ADS_CONVERSION_SEND_TO);
		expect(SIGN_UP_ADS_CONVERSION_SEND_TO).toBe("AW-18498207004/O9fRCK3JzJsdEJz60PRE");
		expect(emitSignUp(client, true, "Google")).toBe(true);
		expect(emitSignUp(client, true, "Google")).toBe(false);
		expect(emitSignUp(client, false, "Google")).toBe(false);
		expect(calls.map((entry) => entry[1])).toEqual(["sign_up", "conversion"]);
		expect(calls[1]?.[2]).toEqual({
			utm_source: "ads",
			gclid: "Cjwtest",
			send_to: "AW-18498207004/O9fRCK3JzJsdEJz60PRE",
		});
	});

	it("configures both tags and leaves page_view on", () => {
		const calls: unknown[][] = [];
		const gtag = (...args: unknown[]) => {
			calls.push(args);
		};
		configureMeasurementTags(gtag, { ga4: PRODUCTION_GA4_MEASUREMENT_ID, ads: PRODUCTION_GOOGLE_ADS_ID }, { gclid: "Cjwtest" });
		configureMeasurementTags(gtag, { ga4: null, ads: null }, {});
		expect(calls).toEqual([
			["config", "G-F1270VCGEL", { gclid: "Cjwtest" }],
			["config", "AW-18498207004", { gclid: "Cjwtest" }],
		]);
		expect(JSON.stringify(calls)).not.toContain("send_page_view");
		expect(JSON.stringify(calls)).not.toContain("conversion");
	});
});
