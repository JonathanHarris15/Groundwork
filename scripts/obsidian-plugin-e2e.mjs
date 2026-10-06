#!/usr/bin/env node
/**
 * Real Obsidian (AppImage + xvfb): local server, seeded account, CDP screenshots.
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, copyFileSync, appendFileSync, writeFileSync, cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const obsidianBin =
	process.env.OBSIDIAN_BIN?.trim() ||
	path.join(root, "tmp/obsidian-install/squashfs-root/obsidian");
const vaultTemplate = path.join(root, "scripts/fixtures/obsidian-test-vault");
const vault = process.env.GROUNDWORK_OBSIDIAN_VAULT?.trim() || path.join(root, "tmp/gw-test-vault");
const pluginDist = path.join(root, "packages/obsidian-plugin/dist");
const pluginVault = path.join(vault, ".obsidian/plugins/groundwork");
const outDir =
	process.env.GROUNDWORK_OBSIDIAN_E2E_OUT?.trim() ||
	(process.env.CI ? path.join(root, "artifacts/obsidian-real") : "/opt/cursor/artifacts/obsidian-real");
const port = 8787;
const obsidianConfig = path.join(process.env.HOME ?? "/tmp", ".config/obsidian/obsidian.json");
const serverEntry = path.join(root, "packages/server/dist/server.js");

const scenario = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1] ?? "signed-in";
const skipIfMissing = process.argv.includes("--skip-if-missing-obsidian");

mkdirSync(outDir, { recursive: true });

if (!existsSync(obsidianBin)) {
	const msg = `Obsidian binary not found at ${obsidianBin}. Run: bash scripts/install-obsidian-appimage.sh`;
	if (skipIfMissing) {
		console.log(`SKIP: ${msg}`);
		process.exit(0);
	}
	console.error(msg);
	process.exit(2);
}

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
if (scenario !== "signed-out") {
	run(`npx -y tsx ${JSON.stringify(path.join(root, "scripts/seed-obsidian-graph-vault.mjs"))} ${JSON.stringify(vault)}`);
}

mkdirSync(path.dirname(obsidianConfig), { recursive: true });
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
	[
		"-a",
		"--server-args=-screen 0 1280x800x24",
		obsidianBin,
		"--no-sandbox",
		"--disable-gpu",
		`--remote-debugging-port=${cdpPort}`,
		vault,
	],
	{
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
		env: { ...process.env, ELECTRON_DISABLE_GPU: "1", LIBGL_ALWAYS_SOFTWARE: "1" },
	},
);
child.stdout?.on("data", (d) => appendFileSync(log, d));
child.stderr?.on("data", (d) => appendFileSync(log, d));

await sleep(18_000);

const { chromium } = await import("playwright");
let browser;
for (let attempt = 0; attempt < 6; attempt++) {
	try {
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 45_000 });
		break;
	} catch (e) {
		if (attempt === 5) throw e;
		await sleep(5000);
	}
}
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
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await page.locator(".gw-root").screenshot({ path: file, timeout: 30_000 });
			return;
		} catch (e) {
			if (attempt === 4) throw e;
			await sleep(400);
		}
	}
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
	await page.locator(".gw-goalbar-label", { hasText: "Working on:" }).waitFor({ timeout: 15_000 });
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
	await page.waitForFunction(
		() => {
			const root = document.querySelector(".gw-root");
			if (!root) return false;
			const empties = root.querySelectorAll(".gw-messages > .gw-empty").length;
			const heroes = root.querySelectorAll('.gw-messages > .gw-empty .gw-hero h2').length;
			return empties <= 1 && heroes <= 1;
		},
		{ timeout: 30_000 },
	);
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

/** Library and Settings are screens like the tabs: no Close or X, and a center tab leaves them. */
async function expectNoCloseButton(screen) {
	const closers = page.locator(`${rootSel}.is-${screen} .gw-${screen} button`).filter({ hasText: /^(Close|×|✕)$/ });
	const labelled = page.locator(`${rootSel}.is-${screen} .gw-${screen} button[aria-label="Close"]`);
	if ((await closers.count()) + (await labelled.count())) throw new Error(`${screen} still shows a Close button`);
}
const tab = (id) => page.locator(`${rootSel} [data-testid="gw-${id}-tab"]`);
const utility = (id) => page.locator(`${rootSel} [data-testid="gw-${id}-btn"]`);

