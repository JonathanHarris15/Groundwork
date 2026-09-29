import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Client = "claude-desktop" | "claude-code" | "cursor" | "print";

export function serverEntry(cliPath: string, vault: string) {
	return { command: process.execPath, args: [cliPath, "mcp", "--vault", vault] };
}

function claudeDesktopConfig(): string {
	const home = os.homedir();
	if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
	if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
	return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

async function mergeMcpJson(file: string, entry: ReturnType<typeof serverEntry>): Promise<void> {
	let cfg: { mcpServers?: Record<string, unknown> } = {};
	try {
		cfg = JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		cfg = {};
	}
	cfg.mcpServers = { ...(cfg.mcpServers ?? {}), groundwork: entry };
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(cfg, null, 2));
}

export async function connectClient(client: Client, cliPath: string, vault: string): Promise<string> {
	const entry = serverEntry(cliPath, vault);
	switch (client) {
		case "claude-desktop": {
			const file = claudeDesktopConfig();
			await mergeMcpJson(file, entry);
			return `Added Groundwork to Claude Desktop (${file}). Restart Claude Desktop, then ask it to teach you something.`;
		}
		case "cursor": {
			const file = path.join(os.homedir(), ".cursor", "mcp.json");
			await mergeMcpJson(file, entry);
			return `Added Groundwork to Cursor (${file}).`;
		}
		case "claude-code": {
			const args = ["mcp", "add", "--scope", "user", "groundwork", "--", entry.command, ...entry.args];
			try {
				execFileSync("claude", args, { stdio: "inherit" });
				return "Added Groundwork to Claude Code (user scope).";
			} catch {
				return `Couldn't run the \`claude\` CLI. Run this yourself:\n  claude ${args.map(quote).join(" ")}`;
			}
		}
		default:
			return JSON.stringify({ mcpServers: { groundwork: entry } }, null, 2);
	}
}

function quote(a: string): string {
	return /[\s"']/.test(a) ? JSON.stringify(a) : a;
}

export function hasCommand(cmd: string): boolean {
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}