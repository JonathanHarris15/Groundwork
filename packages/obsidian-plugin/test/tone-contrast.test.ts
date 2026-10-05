import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MASTERY_TONES } from "@groundwork/core";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
const TONES = [...MASTERY_TONES, "goal"] as const;

function block(selector: string): string {
	const start = css.indexOf(`${selector} {`);
	expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
	return css.slice(start, css.indexOf("}", start));
}

function vars(selector: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of block(selector).matchAll(/(--gw-tone-[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
	return out;
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => {
	const h = hex.replace("#", "");
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
};
/** color-mix(in srgb, a p%, b) */
const mix = (a: Rgb, p: number, b: Rgb): Rgb => a.map((v, i) => v * p + b[i] * (1 - p)) as Rgb;
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

const dark = vars(".gw-root");
const light = { ...dark, ...vars(".gw-root.gw-theme-light,\nbody.theme-light .gw-root.gw-theme-obsidian") };

/** Paper first; the rest are the surfaces a pill, dot, or marker sits on (raised, map, chip, form field). */
const THEMES = [
	{ name: "Groundwork dark", palette: dark, paper: "#1e1e1e", surfaces: ["#232323", "#1b1b1b", "#252525", "#2b2b2b"] },
	{ name: "Obsidian dark", palette: dark, paper: "#1e1e1e", surfaces: ["#262626", "#202020", "#242424"] },
	{ name: "Groundwork light", palette: light, paper: "#f6f4f0", surfaces: ["#ffffff", "#efeae3"] },
	{ name: "Obsidian light", palette: light, paper: "#ffffff", surfaces: ["#f6f6f6", "#fafafa"] },
];

describe("mastery tone palette", () => {
	for (const theme of THEMES) {
		describe(theme.name, () => {
			const pct = parseFloat(theme.palette["--gw-tone-pill-mix"]) / 100;
			const paper = rgb(theme.paper);
			for (const tone of TONES) {
				const fill = rgb(theme.palette[`--gw-tone-${tone}`]);
				const ink = rgb(theme.palette[`--gw-tone-${tone}-ink`]);
				it(`${tone}: pill text is at least 4.5:1 on its pill on every surface`, () => {
					for (const surface of [theme.paper, ...theme.surfaces]) {
						expect(contrast(ink, mix(fill, pct, rgb(surface))), `${tone} pill on ${surface}`).toBeGreaterThanOrEqual(4.5);
					}
				});
				it(`${tone}: ink is at least 4.5:1 as plain text on the panel`, () => {
					expect(contrast(ink, paper)).toBeGreaterThanOrEqual(4.5);
				});
				it(`${tone}: dot, bar, and node fill is at least 3:1 on every surface`, () => {
					for (const surface of [theme.paper, ...theme.surfaces]) {
						expect(contrast(fill, rgb(surface)), `${tone} fill on ${surface}`).toBeGreaterThanOrEqual(3);
					}
				});
			}
		});
	}
});

describe("stylesheet invariants", () => {
	it("styles mastery pills in one rule", () => {
		const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/[^{}]*\.gw-status(?![\w-])[^{}]*\{/g)];
		expect(rules).toHaveLength(1);
	});

	it("keeps the composer box the column's width", () => {
		expect(block(".gw-box")).toMatch(/\bwidth:\s*100%/);
	});

	it("has no overlay panel or Close button styles", () => {
		expect(css).not.toMatch(/is-overlay|gw-panel-close/);
	});
});
