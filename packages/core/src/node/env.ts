import * as os from "node:os";
import * as path from "node:path";

/** GUI apps (Obsidian launched from the Dock/Start menu) don't inherit the shell PATH; add the usual tool locations. */
export function guiPathDirs(): string[] {
	const home = os.homedir();
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
		return [path.join(home, ".local", "bin"), path.join(appData, "npm"), path.join(home, ".bun", "bin")];
	}
	return [
		path.join(home, ".local", "bin"),
		path.join(home, ".claude", "local"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		path.join(home, ".npm-global", "bin"),
		path.join(home, ".bun", "bin"),
		path.join(home, ".volta", "bin"),
		"/usr/bin",
		"/bin",
	];
}

export function withGuiPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const sep = process.platform === "win32" ? ";" : ":";
	const current = (env.PATH ?? env.Path ?? "").split(sep).filter(Boolean);
	const merged = [...current, ...guiPathDirs().filter((d) => !current.includes(d))];
	return { ...env, PATH: merged.join(sep) };
}
