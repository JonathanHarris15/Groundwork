import type { FetchLike } from "./platform-fetch";

export const OBSIDIAN_DOWNLOAD_FALLBACK = "https://obsidian.md/download";

export type ObsidianOs = "windows" | "mac" | "linux";

const CACHE_MS = 60 * 60 * 1000;

export interface DownloadCache {
	at: number;
	byOs: Partial<Record<ObsidianOs, string>>;
}

export function emptyDownloadCache(): DownloadCache {
	return { at: 0, byOs: {} };
}

export function isObsidianOs(value: unknown): value is ObsidianOs {
	return value === "windows" || value === "mac" || value === "linux";
}

interface GithubAsset {
	name?: string;
	browser_download_url?: string;
}

function assetFor(os: ObsidianOs, assets: GithubAsset[]): string | null {
	const suffix = os === "windows" ? ".exe" : os === "mac" ? ".dmg" : ".AppImage";
	const match = assets.find((asset) => {
		const name = asset.name ?? "";
		return name.startsWith("Obsidian") && name.endsWith(suffix) && typeof asset.browser_download_url === "string" && asset.browser_download_url.startsWith("https://");
	});
	return match?.browser_download_url ?? null;
}

/**
 * Latest desktop installer from Obsidian's public GitHub releases.
 * A failed lookup still returns the download page so the button does something.
 */
export async function resolveObsidianDownload(os: ObsidianOs, fetchImpl: FetchLike, now: number, cache: DownloadCache): Promise<string> {
	const cached = cache.byOs[os];
	if (now - cache.at < CACHE_MS && cached) return cached;
	try {
		const response = await fetchImpl("https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest", {
			headers: { accept: "application/vnd.github+json", "user-agent": "Groundwork" },
		});
		if (!response.ok) return cache.byOs[os] ?? OBSIDIAN_DOWNLOAD_FALLBACK;
		const body = (await response.json()) as { assets?: GithubAsset[] };
		const assets = Array.isArray(body.assets) ? body.assets : [];
		const next: DownloadCache["byOs"] = {};
		for (const name of ["windows", "mac", "linux"] as const) {
			const url = assetFor(name, assets);
			if (url) next[name] = url;
		}
		cache.at = now;
		cache.byOs = next;
		return next[os] ?? OBSIDIAN_DOWNLOAD_FALLBACK;
	} catch {
		return cache.byOs[os] ?? OBSIDIAN_DOWNLOAD_FALLBACK;
	}
}
