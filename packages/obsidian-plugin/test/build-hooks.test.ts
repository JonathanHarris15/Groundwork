import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginBuildStamp, refreshCliPluginSnapshot } from "../build-hooks.mjs";

describe("plugin build stamp", () => {
	it("keeps community production builds on the manifest version", () => {
		expect(pluginBuildStamp({ prod: true, local: false, version: "0.1.1", commit: "abc", time: "2026-10-04 00:00:00Z" })).toBe("0.1.1");
	});

	it("stamps a local update so Obsidian can tell it from the running bundle", () => {
		expect(pluginBuildStamp({ prod: true, local: true, version: "0.1.1", commit: "abc", time: "2026-10-04 00:00:00Z" })).toBe("abc 2026-10-04 00:00:00Z");
	});
});

describe("CLI plugin snapshot", () => {
	it("replaces a stale CLI copy with the plugin build update.py just wrote", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "gw-snapshot-"));
		const pluginDist = path.join(root, "plugin-dist");
		const cliPlugin = path.join(root, "cli-plugin");
		mkdirSync(pluginDist, { recursive: true });
		mkdirSync(cliPlugin, { recursive: true });
		for (const file of ["main.js", "manifest.json", "styles.css"]) {
			writeFileSync(path.join(cliPlugin, file), `OLD ${file}`);
			writeFileSync(path.join(pluginDist, file), `NEW ${file}`);
		}
		expect(refreshCliPluginSnapshot(pluginDist, cliPlugin)).toBe(true);
		expect(readFileSync(path.join(cliPlugin, "main.js"), "utf8")).toBe("NEW main.js");
		expect(readFileSync(path.join(cliPlugin, "styles.css"), "utf8")).toBe("NEW styles.css");
	});

	it("leaves a published CLI alone when no snapshot exists yet", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "gw-snapshot-"));
		const pluginDist = path.join(root, "plugin-dist");
		mkdirSync(pluginDist, { recursive: true });
		writeFileSync(path.join(pluginDist, "main.js"), "NEW main.js");
		expect(refreshCliPluginSnapshot(pluginDist, path.join(root, "missing"))).toBe(false);
	});
});
