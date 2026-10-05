#!/usr/bin/env node
/**
 * Real Obsidian (AppImage extract + xvfb): screenshots via CDP.
 * Graph-focused: concept map tab, force canvas, sidebar widths, zoom, light/dark.
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, copyFileSync, appendFileSync, writeFileSync, cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const obsidianBin = "/workspace/tmp/obsidian-install/squashfs-root/obsidian";
const vaultTemplate = path.join(root, "scripts/fixtures/obsidian-test-vault");
const vault = "/workspace/tmp/gw-test-vault";
const pluginDist = path.join(root, "packages/obsidian-plugin/dist");
const pluginVault = path.join(vault, ".obsidian/plugins/groundwork");
const outDir = "/opt/cursor/artifacts/obsidian-real";
const port = 9333;
const obsidianConfig = "/home/ubuntu/.config/obsidian/obsidian.json";

if (!existsSync(obsidianBin)) {
	console.error(`Obsidian binary missing at ${obsidianBin}. Extract Obsidian 1.13.7 AppImage to that path first.`);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });
mkdirSync(path.dirname(obsidianConfig), { recursive: true });
if (existsSync(vault)) {
	execSync(`rm -rf ${JSON.stringify(vault)}`);
}
cpSync(vaultTemplate, vault, { recursive: true });
execSync(`npx -y tsx ${JSON.stringify(path.join(root, "scripts/seed-obsidian-graph-vault.mjs"))} ${JSON.stringify(vault)}`, {
	cwd: root,
	stdio: "inherit",
});
mkdirSync(pluginVault, { recursive: true });
for (const file of ["main.js", "styles.css", "manifest.json"]) {
	copyFileSync(path.join(pluginDist, file), path.join(pluginVault, file));
}
writeFileSync(
	path.join(vault, ".obsidian/appearance.json"),
	JSON.stringify({ theme: "obsidian", baseFontSize: 16, accentColor: "" }, null, 2),
);
writeFileSync(
	path.join(vault, ".obsidian/plugins/groundwork/data.json"),
	JSON.stringify(
		{
			provider: "demo",
			claudePath: "",
			claudeModel: "",
			model: "claude-sonnet-4-5",
			maxTokens: 8192,
			deviceName: "cloud-test",
			appearance: "obsidian",
			readFolders: [],
			writeFolders: [],
		},
		null,
		2,
	),
);

writeFileSync(
	obsidianConfig,
	JSON.stringify({
		vaults: {
			gwtestvault00001: { path: vault, ts: Date.now(), open: true },
		},
	}),
);

writeFileSync(
	path.join(vault, ".obsidian/workspace.json"),
	JSON.stringify(
		{
			main: {
				id: "gw-main",
				type: "split",
				children: [
					{
						id: "note-leaf",
						type: "leaf",
						state: { type: "markdown", state: { file: "Welcome.md", mode: "source" }, icon: "lucide-file", title: "Welcome" },
					},
					{
						id: "gw-leaf",
						type: "leaf",
						state: { type: "groundwork-chat", state: {}, icon: "graduation-cap", title: "Groundwork" },
					},
				],
				direction: "vertical",
			},
			active: "gw-leaf",
			lastOpenFiles: ["Welcome.md"],
		},
		null,
		2,
	),
);

try {
	execSync("pkill -f 'squashfs-root/obsidian' || true", { stdio: "ignore" });
} catch {
	/* ignore */
}

