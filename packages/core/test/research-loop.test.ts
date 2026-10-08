import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import { HOST_FETCH_LIMIT, normalizeFetchUrl, RESEARCH_BUDGET, unfinishedTurn } from "../src/agent/research";
import type { AgentEvent, ContentBlock, Provider, ProviderRequest } from "../src/agent/types";
import { describePublicBody, PUBLIC_EXCERPT_CHARS } from "../src/figure-net";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import type { ToolDef } from "../src/tools";

function session(provider: Provider, tools: ToolDef[], maxSteps?: number): AgentSession {
	const store = new KnowledgeStore(new MemoryVaultIO());
	return new AgentSession({ provider, store, tools, system: "You are the tutor.", session: { id: "s" }, maxSteps });
}

function scripted(reply: (req: ProviderRequest, step: number) => ContentBlock[] | { content: ContentBlock[]; stopReason: string }): Provider & { calls: ProviderRequest[] } {
	const calls: ProviderRequest[] = [];
	let n = 0;
	return {
		name: "script",
		calls,
		async complete(req) {
			calls.push(req);
			const step = n++;
			const answered = reply(req, step);
			const content = Array.isArray(answered) ? answered : answered.content;
			const stopReason = Array.isArray(answered) ? (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn") : answered.stopReason;
			for (const block of content) {
				if (block.type === "text" && typeof block.text === "string" && block.text) req.onText(block.text);
			}
			return { content, stopReason };
		},
	};
}

function toolUse(name: string, input: unknown, id = name): ContentBlock {
	return { type: "tool_use", id, name, input };
}

function fetchTool(onFetch: (url: string) => string): ToolDef {
	return {
		name: "fetch_public",
		description: "Read a public page.",
		inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
		async run(input: { url?: string }) {
			const url = String(input.url ?? "");
			return { text: onFetch(url), summary: `Read ${url}` };
		},
	};
}

function resultText(agent: AgentSession): string {
	return agent.messages
		.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
		.filter((block) => block.type === "tool_result")
		.map((block) => {
			const content = (block as { content?: unknown }).content;
			return typeof content === "string" ? content : "";
		})
		.join("\n");
}

describe("fetch URL dedupe", () => {
	it("treats a fragment, a trailing slash, and host casing as the same page", () => {
		expect(normalizeFetchUrl("https://www.Example.com/chapter-6#eq:Gamma-Poisson-ch6")).toBe("https://www.example.com/chapter-6");
		expect(normalizeFetchUrl("https://www.example.com/chapter-6/")).toBe("https://www.example.com/chapter-6");
		expect(normalizeFetchUrl("https://www.example.com:443/chapter-6?b=2&a=1")).toBe("https://www.example.com/chapter-6?a=1&b=2");
		expect(normalizeFetchUrl("not a url")).toBeNull();
	});

	it("serves a page fetched earlier in the turn from the cache", async () => {
		const fetched: string[] = [];
		const provider = scripted((_req, step) => {
			const urls = [
				"https://www.Example.com/chapter-6#eq:Gamma-Poisson-ch6",
				"https://www.example.com/chapter-6/",
				"https://www.example.com/chapter-6#other",
			];
			if (step < urls.length) return [toolUse("fetch_public", { url: urls[step] }, `f${step}`)];
			return [{ type: "text", text: "Use a grid of 501 values from 0 to 15." }];
		});
		const agent = session(provider, [fetchTool((url) => (fetched.push(url), `Page body for ${url}`))]);
		const events: AgentEvent[] = [];
		await agent.send("Read the chapter.", (event) => events.push(event));

		expect(fetched).toEqual(["https://www.Example.com/chapter-6#eq:Gamma-Poisson-ch6"]);
		expect(resultText(agent)).toContain("You already fetched this page");
		expect(resultText(agent)).toContain("Stop fetching it and answer");
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.some((event) => event.type === "text_delta" && event.text.includes("501"))).toBe(true);
	});
});

