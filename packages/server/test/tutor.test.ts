import { describe, expect, it } from "vitest";
import { emptyFlashcardLibrary, makeCard, PATHS, serializeFlashcardLibrary, USER_KEY_PROVIDERS } from "@groundwork/core";
import { AccountDirectory } from "../src/accounts";
import { route, type ServerDeps } from "../src/app";
import type { Auth } from "../src/auth";
import type { Billing } from "../src/billing";
import { MemoryDirectory } from "../src/memory";
import { SecretDirectory } from "../src/secrets";

function billing(): Billing {
	return {
		configured: false,
		async checkout() {
			throw new Error("no");
		},
		async portal() {
			throw new Error("no");
		},
		async applyEvent() {
			throw new Error("no");
		},
	};
}

function deps(over: Partial<ServerDeps> = {}): ServerDeps {
	const auth: Auth = { firebase: false, async uid() { return { uid: "local", email: "ada@example.com", name: "Ada" }; }, async revokeRefreshTokens() {} };
	return {
		auth,
		accounts: new AccountDirectory(),
		secrets: new SecretDirectory(),
		billing: billing(),
		jev: true,
		memory: new MemoryDirectory(),
		async grade() {
			return [];
		},
		async selectContext() {
			return [];
		},
		...over,
	};
}

