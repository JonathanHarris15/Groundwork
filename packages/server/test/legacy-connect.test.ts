import { describe, expect, it } from "vitest";
import { compareVersions, emptyLegacyCache, legacyConnectStatus, legacyFromStoreVersion, parseStoreVersion } from "../src/legacy-connect";
import { publicSetupRoute } from "../src/setup-routes";
import type { Auth } from "../src/auth";

const auth: Auth = {
	firebase: false,
	async uid() {
		return { uid: "local" };
	},
	async revokeRefreshTokens() {},
};

function page(version: string): string {
	return `<div class="text-muted">Current version</div><div class="">${version}</div>`;
}

describe("legacy connect", () => {
	it("parses the community page version", () => {
		expect(parseStoreVersion(page("0.2.1"))).toBe("0.2.1");
		expect(parseStoreVersion("no version here")).toBeNull();
	});

	it("compares numeric tuples", () => {
		expect(compareVersions("0.2.2", "0.2.3")).toBe(-1);
		expect(compareVersions("0.2.3", "0.2.3")).toBe(0);
		expect(compareVersions("0.2.10", "0.2.3")).toBe(1);
		expect(compareVersions("0.10.0", "0.2.3")).toBe(1);
		expect(compareVersions("beta", "0.2.3")).toBeNull();
	});

	it("keeps the older link until the store lists 0.2.3", () => {
		expect(legacyFromStoreVersion("0.2.1")).toBe(true);
		expect(legacyFromStoreVersion("0.2.2")).toBe(true);
		expect(legacyFromStoreVersion("0.2.3")).toBe(false);
		expect(legacyFromStoreVersion("0.2.10")).toBe(false);
		expect(legacyFromStoreVersion(null)).toBe(true);
	});

	it("serves the store decision and honors the flag", async () => {
		const listed = await publicSetupRoute("GET", "/v1/setup/legacy-connect", null, {
			auth,
			env: {},
			fetchImpl: async () => new Response(page("0.2.1"), { status: 200 }),
			legacyCache: emptyLegacyCache(),
		});
		expect(listed?.json).toEqual({ legacy: true, storeVersion: "0.2.1", codeSince: "0.2.3" });

		const current = await legacyConnectStatus({
			env: {},
			fetchImpl: async () => new Response(page("0.2.3"), { status: 200 }),
			now: 1_000,
			cache: emptyLegacyCache(),
		});
		expect(current).toEqual({ legacy: false, storeVersion: "0.2.3", codeSince: "0.2.3" });

		let fetches = 0;
		const cache = emptyLegacyCache();
		const fetchImpl = async () => {
			fetches += 1;
			return new Response(page("0.2.2"), { status: 200 });
		};
		await legacyConnectStatus({ env: {}, fetchImpl, now: 5_000, cache });
		await legacyConnectStatus({ env: {}, fetchImpl, now: 5_000 + 60_000, cache });
		expect(fetches).toBe(1);

		const forcedOff = await legacyConnectStatus({
			env: { GROUNDWORK_LEGACY_CONNECT: "0" },
			fetchImpl: async () => {
				throw new Error("store should not be read");
			},
			now: 1,
			cache: emptyLegacyCache(),
		});
		expect(forcedOff.legacy).toBe(false);
		expect(forcedOff.storeVersion).toBeNull();

		const forcedOn = await legacyConnectStatus({
			env: { GROUNDWORK_LEGACY_CONNECT: "1" },
			fetchImpl: async () => new Response(page("0.2.3"), { status: 200 }),
			now: 1,
			cache: emptyLegacyCache(),
		});
		expect(forcedOn.legacy).toBe(true);

		const down = await legacyConnectStatus({
			env: {},
			fetchImpl: async () => new Response("nope", { status: 503 }),
			now: 1,
			cache: emptyLegacyCache(),
		});
		expect(down).toEqual({ legacy: true, storeVersion: null, codeSince: "0.2.3" });
	});
});
