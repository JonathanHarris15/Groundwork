#!/usr/bin/env node
/**
 * Real Obsidian captures for the Calc 1 practice-test page.
 * Full window and a tight crop of each scene, at 2x, dark theme.
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, cpSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const obsidianBin = process.env.OBSIDIAN_BIN?.trim() || path.join(root, "tmp/obsidian-install/squashfs-root/obsidian");
const vaultTemplate = path.join(root, "scripts/fixtures/obsidian-test-vault");
const vault = path.join(root, "tmp/gw-calc-vault");
const pluginDist = path.join(root, "packages/obsidian-plugin/dist");
const pluginVault = path.join(vault, ".obsidian/plugins/groundwork");
const dataDir = path.join(root, "tmp/calc-capture");
const outDir = "/opt/cursor/artifacts/captures";
const port = 8787;
const cdpPort = 9334;
const obsidianConfig = path.join(process.env.HOME ?? "/tmp", ".config/obsidian/obsidian.json");
const serverEntry = path.join(root, "packages/server/dist/server.js");

if (!existsSync(obsidianBin)) {
	console.error(`Obsidian binary not found at ${obsidianBin}. Run: bash scripts/install-obsidian-appimage.sh`);
	process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });

function run(cmd) {
	execSync(cmd, { stdio: "inherit", cwd: root });
}

run("npx tsx scripts/seed-calc-final-memory.mjs");
run(`GROUNDWORK_API_URL=http://127.0.0.1:${port} npm run build -w packages/obsidian-plugin`);
if (!existsSync(serverEntry)) run("npm run build -w packages/server");

if (existsSync(vault)) execSync(`rm -rf ${JSON.stringify(vault)}`);
cpSync(vaultTemplate, vault, { recursive: true });
writeFileSync(path.join(vault, "Welcome.md"), "");
mkdirSync(pluginVault, { recursive: true });
for (const file of ["main.js", "styles.css", "manifest.json"]) {
	copyFileSync(path.join(pluginDist, file), path.join(pluginVault, file));
}
const pluginSettings = {
	provider: "demo",
	claudePath: "",
	claudeModel: "",
	model: "claude-sonnet-4-5",
	maxTokens: 8192,
	deviceName: "calc-capture",
	appearance: "dark",
	readFolders: [],
	writeFolders: [],
	accountToken: "e2e-local-token",
};
writeFileSync(path.join(pluginVault, "data.json"), JSON.stringify(pluginSettings, null, 2));
writeFileSync(path.join(pluginVault, "e2e-account-token"), "e2e-local-token\n");
const memory = JSON.parse(readFileSync(path.join(dataDir, "tutor-memory.json"), "utf8"));
writeFileSync(path.join(pluginVault, "e2e-memory.json"), JSON.stringify({ files: memory.users.local.memory.files }, null, 2));
writeFileSync(path.join(vault, ".obsidian/appearance.json"), JSON.stringify({ theme: "obsidian", cssTheme: "" }, null, 2));
writeFileSync(
	path.join(vault, ".obsidian/workspace.json"),
	JSON.stringify(
		{
			main: {
				id: "gw-main",
				type: "split",
				children: [
					{
						id: "gw-leaf",
						type: "leaf",
						state: { type: "groundwork-chat", state: {}, icon: "graduation-cap", title: "Groundwork" },
					},
				],
				direction: "horizontal",
			},
			left: { id: "left-sidebar", type: "split", children: [], direction: "horizontal", width: 0, collapsed: true },
			right: { id: "right-sidebar", type: "split", children: [], direction: "horizontal", width: 0, collapsed: true },
			active: "gw-leaf",
			lastOpenFiles: [],
		},
		null,
		2,
	),
);

mkdirSync(path.dirname(obsidianConfig), { recursive: true });
writeFileSync(obsidianConfig, JSON.stringify({ vaults: { gwcalcvault0001: { path: vault, ts: Date.now(), open: true } } }));

const serverLog = "/tmp/groundwork-calc-server.log";
const obsidianLog = "/tmp/obsidian-calc-capture.log";
writeFileSync(serverLog, "");
writeFileSync(obsidianLog, "");

const serverEnv = { ...process.env, GROUNDWORK_PORT: String(port) };
delete serverEnv.FIREBASE_SERVICE_ACCOUNT_JSON;
delete serverEnv.GOOGLE_APPLICATION_CREDENTIALS;
serverEnv.GROUNDWORK_MEMORY_FILE = path.join(dataDir, "tutor-memory.json");
serverEnv.GROUNDWORK_ACCOUNT_FILE = path.join(dataDir, "accounts.json");
const server = spawn("node", [serverEntry], { env: serverEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
server.stdout?.on("data", (d) => appendFileSync(serverLog, d));
server.stderr?.on("data", (d) => appendFileSync(serverLog, d));

let obsidian;
let browser;
const notes = {};

function stop(child) {
	if (!child?.pid) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try {
			process.kill(child.pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	}
}

try {
	for (let i = 0; i < 40; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/v1/web-config`);
			if (res.ok) break;
		} catch {
			/* wait */
		}
		if (i === 39) throw new Error("Local Groundwork server did not start");
		await sleep(250);
	}

	obsidian = spawn(
		"xvfb-run",
		["-a", "--server-args=-screen 0 2880x3200x24", obsidianBin, "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=2", `--remote-debugging-port=${cdpPort}`, vault],
		{ stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ELECTRON_DISABLE_GPU: "1", LIBGL_ALWAYS_SOFTWARE: "1", LANG: "en_US.UTF-8" } },
	);
	obsidian.stdout?.on("data", (d) => appendFileSync(obsidianLog, d));
	obsidian.stderr?.on("data", (d) => appendFileSync(obsidianLog, d));
	await sleep(18_000);

	const { chromium } = await import("playwright");
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
	const client = await page.context().newCDPSession(page);
	await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1600, deviceScaleFactor: 2, mobile: false });
	console.log("devicePixelRatio", await page.evaluate(() => window.devicePixelRatio));

	async function dismiss() {
		for (const label of [/Turn on community plugins/i, /Trust author/i, /Enable community plugins/i, /^Open$/i, /Trust vault/i]) {
			const btn = page.getByRole("button", { name: label });
			if (await btn.count()) {
				await btn.first().click().catch(() => {});
				await sleep(500);
			}
		}
	}
	for (let i = 0; i < 8; i++) {
		await dismiss();
		await sleep(400);
	}
	if (!(await page.locator(".gw-root").count())) {
		await page.keyboard.press("Control+p");
		await sleep(400);
		await page.keyboard.type("Groundwork: Open tutor", { delay: 12 });
		await page.keyboard.press("Enter");
		await sleep(2000);
		await dismiss();
	}
	await page.waitForSelector('.gw-root[data-gw-ready="true"]', { timeout: 60_000 });
	await page.waitForSelector('.gw-root[data-gw-bootstrapped="true"]', { timeout: 120_000 });
	await page.waitForFunction(() => [...(document.querySelector(".gw-goal-select")?.options ?? [])].some((o) => /Calc 1 final/.test(o.text)), { timeout: 60_000 });
	await page.evaluate(() => {
		for (const side of document.querySelectorAll(".mod-left-split, .mod-right-split")) side.classList.add("is-collapsed");
	});
	await sleep(600);

	async function full(name) {
		const file = path.join(outDir, `${name}-full.png`);
		await page.screenshot({ path: file, scale: "device" });
		return file;
	}
	async function clipShot(name, box) {
		const file = path.join(outDir, `${name}-crop.png`);
		const clip = {
			x: Math.max(0, box.x),
			y: Math.max(0, box.y),
			width: Math.max(1, box.width),
			height: Math.max(1, box.height),
		};
		await page.screenshot({ path: file, clip, scale: "device" });
		return file;
	}
	async function boxOf(selector, bottomSelector) {
		return page.evaluate(
			({ selector, bottomSelector }) => {
				const top = document.querySelector(selector)?.getBoundingClientRect();
				const bottom = (bottomSelector ? document.querySelector(bottomSelector) : document.querySelector(selector))?.getBoundingClientRect();
				if (!top || !bottom) return null;
				return { x: top.x, y: top.y, width: top.width, height: bottom.bottom - top.y };
			},
			{ selector, bottomSelector },
		);
	}
	async function textOf(selector) {
		return page.locator(selector).innerText().catch(() => "");
	}
	function assertNoSat(label, text) {
		if (/\bSAT\b/.test(text)) throw new Error(`${label} shows SAT`);
	}

	const goalsTab = page.locator('[data-testid="gw-goals-tab"]');
	await goalsTab.evaluate((el) => el.click());
	await page.locator(".gw-goal-title", { hasText: "Calc 1 final" }).waitFor({ timeout: 20_000 });
	await page.locator(".gw-kicker").waitFor({ timeout: 10_000 });
	await sleep(800);
	notes.goals = await textOf(".gw-goals");
	assertNoSat("goals", notes.goals);
	await full("g3-goals");
	const goalsBox = await page.evaluate(() => {
		const pane = document.querySelector(".gw-goals");
		if (!pane) return null;
		const bits = pane.querySelectorAll(".gw-goal-hero, .gw-concept-row, .gw-track, .gw-side button, .gw-side a");
		const top = pane.getBoundingClientRect();
		let bottom = top.top;
		let right = top.left + 200;
		for (const node of bits) {
			const box = node.getBoundingClientRect();
			bottom = Math.max(bottom, box.bottom);
			right = Math.max(right, box.right);
		}
		return { x: top.x, y: top.y, width: Math.min(top.width, right - top.x + 12), height: bottom - top.y + 16 };
	});
	if (!goalsBox) throw new Error("Goals pane missing");
	await clipShot("g3-goals", goalsBox);

	await page.locator('[data-testid="gw-map-tab"]').evaluate((el) => el.click());
	await page.locator(".gw-path-title").waitFor({ timeout: 20_000 });
	await page.waitForFunction(() => !!document.querySelector("canvas.gw-force-canvas"), { timeout: 20_000 });
	await sleep(1500);
	notes.map = `${await textOf(".gw-side")}\n${await textOf(".gw-map-key")}`;
	assertNoSat("map", notes.map);
	await full("g3-map");
	const mapBox = await boxOf(".gw-map-row");
	if (!mapBox) throw new Error("Map pane missing");
	await clipShot("g3-map", mapBox);

	await page.locator('[data-testid="gw-learn-tab"]').evaluate((el) => el.click());
	await page.locator(".gw-input").waitFor({ timeout: 15_000 });
	const prompt = "Write a practice test for my Calc 1 final. Derivatives and the chain rule. I don't have any slides.";
	await page.locator(".gw-input").fill(prompt);
	await page.locator(".gw-send").evaluate((el) => el.click());
	await page.locator(".gw-test:not(.is-done) .gw-test-title").waitFor({ timeout: 30_000 });
	await page.evaluate(() => {
		const scroller = document.querySelector(".gw-messages");
		if (scroller) scroller.scrollTop = 0;
	});
	await sleep(500);
	notes.chat = await textOf(".gw-messages");
	assertNoSat("chat", notes.chat);
	await full("s1-topic-chat");
	const chatClip = await page.evaluate(() => {
		const user = document.querySelector(".gw-msg-row.is-me");
		const card = document.querySelector(".gw-test");
		if (!user || !card) return null;
		const a = user.getBoundingClientRect();
		const b = card.getBoundingClientRect();
		const progress = card.querySelector(".gw-test-progress");
		const end = progress ? progress.getBoundingClientRect().bottom : b.top + 180;
		const x = Math.min(a.x, b.x);
		const width = Math.max(a.right, b.right) - x;
		return { x, y: a.y, width, height: end - a.y + 14 };
	});
	if (!chatClip || chatClip.height < 80) throw new Error("Topic chat missing");
	await clipShot("s1-topic-chat", chatClip);
	await page.evaluate(() => document.querySelector(".gw-test")?.scrollIntoView({ block: "start" }));
	await sleep(400);
	await full("s2-midtest");
	const midBox = await boxOf(".gw-test", ".gw-test-question");
	if (!midBox) throw new Error("Mid-test card missing");
	await clipShot("s2-midtest", midBox);

	const questions = page.locator(".gw-test .gw-test-question");
	const count = await questions.count();
	if (count !== 10) throw new Error(`Expected 10 questions, saw ${count}`);
	const picks = [1, 0, 0, 1, "free", 0, 1, 0, 0, 0];
	for (let i = 0; i < picks.length; i++) {
		const q = questions.nth(i);
		await q.scrollIntoViewIfNeeded();
		if (picks[i] === "free") {
			const editor = q.locator(".gw-free-editor");
			await editor.evaluate((el) => {
				el.focus();
				el.textContent = "$\\cos(3x)$";
				el.dispatchEvent(new InputEvent("input", { bubbles: true }));
			});
		} else {
			await q.locator(".gw-option:not(.gw-option-dontknow)").nth(picks[i]).evaluate((el) => el.click());
		}
	}
	await page.waitForFunction(() => /10\/10 answered/.test(document.querySelector(".gw-test-progress")?.textContent ?? ""), { timeout: 10_000 });
	await page.locator(".gw-test .gw-submit", { hasText: "Submit test" }).evaluate((el) => el.click());
	await page.locator(".gw-test-report.is-ready").waitFor({ timeout: 30_000 });
	await page.getByText("Beliefs to fix").waitFor({ timeout: 15_000 });
	await sleep(600);
	notes.results = await textOf(".gw-test");
	const reportText = await textOf(".gw-test-report");
	notes.report = reportText;
	assertNoSat("results", notes.results);
	await page.evaluate(() => document.querySelector(".gw-test")?.scrollIntoView({ block: "start" }));
	await full("g1-results");
	await page.evaluate(() => {
		document.querySelectorAll(".gw-test > .gw-card-head .gw-pill").forEach((el) => {
			if (/question/i.test(el.textContent ?? "")) el.remove();
		});
	});
	const resultsHead = await page.evaluate(() => {
		const card = document.querySelector(".gw-test");
		const report = document.querySelector(".gw-test-report");
		if (!card || !report) return null;
		const top = card.getBoundingClientRect();
		const bottom = report.getBoundingClientRect();
		return { x: top.x, y: top.y, width: top.width, height: bottom.bottom - top.y };
	});
	if (!resultsHead) throw new Error("Results report missing");
	await clipShot("g1-results", resultsHead);

	await page.locator(".gw-input").fill("Check the chain rule.");
	await page.locator(".gw-send").evaluate((el) => el.click());
	const quiz = page.locator(".gw-quiz:not(.gw-test-question)").last();
	await quiz.waitFor({ timeout: 30_000 });
	await quiz.locator(".gw-option:not(.gw-option-dontknow)").first().evaluate((el) => el.click());
	await quiz.locator(".gw-submit", { hasText: "Check answer" }).evaluate((el) => el.click());
	await quiz.getByText("Not quite").waitFor({ timeout: 15_000 });
	await quiz.getByText(/Likely belief/).waitFor({ timeout: 15_000 });
	await quiz.locator(".gw-mastery-delta").waitFor({ timeout: 15_000 });
	await sleep(400);
	notes.quiz = await quiz.innerText();
	const afterQuiz = await textOf(".gw-messages");
	notes.afterQuiz = afterQuiz.slice(notes.chat.length);
	if (/re-?teach/i.test(notes.quiz) || /re-?teach/i.test(notes.afterQuiz)) throw new Error("Quiz capture includes a re-teach line");
	assertNoSat("quiz", notes.quiz);
	await quiz.scrollIntoViewIfNeeded();
	await sleep(200);
	await full("g2-quiz");
	const quizBox = await quiz.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	});
	await clipShot("g2-quiz", quizBox);

	writeFileSync(path.join(outDir, "notes.json"), JSON.stringify(notes, null, 2));
	console.log("Captured college practice scenes.");
	console.log(JSON.stringify({ report: notes.report, goals: notes.goals.slice(0, 500), quiz: notes.quiz, map: notes.map.slice(0, 800) }, null, 2));
} catch (err) {
	console.error(err);
	try {
		const page = browser?.contexts?.()[0]?.pages?.()[0];
		if (page) await page.screenshot({ path: path.join(outDir, "failure-full.png") });
	} catch {
		/* no page */
	}
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {
		/* ignore */
	}
	stop(obsidian);
	stop(server);
}
