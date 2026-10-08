import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

function themeBlock(selector: string): string {
	const start = css.indexOf(`${selector} {`);
	expect(start, selector).toBeGreaterThanOrEqual(0);
	return css.slice(start, css.indexOf("\n}", start));
}

function color(block: string, name: string): string {
	const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
	expect(m, name).toBeTruthy();
	return m![1];
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16)) as Rgb;
const luminance = (c: Rgb) => {
	const [r, g, b] = c.map((v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

const ROLES = ["--code-normal", "--code-comment", "--code-keyword", "--code-string", "--code-function", "--code-property", "--code-operator", "--color-yellow"];

describe("code colors", () => {
	for (const [name, selector] of [
		["dark", ".gw-root.gw-theme-dark"],
		["light", ".gw-root.gw-theme-light"],
	] as const) {
		it(`${name}: token colors are at least 4.5:1 on the code background`, () => {
			const block = themeBlock(selector);
			const bg = rgb(color(block, "--code-background"));
			for (const role of ROLES) {
				expect(contrast(rgb(color(block, role)), bg), role).toBeGreaterThanOrEqual(4.5);
			}
		});
	}
});

describe("code layout", () => {
	it("keeps inline spaces and scrolls fenced code instead of wrapping it", () => {
		expect(css).toMatch(/\.gw-root \.markdown-rendered :not\(pre\) > code \{[^}]*white-space:\s*break-spaces/s);
		expect(css).toMatch(/\.gw-root \.markdown-rendered pre code\[class\*="language-"\] \{[^}]*white-space:\s*pre/s);
		expect(css).toMatch(/\.gw-free-editor \{[^}]*white-space:\s*break-spaces/s);
		expect(css).toMatch(/--code-white-space:\s*pre/);
		expect(css).not.toMatch(/!important/);
	});
});
