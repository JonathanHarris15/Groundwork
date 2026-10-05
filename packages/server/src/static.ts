import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

const FILES: Record<string, { file: string; type: string }> = {
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
	"/404.html": { file: "404.html", type: "text/html; charset=utf-8" },
	"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
	"/force-graph.js": { file: "force-graph.js", type: "text/javascript; charset=utf-8" },
	"/graph-harness.html": { file: "graph-harness.html", type: "text/html; charset=utf-8" },
	"/graph-account-preview.html": { file: "graph-account-preview.html", type: "text/html; charset=utf-8" },
	"/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
	"/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

export function readSite(urlPath: string): { body: string; type: string } | null {
	const hit = FILES[urlPath];
	if (!hit) return null;
	return { body: readFileSync(path.join(publicDir, hit.file), "utf8"), type: hit.type };
}