/** Interval text must sit inside the button, clear of the border, and the key hint must not collide with the label. */
async function assertRatingIntervalsFit() {
	const show = page.locator(`${rootSel} .gw-fc-show`);
	if (await show.count()) await show.click();
	await page.waitForSelector(`${rootSel} .gw-rb-when`, { timeout: 10_000 });
	const problems = await page.evaluate((sel) => {
		const card = document.querySelector(`${sel} .gw-fcard`)?.getBoundingClientRect();
		const rate = document.querySelector(`${sel} .gw-fc-rate`)?.getBoundingClientRect();
		const issues = [];
		if (!card || !rate) issues.push("missing card or rating row");
		else if (Math.abs(rate.top - card.bottom) > 1) issues.push(`rating row sits ${Math.abs(rate.top - card.bottom).toFixed(1)}px off the card`);
		for (const button of document.querySelectorAll(`${sel} .gw-rb`)) {
			const interval = button.querySelector(".gw-rb-when");
			const label = button.querySelector("b");
			const key = button.querySelector("kbd");
			const name = label?.textContent || "rating";
			if (!interval || !label || !key) {
				issues.push(`${name} is missing its label, key, or interval`);
				continue;
			}
			const box = button.getBoundingClientRect();
			const cs = getComputedStyle(button);
			const inner = {
				top: box.top + (parseFloat(cs.borderTopWidth) || 0),
				right: box.right - (parseFloat(cs.borderRightWidth) || 0),
				bottom: box.bottom - (parseFloat(cs.borderBottomWidth) || 0),
				left: box.left + (parseFloat(cs.borderLeftWidth) || 0),
			};
			const text = interval.getBoundingClientRect();
			const outside = text.top < inner.top - 0.5 || text.bottom > inner.bottom + 0.5 || text.left < inner.left - 0.5 || text.right > inner.right + 0.5;
			if (outside) issues.push(`${name} interval is outside the button`);
			else if (inner.bottom - text.bottom < 6) issues.push(`${name} interval is ${(inner.bottom - text.bottom).toFixed(1)}px from the button edge`);
			const labelBox = label.getBoundingClientRect();
			const keyBox = key.getBoundingClientRect();
			const gap = Math.max(keyBox.left - labelBox.right, labelBox.left - keyBox.right, keyBox.top - labelBox.bottom, labelBox.top - keyBox.bottom);
			if (gap < 4) issues.push(`${name} key hint crowds the label`);
		}
		return issues;
	}, rootSel);
	if (problems.length) throw new Error(`Flashcard ratings: ${problems.join("; ")}`);
}

