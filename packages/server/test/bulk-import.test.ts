import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findCycle, hostedCostUsd, KnowledgeStore, MemoryVaultIO } from "@groundwork/core";
import { AccountDirectory } from "../src/accounts";
import { route, type ServerDeps } from "../src/app";
import type { Auth } from "../src/auth";
import { MemoryBulkJobStore } from "../src/bulk-job";
import type { Billing } from "../src/billing";
import { MemoryDirectory } from "../src/memory";
import { SecretDirectory } from "../src/secrets";
import { BULK_ASK, nineDeckFiles, scriptedBulkReply } from "../../core/test/fixtures/bulk-decks";

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

function systemText(body: Record<string, unknown>): string {
	if (typeof body.system === "string") return body.system;
	if (!Array.isArray(body.system)) return "";
	return body.system.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
}

function userText(body: Record<string, unknown>): string {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const content = (messages[0] as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
}

function provider(opts: { failOnce?: boolean; delayMs?: number } = {}): {
	fetchImpl: typeof fetch;
	maxInFlight: () => number;
	calls: () => number;
} {
	let inFlight = 0;
	let maxInFlight = 0;
	let calls = 0;
	let failed = false;
	const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		calls += 1;
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const system = systemText(body);
		const user = userText(body);
		try {
			if (opts.failOnce && !failed && !system.includes("reconcile")) {
				failed = true;
				return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "content-type": "application/json" } });
			}
			if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
			const reply = scriptedBulkReply(system, user);
			return new Response(
				JSON.stringify({
					content: [{ type: "text", text: reply.text }],
					stop_reason: "end_turn",
					usage: { input_tokens: reply.usage.input, output_tokens: reply.usage.output },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		} finally {
			inFlight -= 1;
		}
	}) as typeof fetch;
	return { fetchImpl, maxInFlight: () => maxInFlight, calls: () => calls };
}

async function readSse(result: { sse?: (write: (chunk: string) => void, signal: AbortSignal) => Promise<void> }): Promise<Array<Record<string, unknown>>> {
	const chunks: string[] = [];
	await result.sse?.((chunk) => chunks.push(chunk), new AbortController().signal);
	return chunks
		.join("")
		.split("\n\n")
		.map((part) => part.trim())
		.filter((part) => part.startsWith("data:"))
		.map((part) => JSON.parse(part.slice(5).trim()) as Record<string, unknown>);
}

