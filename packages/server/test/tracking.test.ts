import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkoutSuccessUrl } from "../src/billing";
import { renderSite, robotsTxt, sitemapXml } from "../src/site-pages";
import { readSite } from "../src/static";
import {
	attributionFromHeader,
	attributionFromSearch,
	cleanTransactionId,
	consentDefaults,
	CONTACT_EMAIL_DEFAULT,
	measurementIds,
	mergeAttribution,
	purchaseValue,
	resolveContactEmail,
	shouldFireObsidianConnected,
	shouldFireSignUp,
	shouldRecordPurchase,
	tagScriptUrl,
} from "../src/tracking";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("ads tracking", () => {
	it("defaults consent to denied, with the US granted until a choice is stored", () => {
		const defaults = consentDefaults(null);
		expect(defaults[0]).toMatchObject({ ad_storage: "denied", analytics_storage: "denied" });
		expect(defaults[0]).not.toHaveProperty("region");
		expect(defaults[1]).toMatchObject({ ad_storage: "granted", analytics_storage: "granted", region: ["US"] });
		expect(consentDefaults("granted")).toEqual([
			{ ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted", analytics_storage: "granted" },
		]);
		expect(consentDefaults("denied")[0].ad_storage).toBe("denied");
	});

	it("keeps the first touch and reads the attribution header", () => {
		const first = attributionFromSearch("?utm_source=ads&utm_medium=cpc&gclid=abc123&utm_campaign=exam");
		expect(mergeAttribution(null, first)).toEqual(first);
		expect(mergeAttribution(first, attributionFromSearch("?utm_source=later"))).toEqual(first);
		const header = encodeURIComponent(JSON.stringify(first));
		expect(attributionFromHeader(header)).toEqual({
			utmSource: "ads",
			utmMedium: "cpc",
			utmCampaign: "exam",
			gclid: "abc123",
		});
		expect(attributionFromHeader("not-json")).toBeNull();
	});

	it("prices a purchase once per session id", () => {
		expect(purchaseValue("byom")).toBe(9);
		expect(purchaseValue("included")).toBe(20);
		expect(purchaseValue("free")).toBeNull();
		expect(cleanTransactionId("cs_test_1")).toBe("cs_test_1");
		expect(cleanTransactionId("{CHECKOUT_SESSION_ID}")).toBeNull();
		expect(cleanTransactionId("cs test")).toBeNull();
		expect(shouldRecordPurchase("cs_test_1", [])).toBe(true);
		expect(shouldRecordPurchase("cs_test_1", ["cs_test_1"])).toBe(false);
		expect(checkoutSuccessUrl("https://groundworklearn.com", "byom")).toBe(
			"https://groundworklearn.com/?billing=success&session_id={CHECKOUT_SESSION_ID}&plan=byom",
		);
	});

	it("fires sign-up and the Obsidian link only on the first time", () => {
		expect(shouldFireSignUp(true, false)).toBe(true);
		expect(shouldFireSignUp(true, true)).toBe(false);
		expect(shouldFireSignUp(false, false)).toBe(false);
		expect(shouldFireObsidianConnected(true)).toBe(true);
		expect(shouldFireObsidianConnected(false)).toBe(false);
	});

	it("defaults the contact email and ignores measurement ids that do not match", () => {
		expect(CONTACT_EMAIL_DEFAULT).toBe("methoddev1505@gmail.com");
		expect(resolveContactEmail(undefined)).toBe("methoddev1505@gmail.com");
		expect(resolveContactEmail("  ")).toBe("methoddev1505@gmail.com");
		expect(resolveContactEmail("hello@example.com")).toBe("hello@example.com");
		expect(measurementIds("G-ABC123", "AW-9")).toEqual({ ga4: "G-ABC123", ads: "AW-9" });
		expect(measurementIds("nope", "AW-")).toEqual({ ga4: null, ads: null });
		expect(tagScriptUrl({ ga4: null, ads: null })).toBeNull();
		expect(tagScriptUrl({ ga4: "G-ABC123", ads: null })).toContain("G-ABC123");
	});

	it("publishes real pages with the contact email and no draft markers", () => {
		const paths = ["/", "/pricing", "/exam-prep", "/concept-map", "/quizzes-flashcards", "/goals", "/get-started", "/privacy", "/terms", "/404.html"];
		for (const href of paths) {
			const body = readSite(href)?.body ?? "";
			expect(body.length).toBeGreaterThan(200);
			expect(body).toContain("methoddev1505@gmail.com");
			expect(body).toContain('href="/privacy"');
			expect(body).toContain('href="/terms"');
			expect(body).not.toContain("[Dev:");
			expect(body.toLowerCase()).not.toContain("coming soon");
			expect(body).not.toContain("public profile");
		}
		expect(readSite("/quizzes-flashcards")?.body).toContain("Quiz yourself on your own notes and lecture slides");
		expect(readSite("/privacy")?.body).toContain("delete");
		expect(sitemapXml()).toContain("https://groundworklearn.com/pricing");
		expect(sitemapXml()).not.toContain("graph-harness");
		expect(robotsTxt()).toContain("Disallow: /v1/");
		expect(renderSite("/nope")).toBeNull();
		const home = readFileSync(path.join(root, "packages/server/public/index.html"), "utf8");
		expect(home).toContain("not started");
		expect(home).not.toContain("not built");
	});
});
