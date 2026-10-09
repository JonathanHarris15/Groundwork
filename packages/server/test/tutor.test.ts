import { describe, expect, it } from "vitest";
import { USER_KEY_PROVIDERS } from "@groundwork/core";
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

});
