import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { bundledPluginDir, installPlugin } from "../src/obsidian";

/** Layout matches the repo: packages/cli/dist next to packages/obsidian-plugin/dist. */
function layout() {
	const root = mkdtempSync(path.join(os.tmpdir(), "gw-plugin-dir-"));
	const cliDir = path.join(root, "packages/cli/dist");
	const snapshot = path.join(cliDir, "plugin");
	const workspace = path.join(root, "packages/obsidian-plugin/dist");
	mkdirSync(snapshot, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	const files = ["main.js", "manifest.json", "styles.css"] as const;
	for (const file of files) {
		writeFileSync(path.join(snapshot, file), `OLD ${file}`);
		writeFileSync(path.join(workspace, file), file === "manifest.json" ? JSON.stringify({ version: "0.1.1" }) : `NEW ${file}`);
	}
	return { root, cliDir, snapshot, workspace };
}

describe("bundledPluginDir", () => {
	it("installs the plugin build update.py just produced, not the older CLI snapshot", async () => {
		const { cliDir, workspace } = layout();
		const src = bundledPluginDir(cliDir);
		expect(src).toBe(workspace);

		const vault = mkdtempSync(path.join(os.tmpdir(), "gw-vault-"));
		await installPlugin(vault, src);
		const installed = readFileSync(path.join(vault, ".obsidian/plugins/groundwork/main.js"), "utf8");
		expect(installed).toBe("NEW main.js");
	});

	it("uses the CLI snapshot when the workspace build is absent", () => {
		const { cliDir, snapshot, workspace } = layout();
		rmSync(workspace, { recursive: true, force: true });
		expect(bundledPluginDir(cliDir)).toBe(snapshot);
	});
});
