import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { promotionCodesFrom } from "../src/billing";
import { AccountDirectory } from "../src/accounts";
import { route, type ServerDeps } from "../src/app";
import type { Auth } from "../src/auth";
import type { Billing } from "../src/billing";
import { MemoryDirectory } from "../src/memory";
import { SecretDirectory } from "../src/secrets";
import { UsageDirectory } from "../src/usage";
import { FileUsageStore, MemoryUsageStore } from "../src/usage-store";

function billing(over: Partial<Billing> = {}): Billing {
	return {
		configured: false,
		async checkout() {
			return "https://pay.example/session";
		},
		async portal() {
			throw new Error("no");
		},
		async applyEvent() {
			throw new Error("no");
		},
		...over,
	};
}

function deps(over: Partial<ServerDeps> = {}): ServerDeps {
	const auth: Auth = { firebase: false, async uid() { return { uid: "local" }; }, async revokeRefreshTokens() {} };
	return {
		auth,
		accounts: new AccountDirectory(),
		secrets: new SecretDirectory(),
		billing: billing(),
		jev: true,
		memory: new MemoryDirectory(),
		async grade(items) {
			return items.map(() => ({ outcome: "correct" as const, feedback: "Matched.", slip: false }));
		},
		async selectContext() {
			return [];
		},
		usage: new UsageDirectory(new MemoryUsageStore()),
		...over,
	};
}

const turn = { system: "Teach.", messages: [{ role: "user", content: "What is a limit? The secret phrase is indigo-otter." }], tools: [] };

