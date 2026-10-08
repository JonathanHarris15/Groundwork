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
	cleanGaClientId,
	cleanGaSessionId,
	cleanGclid,
	cleanTransactionId,
	consentDefaults,
	CONTACT_EMAIL_DEFAULT,
	gaClientIdFromCookie,
	gaSessionIdFromCookie,
	measurementIds,
	mergeAttribution,
	PRODUCTION_GA4_MEASUREMENT_ID,
	purchaseValue,
	resolveContactEmail,
	resolveMeasurementIds,
	shouldFireObsidianConnected,
	shouldFireSignUp,
	shouldLoadMeasurementTag,
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
		expect(purchaseValue("byom")).toBe(6);
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
		expect(PRODUCTION_GA4_MEASUREMENT_ID).toBe("G-F4236HGZSM");
		expect(resolveMeasurementIds({ ga4: undefined, ads: undefined, production: true })).toEqual({
			ga4: "G-F4236HGZSM",
			ads: null,
		});
		expect(resolveMeasurementIds({ ga4: "", ads: "", production: true })).toEqual({ ga4: "G-F4236HGZSM", ads: null });
		expect(resolveMeasurementIds({ ga4: undefined, ads: "AW-123", production: false })).toEqual({ ga4: null, ads: "AW-123" });
		expect(resolveMeasurementIds({ ga4: "G-OTHER1", ads: undefined, production: true })).toEqual({ ga4: "G-OTHER1", ads: null });
		expect(resolveMeasurementIds({ ga4: "nope", ads: undefined, production: true })).toEqual({ ga4: null, ads: null });
	});

	it("loads the measurement tag only for a real visitor on the live host", () => {
		expect(shouldLoadMeasurementTag({ hostname: "groundworklearn.com", webdriver: false, userAgent: "Mozilla/5.0" })).toBe(true);
		expect(shouldLoadMeasurementTag({ hostname: "www.groundworklearn.com", webdriver: false, userAgent: "Mozilla/5.0" })).toBe(true);
		expect(shouldLoadMeasurementTag({ hostname: "GroundworkLearn.com.", webdriver: false, userAgent: "Mozilla/5.0" })).toBe(true);
		expect(shouldLoadMeasurementTag({ hostname: "127.0.0.1", webdriver: false, userAgent: "Mozilla/5.0" })).toBe(false);
		expect(shouldLoadMeasurementTag({ hostname: "localhost", webdriver: false, userAgent: "Mozilla/5.0" })).toBe(false);
		expect(shouldLoadMeasurementTag({ hostname: "evilgroundworklearn.com", webdriver: false, userAgent: "Mozilla/5.0" })).toBe(false);
		expect(shouldLoadMeasurementTag({ hostname: "groundworklearn.com", webdriver: true, userAgent: "Mozilla/5.0" })).toBe(false);
		expect(shouldLoadMeasurementTag({ hostname: "groundworklearn.com", webdriver: false, userAgent: "Mozilla HeadlessChrome/120" })).toBe(false);
		expect(cleanGaClientId("123.456")).toBe("123.456");
		expect(cleanGaClientId("not-an-id")).toBeNull();
		expect(cleanGaSessionId("1700000001")).toBe("1700000001");
		expect(cleanGaSessionId("12ab")).toBeNull();
		expect(cleanGclid("CjwKCtestclick")).toBe("CjwKCtestclick");
		expect(cleanGclid("short")).toBeNull();
		expect(gaClientIdFromCookie("theme=dark; _ga=GA1.1.12345.67890; other=1")).toBe("12345.67890");
		expect(gaClientIdFromCookie("_ga=nope")).toBeNull();
		expect(gaSessionIdFromCookie("_ga_F4236HGZSM=GS1.1.1700000001.1.1.1700000001.0.0.0")).toBe("1700000001");
		expect(gaSessionIdFromCookie("_ga_F4236HGZSM=GS2.1.s1700000002$o1$g0$t1700000002$j0$l0$h0")).toBe("1700000002");
		expect(gaSessionIdFromCookie("a=b")).toBeNull();
	});

	it("publishes real pages with the contact email and no draft markers", () => {
		const paths = ["/", "/pricing", "/practice-tests", "/exam-prep", "/concept-map", "/quizzes-flashcards", "/goals", "/get-started", "/privacy", "/terms", "/404.html"];
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
		expect(readSite("/quizzes-flashcards")?.body).toContain("Quiz yourself in Obsidian on your own notes and lecture slides");
		expect(readSite("/quizzes-flashcards")?.body).toContain("You can export a deck to your vault as plain Markdown.");
		expect(readSite("/quizzes-flashcards")?.body).toContain('height="1756"');
		expect(readSite("/quizzes-flashcards")?.body).toContain("Quiz cards can come straight from the notes and lecture slides already in your vault.");
		expect(readSite("/exam-prep")?.body).toContain("for a midterm or final");
		expect(readSite("/exam-prep")?.body).toContain("plans in Obsidian");
		const practice = String(readSite("/practice-tests")?.body ?? "");
		expect(practice).toContain("Practice tests for college exams, in Obsidian | Groundwork");
		expect(practice).toContain("Practice questions and practice tests for calculus, statistics, and chemistry exams. See which concept broke, with explanations after each question.");
		expect(practice).toContain("<h1>Practice tests that show what broke.</h1>");
		expect(practice).toContain("Name a topic, or add your slides, notes, or a practice exam.");
		expect(practice).toContain('href="/#signin"');
		expect(practice).toContain("Requires Obsidian desktop. Sign up here, install on your computer.");
		expect(practice).toContain('src="/tracking.js?v=6"');
		expect(practice).toContain('href="/practice-tests">Practice tests</a>');
		expect(practice).not.toMatch(/\b\d+\s+questions?\b/i);
		expect(practice.toLowerCase()).not.toContain("personalized feedback on every answer");
		expect(practice).not.toMatch(/re-?teach/i);
		const withoutDenial = practice.replace(/Are these real exam questions\?/g, "");
		expect(withoutDenial).not.toMatch(/real exam questions|official exam questions|official questions/i);
		expect(practice).not.toMatch(/\b(guarantee|guaranteed)\b/i);
		expect(practice).not.toMatch(/score increase|improve your grade|improve your score|raise your grade|raise your score/i);
		expect(practice).not.toMatch(/spaced repetition|\bscheduling\b/i);
		expect(practice.match(/<h1>([^<]*)<\/h1>/)?.[1] ?? "").not.toMatch(/\bAI\b/i);
		expect(practice).not.toMatch(/\b(AP|SAT|ACT|ACS|Chegg|Quizlet|Course Hero)\b/i);
		expect(practice).not.toMatch(/Obsidian (approves|endorses|endorsed|approved)/i);
		expect(practice).toContain("18 and older");
		expect(String(readSite("/terms")?.body)).toContain("You must be 18 or older to use Groundwork");
		expect(String(readSite("/privacy")?.body)).toContain("anyone under 18, including children under 13");
		expect(String(readSite("/privacy")?.body)).toContain("methoddev1505@gmail.com");
		expect(sitemapXml()).toContain("https://groundworklearn.com/practice-tests");
		const home = readFileSync(path.join(root, "packages/server/public/index.html"), "utf8");
		expect(home).toContain('href="/practice-tests"');
		expect(readSite("/privacy")?.body).toContain("adssettings.google.com");
		expect(readSite("/privacy")?.body).toContain("Groundwork’s model provider on Free and the $20 plan");
		expect(readSite("/pricing")?.body).toContain("Choose $6");
		expect(readSite("/pricing")?.body).toContain("Choose $20");
		expect(readSite("/pricing")?.body).not.toContain("Billing is handled by Stripe.");
		expect(readSite("/pricing")?.body).not.toContain("$9");
		expect(readSite("/pricing")?.body).not.toContain("$15");
		expect(readSite("/pricing")?.body).not.toContain("$4");
		expect(readSite("/terms")?.body).toContain("$6 per month");
		expect(readSite("/terms")?.body).toContain("$20 per month");
		expect(String(readSite("/pricing")?.body)).not.toContain("G-F4236HGZSM");
		expect(readSite("/privacy")?.body).toContain("delete");
		expect(sitemapXml()).toContain("https://groundworklearn.com/pricing");
		expect(sitemapXml()).not.toContain("graph-harness");
		expect(robotsTxt()).toContain("Disallow: /v1/");
		expect(renderSite("/nope")).toBeNull();
		expect(home).toContain("not started");
		expect(home).not.toContain("not built");
		expect(home).toContain("Quiz yourself on your own notes and lecture slides");
		expect(home).toContain('class="story-shot"');
		expect(home).toContain("/hero/concept-map-768.webp");
		expect(home).toContain("/shots/exam-chat-768.webp");
		expect(home).toContain("/shots/quiz-768.webp");
		expect(home).toContain("/shots/flashcards-768.webp");
		expect(home).toContain("/shots/goals-768.webp");
		expect(home).toContain("Reviews count a little; quiz cards set the marks.");
		expect(home).toContain("December 8, with 15 days left");
		expect(home).toContain('content="https://groundworklearn.com/og.png"');
		expect(home).toContain("$20/month");
		expect(home).toContain("$6/month");
		expect(home).not.toContain("G-F4236HGZSM");
		expect(home).not.toContain("$15/month");
		expect(home).not.toContain("$4/month");
	});
});
