import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const jszipRoot = path.dirname(require.resolve("jszip/package.json"));

// The published jszip browser build inlines setimmediate. Point the package at
// its source modules so the shims below replace those polyfills.
export const bundleAlias = {
	jszip: path.join(jszipRoot, "lib/index.js"),
	setimmediate: path.join(here, "setimmediate.cjs"),
	immediate: path.join(here, "immediate.cjs"),
	lie: path.join(here, "lie.cjs"),
};
