#!/usr/bin/env node
/**
 * Real Obsidian (AppImage extract + xvfb): screenshots via CDP.
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, copyFileSync, appendFileSync, writeFileSync } from "node:fs";
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

mkdirSync(outDir, { recursive: true });
mkdirSync(path.dirname(obsidianConfig), { recursive: true });
for (const file of ["main.js", "styles.css", "manifest.json"]) {
	copyFileSync(path.join(pluginDist, file), path.join(pluginVault, file));
}

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

const { chromium } = await import("playwright");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 45_000 });
const page = browser.contexts()[0]?.pages()[0];
if (!page) throw new Error("No Obsidian page from CDP");

async function shot(name) {
	await page.screenshot({ path: path.join(outDir, `${name}.png`) });
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

await dismissStartupDialogs();

if (!(await page.locator(".gw-root").count())) {
	await page.keyboard.press("Control+p");
	await sleep(400);
	await page.keyboard.type("Groundwork: Open tutor", { delay: 15 });
	await sleep(300);
	await page.keyboard.press("Enter");
	await sleep(2000);
	await dismissStartupDialogs();
}

try {
	await page.waitForSelector(".gw-root", { timeout: 30_000 });
} catch {
	await shot("00-debug-no-plugin");
	throw new Error("Groundwork panel did not load — see 00-debug-no-plugin.png and obsidian.log");
}

await shot("01-tutor-open-1280");

await page.setViewportSize({ width: 360, height: 800 });
await sleep(700);
await shot("02-sidebar-360");

await page.setViewportSize({ width: 280, height: 720 });
await sleep(700);
await shot("03-sidebar-280");

await page.setViewportSize({ width: 1280, height: 800 });
await page.keyboard.press("Control+=");
await page.keyboard.press("Control+=");
await sleep(500);
await shot("04-zoom-in");

const rootSel = ".gw-root";
await page.locator(`${rootSel} button[aria-label="Library"]`).click();
await sleep(900);
await shot("05-library-overlay");

	await page.keyboard.press("Escape");
	await sleep(500);
await page.locator(`${rootSel} button[role="tab"]`, { hasText: "Concept map" }).click();
await sleep(1000);
await shot("06-map");

await page.locator(`${rootSel} button[aria-label="Library"]`).click();
await sleep(900);
await shot("07-map-then-library");

await page.keyboard.press("Escape");
await sleep(500);
await shot("08-after-escape");

await browser.close();
try {
	process.kill(-child.pid, "SIGTERM");
} catch {
	child.kill("SIGTERM");
}

console.log(`Wrote Obsidian E2E screenshots to ${outDir}`);
