import { describe, expect, it } from "vitest";
import { configureMeasurementTags, emitObsidianConnected, emitSignUp, type Ga4EventClient } from "../src/ga4-events";
import type { Attribution } from "../src/tracking";

function mockClient(attribution: Attribution = { utm_source: "ads", gclid: "Cjwtest" }) {
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
	};
	return { calls, client, gtag };
}

describe("GA4 events", () => {
	it("fires sign_up and obsidian_connected with the gtag mock, and does not emit purchase", () => {
		const { calls, client, gtag } = mockClient();
		configureMeasurementTags(gtag, { ga4: "G-F4236HGZSM", ads: null }, { campaign_source: "ads", gclid: "Cjwtest" });
		expect(emitSignUp(client, true, "Google")).toBe(true);
		expect(emitSignUp(client, true, "local")).toBe(false);
		expect(emitSignUp(client, false, "Google")).toBe(false);
		expect(emitObsidianConnected(client, true)).toBe(true);
		expect(emitObsidianConnected(client, false)).toBe(false);

		expect(calls.map((entry) => entry[1])).toEqual(["G-F4236HGZSM", "sign_up", "obsidian_connected"]);
		expect(calls[1]?.[2]).toEqual({ utm_source: "ads", gclid: "Cjwtest", method: "Google" });
		expect(calls[2]?.[2]).toEqual({ utm_source: "ads", gclid: "Cjwtest" });
		expect(JSON.stringify(calls)).not.toContain("purchase");
		expect(JSON.stringify(calls)).not.toContain("conversion");
		expect(JSON.stringify(calls)).not.toContain("AW-");
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
