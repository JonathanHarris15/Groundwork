import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/main.js");

describe("plugin bundle scan signals", () => {
	it("avoids runtime hostname and env reads in release-shaped bundles", () => {
		const source = readFileSync(bundle, "utf8");
		expect(source).not.toMatch(/os\.hostname/);
		expect(source).not.toMatch(/process\.env\.GROUNDWORK_API_URL/);
	});

	it("documents where dynamic code generation comes from", () => {
		const source = readFileSync(bundle, "utf8");
		const ajv = source.includes("validateFunctionCode");
		const dynamic = source.includes("new Function");
		expect(dynamic).toBe(true);
		expect(ajv).toBe(true);
	});
});
