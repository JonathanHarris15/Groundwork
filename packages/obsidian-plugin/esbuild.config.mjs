import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginBuildStamp, refreshCliPluginSnapshot } from "./build-hooks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";
const manifest = JSON.parse(readFileSync(path.join(here, "manifest.json"), "utf8"));

function commit() {
	try {
		const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: here, encoding: "utf8" }).trim() ? "+local" : "";
		return sha + dirty;
	} catch {
		return "unknown";
	}
}

// Production bundles use the manifest version so community-plugin rebuild checks are deterministic.
// `python update.py` sets GROUNDWORK_LOCAL_BUILD so the stamp changes and Obsidian offers a reload.
// Dev/watch builds still stamp git + time so local copies are easy to tell apart.
const build = pluginBuildStamp({
	prod,
	local: process.env.GROUNDWORK_LOCAL_BUILD === "1",
	version: manifest.version,
	commit: commit(),
	time: `${new Date().toISOString().slice(0, 19).replace("T", " ")}Z`,
});
const outdir = path.join(here, "dist");
mkdirSync(outdir, { recursive: true });

const copyAssets = {
	name: "copy-assets",
	setup(build) {
		build.onEnd(() => {
			for (const f of ["manifest.json", "styles.css"]) copyFileSync(path.join(here, f), path.join(outdir, f));
			refreshCliPluginSnapshot(outdir, path.resolve(here, "../cli/dist/plugin"));
		});
	},
};

const eventsShim = path.join(here, "shims/events.cjs");
const rendererSafeEvents = {
	name: "renderer-safe-events",
	setup(build) {
		build.onResolve({ filter: /^(node:)?events$/ }, (args) => (args.importer === eventsShim ? { path: "events", external: true } : { path: eventsShim }));
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
	// The Agent SDK calls createRequire(import.meta.url) at load time; CJS has no import.meta, so give it a real file URL.
	define: { "import.meta.url": "__gw_import_meta_url", __GW_BUILD__: JSON.stringify(build) },
	banner: {
		js: `/* groundwork-build: ${build} */\nvar __gw_import_meta_url = require("url").pathToFileURL(typeof __filename === "string" ? __filename : require("path").join(process.cwd(), "groundwork-plugin.js")).href;`,
	},
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	plugins: [rendererSafeEvents, copyAssets],
});

if (prod) {
	await ctx.rebuild();
	await ctx.dispose();
} else {
	await ctx.watch();
}
