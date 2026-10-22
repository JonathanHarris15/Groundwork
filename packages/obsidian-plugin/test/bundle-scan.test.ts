import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/main.js");

describe("plugin bundle scan signals", () => {
	it("avoids runtime hostname reads and inlines GROUNDWORK_API_URL at build time", () => {
		const source = readFileSync(bundle, "utf8");
		expect(source).not.toMatch(/os\.hostname/);
		// esbuild replaces process.env.GROUNDWORK_API_URL with a string literal (empty in CI production builds).
		expect(source).not.toMatch(/process\.env\.GROUNDWORK_API_URL/);
	});

	it("does not inject script elements at runtime", () => {
		const source = readFileSync(bundle, "utf8");
		expect(source.split('createElement("script")').length - 1).toBe(0);
		expect(source.split("createElement('script')").length - 1).toBe(0);
	});

	it("keeps dynamic code generation to ajv's schema compiler", () => {
		const source = readFileSync(bundle, "utf8");
		expect(source.match(/new Function/g)).toHaveLength(1);
		expect(source).toContain("validateFunctionCode");
	});
});
