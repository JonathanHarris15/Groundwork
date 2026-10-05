import { describe, expect, it } from "vitest";
import { pluginFixturePaths } from "../src/plugin-paths";

describe("plugin fixture paths", () => {
	it("prefers the installed plugin dir and falls back to vault configDir", () => {
		const app = { vault: { configDir: "vault-config" } } as import("obsidian").App;
		expect(pluginFixturePaths(app, ".obsidian/plugins/groundwork", "e2e-account-token")).toEqual([
			".obsidian/plugins/groundwork/e2e-account-token",
			"vault-config/plugins/groundwork/e2e-account-token",
		]);
	});
});
