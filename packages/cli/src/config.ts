import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CliConfig {
	vault?: string;
}

export function configPath(): string {
	const base = process.platform === "win32" ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")) : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
	return path.join(base, "groundwork", "config.json");
}

export async function readConfig(): Promise<CliConfig> {
	try {
		return JSON.parse(await fs.readFile(configPath(), "utf8"));
	} catch {
		return {};
	}
}

export async function writeConfig(cfg: CliConfig): Promise<void> {
	await fs.mkdir(path.dirname(configPath()), { recursive: true });
	await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2));
}

export function defaultVaultDir(): string {
	return path.join(os.homedir(), "Groundwork");
}

/** --vault flag, then GROUNDWORK_VAULT, then the saved config. */
export async function resolveVault(flag?: string): Promise<string> {
	const candidate = flag ?? process.env.GROUNDWORK_VAULT ?? (await readConfig()).vault;
	if (!candidate) {
		throw new Error("No vault configured. Run `groundwork init` (new vault) or `groundwork clone <git-url>` (existing vault) first, or pass --vault.");
	}
	const abs = path.resolve(candidate.replace(/^~(?=$|\/|\\)/, os.homedir()));
	if (!existsSync(abs)) throw new Error(`Vault folder not found: ${abs}`);
	return abs;
}

export function expandHome(p: string): string {
	return path.resolve(p.replace(/^~(?=$|\/|\\)/, os.homedir()));
}
