import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DecodedIdToken } from "firebase-admin/auth";
import { createFirebaseAuth } from "../src/auth";
import { FileIdTokenDenylist } from "../src/id-token-denylist";

function decoded(partial: Partial<DecodedIdToken> & { uid: string }): DecodedIdToken {
	return {
		aud: "x",
		auth_time: partial.iat ?? 1,
		exp: partial.exp ?? 9_999_999_999,
		firebase: { identities: {}, sign_in_provider: "custom" },
		iat: partial.iat ?? 1,
		iss: "https://securetoken.google.com/x",
		sub: partial.uid,
		uid: partial.uid,
		...partial,
	} as DecodedIdToken;
}

describe("firebase auth denylist", () => {
	it("rejects an ID token after sign-out revokes the session", async () => {
		const file = path.join(mkdtempSync(path.join(os.tmpdir(), "gw-auth-deny-")), "deny.json");
		const denylist = new FileIdTokenDenylist(file);
		const token = decoded({ uid: "ada", jti: "jwt-1", iat: 1_700_000_000 });
		const admin = {
			async verifyIdToken(id: string) {
				if (id !== "id-ada") throw new Error("bad token");
				return token;
			},
			async revokeRefreshTokens(uid: string) {
				expect(uid).toBe("ada");
			},
		};
		const auth = createFirebaseAuth(admin as ReturnType<typeof import("firebase-admin/auth").getAuth>, denylist);
		await expect(auth.uid("Bearer id-ada")).resolves.toMatchObject({ uid: "ada" });
		await auth.revokeRefreshTokens("ada", "Bearer id-ada");
		await expect(auth.uid("Bearer id-ada")).rejects.toMatchObject({ status: 401 });
	});
});
