import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
	entryPoints: [path.join(here, "src/index.ts")],
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	outfile: path.join(here, "dist/server.js"),
	logLevel: "info",
});
