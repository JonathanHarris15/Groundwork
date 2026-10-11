import type { FetchLike } from "./platform-fetch";

/** First plugin release that redeems a one-time connect code. */
export const CODE_CONNECT_VERSION = "0.2.3";

/** Community plugin page. Its “Current version” is what a new install gets. */
export const STORE_PLUGIN_URL = "https://community.obsidian.md/plugins/groundwork";

const CACHE_MS = 15 * 60 * 1000;

export interface LegacyConnectCache {
	at: number;
	storeVersion: string | null;
}

export interface LegacyConnectStatus {
	/** True when the checklist should offer the pre-0.2.3 Open Obsidian link. */
	legacy: boolean;
	/** Parsed store version, or null when the flag forced the answer or the page could not be read. */
	storeVersion: string | null;
	codeSince: typeof CODE_CONNECT_VERSION;
}

export function emptyLegacyCache(): LegacyConnectCache {
	return { at: 0, storeVersion: null };
}

/** Pull `Current version` from the community plugin page. */
export function parseStoreVersion(html: string): string | null {
	const match = html.match(/Current version<\/div>\s*<div[^>]*>\s*([0-9]+\.[0-9]+\.[0-9]+)\s*<\/div>/i);
	return match?.[1] ?? null;
}

/** Numeric tuple order. Null when either side is not a dotted version. */
export function compareVersions(left: string, right: string): number | null {
	const parse = (value: string): number[] | null => {
		const parts = value.split(".");
		if (parts.length < 2 || parts.length > 4) return null;
		const numbers: number[] = [];
		for (const part of parts) {
			if (!/^\d+$/.test(part)) return null;
			numbers.push(Number(part));
		}
		return numbers;
	};
	const a = parse(left);
	const b = parse(right);
	if (!a || !b) return null;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/** Plugins older than the code flow still need the refresh link. An unreadable page keeps it on. */
export function legacyFromStoreVersion(version: string | null): boolean {
	if (!version) return true;
	const order = compareVersions(version, CODE_CONNECT_VERSION);
	if (order === null) return true;
	return order < 0;
}

async function readStoreVersion(fetchImpl: FetchLike, now: number, cache: LegacyConnectCache): Promise<string | null> {
	if (cache.at > 0 && now - cache.at < CACHE_MS) return cache.storeVersion;
	try {
		const response = await fetchImpl(STORE_PLUGIN_URL, {
			headers: { accept: "text/html", "user-agent": "Groundwork" },
		});
		if (!response.ok) {
			cache.at = now;
			cache.storeVersion = null;
			return null;
		}
		const version = parseStoreVersion(await response.text());
		cache.at = now;
		cache.storeVersion = version;
		return version;
	} catch {
		cache.at = now;
		cache.storeVersion = null;
		return null;
	}
}

/**
 * `GROUNDWORK_LEGACY_CONNECT=1` forces the older link on, `=0` forces it off.
 * Unset follows the community store: on until Current version is 0.2.3 or later.
 * A failed lookup stays on, so a store outage does not strand new installs.
 */
export async function legacyConnectStatus(options: {
	env?: NodeJS.ProcessEnv;
	fetchImpl: FetchLike;
	now: number;
	cache: LegacyConnectCache;
}): Promise<LegacyConnectStatus> {
	const flag = options.env?.GROUNDWORK_LEGACY_CONNECT?.trim();
	if (flag === "0" || flag === "1") {
		return { legacy: flag === "1", storeVersion: null, codeSince: CODE_CONNECT_VERSION };
	}
	const storeVersion = await readStoreVersion(options.fetchImpl, options.now, options.cache);
	return { legacy: legacyFromStoreVersion(storeVersion), storeVersion, codeSince: CODE_CONNECT_VERSION };
}
