import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostedHeavyAllowed, paidPlan, PLANS, USER_KEY_PROVIDERS, type PlanId } from "@groundwork/core";
import { describe, expect, it } from "vitest";
import { homeJsonLdScript, llmsTxt, planComparison, renderSite, sitemapXml } from "../src/site-pages";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLAN_ORDER: PlanId[] = ["free", "byom", "included"];

function graphs(html: string): Array<{ "@context"?: string; "@graph"?: Array<Record<string, unknown>> }> {
	const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
	return scripts.map((match) => JSON.parse(match[1] ?? "") as { "@context"?: string; "@graph"?: Array<Record<string, unknown>> });
}

function visibleFaqs(html: string): Array<{ q: string; a: string }> {
	const start = html.indexOf("<h2>Questions</h2>");
	expect(start).toBeGreaterThan(-1);
	const section = html.slice(start, html.indexOf("</section>", start));
	return [...section.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((match) => ({
		q: (match[1] ?? "").trim(),
		a: (match[2] ?? "").trim(),
	}));
}

function node(graph: Array<Record<string, unknown>>, type: string): Record<string, unknown> {
	const found = graph.find((item) => item["@type"] === type);
	expect(found, type).toBeTruthy();
	return found ?? {};
}

describe("site schema", () => {
	it("publishes organization, software offers, and FAQ text that matches the page", () => {
		const home = readFileSync(path.join(root, "packages/server/public/index.html"), "utf8");
		expect(home).toContain(homeJsonLdScript());
		const homeGraph = graphs(home);
		expect(homeGraph).toHaveLength(1);
		expect(homeGraph[0]?.["@context"]).toBe("https://schema.org");
		const homeNodes = homeGraph[0]?.["@graph"] ?? [];
		expect(node(homeNodes, "Organization")).toMatchObject({
			name: "Groundwork",
			url: "https://groundworklearn.com",
			logo: "https://groundworklearn.com/og.png",
		});
		const app = node(homeNodes, "SoftwareApplication");
		expect(app.offers).toHaveLength(3);
		expect(JSON.stringify(app)).not.toMatch(/aggregateRating|reviewCount|Most popular/i);

		const pricing = String(renderSite("/pricing")?.body);
		const practice = String(renderSite("/practice-tests")?.body);
		for (const html of [pricing, practice]) {
			const parsed = graphs(html);
			expect(parsed).toHaveLength(1);
			expect(parsed[0]?.["@context"]).toBe("https://schema.org");
			const faq = node(parsed[0]?.["@graph"] ?? [], "FAQPage");
			const entities = faq.mainEntity as Array<{ "@type": string; name: string; acceptedAnswer: { "@type": string; text: string } }>;
			const visible = visibleFaqs(html);
			expect(entities).toHaveLength(visible.length);
			expect(visible.length).toBeGreaterThan(0);
			entities.forEach((entity, index) => {
				expect(entity["@type"]).toBe("Question");
				expect(entity.acceptedAnswer["@type"]).toBe("Answer");
				expect(entity.name).toBe(visible[index]?.q);
				expect(entity.acceptedAnswer.text).toBe(visible[index]?.a);
			});
		}

		const pricingApp = node(graphs(pricing)[0]?.["@graph"] ?? [], "SoftwareApplication");
		const offers = pricingApp.offers as Array<{
			name: string;
			price: string;
			priceCurrency: string;
			priceSpecification: { price: string; priceCurrency: string; billingDuration: string; unitCode: string; unitText: string };
		}>;
		expect(offers.map((offer) => offer.name)).toEqual(PLAN_ORDER.map((id) => PLANS[id].name));
		for (const [index, id] of PLAN_ORDER.entries()) {
			const offer = offers[index];
			expect(offer?.price).toBe(String(PLANS[id].priceUsdPerMonth));
			expect(offer?.priceCurrency).toBe("USD");
			expect(offer?.priceSpecification).toMatchObject({
				price: String(PLANS[id].priceUsdPerMonth),
				priceCurrency: "USD",
				billingDuration: "P1M",
				unitCode: "MON",
				unitText: "month",
			});
		}
		expect(JSON.stringify(pricingApp)).not.toMatch(/hostedCredit|\$1\.25|\$12/);
	});

	it("builds the comparison table from the plan record and the paid-plan gates", () => {
		const rows = planComparison();
		const pricing = String(renderSite("/pricing")?.body);
		expect(pricing).toContain("Recommended");
		expect(pricing).not.toContain("Most popular");
		expect(pricing).not.toMatch(/hostedCredit|\$1\.25|\$12/);
		const byomOwn = rows.find((row) => row.feature === "Your own model or key")?.cells.byom ?? "";
		for (const label of ["OpenRouter", "Anthropic", "Google", "xAI", "OpenAI"]) expect(byomOwn).toContain(label);
		expect(USER_KEY_PROVIDERS).toHaveLength(5);

		for (const id of PLAN_ORDER) {
			const heavy = rows.find((row) => row.feature === "Heavy model")?.cells[id] ?? "";
			const light = rows.find((row) => row.feature === "Light model")?.cells[id] ?? "";
			const cards = rows.find((row) => row.feature === "New flashcards")?.cells[id] ?? "";
			const review = rows.find((row) => row.feature === "Review existing decks")?.cells[id] ?? "";
			const limit = rows.find((row) => row.feature === "Monthly limit")?.cells[id] ?? "";
			const sync = rows.find((row) => row.feature === "Sync across computers")?.cells[id] ?? "";
			expect(heavy.startsWith("Yes")).toBe(hostedHeavyAllowed({ plan: id, ownModel: PLANS[id].ownModel }));
			expect(light).toBe(PLANS[id].ownModel ? "Your own model" : "Yes");
			expect(cards === "Yes").toBe(paidPlan(id));
			expect(review).toBe("Yes");
			expect(sync).toBe("Yes");
			if (PLANS[id].ownModel || PLANS[id].hostedCreditUsd <= 0) expect(limit).toContain("Not metered here");
			else expect(limit).toContain("share of that month");
			expect(pricing).toContain(rows.find((row) => row.feature === "Light model")?.feature);
			for (const cell of Object.values(rows.find((row) => row.feature === "Heavy model")?.cells ?? {})) {
				expect(pricing).toContain(cell);
			}
		}
		expect(rows.find((row) => row.feature === "Light model")?.cells.byom).toBe("Your own model");
		expect(rows.find((row) => row.feature === "Heavy model")?.cells.byom).toBe("Your own model");
		expect(pricing).toContain(`$${PLANS.byom.priceUsdPerMonth}/month`);
		expect(pricing).toContain(`$${PLANS.included.priceUsdPerMonth}/month`);
	});

	it("ships llms.txt and a changelog of the tagged releases, and keeps llms.txt out of the sitemap", () => {
		const card = llmsTxt();
		expect(renderSite("/llms.txt")).toEqual({ body: card, type: "text/plain; charset=utf-8" });
		expect(card).toContain("college students and adult learners, 18 and older");
		expect(card).toContain("Obsidian desktop");
		expect(card).toContain("does not run on a phone");
		expect(card).toContain(`$${PLANS.free.priceUsdPerMonth} per month`);
		expect(card).toContain(`$${PLANS.byom.priceUsdPerMonth} per month`);
		expect(card).toContain(`$${PLANS.included.priceUsdPerMonth} per month`);
		expect(card).toContain("https://groundworklearn.com/pricing");
		expect(card).toContain("https://groundworklearn.com/changelog");
		expect(card).not.toMatch(/hostedCredit|\$1\.25|\$12|Most popular/);

		const changelog = String(renderSite("/changelog")?.body);
		expect(changelog).toContain('href="/changelog"');
		for (const version of ["0.1.0", "0.1.17", "0.2.0", "0.2.3", "0.2.4"]) {
			expect(changelog).toContain(`releases/tag/${version}`);
			expect(changelog).toContain(`<time datetime="`);
		}
		expect(changelog).toContain("October 2, 2026");
		expect(changelog).toContain("October 12, 2026");
		expect(changelog).not.toMatch(/\$1\.25|\$12|Most popular|hostedCredit/);
		expect(sitemapXml()).toContain("https://groundworklearn.com/changelog");
		expect(sitemapXml()).not.toContain("llms.txt");
	});
});
