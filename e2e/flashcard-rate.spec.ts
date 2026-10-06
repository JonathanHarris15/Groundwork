import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Obsidian gives every `button` a fixed height (`--input-height`, 30px) and centers it.
 * The rating interval has to clear that border, on Groundwork dark, Groundwork light,
 * and the vault theme in both dark and light.
 */
const pluginCss = readFileSync(path.join(process.cwd(), "packages/obsidian-plugin/styles.css"), "utf8");
const outDir = "/opt/cursor/artifacts/flashcard-rate";
mkdirSync(outDir, { recursive: true });

const obsidianButtons = `
button {
  --input-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--input-height);
  padding: 4px 12px;
  border: 0;
  border-radius: 6px;
  font-size: 13px;
  box-sizing: border-box;
  white-space: nowrap;
}
button:not(.clickable-icon) {
  background-color: var(--interactive-normal, #353535);
  box-shadow: 0 1px 2px rgba(0,0,0,.25);
}
button:hover { background-color: var(--interactive-hover, #3a3a3a); }
`;

const obsidianDark = `
body.theme-dark {
  --background-primary: #1c1c1c;
  --background-primary-alt: #232323;
  --background-secondary: #282828;
  --background-modifier-border: #333333;
  --background-modifier-hover: #353535;
  --background-modifier-form-field: #252525;
  --text-normal: #dadada;
  --text-muted: #b3b3b3;
  --text-faint: #888888;
  --interactive-normal: #2a2a2a;
  --interactive-hover: #353535;
}
`;

const obsidianLight = `
body.theme-light {
  --background-primary: #ffffff;
  --background-primary-alt: #fafafa;
  --background-secondary: #f6f6f6;
  --background-modifier-border: #e4e4e4;
  --background-modifier-hover: #e8e8e8;
  --background-modifier-form-field: #ffffff;
  --text-normal: #222222;
  --text-muted: #5c5c5c;
  --text-faint: #888888;
  --interactive-normal: #f6f6f6;
  --interactive-hover: #e8e8e8;
}
`;

const themes = [
	{ name: "dark", body: "", root: "gw-root gw-theme-dark is-flashcards", extra: "" },
	{ name: "light", body: "", root: "gw-root gw-theme-light is-flashcards", extra: "" },
	{ name: "obsidian-dark", body: "theme-dark", root: "gw-root gw-theme-obsidian is-flashcards", extra: obsidianDark },
	{ name: "obsidian-light", body: "theme-light", root: "gw-root gw-theme-obsidian is-flashcards", extra: obsidianLight },
] as const;

function pageHtml(theme: (typeof themes)[number]): string {
	const button = (rating: string, label: string, key: string, when: string) =>
		`<button class="gw-rb gw-rb-${rating}" type="button"><span class="gw-rb-line"><b>${label}</b><kbd>${key}</kbd></span><span class="gw-rb-when">${when}</span></button>`;
	return `<!doctype html><html><head><style>${obsidianButtons}${theme.extra}${pluginCss}</style></head>
<body class="${theme.body}">
  <div class="${theme.root}">
    <div class="gw-flash is-revealed">
      <div class="gw-fc-study">
        <div class="gw-fc-unit">
          <div class="gw-fc-stack">
            <div class="gw-fcard"><div class="gw-fcard-front">What is the power rule?</div></div>
          </div>
          <div class="gw-fc-rate">
            ${button("again", "Again", "1", "Right away")}
            ${button("hard", "Hard", "2", "Later")}
            ${button("good", "Good", "3", "Done")}
            ${button("easy", "Easy", "4", "Done")}
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
}

test.describe("flashcard rating row", () => {
	for (const theme of themes) {
		test(`${theme.name}: interval sits inside the button and the row joins the card`, async ({ page }, testInfo) => {
			await page.setContent(pageHtml(theme), { waitUntil: "domcontentloaded" });
			await page.evaluate(() => document.fonts.ready);
			const report = await measure(page);
			if (testInfo.project.name === "chromium") {
				await page.screenshot({ path: path.join(outDir, `${theme.name}.png`) });
			}
			expect(report.issues, report.issues.join("\n")).toEqual([]);
			for (const sample of report.contrast) {
				expect(sample.ratio, `${sample.name} ${sample.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
			}
		});
	}
});