describe("usage rollups", () => {
	it("adds calls into one daily bucket and leaves the chat text out", async () => {
		const store = new MemoryUsageStore();
		await store.add({ uid: "ada", day: "2026-10-02", plan: "free", model: "light", feature: "quiz", calls: 1, costUsd: 0.1, chargedUsd: 0.1, inputTokens: 10, outputTokens: 4 });
		await store.add({ uid: "ada", day: "2026-10-02", plan: "free", model: "light", feature: "quiz", calls: 1, costUsd: 0.2, chargedUsd: 0.2, inputTokens: 5, outputTokens: 1 });
		const rows = await store.listDays();
		expect(rows).toEqual([
			expect.objectContaining({ calls: 2, costUsd: 0.3, chargedUsd: 0.3, inputTokens: 15, outputTokens: 5, feature: "quiz" }),
		]);
		expect(JSON.stringify(rows)).not.toContain("indigo");
	});

	it("reloads a file rollup", async () => {
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-usage-")), "usage.json");
		const store = new FileUsageStore(file);
		await store.add({ uid: "ada", day: "2026-10-02", plan: "free", model: "heavy", feature: "unknown", calls: 1, costUsd: 0.5, chargedUsd: 0.4, inputTokens: 8, outputTokens: 2 });
		await store.raiseLedger({ uid: "ada", period: "2026-10", plan: "free", costUsd: 0.4, chargedUsd: 0.4 });
		await store.raiseLedger({ uid: "ada", period: "2026-10", plan: "free", costUsd: 0.2, chargedUsd: 0.2 });
		const again = new FileUsageStore(file);
		expect(await again.listDays()).toEqual([expect.objectContaining({ costUsd: 0.5, model: "heavy", feature: "unknown" })]);
		expect(await again.listLedgers()).toEqual([expect.objectContaining({ costUsd: 0.4, chargedUsd: 0.4 })]);
	});

	it("counts a hosted turn in the tagged feature, and an untagged turn as unknown", async () => {
		const store = new MemoryUsageStore();
		const usage = new UsageDirectory(store);
		const fetchImpl = (async () =>
			new Response(
				JSON.stringify({
					content: [{ type: "text", text: "A limit is the value being approached." }],
					stop_reason: "end_turn",
					usage: { input_tokens: 2_000, output_tokens: 500 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as typeof fetch;
		const server = deps({ usage, openRouterKey: "sk-or-groundwork", fetchImpl });
		await route("POST", "/v1/account/plan", { plan: "free" }, server);
		const tagged = await route("POST", "/v1/tutor/complete", { ...turn, feature: "quiz" }, server);
		expect(tagged.status).toBe(200);
		const untagged = await route("POST", "/v1/tutor/complete", turn, server);
		expect(untagged.status).toBe(200);
		const report = await usage.report(server.accounts, new Date("2026-10-09T00:00:00.000Z"));
		expect(report.features.find((row) => row.feature === "quiz")?.calls).toBe(1);
		expect(report.features.find((row) => row.feature === "unknown")?.calls).toBe(1);
		expect(JSON.stringify(await store.listDays())).not.toContain("indigo-otter");
		expect(report.users[0]?.chargedUsd).toBeCloseTo(0.0068);
	});

	it("records a checkout start and a grading call", async () => {
		const usage = new UsageDirectory(new MemoryUsageStore());
		const server = deps({ usage });
		await route("POST", "/v1/account/plan", { plan: "free" }, server);
		const checkout = await route("POST", "/v1/billing/checkout", { plan: "byom" }, server);
		expect(checkout.status).toBe(200);
		const graded = await route("POST", "/v1/grade", { items: [{ question: "Q", reference: "A", answer: "A" }] }, server);
		expect(graded.status).toBe(200);
		const report = await usage.report(server.accounts, new Date());
		expect(report.upgrades.clicks).toBe(1);
		expect(report.features.find((row) => row.feature === "grading")?.calls).toBe(1);
	});

	it("snapshots the month ledger before the calendar rolls", async () => {
		const usage = new UsageDirectory(new MemoryUsageStore());
		const accounts = new AccountDirectory(undefined, {
			onPeriodClose: (record) => usage.noteSpend(record),
			onSpend: (record) => usage.noteSpend(record),
		});
		const server = deps({ usage, accounts });
		await route("POST", "/v1/account/plan", { plan: "free" }, server);
		const october = new Date("2026-10-15T00:00:00.000Z");
		await accounts.charge("local", 0.5, october);
		await accounts.rename("local", "Ada", new Date("2026-11-02T00:00:00.000Z"));
		const report = await usage.report(accounts, new Date("2026-11-03T00:00:00.000Z"));
		expect(report.limits.find((row) => row.period === "2026-10")?.overall.meanUsd).toBeCloseTo(0.5);
	});
});

describe("admin usage gate", () => {
	const auth: Auth = {
		firebase: true,
		async uid(authorization) {
			if (authorization === "Bearer admin") return { uid: "jono", email: "jono591737@gmail.com", name: "Jonathan" };
			if (authorization === "Bearer ada") return { uid: "ada", email: "ada@example.com", name: "Ada" };
			throw Object.assign(new Error("Sign in required."), { status: 401 });
		},
		async revokeRefreshTokens() {},
	};

	it("returns 404 to everyone except the allowlisted account", async () => {
		const server = deps({ auth, usage: new UsageDirectory(new MemoryUsageStore()) });
		const anonymous = await route("GET", "/admin/usage", null, server);
		expect(anonymous.status).toBe(404);
		expect(anonymous.text).toContain("Page not found");
		expect(anonymous.text).not.toContain("Proposed Free limit");
		const stranger = await route("GET", "/admin/usage", null, server, "Bearer ada");
		expect(stranger.status).toBe(404);
		expect(JSON.stringify(stranger.json)).not.toContain("hostedCredit");
		const csv = await route("GET", "/admin/usage.csv", null, server, "Bearer ada");
		expect(csv.status).toBe(404);
		const api = await route("GET", "/v1/admin/usage", null, server, "Bearer ada");
		expect(api.status).toBe(404);
	});

	it("shows the dashboard and the CSV to the allowlisted account", async () => {
		const server = deps({ auth, usage: new UsageDirectory(new MemoryUsageStore()) });
		const page = await route("GET", "/admin/usage", null, server, "Bearer admin");
		expect(page.status).toBe(200);
		expect(page.type).toContain("text/html");
		expect(page.text).toContain("A consistent user is active on at least one day in 3 of the last 4 ISO weeks");
		expect(page.text).toContain("Proposed Free limit");
		expect(page.text).toContain("The sample is too small");
		expect(page.text).toContain("$1.25");
		expect(page.text).not.toContain("indigo");
		const csv = await route("GET", "/admin/usage.csv", null, server, "Bearer admin");
		expect(csv.status).toBe(200);
		expect(csv.text).toContain("consistent_user");
		expect(csv.headers?.["content-disposition"]).toContain("groundwork-usage.csv");
	});

	it("reads GROUNDWORKTESTER off a Stripe discount", () => {
		expect(promotionCodesFrom({ discounts: [{ promotion_code: { code: "GROUNDWORKTESTER" } }] })).toContain("GROUNDWORKTESTER");
		expect(promotionCodesFrom({ discounts: [{ coupon: { percent_off: 100 } }] })).toEqual([]);
	});
});
