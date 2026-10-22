import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_SETUP, PLANS, USER_KEY_PROVIDERS } from "@groundwork/core";
import { describe, expect, it } from "vitest";
import { llmsTxt, publicPagePaths, renderSite, sitemapXml } from "../src/site-pages";

function visibleFaqs(html: string): Array<{ q: string; a: string }> {
	const start = html.indexOf("<h2>Questions</h2>");
	expect(start).toBeGreaterThan(-1);
	const section = html.slice(start, html.indexOf("</section>", start));
	return [...section.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((match) => ({
		q: (match[1] ?? "").trim(),
		a: (match[2] ?? "").trim(),
	}));
}

describe("BYOM landing page", () => {
	it("offers the Claude subscription at the plan price and the same sign-up handoff as pricing", () => {
		const html = String(renderSite("/byom")?.body);
		const price = PLANS.byom.priceUsdPerMonth;
		expect(PLANS.byom.hostedCreditUsd).toBe(0);
		expect(PLANS.byom.ownModel).toBe(true);
		expect(html).toContain("<h1>Use the Claude subscription you already have</h1>");
		expect(html).toContain(`<p class="mkt-sub">Groundwork for $${price}/mo</p>`);
		expect(html).toContain('href="/?plan=byom#signin"');
		expect(html).toContain(">Sign up");
		expect(html).toContain('class="nav-session" data-sign-in href="/?plan=byom#signin"');
		expect(html).toContain('src="/tracking.js?v=9"');
		expect(html).toContain('href="/styles.css?v=23"');
		expect(html).toContain('class="mkt-main byom"');
		expect(publicPagePaths()).toContain("/byom");
		expect(sitemapXml()).toContain("https://groundworklearn.com/byom");
		expect(llmsTxt()).toContain("https://groundworklearn.com/byom");

		const pricing = String(renderSite("/pricing")?.body);
		const cardStart = pricing.indexOf("<h2>Bring your own model</h2>");
		const card = pricing.slice(cardStart, pricing.indexOf("</li>", cardStart));
		expect(card).toContain('href="/byom"');
		expect(card).toContain("Use the Claude subscription you already have");
		expect(card).toContain('href="/?plan=byom#signin"');

		const firebase = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../firebase.json"), "utf8")) as {
			hosting: { rewrites: Array<{ source: string }> };
		};
		expect(firebase.hosting.rewrites.some((rule) => rule.source === "/byom")).toBe(true);
	});

	it("shows the Claude Code setup, the key path, and the limits", () => {
		const html = String(renderSite("/byom")?.body);
		const [install, signIn, check] = CLAUDE_SETUP;
		expect(CLAUDE_SETUP).toHaveLength(3);
		const commands = /^In a terminal, run (.+)\. On Windows PowerShell: (.+)$/.exec(install?.detail ?? "");
		expect(commands?.[1]).toBeTruthy();
		expect(commands?.[2]).toBeTruthy();
		expect(html).toContain(install?.title);
		expect(html).toContain("Mac and Linux");
		expect(html).toContain("Windows PowerShell");
		expect(html).toContain(`<code>${commands?.[1]}</code>`);
		expect(html).toContain(`<code>${commands?.[2]}</code>`);
		expect(html).toContain(signIn?.title);
		expect(html).toContain('<code translate="no">claude</code>');
		expect(html).toContain('<code translate="no">/login</code>');
		expect(html).toContain(check?.title);
		expect(html).toContain(check?.detail);
		expect(html).toContain("Requires Obsidian desktop");
		expect(html).toContain("Or paste an API key");
		expect(html).toContain("Paste a key from Anthropic, OpenRouter, OpenAI, Google, or xAI. That provider bills you per token.");
		for (const id of USER_KEY_PROVIDERS) expect(html.toLowerCase()).toContain(id === "xai" ? "xai" : id);

		const parsed = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1] ?? "") as { "@graph"?: Array<Record<string, unknown>> });
		const faq = parsed[0]?.["@graph"]?.find((node) => node["@type"] === "FAQPage");
		const entities = faq?.mainEntity as Array<{ name: string; acceptedAnswer: { text: string } }>;
		const visible = visibleFaqs(html);
		expect(entities).toHaveLength(visible.length);
		entities.forEach((entity, index) => {
			expect(entity.name).toBe(visible[index]?.q);
			expect(entity.acceptedAnswer.text).toBe(visible[index]?.a);
		});
		const answers = visible.map((item) => item.a).join(" ");
		expect(answers).toContain("count against that plan’s limits");
		expect(answers).toContain("Groundwork never sees or stores that login");
		expect(answers).toContain("Anthropic’s own login, on your computer");
		expect(answers).toContain("not affiliated with or endorsed by Anthropic");
		expect(answers).toContain("includes no hosted credit");
		expect(answers).toContain("18 and older");
		expect(html).not.toMatch(/unlimited/i);
		expect(html).not.toMatch(/testimonial|trusted by/i);
		expect(html).not.toMatch(/\b\d[\d,]*\+?\s+(users|students|learners|customers)\b/i);
		expect(html).not.toMatch(/<img/i);
		expect(html).not.toMatch(/hostedCreditUsd|\$1\.25|\$12/);
	});
});
