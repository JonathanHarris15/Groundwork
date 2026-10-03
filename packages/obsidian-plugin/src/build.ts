declare const __GW_BUILD__: string | undefined;

/** Release builds use manifest version; dev builds use git + time. Also written as the first line of main.js. */
export const BUILD: string = typeof __GW_BUILD__ === "string" ? __GW_BUILD__ : "dev";

export function readBuildStamp(js: string): string | null {
	return /^\/\* groundwork-build: (.+?) \*\//.exec(js)?.[1] ?? null;
}