describe("research budget", () => {
	it("stops web fetches after the budget and tells the tutor to answer", async () => {
		const fetched: string[] = [];
		const provider = scripted((req, step) => {
			if (!req.tools.some((tool) => tool.name === "fetch_public")) return [{ type: "text", text: "Answering from the pages already read." }];
			return [toolUse("fetch_public", { url: `https://source-${step}.example/page` }, `f${step}`)];
		});
		const agent = session(provider, [
			fetchTool((url) => (fetched.push(url), `Body of ${url}`)),
			{
				name: "search_knowledge",
				description: "Search the vault.",
				inputSchema: { type: "object", properties: {} },
				async run() {
					return { text: "No notes.", summary: "No notes" };
				},
			},
		]);
		const events: AgentEvent[] = [];
		await agent.send("Look this up.", (event) => events.push(event));

		expect(fetched).toHaveLength(RESEARCH_BUDGET);
		const closed = provider.calls.find((call) => !call.tools.some((tool) => tool.name === "fetch_public"));
		expect(closed?.tools.some((tool) => tool.name === "search_knowledge")).toBe(true);
		expect(closed?.system).toContain("research limit");
		expect(events.some((event) => event.type === "text_delta" && event.text.includes("Answering from the pages"))).toBe(true);
		expect(events.some((event) => event.type === "error")).toBe(false);
	});

	it("refuses another fetch from a host it has already read", async () => {
		const fetched: string[] = [];
		const provider = scripted((_req, step) => {
			if (step < HOST_FETCH_LIMIT + 1) return [toolUse("fetch_public", { url: `https://www.bayesrulesbook.com/ch-${step}` }, `f${step}`)];
			return [{ type: "text", text: "Enough of that site." }];
		});
		const agent = session(provider, [fetchTool((url) => (fetched.push(url), `Body ${url}`))]);
		await agent.send("Read the book.", () => undefined);

		expect(fetched).toHaveLength(HOST_FETCH_LIMIT);
		expect(resultText(agent)).toContain("Stop fetching that site");
		expect(resultText(agent)).toContain("Do not fetch it again");
	});
});

describe("graceful step cap", () => {
	it("answers with no tools when only a few steps remain", async () => {
		const provider = scripted((req) => {
			if (req.tools.length === 0) return [{ type: "text", text: "seq(from = 0, to = 15, length = 501) and stan with 4 chains." }];
			return [toolUse("list_notes", {})];
		});
		const events: AgentEvent[] = [];
		const agent = session(
			provider,
			[{ name: "list_notes", description: "List notes.", inputSchema: { type: "object", properties: {} }, async run() { return { text: "One note.", summary: "One note" }; } }],
			4,
		);
		await agent.send("Set up the assignment.", (event) => events.push(event));

		expect(provider.calls.some((call) => call.tools.length === 0 && call.system.includes("nearly out of steps"))).toBe(true);
		expect(events.some((event) => event.type === "continue_offer")).toBe(false);
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.some((event) => event.type === "text_delta" && event.text.includes("501"))).toBe(true);
	});

	it("shows what was found and offers to continue when the cap is still hit", async () => {
		const provider = scripted((req) => {
			if (req.tools.length === 0) return { content: [], stopReason: "pause_turn" };
			return [toolUse("list_notes", {})];
		});
		const events: AgentEvent[] = [];
		const agent = session(
			provider,
			[{
				name: "list_notes",
				description: "List notes.",
				inputSchema: { type: "object", properties: {} },
				async run() {
					return { text: "The Gamma-Poisson posterior for equation 6.2 is Gamma(13, 3).", summary: "Found the posterior" };
				},
			}],
			5,
		);
		await agent.send("Set up the assignment.", (event) => events.push(event));

		const offered = events.find((event) => event.type === "continue_offer");
		expect(offered).toEqual({ type: "continue_offer", text: "I can finish this from here." });
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.some((event) => event.type === "text_delta" && /Stopped after/.test(event.text))).toBe(false);
		const partial = events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
		expect(partial).toContain("Here's where I got to");
		expect(partial).toContain("Gamma(13, 3)");
		expect(agent.messages.at(-1)?.role).toBe("assistant");
	});

	it("wraps up a quiz loop instead of quizzing until the step cap", async () => {
		let quizzes = 0;
		const provider = scripted((req, step) => {
			if (!req.tools.some((tool) => tool.name === "quiz")) return [{ type: "text", text: "We stopped on the derivative. Next time, practice the chain rule." }];
			return [toolUse("quiz", { concept: "Derivative" }, `q${step}`)];
		});
		const events: AgentEvent[] = [];
		const agent = session(
			provider,
			[{
				name: "quiz",
				description: "Ask one graded question.",
				inputSchema: { type: "object", properties: {} },
				async run() {
					quizzes += 1;
					return { text: `Recorded a quiz on the derivative (${quizzes}).`, summary: `Quiz ${quizzes}` };
				},
			}],
			8,
		);
		await agent.send("I have a Calc 1 final Dec 9, help me study.", (event) => events.push(event));

		expect(quizzes).toBeGreaterThan(0);
		expect(quizzes).toBeLessThan(8);
		expect(provider.calls.at(-1)?.tools).toEqual([]);
		expect(provider.calls.at(-1)?.system).toMatch(/nearly out of steps/);
		expect(events.some((event) => event.type === "text_delta" && event.text.includes("chain rule"))).toBe(true);
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.some((event) => event.type === "continue_offer")).toBe(false);
	});

	it("keeps the latest quiz results when a quiz loop still hits the cap", async () => {
		let quizzes = 0;
		const provider = scripted((req, step) => {
			if (req.tools.length === 0) return { content: [], stopReason: "pause_turn" };
			return [toolUse("quiz", { concept: "Derivative" }, `q${step}`)];
		});
		const events: AgentEvent[] = [];
		const agent = session(
			provider,
			[{
				name: "quiz",
				description: "Ask one graded question.",
				inputSchema: { type: "object", properties: {} },
				async run() {
					quizzes += 1;
					return { text: `Question ${quizzes} on derivatives was recorded.`, summary: `Quiz ${quizzes}` };
				},
			}],
			5,
		);
		await agent.send("I have a Calc 1 final Dec 9, help me study.", (event) => events.push(event));

		const partial = events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
		expect(quizzes).toBe(2);
		expect(partial).toContain("Question 2 on derivatives");
		expect(events.some((event) => event.type === "continue_offer")).toBe(true);
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.some((event) => event.type === "text_delta" && /Stopped after/.test(event.text))).toBe(false);
		expect(agent.messages.at(-1)?.role).toBe("assistant");
	});

	it("closes the turn after a long draft so the next message is not a second user turn", async () => {
		const provider = scripted(() => [
			{ type: "text", text: "Start with a grid of 501 lambda values between 0 and 15, then fit the stan model with four chains of 10,000 iterations." },
			toolUse("list_notes", {}),
		]);
		const events: AgentEvent[] = [];
		const agent = session(
			provider,
			[{ name: "list_notes", description: "List notes.", inputSchema: { type: "object", properties: {} }, async run() { return { text: "A note.", summary: "A note" }; } }],
			4,
		);
		await agent.send("Set up the assignment.", (event) => events.push(event));
		expect(events.some((event) => event.type === "continue_offer")).toBe(true);
		expect(agent.messages.at(-1)).toMatchObject({ role: "assistant" });
		expect(events.some((event) => event.type === "error")).toBe(false);
	});

	it("keeps a long answer that was already written and still offers to continue", () => {
		const unfinished = unfinishedTurn(
			[
				{ role: "user", content: "help" },
				{ role: "assistant", content: [{ type: "text", text: "Start with a grid of 501 lambda values between 0 and 15, then the stan model with four chains." }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "Public text from example.com: the rest of the chapter." }] },
			],
			1,
		);
		expect(unfinished.answer).toBe("");
		expect(unfinished.note).toBe("I had to stop before this was finished.");
	});
});