if (scenario === "signed-in") {
	await utility("library").click();
	await page.waitForSelector(`${rootSel}.is-library`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel} .gw-lib-name`, { hasText: /Calculus/i, timeout: 20_000 });
	await expectNoCloseButton("library");
	await sleep(800);
	await shotGroundwork("04-library");

	await page.locator(`${rootSel} button.gw-lib-tab`, { hasText: /^Concepts/ }).click({ timeout: 10_000 }).catch(() => {});
	await sleep(600);
	await shot("05-library-concepts");

	await page.locator(`${rootSel} button.gw-lib-tab`, { hasText: /^Flashcards/ }).click({ timeout: 10_000 });
	await page.waitForSelector(`${rootSel} .gw-fc-lib-layout`, { timeout: 20_000 });
	await page.locator(`${rootSel} .gw-fc-lib-deck`, { hasText: "Unsorted" }).waitFor({ timeout: 20_000 });
	await sleep(600);
	await shotGroundwork("05b-library-flashcards");

	await page.locator(`${rootSel} .gw-fc-lib-deck`, { hasText: "Unsorted" }).click();
	await page.locator(`${rootSel} .gw-fc-lib-note`, { hasText: "aren't put in a deck" }).waitFor({ timeout: 10_000 });
	if (await page.locator(`${rootSel} .gw-fc-lib-head button`, { hasText: /^Delete$/ }).count()) {
		throw new Error("Unsorted should not offer Delete");
	}
	await page.locator(`${rootSel} .gw-fc-lib-deck`, { hasText: "Scratch pad" }).click();
	await page.locator(`${rootSel} .gw-fc-lib-card button`, { hasText: /^Edit$/ }).waitFor({ timeout: 10_000 });
	await page.locator(`${rootSel} .gw-fc-lib-card button`, { hasText: /^Delete$/ }).waitFor({ timeout: 10_000 });
	await page.locator(`${rootSel} .gw-fc-lib-head button`, { hasText: /^Rename$/ }).click();
	const deckName = page.locator(`${rootSel} .gw-fc-lib-rename input[aria-label='Deck name']`);
	await deckName.fill("Drill pad");
	await page.locator(`${rootSel} .gw-fc-lib-rename button`, { hasText: /^Save$/ }).click();
	await page.locator(`${rootSel} h3`, { hasText: "Drill pad" }).waitFor({ timeout: 10_000 });
	const deleteBtn = page.locator(`${rootSel} .gw-fc-lib-head button[aria-label="Delete Drill pad"]`);
	await deleteBtn.waitFor({ timeout: 10_000 });
	const pageErrors = [];
	page.on("pageerror", (err) => pageErrors.push(String(err)));
	// Pointer clicks from CDP sometimes land beside this button under xvfb. A DOM click still runs the handler.
	await deleteBtn.evaluate((el) => {
		window.__gwDeleteClicks = 0;
		el.addEventListener("click", () => {
			window.__gwDeleteClicks += 1;
		});
		el.click();
	});
	try {
		await page.locator(".modal").waitFor({ timeout: 10_000 });
	} catch (err) {
		const info = await page.evaluate(() => ({
			clicks: window.__gwDeleteClicks ?? 0,
			modals: document.querySelectorAll(".modal").length,
			containers: document.querySelectorAll(".modal-container").length,
			head: document.querySelector(".gw-fc-lib-head")?.innerText ?? "",
			notices: [...document.querySelectorAll(".notice")].map((node) => node.textContent),
		}));
		const pages = page.context().pages();
		const elsewhere = [];
		for (const other of pages) {
			elsewhere.push({ url: other.url(), modals: await other.locator(".modal-container").count() });
		}
		await shot("05c-delete-failed");
		throw new Error(
			`Delete did not open a modal (${JSON.stringify({ ...info, elsewhere, pageErrors })}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const confirmText = await page.locator(".modal").innerText();
	if (!/1 card/.test(confirmText) || !/vault/i.test(confirmText)) {
		throw new Error(`Delete confirmation did not explain the card count and the vault notes: ${confirmText}`);
	}
	await shot("05c-delete-deck-confirm");
	await page.locator(".modal button", { hasText: "Delete deck" }).click();
	await page.waitForFunction(() => !document.querySelector(".gw-root")?.textContent?.includes("Drill pad"), { timeout: 10_000 });
	await page.locator(`${rootSel} .gw-lib-tab[title="Flashcards"] .gw-lib-count`, { hasText: /^2$/ }).waitFor({ timeout: 10_000 });
	await page.locator(`${rootSel} h3`, { hasText: /Calculus fluency|Unsorted/ }).waitFor({ timeout: 10_000 });
	await sleep(400);
	await shotGroundwork("05d-deck-deleted");

	await tab("map").click();
	await page.waitForSelector(`${rootSel}.is-map:not(.is-library)`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel} .gw-force-map, ${rootSel} .gw-map-empty`, { timeout: 60_000 });
	await sleep(800);
	await shotGroundwork("06-map");

	await tab("goals").click();
	await page.waitForSelector(`${rootSel}.is-goals`, { timeout: 15_000 });
	await sleep(1200);
	await shotGroundwork("07-goals");
	await page.locator(`${rootSel} .gw-concept-list`).scrollIntoViewIfNeeded();
	const clipped = await page.evaluate((sel) => {
		const list = document.querySelector(`${sel} .gw-concept-list`);
		const edge = list?.getBoundingClientRect().right ?? 0;
		return [...(list?.querySelectorAll(".gw-row-action") ?? [])].filter((b) => b.getBoundingClientRect().right > edge + 1).length;
	}, rootSel);
	if (clipped) throw new Error(`${clipped} Goals row action(s) sit past the edge of the concept list`);
	await sleep(400);
	await shotGroundwork("07b-goals-concepts");

	await tab("flashcards").click();
	await page.waitForSelector(`${rootSel}.is-flashcards`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel} .gw-fc-loading, ${rootSel} .gw-fc-empty, ${rootSel} .gw-fcard`, { timeout: 20_000 });
	await sleep(800);
	await assertRatingIntervalsFit();
	await shotGroundwork("08-flashcards");
	for (const appearance of ["Dark", "Light"]) {
		await utility("settings").click();
		await page.waitForSelector(`${rootSel}.is-settings`, { timeout: 15_000 });
		await page.locator(`${rootSel} button.gw-appearance-btn`, { hasText: new RegExp(`^${appearance}$`) }).click({ timeout: 10_000 });
		await sleep(300);
		await tab("flashcards").click();
		await page.waitForSelector(`${rootSel}.is-flashcards .gw-fcard`, { timeout: 15_000 });
		await assertRatingIntervalsFit();
	}
	await utility("settings").click();
	await page.waitForSelector(`${rootSel}.is-settings`, { timeout: 15_000 });
	await page.locator(`${rootSel} button.gw-appearance-btn`, { hasText: /^Obsidian$/ }).click({ timeout: 10_000 });
	await sleep(300);
	await tab("flashcards").click();
	await page.waitForSelector(`${rootSel}.is-flashcards:not(.is-settings)`, { timeout: 15_000 });

	await utility("library").click();
	await page.waitForSelector(`${rootSel}.is-library`, { timeout: 15_000 });
	await page.locator(`${rootSel} button.gw-lib-tab`, { hasText: /^Flashcards/ }).click({ timeout: 10_000 });
	await page.locator(`${rootSel} .gw-fc-lib-deck`, { hasText: "Later deck" }).click();
	await page.locator(`${rootSel} h3`, { hasText: "Later deck" }).waitFor({ timeout: 10_000 });
	await page.locator(`${rootSel} button`, { hasText: "Study this deck" }).click();
	await page.waitForSelector(`${rootSel}.is-flashcards .gw-fcard-front`, { timeout: 15_000 });
	const sitting = await page.locator(`${rootSel}.is-flashcards`).innerText();
	if (/Nothing due|tomorrow|Next card/i.test(sitting)) {
		throw new Error(`Study sitting still talks about a due date: ${sitting}`);
	}
	if (!sitting.includes("What is the integral of 2x?")) {
		throw new Error(`A card due in 2099 did not open: ${sitting}`);
	}
	await shotGroundwork("08b-study-not-due");
	await page.locator(`${rootSel} .gw-fc-show`).click();
	await page.locator(`${rootSel} .gw-rb-again`).click();
	await page.waitForFunction(
		() => document.querySelector(".gw-root.is-flashcards .gw-fcard-front")?.textContent?.includes("integral of 2x"),
		{ timeout: 10_000 },
	);
	await page.locator(`${rootSel} .gw-fc-show`).click();
	await page.locator(`${rootSel} .gw-rb-good`).click();
	await page.waitForFunction(
		() => /Deck finished/.test(document.querySelector(".gw-root.is-flashcards")?.textContent ?? ""),
		{ timeout: 10_000 },
	);
	const finished = await page.locator(`${rootSel}.is-flashcards`).innerText();
	if (/Nothing due|tomorrow|Next card/i.test(finished)) {
		throw new Error(`Finished sitting still talks about tomorrow: ${finished}`);
	}
	await shotGroundwork("08c-deck-finished");

	await utility("settings").click();
	await page.waitForSelector(`${rootSel}.is-settings:not(.is-flashcards)`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel}.is-settings .gw-library-title`, { hasText: "Settings", timeout: 15_000 });
	await page.waitForSelector(`${rootSel}.is-settings h3`, { timeout: 15_000 });
	await expectNoCloseButton("settings");
	await page.locator(`${rootSel}.is-settings .gw-settings .gw-tutor-weight button`, { hasText: /^Light$/ }).waitFor({ timeout: 15_000 });
	await page.locator(`${rootSel}.is-settings .gw-settings .gw-tutor-weight button`, { hasText: /^Heavy$/ }).click();
	await page.locator(`${rootSel}.is-settings .gw-settings .gw-tutor-weight button.is-on`, { hasText: /^Heavy$/ }).waitFor({ timeout: 15_000 });
	await shotGroundwork("09b-tutor-heavy");
	await page.locator(`${rootSel}.is-settings .gw-settings .gw-tutor-weight button`, { hasText: /^Light$/ }).click();
	await page.locator(`${rootSel}.is-settings .gw-settings .gw-tutor-weight button.is-on`, { hasText: /^Light$/ }).waitFor({ timeout: 15_000 });
	await sleep(400);
	await shotGroundwork("09-settings");

	await utility("library").click();
	await page.waitForSelector(`${rootSel}.is-library:not(.is-settings)`, { timeout: 15_000 });
	await sleep(800);
	await page.locator(`${rootSel} button.gw-lib-tab`, { hasText: /^Chats/ }).click({ timeout: 15_000 });
	await sleep(500);
	const openChat = page.locator(`${rootSel}.is-library .gw-library-scroll button.gw-lib-btn`).filter({ hasText: /^Open$/ });
	if (await openChat.count()) {
		await openChat.first().click({ timeout: 15_000 });
		await page.waitForSelector(`${rootSel}:not(.is-library)`, { timeout: 15_000 });
		await page.waitForSelector(`${rootSel} .gw-msg-row`, { timeout: 25_000 });
		await page.waitForSelector(`${rootSel} .gw-assistant`, { timeout: 25_000 });
		await sleep(800);
		await shotGroundwork("10-chat-seeded");
	}
	await utility("settings").click();
	await page.waitForSelector(`${rootSel}.is-settings`, { timeout: 15_000 });
	await sleep(600);
	await page.locator(`${rootSel} button.gw-appearance-btn`, { hasText: /^Dark$/ }).click({ timeout: 15_000 });
	await sleep(500);
	await tab("learn").click();
	await page.waitForSelector(`${rootSel}:not(.is-settings)`, { timeout: 15_000 });
	await page.waitForSelector(`${rootSel} .gw-msg-row`, { timeout: 20_000 });
	await sleep(600);
	await shotGroundwork("11-dark-learn");
	await utility("library").click();
	await page.waitForSelector(`${rootSel}.is-library`, { timeout: 15_000 });
	await page.locator(`${rootSel} button.gw-lib-tab`, { hasText: /^Concepts/ }).click({ timeout: 10_000 }).catch(() => {});
	await sleep(1000);
	await shot("12-dark-library");
	await tab("map").click();
	await page.waitForSelector(`${rootSel}.is-map:not(.is-library)`, { timeout: 15_000 });
	await sleep(1200);
	await shot("13-dark-map");
	await tab("goals").click();
	await page.waitForSelector(`${rootSel}.is-goals`, { timeout: 15_000 });
	await sleep(1000);
	await shot("14-dark-goals");
}

if (scenario === "signed-out") {
	await shot("04-signed-out-empty");
}

if (scenario === "new-account") {
	await utility("library").click();
	await sleep(1000);
	await shot("04-new-account-library");
	await tab("learn").click();
}

await browser.close();
try {
	process.kill(-child.pid, "SIGTERM");
} catch {
	child.kill("SIGTERM");
}
stopServer(serverChild);

console.log(`Wrote Obsidian E2E (${scenario}) screenshots to ${outDir}`);
