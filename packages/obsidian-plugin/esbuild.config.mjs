import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";
const outdir = path.join(here, "dist");
mkdirSync(outdir, { recursive: true });

const copyAssets = {
	name: "copy-assets",
	setup(build) {
		build.onEnd(() => {
			for (const f of ["manifest.json", "styles.css"]) copyFileSync(path.join(here, f), path.join(outdir, f));
		});
	},
};

const ctx = await esbuild.context({
	entryPoints: [path.join(here, "src/main.ts")],
	bundle: true,
	outfile: path.join(outdir, "main.js"),
	format: "cjs",
	platform: "browser",
	target: "es2022",
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	plugins: [copyAssets],
});

if (prod) {
	await ctx.rebuild();
	await ctx.dispose();
} else {
	await ctx.watch();
}
