import type { Auth } from "./auth";
import type { ConnectCodeDirectory } from "./connect-codes";
import { emptyLegacyCache, legacyConnectStatus, type LegacyConnectCache } from "./legacy-connect";
import { emptyDownloadCache, isObsidianOs, OBSIDIAN_DOWNLOAD_FALLBACK, resolveObsidianDownload, type DownloadCache } from "./obsidian-downloads";
import { platformFetch, type FetchLike } from "./platform-fetch";
import { setupPageUrl, setupQrSvg } from "./setup-qr";
import { funnelActor, type SetupFunnel } from "./setup-funnel";

export interface SetupRouteDeps {
	auth: Auth;
	connectCodes?: ConnectCodeDirectory;
	setupFunnel?: SetupFunnel;
	fetchImpl?: FetchLike;
	downloadCache?: DownloadCache;
	/** When set, overrides process.env for the legacy-connect flag. */
	env?: NodeJS.ProcessEnv;
	legacyCache?: LegacyConnectCache;
}

export interface SetupRouteMeta {
	search?: string;
	host?: string;
	forwardedProto?: string;
}

export interface SetupRouteResult {
	status: number;
	json: unknown;
	text?: string;
	type?: string;
	headers?: Record<string, string>;
}

const sharedCache = emptyDownloadCache();
const sharedLegacyCache = emptyLegacyCache();

function searchParams(meta: SetupRouteMeta): URLSearchParams {
	return new URLSearchParams(meta.search ?? "");
}

async function downloadUrl(os: "windows" | "mac" | "linux", deps: SetupRouteDeps): Promise<string> {
	return resolveObsidianDownload(os, deps.fetchImpl ?? platformFetch, Date.now(), deps.downloadCache ?? sharedCache);
}

/** Routes that must run before sign-in is required: download, QR, install ping, code redeem. */
export async function publicSetupRoute(method: string, path: string, body: unknown, deps: SetupRouteDeps, meta: SetupRouteMeta = {}): Promise<SetupRouteResult | null> {
	if (method === "GET" && path === "/v1/setup/obsidian-download") {
		const os = searchParams(meta).get("os");
		if (!isObsidianOs(os)) return { status: 400, json: { error: "Choose Windows, macOS, or Linux." } };
		const url = await downloadUrl(os, deps);
		return { status: 302, json: { url }, headers: { location: url, "cache-control": "no-store" } };
	}
	if (method === "GET" && path === "/v1/setup/legacy-connect") {
		const status = await legacyConnectStatus({
			env: deps.env ?? process.env,
			fetchImpl: deps.fetchImpl ?? platformFetch,
			now: Date.now(),
			cache: deps.legacyCache ?? sharedLegacyCache,
		});
		return { status: 200, json: status, headers: { "cache-control": "no-store" } };
	}
	if (method === "GET" && path === "/v1/setup/qr.svg") {
		const svg = await setupQrSvg(setupPageUrl(meta.host, meta.forwardedProto));
		return { status: 200, json: { ok: true }, text: svg, type: "image/svg+xml", headers: { "cache-control": "private, max-age=300" } };
	}
	if (method === "POST" && path === "/v1/plugin/heartbeat") {
		const installId = (body as { installId?: unknown } | null)?.installId;
		if (typeof installId !== "string" || !funnelActor("plugin_installed", installId)) return { status: 400, json: { error: "Send an install id." } };
		try {
			await deps.setupFunnel?.mark("plugin_installed", installId);
		} catch (err) {
			console.error("Could not record a plugin install.", err);
		}
		return { status: 200, json: { ok: true } };
	}
	if (method === "POST" && path === "/v1/connect/redeem") {
		if (!deps.connectCodes) return { status: 503, json: { error: "Connecting is unavailable right now. Try again in a minute." } };
		const code = (body as { code?: unknown } | null)?.code;
		if (typeof code !== "string") return { status: 400, json: { error: "That code doesn't look right." } };
		const redeemed = await deps.connectCodes.redeem(code);
		if (!redeemed.ok) return { status: redeemed.status, json: { error: redeemed.error } };
		const profile = { email: redeemed.email, displayName: redeemed.displayName };
		if (deps.auth.mintCustomToken) {
			try {
				const customToken = await deps.auth.mintCustomToken(redeemed.uid);
				return { status: 200, json: { customToken, ...profile } };
			} catch (err) {
				console.error("Could not mint a connect token.", err);
				return { status: 503, json: { error: "Connecting is unavailable right now. Try again in a minute." } };
			}
		}
		const token = redeemed.uid === "local" ? "local" : redeemed.uid;
		return { status: 200, json: { token, ...profile } };
	}
	return null;
}

/** Signed-in setup: issue a code, or record an Obsidian download click and return the file URL. */
export async function signedInSetupRoute(
	method: string,
	path: string,
	body: unknown,
	deps: SetupRouteDeps,
	uid: string,
	profile: { email?: string | null; displayName?: string | null },
): Promise<SetupRouteResult | null> {
	if (method === "POST" && path === "/v1/connect/code") {
		if (!deps.connectCodes) return { status: 503, json: { error: "Connecting is unavailable right now. Try again in a minute." } };
		const issued = await deps.connectCodes.issue(uid, profile);
		return { status: 200, json: issued };
	}
	if (method === "POST" && path === "/v1/setup/obsidian-download") {
		const os = (body as { os?: unknown } | null)?.os;
		if (!isObsidianOs(os)) return { status: 400, json: { error: "Choose Windows, macOS, or Linux." } };
		try {
			await deps.setupFunnel?.mark("obsidian_download_click", uid);
		} catch (err) {
			console.error("Could not record an Obsidian download click.", err);
		}
		const url = await downloadUrl(os, deps).catch(() => OBSIDIAN_DOWNLOAD_FALLBACK);
		return { status: 200, json: { url } };
	}
	return null;
}
