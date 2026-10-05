import { describe, expect, it } from "vitest";
import { route, type ServerDeps } from "../src/app";
import { AccountDirectory } from "../src/accounts";
import { MemoryDirectory } from "../src/memory";
import type { Auth } from "../src/auth";
import type { Billing } from "../src/billing";
import { SecretDirectory } from "../src/secrets";

function billing(): Billing {
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
	};
}

function capture(reply: unknown, status = 200): { fetchImpl: typeof fetch; calls: unknown[] } {
	const calls: unknown[] = [];
	const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
		calls.push(init?.body);
		return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function deps(over: Partial<ServerDeps> = {}): ServerDeps {
	const auth: Auth = { firebase: false, async uid() { return { uid: "exam-learner", email: "learner@example.com", name: "Exam Learner" }; }, async revokeRefreshTokens() {} };
	return {
		auth,
		accounts: new AccountDirectory(),
		secrets: new SecretDirectory(),
		billing: billing(),
		jev: true,
		memory: new MemoryDirectory(),
		openRouterKey: "sk-or-test",
		async grade(items) {
			return items.map(() => ({ outcome: "correct" as const, feedback: "Matched.", slip: false }));
		},
		...over,
	};
}

const turn = {
	system: "You are a tutor.",
	messages: [{ role: "user", content: "Midterm covers chapters 3–5 on limits and derivatives." }],
	tools: [],
};

/** After Obsidian syncs tutor memory, the website dashboard should show new concepts. */
describe("exam prep journey (server seam)", () => {
	it("stores exam-prep memory from Obsidian and exposes it on /v1/groundwork", async () => {
		const server = deps();
		await route("POST", "/v1/account/plan", { plan: "free" }, server);
		const saved = await route(
			"PUT",
			"/v1/memory",
			{
				files: {
					"goals/Midterm chapters 3-5.md": "---\ntitle: Midterm chapters 3–5\ndomain: calculus\n---\nExam on limits and derivatives.",
					"concepts/Limit.md": "---\ntitle: Limit\n---\n",
					"concepts/Derivative.md": "---\ntitle: Derivative\nprerequisites:\n  - \"[[Limit]]\"\n---\n",
				},
				knowledge: {
					updatedAt: "2026-10-05T04:00:00.000Z",
					concepts: [
						{ id: "limit", title: "Limit", status: "learning", current: 0.2, prerequisites: [] },
						{ id: "derivative", title: "Derivative", status: "unassessed", current: 0, prerequisites: ["limit"] },
					],
					goals: [],
				},
			},
			server,
		);
		expect(saved.status).toBe(200);
		const view = await route("GET", "/v1/groundwork", null, server);
		expect(view.status).toBe(200);
		expect((view.json as { concepts: unknown[] }).concepts.length).toBeGreaterThanOrEqual(2);
		const tutor = await route("GET", "/v1/tutor", null, server);
		expect(tutor.status).toBe(200);
		expect(tutor.json).toMatchObject({ action: "hosted" });
	});

	it("runs a hosted tutor turn after the learner describes an exam", async () => {
		const { fetchImpl } = capture({
			content: [{ type: "text", text: "Let's plan your midterm prep from limits upward." }],
			stop_reason: "end_turn",
			usage: { input_tokens: 100, output_tokens: 50 },
		});
		const server = deps({ fetchImpl });
		await route("POST", "/v1/account/plan", { plan: "free" }, server);
		const turnResult = await route("POST", "/v1/tutor/complete", turn, server);
		expect(turnResult.status).toBe(200);
	});
});
