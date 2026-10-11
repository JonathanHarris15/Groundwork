import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECT_CODE_TTL_MS, formatConnectCode, normalizeConnectCode } from "@groundwork/core";
import { route, type ServerDeps } from "../src/app";
import { AccountDirectory } from "../src/accounts";
import type { Billing } from "../src/billing";
import { ConnectCodeDirectory, hashConnectCode } from "../src/connect-codes";
import { FileConnectCodeStore, MemoryConnectCodeStore } from "../src/connect-code-store";
import { MemoryDirectory } from "../src/memory";
import { emptyDownloadCache, resolveObsidianDownload } from "../src/obsidian-downloads";
import { SecretDirectory } from "../src/secrets";
import { MemorySetupFunnel } from "../src/setup-funnel";
import { setupPageUrl } from "../src/setup-qr";
import { setupFunnelSection } from "../src/usage-page";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function codeAt(n: number): string {
	return `ABCDEFGHJ${ALPHABET[n % ALPHABET.length]}`;
}

function billing(): Billing {
	return {
		configured: false,
		async checkout() {
			return "";
		},
		async portal() {
			return "";
		},
		async applyEvent() {},
	};
}

function server(over: Partial<ServerDeps> = {}): ServerDeps {
	return {
		auth: {
			firebase: false,
			async uid() {
				return { uid: "local", email: "ada@example.com", name: "Ada Lovelace" };
			},
			async revokeRefreshTokens() {},
		},
		accounts: new AccountDirectory(),
		secrets: new SecretDirectory(),
		billing: billing(),
		jev: false,
		memory: new MemoryDirectory(),
		async grade() {
			return [];
		},
		async selectContext() {
			return [];
		},
		...over,
	};
}

