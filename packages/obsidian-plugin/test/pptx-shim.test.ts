import { builtinModules, createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import { bundleAlias } from "../shims/alias.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = mkdtempSync(path.join(tmpdir(), "gw-pptx-"));
const outfile = path.join(outdir, "pptx.cjs");
const require = createRequire(import.meta.url);

afterAll(() => {
	rmSync(outdir, { recursive: true, force: true });
});

describe("bundled PowerPoint import", () => {
	it("reads slide text without injecting a script element", async () => {
		await esbuild.build({
			stdin: {
				contents: `
					import JSZip from "jszip";
					export async function slideTexts(bytes: Uint8Array): Promise<string[]> {
						const zip = await JSZip.loadAsync(bytes);
						const names = Object.keys(zip.files)
							.filter((name) => /^ppt\\/slides\\/slide\\d+\\.xml$/i.test(name))
							.sort((a, b) => Number(/slide(\\d+)/i.exec(a)?.[1] ?? 0) - Number(/slide(\\d+)/i.exec(b)?.[1] ?? 0));
						const slides: string[] = [];
						for (const name of names) {
							const file = zip.files[name];
							if (!file) continue;
							const xml = await file.async("string");
							const bits: string[] = [];
							const re = /<a:t[^>]*>([^<]*)<\\/a:t>/g;
							let match: RegExpExecArray | null;
							while ((match = re.exec(xml))) bits.push(match[1] ?? "");
							slides.push(bits.join(" "));
						}
						return slides;
					}
				`,
				resolveDir: path.join(here, ".."),
				sourcefile: "pptx-entry.ts",
				loader: "ts",
			},
			bundle: true,
			format: "cjs",
			platform: "browser",
			target: "es2022",
			outfile,
			alias: bundleAlias,
			external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
			logLevel: "silent",
		});
		const source = readFileSync(outfile, "utf8");
		expect(source.split('createElement("script")').length - 1).toBe(0);
		expect(source.split("createElement('script')").length - 1).toBe(0);
		expect(source).not.toContain("new Function");

		const zip = new JSZip();
		zip.file("ppt/slides/slide2.xml", `<a:t>Second slide</a:t>`);
		zip.file("ppt/slides/slide1.xml", `<a:t>We always choose u by LIATE.</a:t>`);
		const bytes = await zip.generateAsync({ type: "uint8array" });
		const { slideTexts } = require(outfile) as { slideTexts: (bytes: Uint8Array) => Promise<string[]> };
		const slides = await slideTexts(bytes);
		expect(slides).toEqual(["We always choose u by LIATE.", "Second slide"]);
	});
});
