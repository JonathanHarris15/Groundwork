import esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, "dist"), { recursive: true });

mkdirSync(path.join(here, "public"), { recursive: true });

await esbuild.build({
	entryPoints: [path.join(here, "graph-client/entry.ts")],
	bundle: true,
	platform: "browser",
	target: "es2022",
	format: "esm",
	outfile: path.join(here, "public/force-graph.js"),
	logLevel: "info",
});

await esbuild.build({
	entryPoints: [path.join(here, "src/browser-tracking.ts")],
	bundle: true,
	platform: "browser",
	target: "es2022",
	format: "iife",
	outfile: path.join(here, "public/tracking.js"),
	logLevel: "info",
});

await esbuild.build({
	entryPoints: [path.join(here, "src/write-site.ts")],
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	outfile: path.join(here, "dist/write-site.js"),
	logLevel: "info",
});

await import(pathToFileURL(path.join(here, "dist/write-site.js")).href);

await esbuild.build({
	entryPoints: [path.join(here, "src/index.ts")],
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	outfile: path.join(here, "dist/server.js"),
	banner: {
		js: "import { createRequire as __gwCreateRequire } from 'node:module'; const require = __gwCreateRequire(import.meta.url);",
	},
	external: ["firebase-admin", "firebase-admin/app", "firebase-admin/auth", "firebase-admin/firestore", "@typesafe-ai/sdk", "stripe", "pyodide"],
	logLevel: "info",
});
