import type { App } from "obsidian";

/** E2e fixture paths under the installed plugin folder (respects non-default vault config dirs). */
export function pluginFixturePaths(app: App, pluginDir: string | undefined, filename: string): string[] {
	const paths: string[] = [];
	if (pluginDir) paths.push(`${pluginDir}/${filename}`);
	const configDir = app.vault?.configDir;
	if (configDir) paths.push(`${configDir}/plugins/groundwork/${filename}`);
	return paths;
}
