import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MASTERY_LABEL, MASTERY_TONES } from "@groundwork/core";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");
const script = read("../public/app.js");
const siteCss = read("../public/styles.css");
const pluginCss = read("../../obsidian-plugin/styles.css");
const TONES = [...MASTERY_TONES, "goal"] as const;

function tokens(css: string, selector: string): Record<string, string> {
	const start = css.indexOf(`${selector} {`);
	expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
	const body = css.slice(start, css.indexOf("}", start));
	return Object.fromEntries([...body.matchAll(/(--gw-tone-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16)) as Rgb;
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

const site = tokens(siteCss, ".board");
const white: Rgb = [255, 255, 255];
const board = rgb("#0f1115");
const sky = mix(white, 0.02, board);
/** The board, the concept panel on it, a highlighted list row, and the fullscreen graph. */
const SURFACES: Rgb[] = [board, sky, mix(white, 0.06, sky), rgb("#16181d")];

describe("site mastery tones", () => {
	it("uses the plugin's labels for each state", () => {
		const literal = script.match(/const MASTERY_LABEL = \{([^}]*)\}/)?.[1] ?? "";
		const entries = [...literal.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
		expect(entries).toEqual(MASTERY_TONES.map((tone) => [tone, MASTERY_LABEL[tone]]));
		expect(script).not.toContain("Not quizzed");
	});

	it("uses the plugin's dark palette", () => {
		expect(Object.keys(site).length).toBeGreaterThan(0);
		expect(site).toEqual(tokens(pluginCss, ".gw-root"));
	});

	for (const tone of TONES) {
		it(`${tone}: pill text is at least 4.5:1 and the dot at least 3:1 on every board surface`, () => {
			const fill = rgb(site[`--gw-tone-${tone}`]);
			const ink = rgb(site[`--gw-tone-${tone}-ink`]);
			const pct = parseFloat(site["--gw-tone-pill-mix"]) / 100;
			for (const surface of SURFACES) {
				expect(contrast(ink, mix(fill, pct, surface))).toBeGreaterThanOrEqual(4.5);
				expect(contrast(fill, surface)).toBeGreaterThanOrEqual(3);
			}
		});
	}

	it("draws concept dots, status pills, goal dots, and the legend by tone, never by subject color", () => {
		const slice = (from: string, to: string) => script.slice(script.indexOf(`function ${from}(`), script.indexOf(`function ${to}(`));
		expect(slice("conceptListItems", "conceptListPanel")).toMatch(/class="tone-dot" data-tone=.*class="concept-status" data-tone=/s);
		expect(slice("graphLegend", "conceptNote")).toContain('class="tone-dot" data-tone=');
		expect(slice("goalList", "conceptCount")).toContain('class="tone-dot" data-tone="solid"');
		expect(script).not.toMatch(/style="background:\$\{/);
	});
});
