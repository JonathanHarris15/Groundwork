import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist/main.js");

describe.skipIf(!existsSync(bundle))("built plugin bundle", () => {
	it("loads as CommonJS the way Obsidian loads it", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "gw-bundle-"));
		mkdirSync(path.join(dir, "node_modules/obsidian"), { recursive: true });
		writeFileSync(path.join(dir, "node_modules/obsidian/index.js"), "module.exports = new Proxy({}, { get: () => class {} });");
		copyFileSync(bundle, path.join(dir, "main.cjs"));
		const mod = createRequire(path.join(dir, "index.js"))("./main.cjs");
		expect(typeof (mod.default ?? mod)).toBe("function");
	});
});
