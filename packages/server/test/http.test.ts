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
import { resetCheckoutAmountLimits } from "../src/public-limit";
import { readSite } from "../src/static";
import { MemoryDirectory } from "../src/memory";
import { FileTutorMemoryStore } from "../src/memory-file";
import { splitUtf8 } from "../src/memory-firestore";
import { SecretDirectory } from "../src/secrets";
import { FileSecretStore } from "../src/secret-store";

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
	const auth: Auth = { firebase: false, async uid() { return { uid: "local", email: "ada@example.com", name: "Ada" }; }, async revokeRefreshTokens() {} };
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
		...over,
	};
}

describe("account server", () => {
	it("serves the three plans and an empty account", async () => {
		const server = deps();
		const plans = await route("GET", "/v1/plans", null, server);
		const listed = JSON.stringify(plans.json);
		expect(listed).toContain("Bring your own model");
		expect(listed).toContain('"priceUsdPerMonth":6');
		expect(listed).toContain('"priceUsdPerMonth":20');
		expect(listed).not.toContain('"priceUsdPerMonth":4');
		expect(listed).not.toContain('"priceUsdPerMonth":15');
		expect(listed).not.toMatch(/hostedCreditUsd|creditUsd|remainingUsd|\$1\.25|\$3|\$8/);
		const account = await route("GET", "/v1/account", null, server);
		expect(account.json).toMatchObject({ needsPlan: true, budgetUsed: 0 });
		expect(account.json).not.toHaveProperty("creditUsd");
		expect(account.json).not.toHaveProperty("remainingUsd");
		expect(account.json).toMatchObject({ created: true });
		expect(account.json).not.toHaveProperty("attribution");
		const returning = await route("GET", "/v1/account", null, server);
		expect(returning.json).toMatchObject({ created: false });
		const linked = await route("POST", "/v1/account/obsidian-connected", {}, server);
		expect(linked.json).toEqual({ first: true });
		expect(await route("POST", "/v1/account/obsidian-connected", {}, server)).toMatchObject({ json: { first: false }, status: 200 });
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
		expect(await server.secrets.get("local", "openrouter")).toBe("sk-or-secret");

		const listed = await route("GET", "/v1/secrets", null, server);
		expect(JSON.stringify(listed.json)).not.toContain("sk-or");
		expect(Object.keys((listed.json as { providers: object }).providers).sort()).toEqual([...USER_KEY_PROVIDERS].sort());

		const jev = await route("POST", "/v1/secrets", { provider: "jev", apiKey: "ts-secret" }, server);
		expect(jev.status).toBe(400);
		expect(JSON.stringify(jev.json)).toMatch(/server/);
		expect(await server.secrets.get("local", "openrouter")).toBe("sk-or-secret");
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
		expect(site?.body).toContain('src="/force-graph.js?v=4"');
		expect(site?.body).toContain('src="/app.js?v=24"');
		expect(site?.body).toContain('href="/styles.css?v=18"');
		expect(site?.body).toContain("/hero/concept-map-768.webp");
		expect(site?.body).toContain("image/avif");
		expect(site?.body).not.toContain('id="hero-graph"');
		const hero = readSite("/hero/concept-map-768.webp");
		expect(hero?.type).toBe("image/webp");
		expect(Buffer.isBuffer(hero?.body)).toBe(true);
		expect((hero?.body as Buffer).byteLength).toBeGreaterThan(1000);
		expect(readSite("/hero/concept-map-768.avif")?.type).toBe("image/avif");
		const quiz = readSite("/shots/quiz-768.webp");
		expect(quiz?.type).toBe("image/webp");
		expect(Buffer.isBuffer(quiz?.body) && quiz.body.length).toBeGreaterThan(1000);
		expect(readSite("/shots/exam-map-480.avif")?.type).toBe("image/avif");
		expect(readSite("/shots/../hero/concept-map.png")).toBeNull();
		expect(site?.body).toContain("Start free");
		expect(site?.body).toContain("methoddev1505@gmail.com");
		expect(site?.body).not.toContain("[Dev:");
		expect(site?.body).not.toContain("coming soon");
		const script = readSite("/app.js")?.body ?? "";
		expect(script).toContain("Sign in with Google");
		expect(script).toContain("signInWithPopup");
		expect(script).toContain("obsidian://groundwork?refresh=");
		expect(script).toContain("https://obsidian.md/download");
		expect(script).toContain("obsidian://show-plugin?id=groundwork");
		expect(script).toContain("https://community.obsidian.md/plugins/groundwork");
		expect(script).toContain("Open Obsidian");
		expect(script).toContain("/v1/groundwork");
		expect(script).toContain("/v1/auth/sign-out");
		const board = script.slice(script.indexOf("function board"), script.indexOf("function graphLegend"));
		expect(board).toContain("goals.length");
		expect(board).toContain('<span class="tile-label">Goals reached</span>');
		expect(board).toContain("concepts.length");
		expect(board).toContain("conceptListPanel(concepts)");
		expect(board).toContain("boardQuota()");
		expect(board).toContain("Tutor usage this month");
		expect(board).toContain("budgetUsed");
		expect(board).not.toContain("stats-pair");
		expect(board).not.toContain("remainingUsd");
		expect(board).not.toContain("creditUsd");
		expect(script).toContain("concept-filter");
		expect(script).toContain("They show up here as you study.");
		expect(script).toContain("Goals you finish in Obsidian show up here.");
		expect(board).not.toContain('<span class="big">0</span>');
		expect(script).not.toContain("Connect Obsidian");
		const account = script.slice(script.indexOf("function showAccount"), script.indexOf("function renderChip"));
		expect(account).toContain("firstRunChecklist");
		expect(account).toContain("studyRecordIsEmpty");
		expect(account).toContain('id="open-obsidian"');
		expect(account.indexOf(">Profile</h2>")).toBeGreaterThan(account.indexOf('id="open-obsidian"'));
		const signIn = script.slice(script.indexOf("function showSignIn"), script.indexOf("function showPlans"));
		expect(signIn).toContain("Sign in with Google");
		expect(signIn).toContain("Continue on this device");
		expect(signIn).toContain("By continuing you confirm you're 18 or older and agree to the <a href=\"/terms\">Terms</a>.");
		expect(script).toContain("conceptGraphHost");
		expect(script).toContain("graph-shell");
		expect(script).toContain("is-empty");
		expect(signIn).not.toContain("planGrid");
		expect(script).toContain("Claude subscription on this computer");
		expect(script).toContain("Written quiz answers are graded");
		expect(script).not.toMatch(/\bJev\b/);
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
		expect(config.json).toMatchObject({
			firebase: { projectId: "groundwork-6f9ca", authDomain: "groundwork-6f9ca.firebaseapp.com" },
			billing: false,
			localDev: true,
		});
		expect(readSite("/404.html")?.body).toContain("Page not found");
		expect(readSite("/favicon.svg")?.type).toContain("image/svg+xml");
		const health = await route("GET", "/health", null, server);
		expect(health).toMatchObject({ status: 200, json: { ok: true } });
		const prodAuth = deps({
			auth: {
				firebase: true,
				async uid() {
					throw Object.assign(new Error("Sign in required."), { status: 401 });
				},
				async revokeRefreshTokens() {},
			},
		});
		const prodConfig = await route("GET", "/v1/web-config", null, prodAuth);
		expect(prodConfig.json).toMatchObject({ localDev: false });
		const paid = await route("POST", "/v1/account/plan", { plan: "included" }, server);
		expect(paid.status).toBe(503);

		let checkoutGa: unknown;
		const checkoutServer = deps({
			billing: billing({
				configured: true,
				async checkout(_uid, _email, plan, _origin, ga) {
					checkoutGa = ga;
					return `https://checkout.stripe.test/${plan}`;
				},
			}),
		});
		const checkout = await route("POST", "/v1/billing/checkout", { plan: "byom" }, checkoutServer, undefined, { origin: "https://groundwork.test" });
		expect(checkout.json).toEqual({ url: "https://checkout.stripe.test/byom" });
		const tracked = await route(
			"POST",
			"/v1/billing/checkout",
			{ plan: "included", gaClientId: "123.456", gaSessionId: "99", gclid: "not valid", gaConsent: "denied" },
			checkoutServer,
			undefined,
			{ origin: "https://groundwork.test", attribution: encodeURIComponent(JSON.stringify({ gclid: "CjwKCtestclick" })) },
		);
		expect(tracked.json).toEqual({ url: "https://checkout.stripe.test/included" });
		expect(checkoutGa).toEqual({ gaClientId: "123.456", gaSessionId: "99", gclid: "CjwKCtestclick", consent: "denied" });
		const amountServer = deps({
			auth: {
				firebase: true,
				async uid() {
					throw Object.assign(new Error("Sign in required."), { status: 401 });
				},
				async revokeRefreshTokens() {},
			},
			billing: billing({
				configured: true,
				async checkoutAmount(sessionId) {
					return sessionId === "cs_free" ? 0 : null;
				},
			}),
		});
		const zero = await route("GET", "/v1/billing/checkout-amount", null, amountServer, undefined, { sessionId: "cs_free" });
		expect(zero).toEqual({ status: 200, json: { amountUsd: 0, currency: "USD" } });
		const unknown = await route("GET", "/v1/billing/checkout-amount", null, amountServer, undefined, { sessionId: "nope" });
		expect(unknown.status).toBe(404);
		resetCheckoutAmountLimits();
		let limited = 0;
		for (let n = 0; n < 31; n++) {
			const hit = await route("GET", "/v1/billing/checkout-amount", null, amountServer, undefined, { sessionId: "cs_free", ip: "203.0.113.8" });
			if (hit.status === 429) limited++;
		}
		expect(limited).toBe(1);
		expect(readSite("/og.png")?.type).toBe("image/png");
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

	it("revokes refresh tokens on website sign-out", async () => {
		const server = deps();
		let revoked: string | null = null;
		server.auth = {
			firebase: true,
			async uid() {
				return { uid: "local", email: "ada@example.com", name: "Ada" };
			},
			async revokeRefreshTokens(uid) {
				revoked = uid;
			},
		};
		const out = await route("POST", "/v1/auth/sign-out", {}, server, "Bearer test-token");
		expect(out.status).toBe(200);
		expect(out.json).toEqual({ ok: true });
		expect(revoked).toBe("local");
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

	it("sets the plan from Stripe before the account is shown, and will not drop a paid plan locally", async () => {
		const accounts = new AccountDirectory();
		let syncs = 0;
		const server = deps({
			accounts,
			billing: billing({
				configured: true,
				async sync(uid) {
					syncs++;
					await accounts.setPlan(uid, "included");
				},
			}),
		});
		const view = await route("GET", "/v1/account", null, server);
		expect(view.status).toBe(200);
		expect(view.json).toMatchObject({ plan: "included", needsPlan: false });
		expect(syncs).toBe(1);
		const refused = await route("POST", "/v1/account/plan", { plan: "free" }, server);
		expect(refused.status).toBe(409);
		expect(refused.json).toEqual({ error: "A Stripe subscription is active on this account. Change or cancel it from billing." });
		expect(JSON.stringify(refused.json)).not.toMatch(/\$|hostedCredit/);
		expect((await route("GET", "/v1/account", null, server)).json).toMatchObject({ plan: "included" });

		const quiet = deps({
			billing: billing({
				configured: true,
				async sync() {
					syncs++;
				},
			}),
		});
		await route("GET", "/v1/groundwork", null, quiet);
		await route("GET", "/v1/memory", null, quiet);
		await route("POST", "/v1/grade", { items: [{ question: "q", reference: "a", answer: "b" }] }, quiet);
		expect(syncs).toBe(3);
		await route("GET", "/v1/account", null, quiet);
		expect(syncs).toBe(4);
	});

	it("still serves the account when Stripe cannot be reached", async () => {
		const server = deps({
			billing: billing({
				configured: true,
				async sync() {
					throw new Error("stripe down");
				},
			}),
		});
		const view = await route("GET", "/v1/account", null, server);
		expect(view.status).toBe(200);
		expect(view.json).toMatchObject({ needsPlan: true });
	});

	it("keeps a provider key after the server process is gone, and still does not return it", async () => {
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-secrets-")), "secrets.json");
		const first = deps({ secrets: new SecretDirectory(new FileSecretStore(file)) });
		const saved = await route("POST", "/v1/secrets", { provider: "openrouter", apiKey: "sk-or-secret" }, first);
		expect(saved.status).toBe(200);
		expect(JSON.stringify(saved.json)).not.toContain("sk-or-secret");
		const restarted = deps({ secrets: new SecretDirectory(new FileSecretStore(file)) });
		expect(await restarted.secrets.get("local", "openrouter")).toBe("sk-or-secret");
		const listed = await route("GET", "/v1/secrets", null, restarted);
		expect(JSON.stringify(listed.json)).not.toContain("sk-or-secret");
		expect(listed.json).toMatchObject({ providers: { openrouter: true } });
	});

	it("refuses a tutor-memory save that would wipe another device", async () => {
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-memory-conflict-")), "memory.json");
		const knowledge = { concepts: [], goals: [], updatedAt: "2026-10-02T00:00:00.000Z" };
		const laptop = deps({ memory: new MemoryDirectory(new FileTutorMemoryStore(file)) });
		const saved = await route("PUT", "/v1/memory", { files: { "learner.md": "from the laptop" }, knowledge, baseUpdatedAt: "" }, laptop);
		expect(saved.status).toBe(200);
		const updatedAt = (saved.json as { updatedAt: string }).updatedAt;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const phone = deps({ memory: new MemoryDirectory(new FileTutorMemoryStore(file)) });
		const added = await route(
			"PUT",
			"/v1/memory",
			{
				files: {
					"learner.md": "from the laptop",
					"concepts/Limit.md": "---\ntitle: Limit\n---\nprivate note",
				},
				knowledge,
				baseUpdatedAt: updatedAt,
			},
			phone,
		);
		expect(added.status).toBe(200);
		const stale = await route("PUT", "/v1/memory", { files: { "learner.md": "from the laptop only" }, knowledge, baseUpdatedAt: updatedAt }, laptop);
		expect(stale.status).toBe(409);
		expect(JSON.stringify(stale.json)).not.toMatch(/\$|hostedCredit/);
		const memory = (stale.json as { memory: { files: Record<string, string> } }).memory;
		expect(memory.files["concepts/Limit.md"]).toContain("title: Limit");
		expect(memory.files["learner.md"]).toBe("from the laptop");
		const kept = await route("GET", "/v1/memory", null, phone);
		expect((kept.json as { files: Record<string, string> }).files["concepts/Limit.md"]).toContain("Limit");
	});

	it("hides a database permission error from the sign-in page", async () => {
		const accounts = {
			async seen() {
				throw new Error("7 PERMISSION_DENIED: Missing or insufficient permissions.");
			},
		} as unknown as AccountDirectory;
		const result = await route("GET", "/v1/account", null, deps({ accounts }));
		expect(result.status).toBe(503);
		expect(JSON.stringify(result.json)).not.toContain("PERMISSION_DENIED");
		expect(JSON.stringify(result.json)).not.toContain("insufficient");
		expect((result.json as { error: string }).error).toContain("account");
	});

	it("reports Jev as unavailable when the server key is missing", async () => {
		const server = deps({ jev: false });
		const health = await route("GET", "/health", null, server);
		expect(health.json).toMatchObject({ ok: true, jev: false, firebase: false });
		const graded = await route("POST", "/v1/grade", { items: [{ question: "q", reference: "a", answer: "b" }] }, server);
		expect(graded.status).toBe(503);
		const context = await route("POST", "/v1/context", { message: "hi", pieces: [] }, server);
		expect(context.status).toBe(503);
	});

	it("selects context pieces and refuses a client API key", async () => {
		let seen = "";
		const server = deps({
			async selectContext(message, pieces) {
				seen = message;
				expect(JSON.stringify(pieces)).not.toMatch(/apiKey|TYPESAFE/);
				return pieces.filter((piece) => piece.kind === "file").map((piece) => piece.id);
			},
		});
		const rejected = await route("POST", "/v1/context", { apiKey: "ts-secret", message: "hi", pieces: [] }, server);
		expect(rejected.status).toBe(400);
		expect(JSON.stringify(rejected.json)).not.toContain("ts-secret");
		const chosen = await route(
			"POST",
			"/v1/context",
			{
				message: "Read lecture 3",
				pieces: [{ id: "file:resources/lecture-3.md", kind: "file", title: "lecture-3.md", text: "The chain rule.", attached: true }],
			},
			server,
		);
		expect(chosen.status).toBe(200);
		expect(seen).toBe("Read lecture 3");
		expect(chosen.json).toEqual({ included: ["file:resources/lecture-3.md"] });
	});
});
