import { describe, expect, it, afterEach } from "vitest";
import { webConfig } from "../src/web-config";

describe("webConfig", () => {
	const savedKService = process.env.K_SERVICE;

	afterEach(() => {
		if (savedKService === undefined) delete process.env.K_SERVICE;
		else process.env.K_SERVICE = savedKService;
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

	it("ignores client query params (localDev is server-only)", () => {
		delete process.env.K_SERVICE;
		expect(webConfig(false, false).localDev).toBe(true);
		expect(webConfig(false, true).localDev).toBe(false);
	});
});