describe("bulk import route", () => {
	it("fans out nine documents, charges each hosted call, and returns one goal", async () => {
		const upstream = provider({ failOnce: true, delayMs: 25 });
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl: upstream.fetchImpl });
		await server.accounts.setPlan("local", "free");
		const started = Date.now();
		const response = await route("POST", "/v1/tutor/bulk-import", { userText: BULK_ASK, files: nineDeckFiles(), stream: true }, server);
		expect(response.status).toBe(200);
		const events = await readSse(response);
		const elapsedMs = Date.now() - started;
		const labels = events.filter((event) => event.type === "progress").map((event) => event.label);
		expect(labels).toContain("Reading 9 documents... 4/9");
		expect(labels).toContain("Building one plan");
		const done = events.find((event) => event.type === "done");
		expect(done?.concepts).toBeGreaterThan(10);
		expect(done?.edges).toBeGreaterThan(10);
		expect(done?.documents).toBe(9);
		expect(upstream.maxInFlight()).toBeGreaterThan(1);
		expect(upstream.maxInFlight()).toBeLessThanOrEqual(3);

		const goal = done?.goal as {
			title: string;
			nodes: Array<{ title: string; prerequisites?: string[] }>;
			sources: string[];
			traces: Array<{ title: string; path: string; locator: string }>;
		};
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		const report = await store.setGoal(goal, { judgments: "off" });
		expect(await store.goals()).toHaveLength(1);
		const edges = new Map(report.nodes.map((node) => [node.id, node.prerequisites]));
		expect(findCycle(edges)).toBeNull();
		const titles = new Set(report.nodes.map((node) => node.title));
		expect(titles.has("Limit")).toBe(true);
		expect([...titles].filter((title) => title === "Limit" || title === "Limits" || title === "FTC")).toEqual(["Limit"]);
		expect(goal.sources).toHaveLength(9);
		expect(goal.traces.length).toBeGreaterThanOrEqual(report.nodes.length);
		for (const node of report.nodes) expect(goal.traces.some((trace) => trace.title === node.title && trace.path.includes("resources/"))).toBe(true);

		const perCall = hostedCostUsd({ input: 1000, output: 200 }, "light");
		const successful = upstream.calls() - 1;
		const account = await server.accounts.get("local");
		expect(account?.spentUsd).toBeCloseTo(successful * perCall, 4);
		const body = JSON.stringify(done);
		expect(body).not.toContain("sk-or-groundwork");
		expect(body).not.toMatch(/hostedCredit|creditUsd|remainingUsd|\$\d/);

		mkdirSync("/opt/cursor/artifacts", { recursive: true });
		writeFileSync(
			"/opt/cursor/artifacts/bulk-import-http.json",
			JSON.stringify(
				{
					documents: done?.documents,
					concepts: report.nodes.length,
					edges: report.nodes.reduce((sum, node) => sum + node.prerequisites.length, 0),
					shards: done?.shards,
					elapsedMs,
					modelCalls: upstream.calls(),
					successfulCalls: successful,
					maxInFlight: upstream.maxInFlight(),
					costUsd: account?.spentUsd,
					goal: report.goal.title,
				},
				null,
				2,
			),
		);
	});

	it("charges Heavy at the Heavy rate and does not meter a saved key", async () => {
		const heavy = provider();
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl: heavy.fetchImpl });
		await server.accounts.setPlan("local", "included");
		await server.accounts.setTutorWeight("local", "heavy");
		const response = await route("POST", "/v1/tutor/bulk-import", { userText: BULK_ASK, files: nineDeckFiles() }, server);
		expect(response.status).toBe(200);
		const perCall = hostedCostUsd({ input: 1000, output: 200 }, "heavy");
		const heavyAccount = await server.accounts.get("local");
		expect(heavyAccount?.spentUsd).toBeCloseTo(heavy.calls() * perCall, 4);
		expect(JSON.stringify(response.json)).not.toMatch(/\$\d|hostedCredit/);

		const byom = provider();
		const own = deps({ openRouterKey: "sk-or-groundwork", fetchImpl: byom.fetchImpl });
		await own.accounts.setPlan("local", "byom");
		await route("POST", "/v1/secrets", { provider: "anthropic", apiKey: "sk-ant-user" }, own);
		await route("POST", "/v1/tutor/setup", { via: "key", provider: "anthropic" }, own);
		const imported = await route("POST", "/v1/tutor/bulk-import", { userText: BULK_ASK, files: nineDeckFiles() }, own);
		expect(imported.status).toBe(200);
		expect(imported.json).toMatchObject({ documents: 9 });
		await expect(own.accounts.get("local")).resolves.toMatchObject({ spentUsd: 0 });
		expect(JSON.stringify(imported.json)).not.toContain("sk-ant-user");
		expect(JSON.stringify(imported.json)).not.toContain("sk-or-groundwork");
	});

	it("refuses the Claude subscription and a missing hosted key", async () => {
		const upstream = provider();
		const claude = deps({ openRouterKey: "sk-or-groundwork", fetchImpl: upstream.fetchImpl });
		await claude.accounts.setPlan("local", "byom");
		const refused = await route("POST", "/v1/tutor/bulk-import", { userText: BULK_ASK, files: nineDeckFiles() }, claude);
		expect(refused.status).toBe(409);
		const refusedJob = await route("POST", "/v1/tutor/bulk-import", { job: true, userText: BULK_ASK, files: nineDeckFiles() }, claude);
		expect(refusedJob.status).toBe(409);
		expect(upstream.calls()).toBe(0);

		const missing = deps({ fetchImpl: upstream.fetchImpl });
		await missing.accounts.setPlan("local", "free");
		const blocked = await route("POST", "/v1/tutor/bulk-import", { userText: BULK_ASK, files: nineDeckFiles() }, missing);
		expect(blocked.status).toBe(503);
		const blockedJob = await route("POST", "/v1/tutor/bulk-import", { job: true, userText: BULK_ASK, files: nineDeckFiles() }, missing);
		expect(blockedJob.status).toBe(503);
		expect(upstream.calls()).toBe(0);
	});

	it("runs one model call per step so a long import survives a short proxy", async () => {
		const upstream = provider();
		const jobs = new MemoryBulkJobStore();
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl: upstream.fetchImpl, bulkJobs: jobs });
		await server.accounts.setPlan("local", "free");
		const created = await route("POST", "/v1/tutor/bulk-import", { job: true, userText: BULK_ASK, files: nineDeckFiles() }, server);
		expect(created.status).toBe(200);
		expect(upstream.calls()).toBe(0);
		const createdBody = created.json as { jobId?: string; status?: string; event?: { label?: string } };
		expect(createdBody.status).toBe("open");
		expect(createdBody.jobId).toMatch(/^[a-f0-9]{32}$/);
		const jobId = createdBody.jobId ?? "";

		const other: Auth = {
			firebase: false,
			async uid() {
				return { uid: "other", email: "bea@example.com", name: "Bea" };
			},
			async revokeRefreshTokens() {},
		};
		const stranger = deps({ auth: other, openRouterKey: "sk-or-groundwork", fetchImpl: upstream.fetchImpl, bulkJobs: jobs });
		const hidden = await route("POST", "/v1/tutor/bulk-import", { jobId, step: true }, stranger);
		expect(hidden.status).toBe(404);
		expect(upstream.calls()).toBe(0);
		const malformed = await route("POST", "/v1/tutor/bulk-import", { jobId: "nope", step: true }, server);
		expect(malformed.status).toBe(400);

		const labels: string[] = [];
		let done: Record<string, unknown> | null = null;
		for (let i = 0; i < 12; i++) {
			const before = upstream.calls();
			const step = await route("POST", "/v1/tutor/bulk-import", { jobId, step: true }, server);
			expect(step.status).toBe(200);
			const body = step.json as Record<string, unknown>;
			expect(JSON.stringify(body)).not.toContain("sk-or-groundwork");
			const delta = upstream.calls() - before;
			if (body.status === "wait" || body.status === "done") expect(delta).toBe(0);
			else expect(delta).toBe(1);
			const event = body.event as { label?: string } | undefined;
			if (event?.label) labels.push(event.label);
			if (body.status === "done") {
				done = body;
				break;
			}
			if (body.status !== "wait") expect(body.status).toBe("open");
		}
		expect(labels).toContain("Reading 9 documents... 4/9");
		expect(labels).toContain("Building one plan");
		expect(done?.documents).toBe(9);
		expect(done?.concepts).toBeGreaterThan(10);
		expect(done?.edges).toBeGreaterThan(10);
		expect(upstream.calls()).toBe(6);

		const goal = done?.goal as {
			title: string;
			nodes: Array<{ title: string; prerequisites?: string[] }>;
			sources: string[];
			traces: Array<{ title: string; path: string; locator: string }>;
		};
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		const report = await store.setGoal(goal, { judgments: "off" });
		const edges = new Map(report.nodes.map((node) => [node.id, node.prerequisites]));
		expect(findCycle(edges)).toBeNull();
		expect(goal.sources).toHaveLength(9);
		const perCall = hostedCostUsd({ input: 1000, output: 200 }, "light");
		const account = await server.accounts.get("local");
		expect(account?.spentUsd).toBeCloseTo(upstream.calls() * perCall, 4);
		expect(JSON.stringify(done)).not.toMatch(/hostedCredit|creditUsd|remainingUsd|\$\d/);

		const again = await route("POST", "/v1/tutor/bulk-import", { jobId, step: true }, server);
		expect(again.status).toBe(200);
		expect((again.json as { status?: string }).status).toBe("done");
		expect(upstream.calls()).toBe(6);
	});

	it("keeps three shard reads in flight while the plugin asks", async () => {
		const upstream = provider({ delayMs: 40 });
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl: upstream.fetchImpl });
		await server.accounts.setPlan("local", "free");
		const created = await route("POST", "/v1/tutor/bulk-import", { job: true, userText: BULK_ASK, files: nineDeckFiles() }, server);
		const jobId = (created.json as { jobId: string }).jobId;
		await Promise.all([0, 1, 2].map(() => route("POST", "/v1/tutor/bulk-import", { jobId, step: true }, server)));
		expect(upstream.maxInFlight()).toBeGreaterThan(1);
		expect(upstream.maxInFlight()).toBeLessThanOrEqual(3);
		expect(upstream.calls()).toBe(3);
	});

	it("renames a large concept list a few titles at a time", async () => {
		const batches: number[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const system = systemText(body);
			const user = userText(body);
			if (system.includes("reconcile")) {
				const parsed = JSON.parse(user) as { concepts?: unknown[] };
				batches.push(Array.isArray(parsed.concepts) ? parsed.concepts.length : 0);
			}
			const reply = scriptedBulkReply(system, user);
			return new Response(
				JSON.stringify({
					content: [{ type: "text", text: reply.text }],
					stop_reason: "end_turn",
					usage: { input_tokens: reply.usage.input, output_tokens: reply.usage.output },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		const server = deps({ openRouterKey: "sk-or-groundwork", fetchImpl });
		await server.accounts.setPlan("local", "free");
		const files = [1, 2, 3].map((file) => ({
			path: `resources/ideas-${file}.md`,
			name: `ideas-${file}.md`,
			text: Array.from({ length: 24 }, (_, index) => `# Quartz notion ${file}${String(index).padStart(2, "0")}`).join("\n"),
		}));
		const created = await route("POST", "/v1/tutor/bulk-import", { job: true, userText: BULK_ASK, files }, server);
		const jobId = (created.json as { jobId: string }).jobId;
		let done: Record<string, unknown> | null = null;
		for (let i = 0; i < 20 && !done; i++) {
			const step = await route("POST", "/v1/tutor/bulk-import", { jobId, step: true }, server);
			const body = step.json as Record<string, unknown>;
			expect(step.status).toBe(200);
			if (body.status === "error") throw new Error(String(body.error));
			if (body.status === "done") done = body;
		}
		expect(batches.length).toBeGreaterThan(1);
		expect(Math.max(...batches)).toBeLessThanOrEqual(20);
		expect(done?.concepts).toBeGreaterThan(60);
		const goal = done?.goal as { nodes: Array<{ title: string; prerequisites?: string[] }> };
		expect(findCycle(new Map(goal.nodes.map((node) => [node.title, node.prerequisites ?? []])))).toBeNull();
	});
});