describe("connect codes", () => {
	it("normalizes a dashed code and rejects ambiguous characters", () => {
		expect(normalizeConnectCode("abcde-fghjk")).toBe("ABCDEFGHJK");
		expect(formatConnectCode("ABCDEFGHJK")).toBe("ABCDE-FGHJK");
		expect(normalizeConnectCode("ABCDE-FGHIJ")).toBeNull();
		expect(normalizeConnectCode("00000-00000")).toBeNull();
		expect(normalizeConnectCode("short")).toBeNull();
	});

	it("issues a code once, expires it, and never stores the raw code", async () => {
		const file = path.join(mkdtempSync(path.join(tmpdir(), "gw-codes-")), "codes.json");
		let now = 1_000_000;
		const codes = new ConnectCodeDirectory(new FileConnectCodeStore(file), () => now, () => "ABCDEFGHJK");
		const issued = await codes.issue("ada", { email: "ada@example.com", displayName: "Ada" });
		expect(issued.code).toBe("ABCDE-FGHJK");
		const stored = readFileSync(file, "utf8");
		expect(stored).not.toContain("ABCDEFGHJK");
		expect(stored).not.toContain("ABCDE-FGHJK");
		expect(stored).toContain(hashConnectCode("ABCDEFGHJK"));

		expect(await codes.redeem("ABCDE-FGHJK")).toMatchObject({ ok: true, uid: "ada", email: "ada@example.com", displayName: "Ada" });
		expect(await codes.redeem("abcde fghjk")).toMatchObject({ ok: false, status: 410, error: "That code was already used. Create a new one on the website." });

		const fresh = new ConnectCodeDirectory(new FileConnectCodeStore(file), () => now, () => "KLMNPQRSTU");
		await fresh.issue("ada", { email: "ada@example.com" });
		now += CONNECT_CODE_TTL_MS + 1;
		expect(await fresh.redeem("KLMNP-QRSTU")).toMatchObject({ ok: false, status: 410, error: "That code expired. Create a new one on the website." });
		expect(await fresh.redeem("nope")).toMatchObject({ ok: false, status: 400, error: "That code doesn't look right." });
		expect(readFileSync(file, "utf8")).not.toContain("KLMNPQRSTU");
	});

	it("stops issuing after ten codes in the window", async () => {
		let n = 0;
		const codes = new ConnectCodeDirectory(new MemoryConnectCodeStore(), () => 5_000, () => codeAt(n++));
		for (let i = 0; i < 10; i++) await codes.issue("ada", { email: "ada@example.com" });
		await expect(codes.issue("ada", {})).rejects.toMatchObject({ status: 429 });
	});

	it("redeems a local token through the route and counts the funnel", async () => {
		let n = 0;
		const funnel = new MemorySetupFunnel();
		const deps = server({
			connectCodes: new ConnectCodeDirectory(new MemoryConnectCodeStore(), () => 5_000, () => codeAt(n++)),
			setupFunnel: funnel,
		});
		const issued = await route("POST", "/v1/connect/code", {}, deps);
		expect(issued.status).toBe(200);
		const code = (issued.json as { code: string }).code;
		expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
		const redeemed = await route("POST", "/v1/connect/redeem", { code }, deps);
		expect(redeemed.status).toBe(200);
		expect(redeemed.json).toMatchObject({ token: "local", email: "ada@example.com", displayName: "Ada Lovelace" });
		expect(redeemed.json).not.toHaveProperty("customToken");
		expect(await route("POST", "/v1/connect/redeem", { code }, deps)).toMatchObject({ status: 410 });
		expect(await funnel.counts()).toMatchObject({ signup: 1 });

		const install = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		expect((await route("POST", "/v1/plugin/heartbeat", { installId: install }, deps)).status).toBe(200);
		expect((await route("POST", "/v1/plugin/heartbeat", { installId: install }, deps)).status).toBe(200);
		expect((await route("POST", "/v1/plugin/heartbeat", { installId: "nope" }, deps)).status).toBe(400);
		expect(await funnel.counts()).toMatchObject({ plugin_installed: 1 });

		const linked = await route("POST", "/v1/account/obsidian-connected", {}, deps);
		expect(linked.json).toEqual({ first: true });
		expect(await funnel.counts()).toMatchObject({ account_connected: 1 });
		await route("POST", "/v1/account/obsidian-connected", {}, deps);
		expect(await funnel.counts()).toMatchObject({ account_connected: 1 });
		const html = setupFunnelSection(await funnel.counts());
		expect(html).toContain("Signed up");
		expect(html).toContain("First tutor turn");
		expect(html).toContain("From the previous step");
	});

	it("mints a custom token when Firebase can, and keeps the raw code out of the response token", async () => {
		let n = 0;
		const deps = server({
			auth: {
				firebase: true,
				async uid() {
					return { uid: "firebase-ada", email: "ada@example.com", name: "Ada" };
				},
				async revokeRefreshTokens() {},
				async mintCustomToken(uid: string) {
					return `custom:${uid}`;
				},
			},
			connectCodes: new ConnectCodeDirectory(new MemoryConnectCodeStore(), () => 5_000, () => codeAt(n++)),
		});
		const issued = await route("POST", "/v1/connect/code", {}, deps);
		const code = (issued.json as { code: string }).code;
		const redeemed = await route("POST", "/v1/connect/redeem", { code }, deps);
		expect(redeemed.json).toEqual({ customToken: "custom:firebase-ada", email: "ada@example.com", displayName: "Ada" });
		expect(JSON.stringify(redeemed.json)).not.toContain(code.replace("-", ""));
	});

	it("points the QR code at an allowed host only", () => {
		expect(setupPageUrl("evil.example", "https")).toBe("https://groundworklearn.com/get-started");
		expect(setupPageUrl("localhost:8787", "http")).toBe("http://localhost:8787/get-started");
		expect(setupPageUrl("groundworklearn.com", "https")).toBe("https://groundworklearn.com/get-started");
		expect(setupPageUrl("groundwork-abc.a.run.app", "https")).toBe("https://groundwork-abc.a.run.app/get-started");
		expect(setupPageUrl("notgroundworklearn.com", "https")).toBe("https://groundworklearn.com/get-started");
	});

	it("uses a release asset when GitHub lists one", async () => {
		const cache = emptyDownloadCache();
		const fetchImpl = async () =>
			new Response(
				JSON.stringify({
					assets: [
						{ name: "Obsidian-1.7.7.exe", browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.7.7/Obsidian-1.7.7.exe" },
						{ name: "Obsidian-1.7.7.dmg", browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.7.7/Obsidian-1.7.7.dmg" },
						{ name: "Obsidian-1.7.7.AppImage", browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.7.7/Obsidian-1.7.7.AppImage" },
					],
				}),
				{ status: 200 },
			);
		await expect(resolveObsidianDownload("linux", fetchImpl, 10, cache)).resolves.toContain("AppImage");
		await expect(resolveObsidianDownload("windows", fetchImpl, 10, cache)).resolves.toContain(".exe");
		const missed = emptyDownloadCache();
		await expect(resolveObsidianDownload("mac", async () => new Response("no", { status: 500 }), 10, missed)).resolves.toBe("https://obsidian.md/download");
	});

	it("records a signed-in download click and redirects an unsigned download", async () => {
		const funnel = new MemorySetupFunnel();
		const deps = server({
			setupFunnel: funnel,
			fetchImpl: async () => new Response(JSON.stringify({ assets: [] }), { status: 200 }),
			downloadCache: emptyDownloadCache(),
		});
		const posted = await route("POST", "/v1/setup/obsidian-download", { os: "linux" }, deps);
		expect(posted.status).toBe(200);
		expect(posted.json).toMatchObject({ url: "https://obsidian.md/download" });
		expect(await funnel.counts()).toMatchObject({ obsidian_download_click: 1, signup: 1 });
		const redirect = await route("GET", "/v1/setup/obsidian-download", null, deps, undefined, { search: "?os=mac" });
		expect(redirect.status).toBe(302);
		expect(redirect.headers?.location).toBe("https://obsidian.md/download");
		expect(await funnel.counts()).toMatchObject({ obsidian_download_click: 1 });
	});
});
