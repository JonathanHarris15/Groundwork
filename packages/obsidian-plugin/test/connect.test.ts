import { describe, expect, it } from "vitest";
import { sessionFromRedeem } from "../src/connect";
import { parseGroundworkCode } from "../src/open-link";

describe("setup code session", () => {
	it("reads a one-time code from the protocol link", () => {
		expect(parseGroundworkCode("abcde-fghjk")).toBe("ABCDEFGHJK");
		expect(parseGroundworkCode("ABCDE-FGHIJ")).toBeNull();
		expect(parseGroundworkCode(undefined)).toBeNull();
	});

	it("exchanges a custom token and keeps a local token as-is", async () => {
		const exchanged = await sessionFromRedeem({ customToken: "custom", email: "ada@example.com", displayName: "Ada" }, async () => ({ refreshToken: "refresh" }));
		expect(exchanged).toEqual({ refreshToken: "refresh", label: "Ada" });
		const local = await sessionFromRedeem({ token: "local", email: "local@groundwork.test" }, async () => {
			throw new Error("should not exchange");
		});
		expect(local).toEqual({ refreshToken: "local", label: "local@groundwork.test" });
		await expect(sessionFromRedeem({ error: "That code expired. Create a new one on the website." }, async () => ({ refreshToken: "no" }))).rejects.toThrow(/expired/);
	});
});