describe("public page excerpts", () => {
	it("reads the chapter instead of the table of contents and the github repo name", () => {
		const nav = `<nav>${"Chapter link ".repeat(1200)}<meta name="github-repo" content="bayes-rules/bayes-rules-book"></nav>`;
		const html = `<!DOCTYPE html><html><head>${nav}</head><body><div class="book-body"><section><h1>Chapter 6</h1><p>${"intro ".repeat(200)}</p><span id="eq:Gamma-Poisson-ch6">equation 6.2 Gamma-Poisson</span><p>use a grid of 501 lambda values between 0 and 15.</p><h2>MCMC</h2><p>run four parallel chains for 10,000 iterations each.</p></section></div></body></html>`;
		expect(nav.length).toBeGreaterThan(12_000);
		const described = describePublicBody(
			{ finalUrl: "https://www.bayesrulesbook.com/chapter-6", contentType: "text/html", bytes: new TextEncoder().encode(html) },
			"https://www.bayesrulesbook.com/chapter-6#eq:Gamma-Poisson-ch6",
		);
		expect(described).toContain("equation 6.2 Gamma-Poisson");
		expect(described).toContain("grid of 501");
		expect(described).toContain("four parallel chains");
		expect(described).not.toContain("bayes-rules/bayes-rules-book");
		expect(described).not.toContain("Chapter link Chapter link");
	});

	it("says when a page was cut, and when an API response has another page", () => {
		const long = `plain ${"word ".repeat(PUBLIC_EXCERPT_CHARS)}`;
		const clipped = describePublicBody({
			finalUrl: "https://example.com/long",
			contentType: "text/plain",
			bytes: new TextEncoder().encode(long),
		});
		expect(clipped).toContain("Fetching this URL again will not return the rest");
		expect(clipped.length).toBeLessThan(long.length);

		const paged = describePublicBody({
			finalUrl: "https://api.github.com/repos/bayes-rules/bayes-rules-book/contents/",
			contentType: "application/json",
			bytes: new TextEncoder().encode('[{"name":"06-approximating.Rmd"}]'),
			link: '<https://api.github.com/repositories/1/contents/?page=2>; rel="next"',
		});
		expect(paged).toContain("06-approximating.Rmd");
		expect(paged).toContain("Do not walk the rest of the pages");
	});
});
