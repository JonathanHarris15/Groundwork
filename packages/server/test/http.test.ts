import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { USER_KEY_PROVIDERS } from "@groundwork/core";
import { AccountDirectory } from "../src/accounts";
import { FileAccountStore } from "../src/account-store";
import { route, type ServerDeps } from "../src/app";
import type { Auth } from "../src/auth";
import type { Billing } from "../src/billing";
import { readSite } from "../src/static";
import { MemoryDirectory } from "../src/memory";
import { FileTutorMemoryStore } from "../src/memory-file";
import { splitUtf8 } from "../src/memory-firestore";
import { SecretDirectory } from "../src/secrets";

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
	const auth: Auth = { firebase: false, async uid() { return { uid: "local", email: "ada@example.com", name: "Ada" }; } };
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
		...over,
	};
}

describe("account server", () => {
	it("serves the three plans and an empty account", async () => {
		const server = deps();
		const plans = await route("GET", "/v1/plans", null, server);
		const listed = JSON.stringify(plans.json);
		expect(listed).toContain("Bring your own model");
		expect(listed).not.toMatch(/hostedCreditUsd|creditUsd|remainingUsd|\$3|\$8/);
		const account = await route("GET", "/v1/account", null, server);
		expect(account.json).toMatchObject({ needsPlan: true, budgetUsed: 0 });
		expect(account.json).not.toHaveProperty("creditUsd");
		expect(account.json).not.toHaveProperty("remainingUsd");
	});

	it("saves a plan and reports the free credit", async () => {
		const server = deps();
		const chosen = await route("POST", "/v1/account/plan", { plan: "free" }, server);
		expect(chosen.status).toBe(200);
		expect(chosen.json).toMatchObject({ plan: "free", ownModel: false, budgetUsed: 0, priceUsdPerMonth: 0 });
		expect(chosen.json).not.toHaveProperty("creditUsd");
		expect(chosen.json).not.toHaveProperty("remainingUsd");
		expect(chosen.json).not.toHaveProperty("spentUsd");
		const again = await route("GET", "/v1/account", null, server);
		expect(again.json).toMatchObject({ plan: "free" });
	});

	it("stores a provider key without returning it, and refuses a Jev key", async () => {
		const server = deps();
		const saved = await route("POST", "/v1/secrets", { provider: "openrouter", apiKey: "sk-or-secret" }, server);
		expect(saved.status).toBe(200);
		expect(JSON.stringify(saved.json)).not.toContain("sk-or-secret");
		expect(saved.json).toMatchObject({ saved: "openrouter", providers: { openrouter: true, anthropic: false } });
		expect(server.secrets.get("local", "openrouter")).toBe("sk-or-secret");

		const listed = await route("GET", "/v1/secrets", null, server);
		expect(JSON.stringify(listed.json)).not.toContain("sk-or");
		expect(Object.keys((listed.json as { providers: object }).providers).sort()).toEqual([...USER_KEY_PROVIDERS].sort());

		const jev = await route("POST", "/v1/secrets", { provider: "jev", apiKey: "ts-secret" }, server);
		expect(jev.status).toBe(400);
		expect(JSON.stringify(jev.json)).toMatch(/server/);
		expect(server.secrets.get("local", "openrouter")).toBe("sk-or-secret");
	});

	it("rejects a bare API key on the grade route", async () => {
		const server = deps();
		const rejected = await route("POST", "/v1/grade", { apiKey: "ts-secret", items: [] }, server);
		expect(rejected.status).toBe(400);
		expect(JSON.stringify(rejected.json)).not.toContain("ts-secret");
	});

	it("grades through the injected Jev function and hides the key", async () => {
		let seen = 0;
		const server = deps({
			async grade(items) {
				seen = items.length;
				expect(JSON.stringify(items)).not.toMatch(/TYPESAFE|apiKey/);
				return items.map(() => ({ outcome: "partial" as const, feedback: "Close.", slip: false }));
			},
		});
		const graded = await route(
			"POST",
			"/v1/grade",
			{ items: [{ question: "Differentiate x^3", reference: "3x^2", answer: "3x" }] },
			server,
		);
		expect(graded.status).toBe(200);
		expect(seen).toBe(1);
		expect(graded.json).toMatchObject({ judgments: [{ outcome: "partial" }] });
	});

	it("serves the account site and keeps paid plans on Stripe", async () => {
		const site = readSite("/");
		expect(site?.type).toContain("text/html");
		expect(site?.body).toContain('src="/app.js?v=12"');
		expect(site?.body).toContain('href="/styles.css?v=3"');
		const script = readSite("/app.js")?.body ?? "";
		expect(script).toContain("Sign in with Google");
		expect(script).toContain("signInWithPopup");
		expect(script).toContain('href="https://community.obsidian.md/plugins/groundwork"');
		expect(script).toContain("Open Obsidian");
		expect(script).not.toContain("obsidian://groundwork?refresh=");
		expect(script).not.toContain("obsidian://show-plugin?id=groundwork");
		expect(script).toContain("/v1/groundwork");
		const board = script.slice(script.indexOf("function board"), script.indexOf("function usageTile"));
		expect(board).toContain("goals.length");
		expect(board).toContain("concepts.length");
		expect(board).toContain("conceptList(concepts)");
		expect(board).toContain("They show up here as you study.");
		expect(board).toContain("Goals you finish in Obsidian show up here.");
		expect(board).not.toContain('<span class="big">0</span>');
		expect(script).not.toContain("Connect Obsidian");
		const account = script.slice(script.indexOf("function showAccount"), script.indexOf("function renderChip"));
		const boardAt = account.indexOf("${board()}");
		const openAt = account.indexOf('id="open-obsidian"');
		const profileAt = account.indexOf(">Profile</h2>");
		expect(boardAt).toBeGreaterThan(-1);
		expect(openAt).toBeGreaterThan(boardAt);
		expect(profileAt).toBeGreaterThan(openAt);
		const signIn = script.slice(script.indexOf("function showSignIn"), script.indexOf("function showPlans"));
		expect(signIn).toContain("Sign in with Google");
		expect(signIn).not.toContain("planGrid");
		expect(script).toContain("Claude subscription on this computer");
		expect(script).toContain("One key covers every account");
		expect(script).not.toMatch(/\$3|\$8 of/);
		const tile = script.slice(script.indexOf("function usageTile"), script.indexOf("function keysSection"));
		expect(tile).toContain("Resets at the end of the month.");
		expect(tile).not.toContain("remainingUsd");
		expect(tile).not.toContain("creditUsd");
		expect(script).not.toContain("model credit left");
		expect(tile).not.toContain("left.");
		expect(readSite("/../.env")).toBeNull();

		const server = deps();
		const config = await route("GET", "/v1/web-config", null, server);
		expect(config.json).toMatchObject({ firebase: { projectId: "groundwork-6f9ca", authDomain: "groundwork-6f9ca.firebaseapp.com" }, billing: false });
		const paid = await route("POST", "/v1/account/plan", { plan: "included" }, server);
		expect(paid.status).toBe(503);

		const checkoutServer = deps({
			billing: billing({
				configured: true,
				async checkout(_uid, _email, plan) {
					return `https://checkout.stripe.test/${plan}`;
				},
			}),
		});
		const checkout = await route("POST", "/v1/billing/checkout", { plan: "byom" }, checkoutServer, undefined, { origin: "https://groundwork.test" });
		expect(checkout.json).toEqual({ url: "https://checkout.stripe.test/byom" });
		const direct = await route("POST", "/v1/account/plan", { plan: "included" }, checkoutServer);
		expect(direct.status).toBe(402);

		const profile = await route("POST", "/v1/account/profile", { displayName: "Ada Lovelace" }, server);
		expect(profile.json).toMatchObject({ displayName: "Ada Lovelace", email: "ada@example.com" });
	});

	it("shows quiz-checked concepts and finished goals, and hides notes", async () => {
		const server = deps();
		const before = await route("GET", "/v1/groundwork", null, server);
		expect(before.json).toEqual({ updatedAt: null, concepts: [], goals: [], graph: { width: 0, height: 0, nodes: [], edges: [], legend: [] } });
		const saved = await route(
			"PUT",
			"/v1/memory",
			{
				files: { "concepts/Limit.md": "private note about the learner" },
				knowledge: {
					updatedAt: "2026-10-02T00:00:00.000Z",
					concepts: [
						{ id: "limit", title: "Limit", status: "solid", current: 0.9, prerequisites: [] },
						{ id: "derivative", title: "Derivative $", status: "learning", current: 0.4, prerequisites: ["limit"] },
						{ id: "chain", title: "Chain rule", status: "unassessed", current: 0, prerequisites: ["derivative"] },
					],
					goals: [
						{ title: "The derivative", status: "done", built: 2, open: 0 },
						{ title: "Integrals $", status: "active", built: 0, open: 3 },
					],
				},
			},
			server,
		);
		expect(saved.status).toBe(200);
		const view = await route("GET", "/v1/groundwork", null, server);
		expect(view.status).toBe(200);
		const json = JSON.stringify(view.json);
		expect(json).not.toContain("private note");
		expect(json).not.toContain("$");
		expect(json).not.toMatch(/"built"|"open"|"current"/);
		expect(view.json).toMatchObject({
			concepts: [
				{ id: "chain", title: "Chain rule", status: "unassessed" },
				{ id: "derivative", title: "Derivative", status: "learning" },
				{ id: "limit", title: "Limit", status: "solid" },
			],
			goals: [{ title: "The derivative", status: "done", concepts: 2 }],
			graph: {
				edges: [
					{ from: "derivative", to: "chain", bridge: false },
					{ from: "limit", to: "derivative", bridge: false },
				],
			},
		});
		expect((view.json as { concepts: unknown[] }).concepts).toHaveLength(3);
		expect((view.json as { graph: { nodes: Array<{ id: string }> } }).graph.nodes.map((n) => n.id)).toContain("chain");
	});

	it("remembers the plan after the server process is gone", async () => {
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-accounts-")), "accounts.json");
		const first = deps({ accounts: new AccountDirectory(new FileAccountStore(file)) });
		const chosen = await route("POST", "/v1/account/plan", { plan: "free" }, first);
		expect(chosen.json).toMatchObject({ plan: "free", needsPlan: false });
		const named = await route("POST", "/v1/account/profile", { displayName: "Ada Lovelace" }, first);
		expect(named.json).toMatchObject({ displayName: "Ada Lovelace", plan: "free" });
		const restarted = deps({ accounts: new AccountDirectory(new FileAccountStore(file)) });
		const again = await route("GET", "/v1/account", null, restarted);
		expect(again.json).toMatchObject({ plan: "free", needsPlan: false, displayName: "Ada Lovelace", email: "ada@example.com" });
	});

	it("lists every concept note stored on the account, not only the saved snapshot", async () => {
		const server = deps();
		const saved = await route(
			"PUT",
			"/v1/memory",
			{
				files: {
					"concepts/Limit.md": "---\ntitle: Limit\n---\nprivate note about limits",
					"concepts/Derivative.md": "---\ntitle: Derivative\nprerequisites:\n  - \"[[Limit]]\"\n---\nprivate note about derivatives",
					"concepts/Integral.md": "---\ntitle: Integral\n---\nprivate note about integrals",
				},
				knowledge: {
					updatedAt: "2026-10-02T00:00:00.000Z",
					concepts: [{ id: "limit", title: "Limit", status: "solid", current: 0.9, prerequisites: [] }],
					goals: [],
				},
			},
			server,
		);
		expect(saved.status).toBe(200);
		const view = await route("GET", "/v1/groundwork", null, server);
		expect(view.status).toBe(200);
		const concepts = (view.json as { concepts: Array<{ id: string; title: string; status: string }> }).concepts;
		expect(concepts).toEqual([
			{ id: "derivative", title: "Derivative", status: "unassessed" },
			{ id: "integral", title: "Integral", status: "unassessed" },
			{ id: "limit", title: "Limit", status: "solid" },
		]);
		const json = JSON.stringify(view.json);
		expect(json).not.toContain("private note");
		expect((view.json as { graph: { nodes: Array<{ id: string }> } }).graph.nodes.map((node) => node.id).sort()).toEqual(["derivative", "integral", "limit"]);
	});

	it("shows the same concepts after the server process is gone", async () => {
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-memory-")), "memory.json");
		const knowledge = {
			concepts: [{ id: "limit", title: "Limit", status: "unassessed", current: 0, prerequisites: [] }],
			goals: [],
			updatedAt: "2026-10-02T00:00:00.000Z",
		};
		const first = deps({ memory: new MemoryDirectory(new FileTutorMemoryStore(file)) });
		const saved = await route("PUT", "/v1/memory", { files: { "learner.md": "Learns by examples." }, knowledge }, first);
		expect(saved.status).toBe(200);
		const restarted = deps({ memory: new MemoryDirectory(new FileTutorMemoryStore(file)) });
		const view = await route("GET", "/v1/groundwork", null, restarted);
		expect(view.json).toMatchObject({ concepts: [{ id: "limit", title: "Limit", status: "unassessed" }] });
		expect(JSON.stringify(view.json)).not.toContain("Learns by examples");
	});

	it("rejoins tutor memory split on a utf-8 boundary", () => {
		const text = "π".repeat(50);
		const parts = splitUtf8(text, 7);
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.join("")).toBe(text);
		for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(7);
	});

	it("keeps tutor memory on the signed-in account", async () => {
		const server = deps();
		const knowledge = { concepts: [], goals: [], updatedAt: "2026-10-02T00:00:00.000Z" };
		const saved = await route("PUT", "/v1/memory", { files: { "learner.md": "Learns by examples." }, knowledge }, server);
		expect(saved.status).toBe(200);
		expect(saved.json).toMatchObject({ files: { "learner.md": "Learns by examples." } });
		const loaded = await route("GET", "/v1/memory", null, server);
		expect(loaded.json).toMatchObject({ files: { "learner.md": "Learns by examples." } });
		const rejected = await route("PUT", "/v1/memory", { files: { "resources/secret.md": "no" }, knowledge }, server);
		expect(rejected.status).toBe(400);
		expect(JSON.stringify(rejected.json)).toMatch(/not tutor memory/);
		expect((await route("GET", "/v1/memory", null, server)).json).toMatchObject({ files: { "learner.md": "Learns by examples." } });
	});

	it("lets the plugin ack an Open Obsidian click before the page checks", async () => {
		const server = deps();
		const nonce = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const before = await route("GET", `/v1/obsidian-opened/${nonce}`, null, server);
		expect(before.json).toEqual({ opened: false });
		const signal = await route("GET", `/v1/obsidian-opened/${nonce}/signal`, null, server);
		expect(signal.status).toBe(200);
		expect(signal.json).toEqual({ ok: true });
		const after = await route("GET", `/v1/obsidian-opened/${nonce}`, null, server);
		expect(after.json).toEqual({ opened: true });
		const junk = await route("GET", "/v1/obsidian-opened/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/signal", null, server);
		expect(junk.status).toBe(400);
	});

	it("reports Jev as unavailable when the server key is missing", async () => {
		const server = deps({ jev: false });
		const health = await route("GET", "/health", null, server);
		expect(health.json).toMatchObject({ ok: true, jev: false, firebase: false });
		const graded = await route("POST", "/v1/grade", { items: [{ question: "q", reference: "a", answer: "b" }] }, server);
		expect(graded.status).toBe(503);
	});
});
