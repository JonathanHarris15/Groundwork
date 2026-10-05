import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileIdTokenDenylist, tokenIsRevoked } from "../src/id-token-denylist";

describe("id token denylist", () => {
	it("rejects tokens at or before the session revoke cutoff and explicit jti", () => {
		expect(tokenIsRevoked({ uid: "ada", iat: 100, jti: "a" }, 100, new Set())).toBe(true);
		expect(tokenIsRevoked({ uid: "ada", iat: 101, jti: "a" }, 100, new Set())).toBe(false);
		expect(tokenIsRevoked({ uid: "ada", iat: 200, jti: "x" }, undefined, new Set(["x"]))).toBe(true);
	});

	it("persists revokes on disk and prunes expired jti rows", async () => {
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-deny-")), "deny.json");
		const deny = new FileIdTokenDenylist(file);
		const now = Math.floor(Date.now() / 1000);
		await deny.revoke({ uid: "ada", jti: "old", iat: now - 60, exp: now - 1 });
		await deny.revoke({ uid: "ada", jti: "live", iat: now, exp: now + 3600 });
		expect(await deny.isRevoked({ uid: "ada", iat: now - 30, jti: "live" })).toBe(true);
		expect(await deny.isRevoked({ uid: "ada", iat: now + 5, jti: "fresh" })).toBe(false);
	});
});
