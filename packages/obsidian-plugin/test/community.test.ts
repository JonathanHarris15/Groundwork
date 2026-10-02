import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Obsidian community plugin checklist", () => {
	it("has the release files the community directory requires", () => {
		const out = execFileSync("node", ["scripts/check-community-plugin.mjs"], { cwd: root, encoding: "utf8" });
		expect(out).toContain("groundwork");
	});
});
