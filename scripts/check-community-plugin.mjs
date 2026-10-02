import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packages/obsidian-plugin/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const versions = JSON.parse(readFileSync(path.join(root, "versions.json"), "utf8"));
const styles = readFileSync(path.join(root, "packages/obsidian-plugin/styles.css"), "utf8");
const site = readFileSync(path.join(root, "packages/site/public/site.css"), "utf8");

const fail = (message) => {
	console.error(message);
	process.exitCode = 1;
};

const required = ["id", "name", "version", "minAppVersion", "description", "author", "authorUrl", "isDesktopOnly"];
for (const key of required) {
	if (manifest[key] === undefined || manifest[key] === "") fail(`manifest.json is missing ${key}`);
}
if (manifest.id !== "groundwork") fail(`plugin id must be "groundwork" so the community folder matches (got ${manifest.id})`);
if (!/^[a-z0-9-]+$/.test(manifest.id)) fail("plugin id must be lowercase letters, numbers, and hyphens");
if (typeof manifest.description !== "string" || manifest.description.length > 250) fail("description must be a string of at most 250 characters");
if (manifest.isDesktopOnly !== true) fail("isDesktopOnly must be true: the plugin shells out to git");
if (versions[manifest.version] !== manifest.minAppVersion) {
	fail(`versions.json must map ${manifest.version} to minAppVersion ${manifest.minAppVersion}`);
}
if (!existsSync(path.join(root, "LICENSE"))) fail("LICENSE is required for the community plugin directory");
if (!existsSync(path.join(root, "README.md"))) fail("README.md is required");

const themeTokens = ["#f3efe6", "#1c1915", "#0e6b52", "#1f8a5b", "#b8860b", "#c45c26", "#6b46c1", "#8d877e"];
for (const token of themeTokens) {
	if (!site.includes(token)) fail(`site.css is missing ${token}`);
	if (!styles.includes(token)) fail(`plugin styles.css is missing website token ${token}`);
}

const distManifest = path.join(root, "packages/obsidian-plugin/dist/manifest.json");
if (existsSync(distManifest)) {
	const built = JSON.parse(readFileSync(distManifest, "utf8"));
	if (built.version !== manifest.version || built.id !== manifest.id) fail("dist/manifest.json does not match the source manifest");
	for (const file of ["main.js", "styles.css"]) {
		if (!existsSync(path.join(root, "packages/obsidian-plugin/dist", file))) fail(`dist/${file} is missing from the plugin build`);
	}
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`Community plugin checklist passed for ${manifest.id} ${manifest.version} (Obsidian ${manifest.minAppVersion}+).`);
