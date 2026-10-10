import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { e2eIdentity } from "../src/auth";
import { isUsageAdmin, USAGE_ADMIN_EMAILS, usageAdminEmails } from "../src/admin-access";
import { promotionCodesFrom } from "../src/billing";
import { isDynamicPath, readSite } from "../src/static";
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
			if (authorization === "Bearer admin") return { uid: "jono", email: "  Jono591737@gmail.com ", name: "Jonathan", emailVerified: true };
			if (authorization === "Bearer unverified") return { uid: "jono", email: "jono591737@gmail.com", name: "Jonathan", emailVerified: false };
			if (authorization === "Bearer ada") return { uid: "ada", email: "ada@example.com", name: "Ada", emailVerified: true };
			throw Object.assign(new Error("Sign in required."), { status: 401 });
		},
		async revokeRefreshTokens() {},
	};

	it("allowlists the Firebase support address, and a test address only outside Cloud Run", () => {
		const firebase = JSON.parse(readFileSync(path.resolve("firebase.json"), "utf8")) as { auth: { providers: { googleSignIn: { supportEmail: string } } } };
		expect(USAGE_ADMIN_EMAILS.map((email) => email.trim().toLowerCase())).toContain(firebase.auth.providers.googleSignIn.supportEmail.trim().toLowerCase());
		expect(usageAdminEmails({ GROUNDWORK_E2E: "1", GROUNDWORK_E2E_ADMIN_EMAIL: " usage-admin@groundwork.test " })).toContain("usage-admin@groundwork.test");
		expect(usageAdminEmails({ GROUNDWORK_E2E: "1", K_SERVICE: "groundwork", GROUNDWORK_E2E_ADMIN_EMAIL: "usage-admin@groundwork.test" })).not.toContain("usage-admin@groundwork.test");
		expect(e2eIdentity("Bearer e2e:Usage-Admin@groundwork.test", { GROUNDWORK_E2E: "1" })).toMatchObject({ email: "usage-admin@groundwork.test", emailVerified: true });
		expect(e2eIdentity("Bearer e2e:a@b.test", { GROUNDWORK_E2E: "1", K_SERVICE: "groundwork" })).toBeNull();
		expect(isUsageAdmin({ email: " JONO591737@gmail.com ", emailVerified: true }, { localDev: false })).toBe(true);
		expect(isUsageAdmin({ email: "jono591737@gmail.com", emailVerified: false }, { localDev: false })).toBe(false);
		expect(isUsageAdmin({ email: "ada@example.com", emailVerified: true }, { localDev: false })).toBe(false);
	});

	it("returns 404 from the data endpoint unless the email is an allowlisted verified address", async () => {
		const server = deps({ auth, usage: new UsageDirectory(new MemoryUsageStore()) });
		const anonymous = await route("GET", "/api/admin/usage", null, server);
		expect(anonymous.status).toBe(404);
		expect(anonymous.json).toEqual({ error: "Not found." });
		expect(anonymous.text).toBeUndefined();
		const stranger = await route("GET", "/api/admin/usage", null, server, "Bearer ada");
		expect(stranger.status).toBe(404);
		expect(JSON.stringify(stranger.json)).not.toContain("hostedCredit");
		const unverified = await route("GET", "/api/admin/usage", null, server, "Bearer unverified");
		expect(unverified.status).toBe(404);
		const csv = await route("GET", "/api/admin/usage.csv", null, server, "Bearer ada");
		expect(csv.status).toBe(404);
		const ada = await route("GET", "/v1/account", null, server, "Bearer ada");
		expect(ada.json).toMatchObject({ isAdmin: false });
	});

	it("returns the dashboard JSON and the CSV to the allowlisted account", async () => {
		const server = deps({ auth, usage: new UsageDirectory(new MemoryUsageStore()) });
		const page = await route("GET", "/api/admin/usage", null, server, "Bearer admin");
		expect(page.status).toBe(200);
		expect(page.json).not.toHaveProperty("isAdmin");
		const body = page.json as { html?: string };
		expect(body.html).toContain("A consistent user is active on at least one day in 3 of the last 4 ISO weeks");
		expect(body.html).toContain("Proposed Free limit");
		expect(body.html).toContain("The sample is too small");
		expect(body.html).toContain("$1.25");
		expect(body.html).toContain('id="download-csv"');
		expect(body.html).not.toContain("indigo");
		const account = await route("GET", "/v1/account", null, server, "Bearer admin");
		expect(account.json).toMatchObject({ isAdmin: true });
		const csv = await route("GET", "/api/admin/usage.csv", null, server, "Bearer admin");
		expect(csv.status).toBe(200);
		expect(csv.text).toContain("consistent_user");
		expect(csv.headers?.["content-disposition"]).toContain("groundwork-usage.csv");
		expect(isDynamicPath("/api/admin/usage")).toBe(true);
		expect(isDynamicPath("/api/admin/usage.csv")).toBe(true);
		expect(isDynamicPath("/nope")).toBe(false);
		const shell = readSite("/admin/usage");
		expect(shell?.body).toContain('id="usage-root"');
		expect(shell?.body).toContain("data-admin-link");
		expect(shell?.body).toContain("/site-session.js");
		expect(String(shell?.body)).not.toContain("$1.25");
		expect(String(shell?.body)).not.toContain("Proposed Free limit");
	});

	it("puts user and paid counts above the usage report and in the CSV", async () => {
		const accounts = new AccountDirectory();
		const now = new Date();
		const recent = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
		const old = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
		await accounts.seen("free-old", { email: "old@example.com" }, null, old);
		await accounts.setPlan("free-old", "free", now);
		await accounts.seen("free-new", { email: "new@example.com" }, null, recent);
		await accounts.setPlan("free-new", "free", now);
		await accounts.seen("payer", { email: "payer@example.com" }, null, old);
		await accounts.setPlan("payer", "byom", now);
		await accounts.rememberMembership("payer", { status: "active", plan: "byom", amountUsd: 6 });
		await accounts.seen("comp", { email: "comp@example.com" }, null, old);
		await accounts.setPlan("comp", "included", now);
		await accounts.rememberMembership("comp", { status: "trialing", plan: "included", amountUsd: 0, couponCode: "GROUNDWORKTESTER" });
		await accounts.seen("late", { email: "late@example.com" }, null, old);
		await accounts.setPlan("late", "included", now);
		const usage = new UsageDirectory(new MemoryUsageStore());
		const server = deps({
			auth,
			accounts,
			usage,
			billing: billing({
				async syncMemberships() {
					await accounts.rememberMembership("late", { status: "active", plan: "included", amountUsd: 0, couponCode: "GROUNDWORKTESTER" });
				},
			}),
		});
		const page = await route("GET", "/api/admin/usage", null, server, "Bearer admin");
		expect(page.status).toBe(200);
		const body = page.json as { html?: string; census?: { paid: number; paying: number; comped: number; users: number; free: number; joinedLast7Days: number } };
		expect(body.census).toMatchObject({ users: 5, free: 2, joinedLast7Days: 1, paid: 3, byom: 1, included: 2, paying: 1, comped: 2 });
		const html = body.html ?? "";
		expect(html.indexOf("usage-head")).toBeGreaterThan(-1);
		expect(html.indexOf("usage-head")).toBeLessThan(html.indexOf("Free plan usage"));
		expect(html).toContain("Paid users");
		expect(html).toContain("Joined in the last 7 days");
		expect(html).toContain("Comped on GROUNDWORKTESTER");
		expect(html).toContain("Paying means more than $0 after discounts.");
		const head = html.slice(0, html.indexOf("Free plan usage"));
		expect(head).not.toMatch(/\$[1-9]/);
		expect(JSON.stringify(body.census)).not.toMatch(/hostedCredit|sk_live|whsec_/);
		const csv = await route("GET", "/api/admin/usage.csv", null, server, "Bearer admin");
		expect(csv.text).toContain("paid_users,3");
		expect(csv.text).toContain("paying,1");
		expect(csv.text).toContain("comped_groundworktester,2");
		expect(csv.text).toContain("joined_last_7_days,1");
		expect(csv.text).toContain("free,2");
		expect(csv.text).toContain("users,5");
	});

	it("reads GROUNDWORKTESTER off a Stripe discount", () => {
		expect(promotionCodesFrom({ discounts: [{ promotion_code: { code: "GROUNDWORKTESTER" } }] })).toContain("GROUNDWORKTESTER");
		expect(promotionCodesFrom({ discounts: [{ coupon: { percent_off: 100 } }] })).toEqual([]);
	});
});
