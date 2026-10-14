import { describe, expect, it, afterEach } from "vitest";
import { webConfig } from "../src/web-config";

describe("webConfig", () => {
	const savedKService = process.env.K_SERVICE;
	const savedGa4 = process.env.GA4_MEASUREMENT_ID;
	const savedAds = process.env.GOOGLE_ADS_ID;
	const savedSecret = process.env.GA4_API_SECRET;

	afterEach(() => {
		if (savedKService === undefined) delete process.env.K_SERVICE;
		else process.env.K_SERVICE = savedKService;
		if (savedGa4 === undefined) delete process.env.GA4_MEASUREMENT_ID;
		else process.env.GA4_MEASUREMENT_ID = savedGa4;
		if (savedAds === undefined) delete process.env.GOOGLE_ADS_ID;
		else process.env.GOOGLE_ADS_ID = savedAds;
		if (savedSecret === undefined) delete process.env.GA4_API_SECRET;
		else process.env.GA4_API_SECRET = savedSecret;
	});

	it("enables localDev only without Firebase admin and without K_SERVICE", () => {
		delete process.env.K_SERVICE;
		expect(webConfig(false, false).localDev).toBe(true);
	});

	it("disables localDev when Firebase admin is configured", () => {
		delete process.env.K_SERVICE;
		expect(webConfig(false, true).localDev).toBe(false);
	});

	it("disables localDev on Cloud Run even without Firebase admin in tests", () => {
		process.env.K_SERVICE = "groundwork";
		expect(webConfig(false, false).localDev).toBe(false);
	});

	it("uses the production GA4 and Ads ids on Cloud Run", () => {
		delete process.env.GA4_MEASUREMENT_ID;
		delete process.env.GOOGLE_ADS_ID;
		delete process.env.GA4_API_SECRET;
		process.env.K_SERVICE = "groundwork";
		expect(webConfig(false, true)).toMatchObject({
			ga4MeasurementId: "G-F1270VCGEL",
			googleAdsId: "AW-18498207004",
			ga4ServerPurchase: false,
			localDev: false,
		});
		delete process.env.K_SERVICE;
		expect(webConfig(false, false).ga4MeasurementId).toBeNull();
		expect(webConfig(false, false).googleAdsId).toBeNull();
		expect(webConfig(false, false).ga4ServerPurchase).toBe(false);
	});

	it("reports a server purchase only when the Measurement Protocol secret is set", () => {
		process.env.K_SERVICE = "groundwork";
		delete process.env.GA4_MEASUREMENT_ID;
		process.env.GA4_API_SECRET = "test-mp-secret";
		expect(webConfig(false, true).ga4ServerPurchase).toBe(true);
		process.env.GA4_API_SECRET = "   ";
		expect(webConfig(false, true).ga4ServerPurchase).toBe(false);
	});

	it("ignores client query params (localDev is server-only)", () => {
		delete process.env.K_SERVICE;
		expect(webConfig(false, false).localDev).toBe(true);
		expect(webConfig(false, true).localDev).toBe(false);
	});
});
