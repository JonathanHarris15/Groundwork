import type { FetchLike } from "./platform-fetch";

/** Official Obsidian download page — never proxy GitHub release binaries through our origin. */
export const OBSIDIAN_DOWNLOAD_FALLBACK = "https://obsidian.md/download";

export type ObsidianOs = "windows" | "mac" | "linux";

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

/** Always send learners to Obsidian's download page (OS is for analytics only). */
export async function resolveObsidianDownload(
	_os: ObsidianOs,
	_fetchImpl: FetchLike,
	_now: number,
	_cache: DownloadCache,
): Promise<string> {
	return OBSIDIAN_DOWNLOAD_FALLBACK;
}
