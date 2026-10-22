import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

describe("display math highlight backstop", () => {
	it("does not paint or blur display math inside a mark or a callout", () => {
		expect(css).toContain(".gw-root .markdown-rendered mark:has(.math-block)");
		expect(css).toContain(".gw-root .markdown-rendered mark:has(mjx-container[display=\"true\"])");
		expect(css).toContain(".gw-root .markdown-rendered .callout .math-block");
		expect(css).toContain(".gw-root .markdown-rendered mjx-assistive-mml");
		const block = css.slice(css.indexOf(".gw-root .math-block {"), css.indexOf(".gw-root .markdown-rendered mark:has(.math-block)"));
		expect(block).toContain("background: transparent");
		expect(block).toContain("filter: none");
		expect(block).toContain("text-shadow: none");
	});
});
