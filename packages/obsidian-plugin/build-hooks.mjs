import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

/**
 * Production community builds stamp the manifest version so a rebuild of the
 * same commit matches. Local updates stamp the commit and time so Obsidian
 * can see that main.js changed and offer Reload Groundwork.
 */
export function pluginBuildStamp({ prod, local, version, commit, time }) {
	if (prod && !local) return version;
	return `${commit} ${time}`;
}

/**
 * `groundwork install-plugin` used to copy packages/cli/dist/plugin, which
 * stays stale until the CLI is rebuilt. Overwrite that snapshot from the
 * plugin build so an already-built CLI installs this panel.
 * Returns false when there is no CLI snapshot yet.
 */
export function refreshCliPluginSnapshot(pluginDist, cliPluginDir) {
	if (!existsSync(path.join(cliPluginDir, "main.js"))) return false;
	if (!existsSync(path.join(pluginDist, "main.js"))) return false;
	mkdirSync(cliPluginDir, { recursive: true });
	for (const file of PLUGIN_FILES) copyFileSync(path.join(pluginDist, file), path.join(cliPluginDir, file));
	return true;
}
