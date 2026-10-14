import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../src/accounts";
import { route, type ServerDeps } from "../src/app";
import type { Auth } from "../src/auth";
import type { Billing } from "../src/billing";
import { MemoryDirectory } from "../src/memory";
import { SecretDirectory } from "../src/secrets";
import type { UsageDirectory } from "../src/usage";

function billing(over: Partial<Billing> = {}): Billing {
	return {
		configured: false,
		async checkout() {
			throw Object.assign(new Error("Stripe isn't connected yet."), { status: 503 });
		},
		async portal() {
			throw Object.assign(new Error("Stripe isn't connected yet."), { status: 503 });
		},
		async applyEvent() {
			throw Object.assign(new Error("Stripe isn't connected yet."), { status: 503 });
		},
		...over,
	};
}

function deps(over: Partial<ServerDeps> = {}): ServerDeps {
	const auth: Auth = {
		firebase: false,
		async uid() {
			return { uid: "local", email: "ada@example.com", name: "Ada" };
		},
		async revokeRefreshTokens() {},
	};
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

const question = {
	question: "Slope through (1, 2) and (3, 8)?",
	explanation: "Rise 6, run 2, so the slope is 3.",
	options: [
		{ label: "3", value: "a" },
		{ label: "1/3", value: "b" },
	],
	correct: ["b"],
};

describe("quiz key route", () => {
	it("does not call Stripe and does not bill the check", async () => {
		let synced = 0;
		let charged = 0;
		const recorded: Array<{ costUsd: number; chargedUsd: number; calls: number }> = [];
		let sent: { model?: unknown; max_tokens?: unknown; reasoning?: unknown; authorization?: string } | null = null;
		const server = deps({
			openRouterKey: "sk-or-server-secret",
			billing: billing({
				async sync() {
					synced += 1;
				},
			}),
			usage: {
				async record(_uid, call) {
					recorded.push({ costUsd: call.costUsd, chargedUsd: call.chargedUsd, calls: call.calls });
				},
			} as UsageDirectory,
			async fetchImpl(url, init) {
				const headers = new Headers(init?.headers);
				sent = {
					authorization: headers.get("authorization") ?? "",
					...(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as object),
				};
				expect(String(url)).toBe("https://openrouter.ai/api/v1/messages");
				return new Response(
					JSON.stringify({
						content: [{ type: "text", text: '{"matchesExplanation":false,"keyedCorrect":false,"anotherAlsoCorrect":false,"correctValue":"a"}' }],
						stop_reason: "end_turn",
						usage: { input_tokens: 400, output_tokens: 80 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		});
		const result = await route("POST", "/v1/quiz-key", question, server);
		expect(synced).toBe(0);
		expect(charged).toBe(0);
		expect(result.status).toBe(200);
		expect(JSON.stringify(result.json)).not.toContain("sk-or-server-secret");
		expect(result.json).toMatchObject({
			model: "openai/gpt-6-luna",
			costUsd: 0.00008,
			inputTokens: 400,
			outputTokens: 80,
			verdict: { correctValue: "a", anotherAlsoCorrect: false },
		});
		expect(typeof (result.json as { latencyMs: unknown }).latencyMs).toBe("number");
		expect(sent?.model).toBe("openai/gpt-6-luna");
		expect(sent?.max_tokens).toBeLessThanOrEqual(256);
		expect(sent?.reasoning).toEqual({ effort: "low" });
		expect(sent?.authorization).toBe("Bearer sk-or-server-secret");
		expect(recorded).toEqual([{ costUsd: 0, chargedUsd: 0, calls: 1 }]);
	});

	it("refuses the check when the server has no OpenRouter key", async () => {
		const result = await route("POST", "/v1/quiz-key", question, deps());
		expect(result.status).toBe(503);
	});

	it("rejects a question with no keyed option", async () => {
		const result = await route("POST", "/v1/quiz-key", { question: "Slope?" }, deps({ openRouterKey: "sk-or-server" }));
		expect(result.status).toBe(400);
	});

	it("checks a free-response reference without billing the learner", async () => {
		let synced = 0;
		const recorded: Array<{ costUsd: number; chargedUsd: number }> = [];
		let sent: { model?: unknown; reasoning?: unknown; messages?: Array<{ content?: string }> } | null = null;
		const server = deps({
			openRouterKey: "sk-or-server-secret",
			billing: billing({
				async sync() {
					synced += 1;
				},
			}),
			usage: {
				async record(_uid, call) {
					recorded.push({ costUsd: call.costUsd, chargedUsd: call.chargedUsd });
				},
			} as UsageDirectory,
			async fetchImpl(_url, init) {
				sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { model?: unknown; reasoning?: unknown; messages?: Array<{ content?: string }> };
				return new Response(
					JSON.stringify({
						content: [
							{
								type: "text",
								text: '{"matchesExplanation":false,"referenceCorrect":false,"learnerCorrect":null,"correctedReference":"w=(1,-1), b=0"}',
							},
						],
						stop_reason: "end_turn",
						usage: { input_tokens: 400, output_tokens: 80 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		});
		const result = await route(
			"POST",
			"/v1/quiz-key",
			{
				format: "free",
				question: "What weights and bias make sign(w·x+b) match the labels?",
				explanation: "w=(1,-1) and b=0 separates the classes.",
				reference: "w=(1,1), b=0",
			},
			server,
		);
		expect(synced).toBe(0);
		expect(result.status).toBe(200);
		expect(JSON.stringify(result.json)).not.toContain("sk-or-server-secret");
		expect(result.json).toMatchObject({
			model: "openai/gpt-6-luna",
			costUsd: 0.00008,
			verdict: { referenceCorrect: false, correctedReference: "w=(1,-1), b=0" },
		});
		expect(sent?.model).toBe("openai/gpt-6-luna");
		expect(sent?.reasoning).toEqual({ effort: "low" });
		expect(sent?.messages?.[0]?.content).toContain("w=(1,1), b=0");
		expect(recorded).toEqual([{ costUsd: 0, chargedUsd: 0 }]);
	});
});
