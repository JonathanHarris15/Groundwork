declare const __GW_BUILD__: string | undefined;

/** Commit and time this bundle was built from; also written as the first line of main.js. */
export const BUILD: string = typeof __GW_BUILD__ === "string" ? __GW_BUILD__ : "dev";

export function readBuildStamp(js: string): string | null {
	return /^\/\* groundwork-build: (.+?) \*\//.exec(js)?.[1] ?? null;
}
