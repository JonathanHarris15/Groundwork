import { describe, expect, it } from "vitest";
import { emptyDownloadCache, OBSIDIAN_DOWNLOAD_FALLBACK, resolveObsidianDownload } from "../src/obsidian-downloads";

describe("resolveObsidianDownload", () => {
	it("always sends learners to the official Obsidian download page", async () => {
		const cache = emptyDownloadCache();
		const githubExe = async () =>
			new Response(
				JSON.stringify({
					assets: [
						{ name: "Obsidian-1.7.7-arm64.AppImage", browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.7.7/Obsidian-1.7.7-arm64.AppImage" },
						{ name: "Obsidian-1.7.7.exe", browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.7.7/Obsidian-1.7.7.exe" },
						{ name: "Obsidian-1.7.7.dmg", browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.7.7/Obsidian-1.7.7.dmg" },
						{ name: "Obsidian-1.7.7.AppImage", browser_download_url: "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.7.7/Obsidian-1.7.7.AppImage" },
					],
				}),
				{ status: 200 },
			);
		for (const os of ["windows", "mac", "linux"] as const) {
			await expect(resolveObsidianDownload(os, githubExe, 10, cache)).resolves.toBe(OBSIDIAN_DOWNLOAD_FALLBACK);
		}
		expect(String(await resolveObsidianDownload("linux", githubExe, 11, cache))).not.toMatch(/github\.com|\.exe|AppImage/);
	});
});
