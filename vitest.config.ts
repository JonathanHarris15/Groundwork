import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const obsidian = fileURLToPath(new URL("./packages/obsidian-plugin/test/shims/obsidian.ts", import.meta.url));

export default defineConfig({
	resolve: {
		alias: { obsidian },
	},
	test: {
		exclude: ["**/node_modules/**", "**/e2e/**", "playwright.config.ts"],
	},
});
