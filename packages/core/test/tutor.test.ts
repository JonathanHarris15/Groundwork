import { describe, expect, it } from "vitest";
import { choosePlan, emptyAccount, presentAccount, settleHosted, setTutorChoice, spendHosted, viewAccount } from "../src/account/usage";
import {
	CLAUDE_SETUP,
	HOSTED_MODEL,
	buildUpstream,
	hostedCostUsd,
	parseTutorCall,
	tutorDecision,
	tutorRuntime,
	tutorStatus,
	readUpstream,
	type TutorCall,
} from "../src/account/tutor";

const now = new Date("2026-10-01T12:00:00Z");
const saved = { anthropic: false, openrouter: false, google: false, xai: false, openai: false };

const call: TutorCall = {
	system: "Teach from the ground up.",
	messages: [
		{ role: "user", content: "What is a limit?" },
		{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_goal", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "No goal yet." }] },
	],
	tools: [{ name: "get_goal", description: "Read the goal", input_schema: { type: "object", properties: {} } }],
	maxTokens: 1000,
};

describe("tutor route", () => {
	it("asks for a plan before it will call a provider", () => {
		const decision = tutorDecision(viewAccount(emptyAccount("u", now), now), { via: "claude", provider: null }, saved);
		expect(decision).toMatchObject({ action: "blocked", setup: "plan" });
		expect(decision.action === "blocked" && decision.error).not.toMatch(/\$\d/);
	});

	it("sends free and Groundwork through one hosted model", () => {
		for (const plan of ["free", "included"] as const) {
			const view = viewAccount(choosePlan(emptyAccount("u", now), plan, now), now);
			const decision = tutorDecision(view, { via: "claude", provider: null }, saved);
			expect(decision).toMatchObject({ action: "hosted", model: HOSTED_MODEL.id, key: "groundwork" });
		}
	});

	it("keeps a Claude subscription on the computer", () => {
		const view = viewAccount(choosePlan(emptyAccount("u", now), "byom", now), now);
		expect(tutorDecision(view, { via: "claude", provider: null }, saved)).toEqual({ action: "claude" });
		const status = tutorStatus({ action: "claude" }, view, { via: "claude", provider: null });
		expect(JSON.stringify(status)).not.toMatch(/\$\d|creditUsd|remainingUsd|hostedCredit|spentUsd/);
		expect(status.claude).toEqual(CLAUDE_SETUP);
		expect(status.label).toBe("Claude subscription");
	});

	it("uses the learner's own key and refuses a missing one", () => {
		const view = viewAccount(setTutorChoice(choosePlan(emptyAccount("u", now), "byom", now), { via: "key", provider: "openai" }, now), now);
		expect(tutorDecision(view, { via: "key", provider: "openai" }, saved).action).toBe("blocked");
		expect(tutorDecision(view, { via: "key", provider: "openai" }, { ...saved, openai: true })).toMatchObject({
			action: "key",
			provider: "openai",
			key: "user",
		});
	});

	it("stops a hosted turn when the budget is gone and never states a dollar amount", () => {
		const spent = spendHosted(choosePlan(emptyAccount("u", now), "free", now), 3, now);
		expect(spent.ok).toBe(true);
		if (!spent.ok) return;
		const decision = tutorDecision(viewAccount(spent.account, now), { via: "claude", provider: null }, saved);
		expect(decision.action).toBe("blocked");
		if (decision.action !== "blocked") return;
		expect(decision.error).toMatch(/budget is used up/);
		expect(decision.error).not.toMatch(/\$\d/);
		const shown = presentAccount(viewAccount(spent.account, now));
		expect(shown.budgetUsed).toBe(1);
		expect(shown).not.toHaveProperty("remainingUsd");
	});
});

describe("hosted ledger", () => {
	it("prices the small model from its published token rates", () => {
		expect(hostedCostUsd({ input: 2_000, output: 500 })).toBe(0.0045);
		expect(hostedCostUsd({ input: 1_000_000, output: 0 })).toBe(1);
	});

	it("lets the last turn finish and then stops", () => {
		const spent = spendHosted(choosePlan(emptyAccount("u", now), "free", now), 2.99, now);
		expect(spent.ok).toBe(true);
		if (!spent.ok) return;
		const settled = settleHosted(spent.account, 0.05, now);
		expect(settled.chargedUsd).toBe(0.01);
		expect(settled.exhausted).toBe(true);
		expect(viewAccount(settled.account, now).remainingUsd).toBe(0);
	});
});

describe("provider requests", () => {
	it("calls OpenRouter with Groundwork's key and ignores a requested larger model", () => {
		const upstream = buildUpstream({ action: "hosted", model: HOSTED_MODEL.id, provider: "openrouter", key: "groundwork" }, "sk-or-groundwork", {
			...call,
			model: "anthropic/claude-opus-4",
		});
		expect(upstream.url).toBe("https://openrouter.ai/api/v1/messages");
		expect(upstream.headers.authorization).toBe("Bearer sk-or-groundwork");
		expect(upstream.body).toMatchObject({ model: HOSTED_MODEL.id, max_tokens: 1000 });
		expect(JSON.stringify(upstream.headers)).not.toContain("sk-ant");
	});

	it("calls each bring-your-own provider at its own API", () => {
		const anthropic = buildUpstream({ action: "key", provider: "anthropic", model: "claude-sonnet-4-5", key: "user" }, "sk-ant-user", call);
		expect(anthropic.url).toBe("https://api.anthropic.com/v1/messages");
		expect(anthropic.headers["x-api-key"]).toBe("sk-ant-user");

		const openai = buildUpstream({ action: "key", provider: "openai", model: "gpt-4.1-mini", key: "user" }, "sk-openai", call);
		expect(openai.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(openai.headers.authorization).toBe("Bearer sk-openai");
		const openaiBody = openai.body as { messages: Array<{ role: string; tool_calls?: unknown; tool_call_id?: string }> };
		expect(openaiBody.messages.some((message) => message.role === "tool" && message.tool_call_id === "toolu_1")).toBe(true);
		expect(openaiBody.messages.some((message) => message.role === "assistant" && message.tool_calls)).toBe(true);

		const xai = buildUpstream({ action: "key", provider: "xai", model: "grok-3", key: "user" }, "xai-key", call);
		expect(xai.url).toBe("https://api.x.ai/v1/chat/completions");

		const google = buildUpstream({ action: "key", provider: "google", model: "gemini-2.5-flash", key: "user" }, "google-key", call);
		expect(google.url).toContain("generativelanguage.googleapis.com");
		expect(google.url).toContain("gemini-2.5-flash");
		expect(google.headers["x-goog-api-key"]).toBe("google-key");
		expect(JSON.stringify(google.body)).toContain("functionResponse");
	});

	it("reads a tool call back into the tutor's shape", () => {
		const read = readUpstream("openai", {
			choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call_1", function: { name: "get_goal", arguments: "{}" } }] } }],
			usage: { prompt_tokens: 10, completion_tokens: 4 },
		});
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.result.stopReason).toBe("tool_use");
		expect(read.result.content).toEqual([{ type: "tool_use", id: "call_1", name: "get_goal", input: {} }]);
	});

	it("rejects a tutor turn that is not a conversation", () => {
		expect(parseTutorCall({ system: "x", messages: [{ role: "system", content: "no" }], tools: [] })).toBeNull();
		expect(parseTutorCall({ system: "x", messages: [{ role: "user", content: "hi" }], tools: [] })?.maxTokens).toBe(8192);
	});
});

describe("tutor runtime", () => {
	it("follows the account when one is signed in, and the computer when it is not", () => {
		expect(tutorRuntime({ selected: "claude", account: null, claudeReady: true, localKey: false }).runtime).toBe("claude");
		expect(tutorRuntime({ selected: "claude", account: null, claudeReady: false, localKey: false }).runtime).toBe("setup");
		expect(tutorRuntime({ selected: "claude", account: status("hosted"), claudeReady: true, localKey: true }).runtime).toBe("proxy");
		expect(tutorRuntime({ selected: "demo", account: status("hosted"), claudeReady: true, localKey: true }).runtime).toBe("demo");
		expect(tutorRuntime({ selected: "anthropic", account: status("key"), claudeReady: false, localKey: false }).runtime).toBe("proxy");
		const blocked = tutorRuntime({ selected: "claude", account: status("blocked"), claudeReady: true, localKey: true });
		expect(blocked).toMatchObject({ runtime: "setup", website: true });
	});
});

function status(action: "hosted" | "key" | "blocked") {
	return tutorStatus(
		action === "hosted"
			? { action: "hosted", model: HOSTED_MODEL.id, provider: "openrouter", key: "groundwork" }
			: action === "key"
				? { action: "key", provider: "openai", model: "gpt-4.1-mini", key: "user" }
				: { action: "blocked", status: 402, error: "Choose a plan on the Groundwork website.", setup: "plan" },
		viewAccount(choosePlan(emptyAccount("u", now), action === "key" ? "byom" : "free", now), now),
		{ via: "claude", provider: null },
	);
}
