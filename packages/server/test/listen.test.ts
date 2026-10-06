import { describe, expect, it } from "vitest";
import { httpsRedirectTarget, isLocalHost, listenTarget } from "../src/listen";

describe("listen address", () => {
	it("stays on loopback for the local server", () => {
		expect(listenTarget({})).toEqual({ host: "127.0.0.1", port: 8787 });
		expect(listenTarget({ GROUNDWORK_PORT: "8799" })).toEqual({ host: "127.0.0.1", port: 8799 });
	});

	it("follows Cloud Run's PORT onto all interfaces", () => {
		expect(listenTarget({ PORT: "8080" })).toEqual({ host: "0.0.0.0", port: 8080 });
		expect(isLocalHost("0.0.0.0")).toBe(false);
		expect(isLocalHost("127.0.0.1")).toBe(true);
	});

	it("redirects forwarded http to https and leaves loopback alone", () => {
		expect(httpsRedirectTarget("http", "groundworklearn.com", "/pricing")).toBe("https://groundworklearn.com/pricing");
		expect(httpsRedirectTarget("http", "127.0.0.1:8787", "/")).toBeNull();
		expect(httpsRedirectTarget("https", "groundworklearn.com", "/")).toBeNull();
	});
});
