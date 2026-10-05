import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../src/accounts";
import { route, type ServerDeps } from "../src/app";
import type { Auth, Identity } from "../src/auth";
import type { Billing } from "../src/billing";
import { MemoryDirectory } from "../src/memory";
import { FileTutorMemoryStore } from "../src/memory-file";
import { SecretDirectory } from "../src/secrets";
import { FileSecretStore } from "../src/secret-store";

function billing(): Billing {
	return {
		configured: false,
		async checkout() {
			throw Object.assign(new Error("off"), { status: 503 });
		},
		async portal() {
			throw Object.assign(new Error("off"), { status: 503 });
		},
		async applyEvent() {
			throw Object.assign(new Error("off"), { status: 503 });
		},
	};
}

function multiAuth(users: Record<string, Identity>): Auth {
	return {
		firebase: true,
		async uid(authorization) {
			const match = authorization?.match(/^Bearer\s+(\S+)$/i);
			if (!match) throw Object.assign(new Error("Sign in required."), { status: 401 });
			const user = users[match[1]];
			if (!user) throw Object.assign(new Error("Sign in required."), { status: 401 });
			return user;
		},
		async revokeRefreshTokens() {},
	};
}

function authedDeps(over: Partial<ServerDeps> = {}): ServerDeps {
	const auth = multiAuth({
		"token-a": { uid: "user-a", email: "a@example.com" },
		"token-b": { uid: "user-b", email: "b@example.com" },
	});
	return {
		auth,
		accounts: new AccountDirectory(),
		secrets: new SecretDirectory(),
		billing: billing(),
		jev: true,
		memory: new MemoryDirectory(),
		async grade(items) {
			return items.map(() => ({ outcome: "correct" as const, feedback: "ok", slip: false }));
		},
		...over,
	};
}

const bearer = (token: string) => `Bearer ${token}`;

describe("/v1 route authz", () => {
	it("requires a bearer token when Firebase auth is on", async () => {
		const server = authedDeps();
		const denied = await route("GET", "/v1/account", null, server);
		expect(denied.status).toBe(401);
	});

	it("keeps tutor memory and secrets scoped to the signed-in uid", async () => {
		const memoryFile = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-mem-")), "memory.json");
		const secretFile = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-sec-")), "secrets.json");
		const server = authedDeps({
			memory: new MemoryDirectory(new FileTutorMemoryStore(memoryFile)),
			secrets: new SecretDirectory(new FileSecretStore(secretFile)),
		});
		const knowledge = { concepts: [], goals: [], updatedAt: "2026-10-02T00:00:00.000Z" };
		const saved = await route(
			"PUT",
			"/v1/memory",
			{ files: { "learner.md": "only A" }, knowledge, baseUpdatedAt: "" },
			server,
			bearer("token-a"),
		);
		expect(saved.status).toBe(200);
		await route("POST", "/v1/secrets", { provider: "openrouter", apiKey: "sk-a-only" }, server, bearer("token-a"));

		const bMemory = await route("GET", "/v1/memory", null, server, bearer("token-b"));
		expect(bMemory.status).toBe(200);
		expect((bMemory.json as { files: Record<string, string> }).files).toEqual({});

		const bSecret = await route("GET", "/v1/secrets", null, server, bearer("token-b"));
		expect(bSecret.json).toMatchObject({ providers: { openrouter: false } });
		expect(await server.secrets.get("user-b", "openrouter")).toBeUndefined();
		expect(await server.secrets.get("user-a", "openrouter")).toBe("sk-a-only");
	});

	it("does not expose obsidian-opened state across nonces", async () => {
		const server = authedDeps();
		const nonceA = "11111111-1111-4111-8111-111111111111";
		const nonceB = "22222222-2222-4222-8222-222222222222";
		await route("GET", `/v1/obsidian-opened/${nonceA}/signal`, null, server);
		const a = await route("GET", `/v1/obsidian-opened/${nonceA}`, null, server);
		const b = await route("GET", `/v1/obsidian-opened/${nonceB}`, null, server);
		expect(a.json).toEqual({ opened: true });
		expect(b.json).toEqual({ opened: false });
	});

	it("rejects an empty display name", async () => {
		const server = authedDeps();
		const bad = await route("POST", "/v1/account/profile", { displayName: "   " }, server, bearer("token-a"));
		expect(bad.status).toBe(400);
	});

	it("rejects an oversized provider key", async () => {
		const server = authedDeps();
		const bad = await route("POST", "/v1/secrets", { provider: "openrouter", apiKey: "x".repeat(600) }, server, bearer("token-a"));
		expect(bad.status).toBe(400);
	});

	it("allows public plan and web-config routes without a token", async () => {
		const server = authedDeps();
		expect((await route("GET", "/v1/plans", null, server)).status).toBe(200);
		expect((await route("GET", "/v1/web-config", null, server)).status).toBe(200);
		expect((await route("GET", "/health", null, server)).status).toBe(200);
	});
});

describe("provider key concurrency", () => {
	it("keeps both keys when two providers are saved in parallel", async () => {
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-sec-race-")), "secrets.json");
		const secrets = new SecretDirectory(new FileSecretStore(file));
		const server = authedDeps({ secrets });
		await Promise.all([
			route("POST", "/v1/secrets", { provider: "openrouter", apiKey: "sk-or-1" }, server, bearer("token-a")),
			route("POST", "/v1/secrets", { provider: "anthropic", apiKey: "sk-ant-1" }, server, bearer("token-a")),
		]);
		expect(await secrets.get("user-a", "openrouter")).toBe("sk-or-1");
		expect(await secrets.get("user-a", "anthropic")).toBe("sk-ant-1");
	});
});