async function measure(page: Page) {
	return page.evaluate(() => {
		const parse = (value: string) => {
			const m = value.match(/rgba?\((\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+\.?\d*)(?:,\s*([\d.]+))?\)/);
			if (!m) return null;
			return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
		};
		const composite = (fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number; a: number }) => {
			const a = fg.a + bg.a * (1 - fg.a);
			const ch = (f: number, b: number) => (a ? (f * fg.a + b * bg.a * (1 - fg.a)) / a : b);
			return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b) };
		};
		const lum = (c: { r: number; g: number; b: number }) => {
			const lin = [c.r, c.g, c.b].map((v) => {
				const s = v / 255;
				return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
		};
		const contrast = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
			const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
			return (hi + 0.05) / (lo + 0.05);
		};
		const resolved = (el: Element, prop: "color" | "backgroundColor") => {
			let node: Element | null = el;
			let color = parse(getComputedStyle(node).getPropertyValue(prop === "color" ? "color" : "background-color"));
			while (node && color && color.a < 1) {
				node = node.parentElement;
				const under = node ? parse(getComputedStyle(node).backgroundColor) : { r: 255, g: 255, b: 255, a: 1 };
				if (!under) break;
				const flat = composite(color, under);
				color = { ...flat, a: 1 };
				if (under.a >= 1) break;
			}
			return color;
		};

		const issues: string[] = [];
		const contrastSamples: Array<{ name: string; ratio: number }> = [];
		const card = document.querySelector(".gw-fcard")?.getBoundingClientRect();
		const rate = document.querySelector(".gw-fc-rate")?.getBoundingClientRect();
		if (!card || !rate) issues.push("missing card or rating row");
		else if (Math.abs(rate.top - card.bottom) > 1) issues.push(`rating row sits ${Math.abs(rate.top - card.bottom).toFixed(1)}px off the card`);
		else if (Math.abs(rate.left - card.left) > 1 || Math.abs(rate.right - card.right) > 1) issues.push("rating row is not the card's width");

		for (const button of document.querySelectorAll(".gw-rb")) {
			const interval = button.querySelector(".gw-rb-when");
			const label = button.querySelector("b");
			const key = button.querySelector("kbd");
			const name = label?.textContent || "rating";
			if (!interval || !label || !key) {
				issues.push(`${name} is missing its label, key, or interval`);
				continue;
			}
			const box = button.getBoundingClientRect();
			const cs = getComputedStyle(button);
			const inner = {
				top: box.top + (parseFloat(cs.borderTopWidth) || 0),
				right: box.right - (parseFloat(cs.borderRightWidth) || 0),
				bottom: box.bottom - (parseFloat(cs.borderBottomWidth) || 0),
				left: box.left + (parseFloat(cs.borderLeftWidth) || 0),
			};
			const text = interval.getBoundingClientRect();
			if (text.width < 2 || text.height < 2) issues.push(`${name} interval has no box`);
			else if (text.top < inner.top - 0.5 || text.bottom > inner.bottom + 0.5 || text.left < inner.left - 0.5 || text.right > inner.right + 0.5) {
				issues.push(`${name} interval is outside the button`);
			} else if (inner.bottom - text.bottom < 6) {
				issues.push(`${name} interval is ${(inner.bottom - text.bottom).toFixed(1)}px from the button edge`);
			}
			const labelBox = label.getBoundingClientRect();
			const keyBox = key.getBoundingClientRect();
			const gap = Math.max(keyBox.left - labelBox.right, labelBox.left - keyBox.right, keyBox.top - labelBox.bottom, labelBox.top - keyBox.bottom);
			if (gap < 4) issues.push(`${name} key hint crowds the label (${gap.toFixed(1)}px)`);

			const surface = resolved(button, "backgroundColor");
			const ink = resolved(label, "color");
			const muted = resolved(interval, "color");
			const keyInk = resolved(key, "color");
			const keySurface = resolved(key, "backgroundColor");
			if (!surface || !ink || !muted || !keyInk || !keySurface) {
				issues.push(`${name} color did not resolve`);
				continue;
			}
			contrastSamples.push(
				{ name: `${name} label`, ratio: contrast(ink, surface) },
				{ name: `${name} interval`, ratio: contrast(muted, surface) },
				{ name: `${name} key`, ratio: contrast(keyInk, keySurface) },
			);
		}
		return { issues, contrast: contrastSamples };
	});
}