function capture(reply: unknown, status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> } {
	const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

const turn = { system: "Teach.", messages: [{ role: "user", content: "What is a limit?" }], tools: [] };

describe("tutor API", () => {
	it("bills a free account to the shared OpenRouter key and hides that key", async () => {
		const { fetchImpl, calls } = capture({
			content: [{ type: "text", text: "A limit is the value being approached." }],
			stop_reason: "end_turn",
			usage: { input_tokens: 2_000, output_tokens: 500 },
		});
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await route("POST", "/v1/account/plan", { plan: "free" }, server);
		const routeInfo = await route("GET", "/v1/tutor", null, server);
		expect(routeInfo.json).toMatchObject({ action: "hosted" });
		const result = await route("POST", "/v1/tutor/complete", { ...turn, model: "anthropic/claude-opus-4" }, server);
		expect(result.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://openrouter.ai/api/v1/messages");
		expect(calls[0].headers.get("authorization")).toBe("Bearer sk-or-groundwork");
		expect(calls[0].body.model).toBe("google/gemini-3.8-flash");
		expect(calls[0].body.stream).toBeUndefined();
		expect(JSON.stringify(result.json)).not.toContain("sk-or-groundwork");
		expect(JSON.stringify(result.json)).not.toMatch(/\$\d|creditUsd|remainingUsd|hostedCredit/);
		expect(result.json).toMatchObject({ route: { action: "hosted", provider: "openrouter" }, budgetUsed: expect.any(Number) });
		await expect(server.accounts.get("local")).resolves.toMatchObject({ spentUsd: 0.0034, remainingUsd: 1.2466 });

		const described = await route("GET", "/v1/tutor", null, server);
		expect(described.json).toMatchObject({ action: "hosted", label: "Light", weight: "light", model: "google/gemini-3.8-flash" });
		expect(JSON.stringify(described.json)).not.toMatch(/\$\d|creditUsd|remainingUsd/);
		expect(Object.keys((described.json as { claude: object[] }).claude)).toHaveLength(3);
	});

	it("routes Heavy to Gemini 3.5 Flash and leaves bring-your-own-model alone", async () => {
		const { fetchImpl, calls } = capture({
			content: [
				{ type: "thinking", thinking: "Recall the definition.", signature: "sig" },
				{ type: "text", text: "A limit is the value being approached." },
			],
			stop_reason: "end_turn",
			usage: { input_tokens: 2_000, output_tokens: 500 },
		});
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "included");
		const refused = await route("POST", "/v1/tutor/weight", { weight: "huge" }, server);
		expect(refused.status).toBe(400);
		const chosen = await route("POST", "/v1/tutor/weight", { weight: "heavy" }, server);
		expect(chosen.status).toBe(200);
		expect(chosen.json).toMatchObject({ action: "hosted", model: "google/gemini-3.5-flash", label: "Heavy", weight: "heavy" });
		const result = await route("POST", "/v1/tutor/complete", { ...turn, model: "anthropic/claude-opus-4" }, server);
		expect(result.status).toBe(200);
		expect(calls[0].body.model).toBe("google/gemini-3.5-flash");
		expect(JSON.stringify(result.json)).toContain("thinking");
		await expect(server.accounts.get("local")).resolves.toMatchObject({ spentUsd: 0.0075 });

		await server.accounts.setPlan("local", "byom");
		const blocked = await route("POST", "/v1/tutor/weight", { weight: "light" }, server);
		expect(blocked.status).toBe(400);
		expect(JSON.stringify(blocked.json)).toMatch(/own model/);
	});

	it("does not call a provider once the budget is gone", async () => {
		const { fetchImpl, calls } = capture({});
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "free");
		await server.accounts.charge("local", 3);
		const result = await route("POST", "/v1/tutor/complete", turn, server);
		expect(result.status).toBe(402);
		expect(JSON.stringify(result.json)).toMatch(/budget is used up/);
		expect(JSON.stringify(result.json)).not.toMatch(/\$\d/);
		expect(calls).toHaveLength(0);
	});

	it("refuses a hosted turn when Groundwork's key is missing", async () => {
		const { fetchImpl, calls } = capture({});
		const server = deps({ fetchImpl });
		await route("POST", "/v1/account/plan", { plan: "free" }, server);
		const result = await route("POST", "/v1/tutor/complete", turn, server);
		expect(result.status).toBe(503);
		expect(calls).toHaveLength(0);
	});

	it("runs bring-your-own keys on that provider and does not meter them", async () => {
		const { fetchImpl, calls } = capture({
			choices: [{ finish_reason: "stop", message: { content: "A derivative measures change." } }],
			usage: { prompt_tokens: 20, completion_tokens: 8 },
		});
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "byom");
		await route("POST", "/v1/secrets", { provider: "openai", apiKey: "sk-openai-user" }, server);
		const setup = await route("POST", "/v1/tutor/setup", { via: "key", provider: "openai" }, server);
		expect(setup.status).toBe(200);
		expect(setup.json).toMatchObject({ action: "key", provider: "openai", label: "OpenAI" });
		expect(JSON.stringify(setup.json)).not.toContain("sk-openai-user");

		const result = await route("POST", "/v1/tutor/complete", turn, server);
		expect(result.status).toBe(200);
		expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
		expect(calls[0].headers.get("authorization")).toBe("Bearer sk-openai-user");
		expect(calls[0].headers.get("authorization")).not.toContain("sk-or-groundwork");
		await expect(server.accounts.get("local")).resolves.toMatchObject({ spentUsd: 0 });
		expect(result.json).toMatchObject({ content: [{ type: "text", text: "A derivative measures change." }], route: { action: "key" } });
	});

	it("keeps the Claude subscription off the server", async () => {
		const { fetchImpl, calls } = capture({});
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "byom");
		const described = await route("GET", "/v1/tutor", null, server);
		expect(described.json).toMatchObject({ action: "claude", label: "Claude subscription" });
		expect(JSON.stringify(described.json)).toContain("Check connection");
		const result = await route("POST", "/v1/tutor/complete", turn, server);
		expect(result.status).toBe(409);
		expect(calls).toHaveLength(0);
	});

	it("says when the hosted provider is out of credits", async () => {
		const { fetchImpl, calls } = capture(
			{
				error: {
					message: "Prompt tokens limit exceeded: 15587 > 2563. To increase, visit https://openrouter.ai/settings/credits and add more credits",
					type: "billing_error",
				},
			},
			402,
		);
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "included");
		await server.accounts.setTutorWeight("local", "heavy");
		const result = await route("POST", "/v1/tutor/complete", { ...turn, stream: true }, server);
		expect(result.status).toBe(502);
		expect(result.json).toEqual({ error: "The model provider is out of credits." });
		expect(JSON.stringify(result.json)).not.toMatch(/That didn't go through|openrouter|15587|\$\d|sk-or-groundwork/);
		expect(calls).toHaveLength(1);

		const refused = capture({ error: { message: "invalid x-api-key" } }, 401);
		const byom = deps({ fetchImpl: refused.fetchImpl });
		await byom.accounts.setPlan("local", "byom");
		await byom.secrets.save("local", "anthropic", "sk-ant-user");
		await route("POST", "/v1/tutor/setup", { via: "key", provider: "anthropic" }, byom);
		const keyResult = await route("POST", "/v1/tutor/complete", { ...turn, stream: true }, byom);
		expect(keyResult.status).toBe(502);
		expect(keyResult.json).toEqual({ error: "Provider key rejected." });
	});

	it("strips a provider key out of an upstream error", async () => {
		const { fetchImpl } = capture({ error: { message: "bad key sk-ant-user" } }, 401);
		const server = deps({ fetchImpl });
		await server.accounts.setPlan("local", "byom");
		await server.secrets.save("local", "anthropic", "sk-ant-user");
		await route("POST", "/v1/tutor/setup", { via: "key", provider: "anthropic" }, server);
		const result = await route("POST", "/v1/tutor/complete", turn, server);
		expect(result.status).toBe(502);
		expect(JSON.stringify(result.json)).not.toContain("sk-ant-user");
		expect(JSON.stringify(result.json)).toContain("[redacted]");
	});

	it("sends Google and xAI to their own hosts", async () => {
		for (const [provider, url] of [
			["google", "generativelanguage.googleapis.com"],
			["xai", "https://api.x.ai/v1/chat/completions"],
		] as const) {
			const { fetchImpl, calls } = capture({
				candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
				usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
				choices: [{ finish_reason: "stop", message: { content: "ok" } }],
			});
			const server = deps({ fetchImpl });
			await server.accounts.setPlan("local", "byom");
			await server.secrets.save("local", provider, `${provider}-secret`);
			await route("POST", "/v1/tutor/setup", { via: "key", provider }, server);
			const result = await route("POST", "/v1/tutor/complete", turn, server);
			expect(result.status).toBe(200);
			expect(calls[0].url).toContain(url);
			expect(JSON.stringify(result.json)).not.toContain(`${provider}-secret`);
		}
		expect(USER_KEY_PROVIDERS).toContain("openrouter");
	});

	it("refuses Heavy for Free, keeps the stored weight, and still lets Groundwork use it", async () => {
		const { fetchImpl, calls } = capture({
			content: [{ type: "text", text: "A limit is the value being approached." }],
			stop_reason: "end_turn",
			usage: { input_tokens: 100, output_tokens: 20 },
		});
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "free");
		const refused = await route("POST", "/v1/tutor/weight", { weight: "heavy" }, server);
		expect(refused.status).toBe(402);
		expect(refused.json).toMatchObject({ code: "heavy_requires_upgrade" });
		expect(JSON.stringify(refused.json)).toContain("$20");
		expect(JSON.stringify(refused.json)).toContain("$6");
		expect(JSON.stringify(refused.json)).not.toMatch(/\$12/);
		const stored = await server.accounts.get("local");
		expect(stored?.tutorWeight ?? "light").toBe("light");

		await server.accounts.setTutorWeight("local", "heavy");
		const stale = await route("POST", "/v1/tutor/complete", turn, server);
		expect(stale.status).toBe(402);
		expect(stale.json).toMatchObject({ code: "heavy_requires_upgrade" });
		expect(calls).toHaveLength(0);
		const described = await route("GET", "/v1/tutor", null, server);
		expect(described.json).toMatchObject({ action: "hosted", plan: "free", weight: "heavy", model: "google/gemini-3.5-flash" });

		const light = await route("POST", "/v1/tutor/complete", turn, server);
		expect(light.status).toBe(402);
		await server.accounts.setTutorWeight("local", "light");
		const sent = await route("POST", "/v1/tutor/complete", turn, server);
		expect(sent.status).toBe(200);
		expect(calls[0].body.model).toBe("google/gemini-3.8-flash");
	});

	it("keeps Bring your own model on the learner's key when Heavy was stored", async () => {
		const { fetchImpl, calls } = capture({
			choices: [{ finish_reason: "stop", message: { content: "A derivative measures change." } }],
			usage: { prompt_tokens: 20, completion_tokens: 8 },
		});
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "byom");
		await server.accounts.setTutorWeight("local", "heavy");
		await server.secrets.save("local", "openai", "sk-openai-user");
		await route("POST", "/v1/tutor/setup", { via: "key", provider: "openai" }, server);
		const weight = await route("POST", "/v1/tutor/weight", { weight: "heavy" }, server);
		expect(weight.status).toBe(400);
		expect(JSON.stringify(weight.json)).toMatch(/own model/);
		const result = await route("POST", "/v1/tutor/complete", { ...turn, messages: [{ role: "user", content: "Make flashcards for the power rule." }] }, server);
		expect(result.status).toBe(200);
		expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
		expect(calls[0].body.model).not.toBe("google/gemini-3.5-flash");
	});

	it("refuses hosted flashcard generation on Free and allows it on Groundwork", async () => {
		const cards = { ...turn, messages: [{ role: "user", content: "Please make flashcards for limits." }] };
		const { fetchImpl, calls } = capture({
			content: [{ type: "text", text: "Here is a card." }],
			stop_reason: "end_turn",
			usage: { input_tokens: 100, output_tokens: 20 },
		});
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "free");
		const refused = await route("POST", "/v1/tutor/complete", cards, server);
		expect(refused.status).toBe(402);
		expect(refused.json).toMatchObject({ code: "flashcards_require_upgrade" });
		expect(JSON.stringify(refused.json)).toContain("$20");
		expect(JSON.stringify(refused.json)).toContain("$6");
		expect(JSON.stringify(refused.json)).not.toMatch(/\$12/);
		expect(calls).toHaveLength(0);
		const review = await route("POST", "/v1/tutor/complete", { ...turn, messages: [{ role: "user", content: "I reviewed my flashcards. Teach me limits." }] }, server);
		expect(review.status).toBe(200);
		expect(calls).toHaveLength(1);

		await server.accounts.setPlan("local", "included");
		const allowed = await route("POST", "/v1/tutor/complete", cards, server);
		expect(allowed.status).toBe(200);
		expect(calls).toHaveLength(2);
	});

	it("refuses a new flashcard file on Free and still accepts a rating", async () => {
		const knowledge = { concepts: [], goals: [], updatedAt: "2026-10-02T00:00:00.000Z" };
		const lib = emptyFlashcardLibrary(new Date("2026-10-02T00:00:00.000Z"));
		lib.decks.push({ id: "limits", title: "Limits" });
		lib.cards.push(makeCard({ id: "c1", deckId: "limits", concept: "Limit", front: "What is a limit?", back: "A value", now: new Date("2026-10-02T00:00:00.000Z") }));
		const file = serializeFlashcardLibrary(lib);
		const server = deps();
		await server.accounts.setPlan("local", "included");
		const saved = await route("PUT", "/v1/memory", { files: { [PATHS.flashcards]: file }, knowledge }, server);
		expect(saved.status).toBe(200);
		await server.accounts.setPlan("local", "free");
		const rated = JSON.parse(file) as { cards: Array<{ reps: number }> };
		rated.cards[0].reps = 2;
		const review = await route("PUT", "/v1/memory", { files: { [PATHS.flashcards]: JSON.stringify(rated) }, knowledge }, server);
		expect(review.status).toBe(200);
		const edited = JSON.parse(file) as { cards: Array<{ front: string }> };
		edited.cards[0].front = "Define a limit.";
		const blocked = await route("PUT", "/v1/memory", { files: { [PATHS.flashcards]: JSON.stringify(edited) }, knowledge }, server);
		expect(blocked.status).toBe(402);
		expect(blocked.json).toMatchObject({ code: "flashcards_require_upgrade" });
		const kept = await route("GET", "/v1/memory", null, server);
		expect(JSON.stringify(kept.json)).not.toContain("Define a limit.");
	});

	it("streams the first token before the model finishes, then charges the turn", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const encoder = new TextEncoder();
		const first = anthropicSse([
			{ type: "message_start", message: { usage: { input_tokens: 2000, output_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A limit" } },
		]);
		const rest = anthropicSse([
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " is the value being approached." } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } },
			{ type: "message_stop" },
		]);
		const calls: Array<{ body: Record<string, unknown> }> = [];
		const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
			calls.push({ body: JSON.parse(String(init?.body)) });
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(encoder.encode(first));
					await held;
					controller.enqueue(encoder.encode(rest));
					controller.close();
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "free");
		const result = await route("POST", "/v1/tutor/complete", { ...turn, stream: true }, server);
		expect(calls[0].body.stream).toBe(true);
		expect(result.sse).toEqual(expect.any(Function));
		const writes: string[] = [];
		let firstWrite = "";
		const finished = result.sse!(async (chunk) => {
			writes.push(chunk);
			if (!firstWrite) {
				firstWrite = chunk;
				release();
			}
		}, new AbortController().signal);
		await finished;
		expect(firstWrite).toContain("A limit");
		expect(firstWrite).not.toContain("approached");
		expect(writes.at(-1)).toContain('"type":"done"');
		expect(writes.join("")).toContain("is the value being approached.");
		await expect(server.accounts.get("local")).resolves.toMatchObject({ spentUsd: 0.0034 });
		expect(JSON.stringify(writes)).not.toMatch(/\$\d|creditUsd|hostedCredit/);
	});

	it("strips a study-gate echo split across stream chunks", async () => {
		const encoder = new TextEncoder();
		const lesson = "Probability is additive over disjoint events.";
		const leak = "quiz: Waiting until they ask to study ask_user: Waiting until they ask to study quiz: Waiting until they ask to study";
		const first = anthropicSse([
			{ type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${lesson}\n\nquiz: Wait` } },
		]);
		const rest = anthropicSse([
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `ing until they ask to study ask_user: Waiting until they ask to study quiz: Waiting until they ask to study` } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } },
			{ type: "message_stop" },
		]);
		const fetchImpl = (async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(first));
					controller.enqueue(encoder.encode(rest));
					controller.close();
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "free");
		const result = await route("POST", "/v1/tutor/complete", { ...turn, stream: true }, server);
		const writes: string[] = [];
		await result.sse!(async (chunk) => {
			writes.push(chunk);
		}, new AbortController().signal);
		const joined = writes.join("");
		expect(joined).toContain(lesson);
		expect(joined).not.toContain("Waiting until they ask to study");
		expect(joined).not.toContain(leak);
		const done = writes.at(-1) ?? "";
		expect(done).toContain('"type":"done"');
		expect(done).not.toContain("Waiting until they ask to study");
		expect(done).toContain(lesson);
	});

	it("settles a streamed request as JSON when the provider ignores streaming", async () => {
		const { fetchImpl, calls } = capture({
			content: [{ type: "text", text: "A limit is the value being approached." }],
			stop_reason: "end_turn",
			usage: { input_tokens: 2_000, output_tokens: 500 },
		});
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "free");
		const result = await route("POST", "/v1/tutor/complete", { ...turn, stream: true }, server);
		expect(result.sse).toBeUndefined();
		expect(result.status).toBe(200);
		expect(calls[0].body.stream).toBe(true);
		expect(result.json).toMatchObject({ stopReason: "end_turn", budgetUsed: expect.any(Number) });
		await expect(server.accounts.get("local")).resolves.toMatchObject({ spentUsd: 0.0034 });
	});
});

function anthropicSse(events: unknown[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
