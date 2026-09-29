import esbuild from "esbuild";
import { chmodSync, cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
mkdirSync(dist, { recursive: true });

await esbuild.build({
	entryPoints: [path.join(here, "src/index.ts")],
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	outfile: path.join(dist, "groundwork.js"),
	banner: {
		js: "#!/usr/bin/env node\nimport { createRequire as __gwCreateRequire } from 'node:module'; const require = __gwCreateRequire(import.meta.url);",
	},
	logLevel: "info",
});
chmodSync(path.join(dist, "groundwork.js"), 0o755);

const pluginDist = path.resolve(here, "../obsidian-plugin/dist");
if (!existsSync(path.join(pluginDist, "main.js"))) {
	console.error("Build the Obsidian plugin first (npm run build at the repo root does both).");
	process.exit(1);
}
cpSync(pluginDist, path.join(dist, "plugin"), { recursive: true });
console.log("Bundled the Obsidian plugin into dist/plugin");
