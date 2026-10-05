#!/usr/bin/env node
/**
 * Real Obsidian (AppImage + xvfb): local server, seeded account, CDP screenshots.
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, copyFileSync, appendFileSync, writeFileSync, cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const obsidianBin = "/workspace/tmp/obsidian-install/squashfs-root/obsidian";
const vaultTemplate = path.join(root, "scripts/fixtures/obsidian-test-vault");
const vault = "/workspace/tmp/gw-test-vault";
const pluginDist = path.join(root, "packages/obsidian-plugin/dist");
const pluginVault = path.join(vault, ".obsidian/plugins/groundwork");
const outDir = "/opt/cursor/artifacts/obsidian-real";
const port = 8787;
const obsidianConfig = "/home/ubuntu/.config/obsidian/obsidian.json";
const serverEntry = path.join(root, "packages/server/dist/server.js");

const scenario = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1] ?? "signed-in";

mkdirSync(outDir, { recursive: true });

function run(cmd, opts = {}) {
	execSync(cmd, { stdio: "inherit", ...opts });
}

function pluginData(extra = {}) {
	return {
		provider: "claude-code",
		claudePath: "",
		claudeModel: "",
		model: "claude-sonnet-4-5",
		maxTokens: 8192,
		deviceName: "cloud-test",
		appearance: "obsidian",
		readFolders: [],
		writeFolders: [],
		...extra,
	};
}

function prepareVault(data) {
	if (existsSync(vault)) execSync(`rm -rf ${JSON.stringify(vault)}`);
	cpSync(vaultTemplate, vault, { recursive: true });
	mkdirSync(pluginVault, { recursive: true });
	for (const file of ["main.js", "styles.css", "manifest.json"]) {
		copyFileSync(path.join(pluginDist, file), path.join(pluginVault, file));
	}
	writeFileSync(path.join(pluginVault, "data.json"), JSON.stringify(data, null, 2));
	if (data.accountToken) {
		writeFileSync(path.join(pluginVault, "e2e-account-token"), `${data.accountToken}\n`);
	}
	const memDb = path.join(root, "packages/server/data/tutor-memory.json");
	if (existsSync(memDb) && scenario !== "signed-out") {
		const db = JSON.parse(readFileSync(memDb, "utf8"));
		const files = db?.users?.local?.memory?.files;
		if (files) writeFileSync(path.join(pluginVault, "e2e-memory.json"), JSON.stringify({ files }, null, 2));
	}
}

async function startServer() {
	if (!existsSync(serverEntry)) run("npm run build -w packages/server");
	try {
		execSync("fuser -k 8787/tcp 2>/dev/null || true", { stdio: "ignore" });
	} catch {
		/* ignore */
	}
	await sleep(300);
	const log = "/tmp/groundwork-e2e-server.log";
	appendFileSync(log, "\n--- server ---\n");
	const child = spawn("node", [serverEntry], {
		env: {
			...process.env,
			GROUNDWORK_PORT: String(port),
			GROUNDWORK_TUTOR_STUB: "1",
			GROUNDWORK_MEMORY_FILE: path.join(root, "packages/server/data/tutor-memory.json"),
			GROUNDWORK_ACCOUNT_FILE: path.join(root, "packages/server/data/accounts.json"),
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	child.stdout?.on("data", (d) => appendFileSync(log, d));
	child.stderr?.on("data", (d) => appendFileSync(log, d));
	for (let i = 0; i < 40; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/v1/web-config`);
			if (res.ok) return child;
		} catch {
			/* wait */
		}
		await sleep(250);
	}
	throw new Error("Local Groundwork server did not start");
}

function stopServer(child) {
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

run(`GROUNDWORK_API_URL=http://127.0.0.1:${port} npm run build -w packages/obsidian-plugin`);

if (scenario === "new-account") run("npx tsx scripts/seed-e2e-tutor-memory.mjs --empty");
else run("npx tsx scripts/seed-e2e-tutor-memory.mjs");

const token = scenario === "signed-out" ? undefined : "e2e-local-token";
prepareVault(token ? pluginData({ accountToken: token }) : pluginData());

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
				direction: "horizontal",
				width: 900,
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

const serverChild = await startServer();
const cdpPort = 9333;
const log = "/tmp/obsidian-e2e.log";
appendFileSync(log, `\n--- run ${scenario} ---\n`);
const child = spawn(
	"xvfb-run",
	["-a", "--server-args=-screen 0 1280x800x24", obsidianBin, "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, vault],
	{ stdio: ["ignore", "pipe", "pipe"], detached: true },
);
child.stdout?.on("data", (d) => appendFileSync(log, d));
child.stderr?.on("data", (d) => appendFileSync(log, d));

await sleep(18_000);

const { chromium } = await import("playwright");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 45_000 });
const page = browser.contexts()[0]?.pages()[0];
if (!page) throw new Error("No Obsidian page from CDP");

const prefix = scenario === "signed-in" ? "" : `${scenario}-`;

async function shot(name) {
	const file = path.join(outDir, `${prefix}${name}.png`);
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await page.screenshot({ path: file });
			return;
		} catch (e) {
			if (attempt === 4) throw e;
			await sleep(400);
		}
	}
}

async function shotGroundwork(name) {
	const file = path.join(outDir, `${prefix}${name}.png`);
	await page.locator(".gw-root").screenshot({ path: file, timeout: 30_000 });
}

async function shotStatusBar(name) {
	const file = path.join(outDir, `${prefix}${name}.png`);
	await page.locator(".gw-statusbar").screenshot({ path: file, timeout: 15_000 });
}

async function shotGoalBar(name) {
	const file = path.join(outDir, `${prefix}${name}.png`);
	await page.locator(".gw-goalbar").screenshot({ path: file, timeout: 15_000 });
}

async function waitSignedInLinked() {
	await page.waitForFunction(
		() => /\bLinked\b/.test(document.querySelector(".gw-statusbar")?.textContent ?? ""),
		{ timeout: 90_000 },
	);
	await page.waitForFunction(
		() => {
			const chip = document.querySelector(".gw-chip-provider");
			if (!chip || chip.hasAttribute("hidden")) return true;
			const text = chip.textContent ?? "";
			return text.length > 0 && !/^Sign in$/i.test(text.trim());
		},
		{ timeout: 30_000 },
	);
	await page.locator(".gw-goalbar-label", { hasText: "Working goal" }).waitFor({ timeout: 15_000 });
	await page.waitForFunction(
		() => (document.querySelector(".gw-goal-select")?.options?.length ?? 0) >= 1,
		{ timeout: 30_000 },
	);
	await page.waitForFunction(
		() => {
			const sel = document.querySelector(".gw-goal-select");
			if (!sel || !("options" in sel) || sel.options.length < 1) return false;
			const label = sel.options[sel.selectedIndex]?.text ?? "";
			return /Calculus fluency|No goal pinned/.test(label);
		},
		{ timeout: 60_000 },
	);
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

const rootSel = ".gw-root";

await page.waitForSelector('.gw-root[data-gw-ready="true"]', { timeout: 60_000 });
if (scenario === "signed-in") {
	await page.waitForSelector('.gw-root[data-gw-bootstrapped="true"]', { timeout: 120_000 });
}

if (scenario === "signed-in") {
	await waitSignedInLinked();
	await page.waitForSelector(`${rootSel} .gw-msg-row`, { timeout: 30_000 });
	await sleep(800);
}

await shot("01-learn-1280-light");
if (scenario === "signed-in") {
	await shotGoalBar("00-working-goal-bar");
	await shotStatusBar("00-status-bar-linked");
}

await shotGroundwork("02-groundwork-column-360");

await page.setViewportSize({ width: 1280, height: 800 });
await page.keyboard.press("Control+=");
await page.keyboard.press("Control+=");
await sleep(500);
await shot("03-zoom-in");

if (scenario === "signed-in") {
	await page.keyboard.press("Escape");
	await sleep(300);
	await page.locator(`${rootSel} [data-testid="gw-library-btn"]`).click();
	await page.waitForSelector(`${rootSel}.is-library`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel} .gw-lib-name`, { hasText: /Calculus/i, timeout: 20_000 });
	await sleep(800);
	await shotGroundwork("04-library");

	await page.locator(`${rootSel} button.gw-lib-tab`, { hasText: /^Concepts/ }).click({ timeout: 10_000 }).catch(() => {});
	await sleep(600);
	await shot("05-library-concepts");

	await page.keyboard.press("Escape");
	await sleep(400);
	await page.locator(`${rootSel} [data-testid="gw-map-tab"]`).click();
	await page.waitForSelector(`${rootSel}.is-map`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel} .gw-concept-map, ${rootSel} .gw-map-empty`, { timeout: 20_000 });
	await sleep(800);
	await shotGroundwork("06-map");

	await page.locator(`${rootSel} [data-testid="gw-goals-tab"]`).click();
	await page.waitForSelector(`${rootSel}.is-goals`, { timeout: 15_000 });
	await sleep(1200);
	await shotGroundwork("07-goals");

	await page.locator(`${rootSel} button[aria-label="Flashcards"]`).click();
	await page.waitForSelector(`${rootSel}.is-flashcards`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel} .gw-fc-loading, ${rootSel} .gw-fc-empty, ${rootSel} .gw-fcard`, { timeout: 20_000 });
	await sleep(800);
	await shotGroundwork("08-flashcards");

	await page.keyboard.press("Escape");
	await sleep(400);
	await page.locator(`${rootSel} button[aria-label="Settings"]`).click();
	await page.waitForSelector(`${rootSel}.is-settings`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel}.is-settings .gw-library-title`, { hasText: "Settings", timeout: 15_000 });
	await page.waitForSelector(`${rootSel}.is-settings h3`, { timeout: 15_000 });
	await sleep(600);
	await shotGroundwork("09-settings");

	await page.keyboard.press("Escape");
	await sleep(400);
	await page.locator(`${rootSel} button[aria-label="Library"]`).click();
	await sleep(800);
	await page.locator(`${rootSel} button.gw-lib-tab`, { hasText: /^Chats/ }).click({ timeout: 15_000 });
	await sleep(500);
	const openChat = page.locator(`${rootSel} button`, { hasText: "Open" }).first();
	if (await openChat.count()) {
		await openChat.click();
		await page.waitForSelector(`${rootSel}:not(.is-overlay)`, { timeout: 15_000 });
		await page.waitForSelector(`${rootSel} .gw-msg-row`, { timeout: 25_000 });
		await page.waitForSelector(`${rootSel} .gw-assistant`, { timeout: 25_000 });
		await sleep(800);
		await shotGroundwork("10-chat-seeded");
	}
	await page.keyboard.press("Escape");
	await sleep(400);
	await page.locator(`${rootSel} button[aria-label="Settings"]`).click();
	await page.waitForSelector(`${rootSel}.is-settings`, { timeout: 15_000 });
	await sleep(600);
	await page.locator(`${rootSel} button.gw-appearance-btn`, { hasText: /^Dark$/ }).click({ timeout: 15_000 });
	await sleep(500);
	await page.keyboard.press("Escape");
	await sleep(400);
	await page.waitForSelector(`${rootSel}:not(.is-overlay)`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel} .gw-msg-row`, { timeout: 20_000 });
	await sleep(600);
	await shotGroundwork("11-dark-learn");
	await page.locator(`${rootSel} button[aria-label="Library"]`).click();
	await sleep(1000);
	await shot("12-dark-library");
	await page.keyboard.press("Escape");
	await sleep(300);
	await page.locator(`${rootSel} button.gw-view[aria-label="Concept map"]`).click();
	await sleep(1200);
	await shot("13-dark-map");
}

if (scenario === "signed-out") {
	await shot("04-signed-out-empty");
}

if (scenario === "new-account") {
	await page.locator(`${rootSel} button[aria-label="Library"]`).click();
	await sleep(1000);
	await shot("04-new-account-library");
	await page.keyboard.press("Escape");
}

await browser.close();
try {
	process.kill(-child.pid, "SIGTERM");
} catch {
	child.kill("SIGTERM");
}
stopServer(serverChild);

console.log(`Wrote Obsidian E2E (${scenario}) screenshots to ${outDir}`);
