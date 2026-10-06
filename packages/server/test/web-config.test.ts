import { describe, expect, it, afterEach } from "vitest";
import { webConfig } from "../src/web-config";

describe("webConfig", () => {
	const savedKService = process.env.K_SERVICE;
	const savedGa4 = process.env.GA4_MEASUREMENT_ID;
	const savedAds = process.env.GOOGLE_ADS_ID;

	afterEach(() => {
		if (savedKService === undefined) delete process.env.K_SERVICE;
		else process.env.K_SERVICE = savedKService;
		if (savedGa4 === undefined) delete process.env.GA4_MEASUREMENT_ID;
		else process.env.GA4_MEASUREMENT_ID = savedGa4;
		if (savedAds === undefined) delete process.env.GOOGLE_ADS_ID;
		else process.env.GOOGLE_ADS_ID = savedAds;
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

	it("uses the production GA4 id on Cloud Run and leaves Ads off until configured", () => {
		delete process.env.GA4_MEASUREMENT_ID;
		delete process.env.GOOGLE_ADS_ID;
		process.env.K_SERVICE = "groundwork";
		expect(webConfig(false, true)).toMatchObject({ ga4MeasurementId: "G-F4236HGZSM", googleAdsId: null, localDev: false });
		delete process.env.K_SERVICE;
		expect(webConfig(false, false).ga4MeasurementId).toBeNull();
	});

	it("ignores client query params (localDev is server-only)", () => {
		delete process.env.K_SERVICE;
		expect(webConfig(false, false).localDev).toBe(true);
		expect(webConfig(false, true).localDev).toBe(false);
	});
});
