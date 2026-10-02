import esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, "dist"), { recursive: true });

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
	external: ["firebase-admin", "firebase-admin/app", "firebase-admin/auth", "firebase-admin/firestore", "@typesafe-ai/sdk", "stripe"],
	logLevel: "info",
});
