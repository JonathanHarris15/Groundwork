import { describe, expect, it } from "vitest";
import { USER_KEY_PROVIDERS } from "@groundwork/core";
import { AccountDirectory } from "../src/accounts";
import { route, type ServerDeps } from "../src/app";
import type { Auth } from "../src/auth";
import type { Billing } from "../src/billing";
import { readSite } from "../src/static";
import { MemoryDirectory } from "../src/memory";
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
		expect(JSON.stringify(plans.json)).toContain("$3 of model credit");
		const account = await route("GET", "/v1/account", null, server);
		expect(account.json).toMatchObject({ needsPlan: true, remainingUsd: 0 });
	});

	it("saves a plan and reports the free credit", async () => {
		const server = deps();
		const chosen = await route("POST", "/v1/account/plan", { plan: "free" }, server);
		expect(chosen.status).toBe(200);
		expect(chosen.json).toMatchObject({ plan: "free", creditUsd: 3, remainingUsd: 3, ownModel: false });
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
		expect(site?.body).toContain('src="/app.js"');
		const script = readSite("/app.js")?.body ?? "";
		expect(script).toContain("Sign in with Google");
		expect(script).toContain("signInWithPopup");
		expect(script).toContain("obsidian://groundwork?refresh=");
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

	it("reports Jev as unavailable when the server key is missing", async () => {
		const server = deps({ jev: false });
		const health = await route("GET", "/health", null, server);
		expect(health.json).toMatchObject({ ok: true, jev: false, firebase: false });
		const graded = await route("POST", "/v1/grade", { items: [{ question: "q", reference: "a", answer: "b" }] }, server);
		expect(graded.status).toBe(503);
	});
});
