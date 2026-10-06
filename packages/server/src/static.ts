import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSite } from "./site-pages";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

const FILES: Record<string, { file: string; type: string }> = {
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
	"/404.html": { file: "404.html", type: "text/html; charset=utf-8" },
	"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
	"/force-graph.js": { file: "force-graph.js", type: "text/javascript; charset=utf-8" },
	"/tracking.js": { file: "tracking.js", type: "text/javascript; charset=utf-8" },
	"/graph-harness.html": { file: "graph-harness.html", type: "text/html; charset=utf-8" },
	"/graph-account-preview.html": { file: "graph-account-preview.html", type: "text/html; charset=utf-8" },
	"/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
	"/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

const HERO_FILE = /^concept-map(?:-\d+)?\.(?:webp|avif|png)$/;
const SHOT_FILE = /^(?:quiz|flashcards|exam-chat|exam-map|goals)(?:-\d+)?\.(?:webp|avif|png)$/;

/** The home hero is one replaceable shot: `public/hero/concept-map.png`, plus the webp and avif sizes built from it. */
function imageType(name: string): string {
	if (name.endsWith(".png")) return "image/png";
	if (name.endsWith(".avif")) return "image/avif";
	return "image/webp";
}

function readImage(urlPath: string, folder: "hero" | "shots", pattern: RegExp): { body: Buffer; type: string } | null {
	const prefix = `/${folder}/`;
	if (!urlPath.startsWith(prefix)) return null;
	const name = path.basename(urlPath);
	if (name !== urlPath.slice(prefix.length) || !pattern.test(name)) return null;
	const file = path.join(publicDir, folder, name);
	if (!existsSync(file)) return null;
	return { body: readFileSync(file), type: imageType(name) };
}

export function readSite(urlPath: string): { body: string | Buffer; type: string } | null {
	const normalized = urlPath.length > 1 && urlPath.endsWith("/") ? urlPath.slice(0, -1) : urlPath;
	const rendered = renderSite(normalized);
	if (rendered) return rendered;
	const hero = readImage(normalized, "hero", HERO_FILE) ?? readImage(normalized, "shots", SHOT_FILE);
	if (hero) return hero;
	const hit = FILES[normalized];
	if (!hit) return null;
	return { body: readFileSync(path.join(publicDir, hit.file), "utf8"), type: hit.type };
}