const log = "/tmp/obsidian-e2e.log";
appendFileSync(log, "\n--- run ---\n");
const child = spawn(
	"xvfb-run",
	["-a", "--server-args=-screen 0 1280x800x24", obsidianBin, "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, vault],
	{ stdio: ["ignore", "pipe", "pipe"], detached: true },
);
child.stdout?.on("data", (d) => appendFileSync(log, d));
child.stderr?.on("data", (d) => appendFileSync(log, d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(18_000);

const { chromium } = await import("@playwright/test");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 45_000 });
const page = browser.contexts()[0]?.pages()[0];
if (!page) throw new Error("No Obsidian page from CDP");

const rootSel = ".gw-root";

async function shot(name) {
	await page.screenshot({ path: path.join(outDir, `${name}.png`) });
}

async function shotCanvas(name) {
	const canvas = page.locator(`${rootSel} canvas.gw-force-canvas`).first();
	if (!(await canvas.count())) {
		await shot(name);
		return;
	}
	const box = await canvas.boundingBox();
	if (!box || box.width < 4 || box.height < 4) {
		await shot(name);
		return;
	}
	await page.screenshot({
		path: path.join(outDir, `${name}.png`),
		clip: { x: box.x, y: box.y, width: box.width, height: box.height },
	});
}

/** Groundwork map column at a fixed width (toolbar + canvas + legend), not the Obsidian file tree. */
async function shotMapColumn(name, columnWidth) {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.evaluate((w) => {
		const side = document.querySelector(".gw-root .gw-side");
		const wrap = document.querySelector(".gw-root .gw-mapwrap");
		if (side) side.style.display = "none";
		if (wrap) {
			wrap.style.width = `${w}px`;
			wrap.style.maxWidth = `${w}px`;
			wrap.style.minHeight = "480px";
		}
	}, columnWidth);
	await sleep(400);
	const fitBtn = page.locator(`${rootSel} button[aria-label="Fit in window"]`).first();
	if (await fitBtn.count()) {
		await fitBtn.click({ force: true });
		await sleep(500);
	}
	await page.locator(`${rootSel} .gw-mapwrap`).screenshot({ path: path.join(outDir, `${name}.png`) });
}

async function resetMapLayout() {
	await page.evaluate(() => {
		const side = document.querySelector(".gw-root .gw-side");
		const wrap = document.querySelector(".gw-root .gw-mapwrap");
		if (side) side.style.display = "";
		if (wrap) {
			wrap.style.width = "";
			wrap.style.maxWidth = "";
			wrap.style.minHeight = "";
		}
	});
}

async function dismissStartupDialogs() {
	for (const label of [/Turn on community plugins/i, /Trust author/i, /Enable community plugins/i, /^Open$/i]) {
		const btn = page.getByRole("button", { name: label });
		if (await btn.count()) {
			await btn.first().click();
			await sleep(800);
		}
	}
}

async function openTutor() {
	if (await page.locator(rootSel).count()) return;
	await page.keyboard.press("Control+p");
	await sleep(400);
	await page.keyboard.type("Groundwork: Open tutor", { delay: 15 });
	await sleep(300);
	await page.keyboard.press("Enter");
	await sleep(2000);
	await dismissStartupDialogs();
}

async function openConceptMap() {
	await page.locator(`${rootSel} button[role="tab"]`, { hasText: "Concept map" }).click();
	await sleep(500);
	await page.locator(rootSel).waitFor({ state: "visible" });
	await sleep(2500);
	const mapText = await page.locator(`${rootSel} .gw-map`).innerText().catch(() => "");
	if (mapText.includes("Pin a goal")) {
		await shot("00-map-empty-state");
		throw new Error(`Concept map is empty: ${mapText.slice(0, 120)}`);
	}
	const err = await page.locator(`${rootSel} .gw-error`).first().textContent().catch(() => "");
	if (err?.trim()) {
		await shot("00-map-error");
		throw new Error(`Concept map error: ${err.trim()}`);
	}
	await page.locator(`${rootSel} canvas.gw-force-canvas`).first().waitFor({ state: "attached", timeout: 35_000 });
	await sleep(1000);
}

async function runPalette(command) {
	await page.keyboard.press("Control+p");
	await sleep(350);
	await page.keyboard.type(command, { delay: 12 });
	await sleep(250);
	await page.keyboard.press("Enter");
	await sleep(900);
}

await dismissStartupDialogs();
await openTutor();
await page.waitForSelector(rootSel, { timeout: 30_000 });
await sleep(4000);
const goalSelect = page.locator(`${rootSel} .gw-goalchip select`);
if (await goalSelect.count()) {
	const options = await goalSelect.locator("option").allTextContents();
	const pick = options.find((t) => t.includes("Midterm")) ?? options.find((t) => t && !/no goal/i.test(t));
	if (pick) {
		await goalSelect.selectOption({ label: pick });
		await sleep(1500);
	}
}

await page.setViewportSize({ width: 1280, height: 800 });
await openConceptMap();
await shot("graph-main-tab-dark-1280");
await shotCanvas("graph-canvas-main-dark-1280");

for (const width of [280, 360]) {
	await shotMapColumn(`graph-map-column-${width}-dark`, width);
}
await resetMapLayout();

try {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.keyboard.press("Control+=");
	await page.keyboard.press("Control+=");
	await sleep(600);
	await shotCanvas("graph-canvas-zoom-in-dark");
	const fitBtn = page.locator(`${rootSel} button[aria-label="Fit in window"]`).first();
	if (await fitBtn.count()) {
		await fitBtn.click({ force: true });
		await sleep(500);
	}
	const canvas = page.locator(`${rootSel} canvas.gw-force-canvas`).first();
	const box = await canvas.boundingBox();
	if (box) {
		await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.42);
		await sleep(400);
		await shotCanvas("graph-canvas-hover-dark");
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.38, { steps: 12 });
		await page.mouse.up();
		await sleep(800);
		await shotCanvas("graph-canvas-drag-dark");
	}
} catch (e) {
	console.warn("Zoom/hover/drag shots skipped:", e instanceof Error ? e.message : e);
}

await page.evaluate(() => {
	const app = window.app;
	if (!app) throw new Error("no app");
	if (typeof app.changeTheme === "function") app.changeTheme("moonstone");
	else if (typeof app.setTheme === "function") app.setTheme("moonstone");
	else {
		document.body.classList.remove("theme-dark");
		document.body.classList.add("theme-light");
	}
});
await sleep(1200);
await openConceptMap();
await shot("graph-main-tab-light-1280");
await shotCanvas("graph-canvas-main-light-1280");
for (const width of [280, 360]) {
	await shotMapColumn(`graph-map-column-${width}-light`, width);
}
await shotMapColumn("graph-map-column-360-light-ghosts-on", 360);
await page.locator(`${rootSel} button.gw-toggle`, { hasText: "Show concepts still ahead" }).click();
await sleep(500);
await shotMapColumn("graph-map-column-360-light-ghosts-off", 360);
await page.locator(`${rootSel} .gw-seg button`, { hasText: "All concepts" }).click();
await sleep(600);
await shotMapColumn("graph-map-column-360-light-all-concepts", 360);
await resetMapLayout();

await browser.close();
try {
	process.kill(-child.pid, "SIGTERM");
} catch {
	child.kill("SIGTERM");
}

console.log(`Wrote Obsidian graph E2E screenshots to ${outDir}`);
