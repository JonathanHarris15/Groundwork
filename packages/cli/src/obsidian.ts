import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLUGIN_ID } from "@groundwork/core";

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

export function bundledPluginDir(cliDir: string): string {
	const candidates = [path.join(cliDir, "plugin"), path.resolve(cliDir, "../../obsidian-plugin/dist")];
	const hit = candidates.find((d) => existsSync(path.join(d, "main.js")));
	if (!hit) throw new Error("Bundled Obsidian plugin not found. Run `npm run build` in the Groundwork repo.");
	return hit;
}

/** Copies the plugin into the vault and enables it. Returns true if anything changed. */
export async function installPlugin(vault: string, pluginSrc: string): Promise<{ changed: boolean; version: string }> {
	const dest = path.join(vault, ".obsidian", "plugins", PLUGIN_ID);
	await fs.mkdir(dest, { recursive: true });
	let changed = false;
	for (const f of PLUGIN_FILES) {
		const src = await fs.readFile(path.join(pluginSrc, f));
		const target = path.join(dest, f);
		const current = existsSync(target) ? await fs.readFile(target) : null;
		if (!current || !current.equals(src)) {
			await fs.writeFile(target, src);
			changed = true;
		}
	}
	const listPath = path.join(vault, ".obsidian", "community-plugins.json");
	let enabled: string[] = [];
	try {
		enabled = JSON.parse(await fs.readFile(listPath, "utf8"));
	} catch {
		enabled = [];
	}
	if (!enabled.includes(PLUGIN_ID)) {
		enabled.push(PLUGIN_ID);
		await fs.writeFile(listPath, JSON.stringify(enabled, null, 2));
		changed = true;
	}
	const version = JSON.parse(readFileSync(path.join(pluginSrc, "manifest.json"), "utf8")).version as string;
	return { changed, version };
}

/** Obsidian keeps its list of known vaults in obsidian.json in its config folder. */
export function obsidianConfigDirs(): string[] {
	const home = os.homedir();
	if (process.platform === "darwin") return [path.join(home, "Library", "Application Support", "obsidian")];
	if (process.platform === "win32") return [path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "obsidian")];
	const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
	return [
		path.join(xdg, "obsidian"),
		path.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian"),
		path.join(home, "snap", "obsidian", "current", ".config", "obsidian"),
	];
}

export async function registerVault(vault: string): Promise<{ id: string; registered: boolean; configPath?: string }> {
	const dirs = obsidianConfigDirs();
	const dir = dirs.find((d) => existsSync(d)) ?? dirs[0];
	const configPath = path.join(dir, "obsidian.json");
	let config: { vaults?: Record<string, { path: string; ts: number; open?: boolean }> } = {};
	try {
		config = JSON.parse(await fs.readFile(configPath, "utf8"));
	} catch {
		config = {};
	}
	config.vaults ??= {};
	const abs = path.resolve(vault);
	for (const [id, v] of Object.entries(config.vaults)) {
		if (path.resolve(v.path) === abs) return { id, registered: false, configPath };
	}
	const id = randomBytes(8).toString("hex");
	config.vaults[id] = { path: abs, ts: Date.now() };
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(configPath, JSON.stringify(config));
	return { id, registered: true, configPath };
}

export function obsidianUri(vaultId: string): string {
	return `obsidian://open?vault=${encodeURIComponent(vaultId)}`;
}

/** Launch Obsidian on the vault. OBSIDIAN_BIN overrides the platform URI handler (e.g. an AppImage). */
export function launchObsidian(uri: string): void {
	const bin = process.env.OBSIDIAN_BIN;
	let cmd: string;
	let args: string[];
	if (bin) {
		cmd = bin;
		args = [uri];
	} else if (process.platform === "darwin") {
		cmd = "open";
		args = [uri];
	} else if (process.platform === "win32") {
		cmd = "cmd";
		args = ["/c", "start", '""', uri];
	} else {
		cmd = "xdg-open";
		args = [uri];
	}
	const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
	child.on("error", () => {
		console.error(`Couldn't launch Obsidian automatically. Open this link: ${uri}`);
	});
	child.unref();
}
