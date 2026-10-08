#!/usr/bin/env node
/**
 * Marketing stills and one screen recording of the Groundwork Obsidian plugin.
 *
 * Local demo account only. Real Obsidian, real plugin, seeded tutor memory.
 * Usage: npx tsx scripts/ad-captures/capture.mjs
 *
 * Output: /opt/cursor/artifacts/ad-captures/
 */
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, cpSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXAM_GOAL_TITLE, examGoalInput } from "./seed-demo-memory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = process.env.AD_CAPTURE_OUT || "/opt/cursor/artifacts/ad-captures";
const work = path.join(root, "tmp/ad-captures");
const memoryFile = path.join(work, "tutor-memory.json");
const accountsFile = path.join(work, "accounts.json");
const vault = path.join(work, "Calc-I");
const examFile = path.join(root, "scripts/ad-captures/fixtures/MATH-151-practice-exam.md");
const obsidianBin = process.env.OBSIDIAN_BIN || path.join(root, "tmp/obsidian-install/squashfs-root/obsidian");
const pluginDist = path.join(root, "packages/obsidian-plugin/dist");
const serverEntry = path.join(root, "packages/server/dist/server.js");
const vaultTemplate = path.join(root, "scripts/fixtures/obsidian-test-vault");
const apiPort = 8787;
const upstreamPort = 8788;
const cdpPort = 9333;
const display = process.env.AD_CAPTURE_DISPLAY || ":99";
const cssWidth = 1440;
const cssHeight = 1000;

mkdirSync(outDir, { recursive: true });
mkdirSync(work, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function track(child) {
	children.push(child);
	return child;
}

function run(cmd, opts = {}) {
	execSync(cmd, { stdio: "inherit", cwd: root, ...opts });
}

function die(child, signal = "SIGTERM") {
	if (!child || child.killed || child.exitCode != null) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			/* already gone */
		}
	}
}

async function waitForHttp(url, tries = 40) {
	for (let i = 0; i < tries; i++) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			/* retry */
		}
		await sleep(250);
	}
	throw new Error(`Nothing answered ${url}`);
}

function pngSize(file) {
	const buf = readFileSync(file);
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function startUpstream() {
	const log = path.join(work, "server.log");
	writeFileSync(log, "");
	const child = track(
		spawn("node", [serverEntry], {
			cwd: root,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				GROUNDWORK_PORT: String(upstreamPort),
				GROUNDWORK_MEMORY_FILE: memoryFile,
				GROUNDWORK_ACCOUNT_FILE: accountsFile,
				FIREBASE_SERVICE_ACCOUNT_JSON: "",
				GOOGLE_APPLICATION_CREDENTIALS: "",
				OPENROUTER_API_KEY: "",
			},
		}),
	);
	child.stdout?.on("data", (d) => writeFileSync(log, readFileSync(log, "utf8") + d));
	child.stderr?.on("data", (d) => writeFileSync(log, readFileSync(log, "utf8") + d));
	return child;
}

function tutorResponse(body) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	const last = messages[messages.length - 1];
	const content = last?.content;
	const blob = typeof content === "string" ? content : JSON.stringify(content ?? "");
	const toolResults = Array.isArray(content) ? content.filter((block) => block?.type === "tool_result") : [];
	if (toolResults.length) {
		return {
			content: [
				{
					type: "text",
					text: [
						"I read the practice exam and saved a goal from it: Prepare for MATH 151 practice, due in just over three weeks.",
						"",
						"The problems sit on the derivative of sine, the derivative of cosine, the chain rule, and the quotient rule. Those are the red nodes. Slope, average rate of change, and the definition are already under them.",
						"",
						"The map is that graph. The highlighted path runs up to the derivative of sine, which is what this exam leans on.",
					].join("\n"),
				},
			],
			stopReason: "end_turn",
			usage: { input: 20, output: 80 },
		};
	}
	if (blob.includes("<exam_plan>") || /practice exam/i.test(blob)) {
		const goal = examGoalInput("resources/MATH-151-practice-exam.md");
		return {
			content: [
				{ type: "tool_use", id: "cap_set_goal", name: "set_goal", input: goal },
				{ type: "tool_use", id: "cap_pin_goal", name: "set_working_goal", input: { goal: EXAM_GOAL_TITLE } },
			],
			stopReason: "tool_use",
			usage: { input: 20, output: 40 },
		};
	}
	return {
		content: [{ type: "text", text: "Attach the practice exam and I'll make the goal from it." }],
		stopReason: "end_turn",
		usage: { input: 8, output: 16 },
	};
}

function startProxy() {
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const raw = Buffer.concat(chunks);
		const url = new URL(req.url || "/", `http://127.0.0.1:${apiPort}`);
		if (req.method === "POST" && url.pathname === "/v1/tutor/complete") {
			let body = {};
			try {
				body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
			} catch {
				body = {};
			}
			const lastContent = body?.messages?.at(-1)?.content;
			const answeringTool = Array.isArray(lastContent) && lastContent.some((block) => block?.type === "tool_result");
			await sleep(answeringTool ? 1600 : 2200);
			const payload = JSON.stringify(tutorResponse(body));
			res.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"access-control-allow-origin": "*",
				"access-control-allow-headers": "authorization, content-type",
				"access-control-allow-methods": "GET, POST, PUT, OPTIONS",
			});
			res.end(payload);
			return;
		}
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"access-control-allow-origin": "*",
				"access-control-allow-headers": "authorization, content-type",
				"access-control-allow-methods": "GET, POST, PUT, OPTIONS",
			});
			res.end();
			return;
		}
		const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
		delete headers["content-length"];
		const upstream = await fetch(`http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`, {
			method: req.method,
			headers,
			body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
		});
		const buf = Buffer.from(await upstream.arrayBuffer());
		const outHeaders = {};
		upstream.headers.forEach((value, key) => {
			if (key === "content-length" || key === "transfer-encoding") return;
			outHeaders[key] = value;
		});
		res.writeHead(upstream.status, outHeaders);
		res.end(buf);
	});
	return new Promise((resolve) => {
		server.listen(apiPort, "127.0.0.1", () => resolve(server));
	});
}

function prepareVault() {
	if (existsSync(vault)) rmSync(vault, { recursive: true, force: true });
	cpSync(vaultTemplate, vault, { recursive: true });
	const pluginVault = path.join(vault, ".obsidian/plugins/groundwork");
	mkdirSync(pluginVault, { recursive: true });
	for (const file of ["main.js", "styles.css", "manifest.json"]) {
		copyFileSync(path.join(pluginDist, file), path.join(pluginVault, file));
	}
	const data = {
		provider: "claude-code",
		claudePath: "",
		claudeModel: "",
		model: "claude-sonnet-4-5",
		maxTokens: 8192,
		deviceName: "Demo",
		appearance: "dark",
		readFolders: ["resources"],
		writeFolders: [],
		accountToken: "demo-local-token",
	};
	writeFileSync(path.join(pluginVault, "data.json"), JSON.stringify(data, null, 2));
	writeFileSync(path.join(pluginVault, "e2e-account-token"), "demo-local-token\n");
	const db = JSON.parse(readFileSync(memoryFile, "utf8"));
	const files = db?.users?.local?.memory?.files;
	if (!files) throw new Error("Seeded memory has no files");
	writeFileSync(path.join(pluginVault, "e2e-memory.json"), JSON.stringify({ files }, null, 2));
	writeFileSync(
		path.join(vault, ".obsidian/appearance.json"),
		JSON.stringify(
			{ theme: "obsidian", baseFontSize: 16, translucency: false, enabledCssSnippets: ["ad-capture"] },
			null,
			2,
		),
	);
	mkdirSync(path.join(vault, ".obsidian/snippets"), { recursive: true });
	writeFileSync(
		path.join(vault, ".obsidian/snippets/ad-capture.css"),
		[
			"/* Capture vault only. Hides Obsidian's status bar so the frame is the product. The map legend and scroll padding are the product's layout. */",
			".status-bar { display: none !important; }",
			".gw-days b { font-size: 40px !important; }",
			".gw-goal-hero { padding: 10px 16px !important; }",
			".gw-goals { gap: 8px !important; }",
			".gw-track { margin-top: 8px !important; }",
			".gw-due-field { margin-top: 4px !important; }",
			".gw-concept-list { flex-shrink: 0 !important; }",
			".gw-concept-head, .gw-concept-row { padding-top: 2px; padding-bottom: 2px; }",
			"",
		].join("\n"),
	);
	const app = JSON.parse(readFileSync(path.join(vault, ".obsidian/app.json"), "utf8"));
	writeFileSync(path.join(vault, ".obsidian/app.json"), JSON.stringify({ ...app, theme: "obsidian", readableLineLength: false }, null, 2));
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
					direction: "vertical",
				},
				left: {
					id: "left-sidebar",
					type: "split",
					children: [
						{
							id: "left-tabs",
							type: "tabs",
							children: [{ id: "file-explorer", type: "leaf", state: { type: "file-explorer", state: {}, icon: "lucide-folder-closed", title: "Files" } }],
						},
					],
					direction: "horizontal",
					width: 240,
					collapsed: true,
				},
				right: {
					id: "right-sidebar",
					type: "split",
					children: [],
					direction: "horizontal",
					width: 240,
					collapsed: true,
				},
				active: "gw-leaf",
				lastOpenFiles: [],
			},
			null,
			2,
		),
	);
	const obsidianConfig = path.join(process.env.HOME || "/tmp", ".config/obsidian/obsidian.json");
	mkdirSync(path.dirname(obsidianConfig), { recursive: true });
	writeFileSync(
		obsidianConfig,
		JSON.stringify({
			vaults: { adcapturevault0001: { path: vault, ts: Date.now(), open: true } },
			theme: "obsidian",
		}),
	);
}

function startXvfb() {
	const child = track(
		spawn("Xvfb", [display, "-screen", "0", "3200x2000x24", "-ac", "+extension", "RANDR"], {
			detached: true,
			stdio: "ignore",
		}),
	);
	return child;
}

function startObsidian() {
	const log = path.join(work, "obsidian.log");
	writeFileSync(log, "");
	const child = track(
		spawn(
			obsidianBin,
			["--no-sandbox", "--disable-gpu", "--force-device-scale-factor=2", `--remote-debugging-port=${cdpPort}`, vault],
			{
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					DISPLAY: display,
					ELECTRON_DISABLE_GPU: "1",
					LIBGL_ALWAYS_SOFTWARE: "1",
				},
			},
		),
	);
	const append = (d) => writeFileSync(log, readFileSync(log, "utf8") + d);
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);
	return child;
}

async function connectCdp() {
	const { chromium } = await import("playwright");
	let browser;
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 20_000 });
			break;
		} catch (err) {
			if (attempt === 7) throw err;
			await sleep(3000);
		}
	}
	const ctx = browser.contexts()[0];
	let page = null;
	for (let i = 0; i < 24 && !page; i++) {
		for (const candidate of ctx?.pages() ?? []) {
			const title = await candidate.title().catch(() => "");
			if (/^Settings\b/i.test(title)) continue;
			const ready = await candidate.locator(".workspace, .gw-root").count().catch(() => 0);
			if (ready) {
				page = candidate;
				break;
			}
		}
		if (!page) await sleep(500);
	}
	if (!page) throw new Error("No Obsidian page from CDP");
	return { browser, page };
}

function windowGeometryOf(id) {
	const geo = execSync(`DISPLAY=${display} xdotool getwindowgeometry --shell ${id}`, { encoding: "utf8" });
	const out = {};
	for (const line of geo.split("\n")) {
		const match = /^(\w+)=(.*)$/.exec(line);
		if (match) out[match[1]] = Number(match[2]);
	}
	return out;
}

function obsidianWindows() {
	let raw = "";
	try {
		raw = execSync(`DISPLAY=${display} xdotool search --onlyvisible --class obsidian`, { encoding: "utf8" });
	} catch {
		return [];
	}
	return raw
		.trim()
		.split("\n")
		.map((id) => id.trim())
		.filter(Boolean)
		.map((id) => {
			const geo = windowGeometryOf(id);
			return { id, ...geo, area: (geo.WIDTH || 0) * (geo.HEIGHT || 0) };
		})
		.sort((a, b) => b.area - a.area);
}

function obsidianWindowId() {
	const id = obsidianWindows()[0]?.id;
	if (!id) throw new Error("Obsidian window not found");
	return id;
}

function windowGeometry() {
	return windowGeometryOf(obsidianWindowId());
}

async function closeExtraPages(browser, page) {
	for (const ctx of browser.contexts()) {
		for (const other of ctx.pages()) {
			if (other === page) continue;
			const title = await other.title().catch(() => "");
			if (/settings/i.test(title)) await other.close().catch(() => {});
		}
	}
	closeStrayWindows();
}

function closeStrayWindows() {
	const windows = obsidianWindows();
	for (const extra of windows.slice(1)) {
		try {
			execSync(`DISPLAY=${display} xdotool windowactivate --sync ${extra.id} key --clearmodifiers Escape`);
		} catch {
			/* already gone */
		}
		try {
			execSync(`DISPLAY=${display} xdotool windowclose ${extra.id}`);
		} catch {
			/* already gone */
		}
	}
	try {
		execSync(`DISPLAY=${display} xdotool mousemove 3190 1990`);
	} catch {
		/* pointer can stay */
	}
}

async function fitWindow(page) {
	let id = "";
	for (let i = 0; i < 12 && !id; i++) {
		try {
			id = obsidianWindowId();
		} catch {
			await sleep(400);
		}
	}
	if (!id) throw new Error("Obsidian window not found");
	execSync(`DISPLAY=${display} xdotool windowmove ${id} 0 0 windowsize ${id} ${cssWidth * 2} ${cssHeight * 2}`, { stdio: "inherit" });
	await sleep(500);
	const box = await page.evaluate(() => ({
		width: window.innerWidth,
		height: window.innerHeight,
		dpr: window.devicePixelRatio,
		outerW: window.outerWidth,
		outerH: window.outerHeight,
	}));
	const geo = windowGeometry();
	console.log("window", box, geo);
	if (box.dpr < 1.9) console.warn(`devicePixelRatio is ${box.dpr}, expected about 2`);
	return { box, geo };
}

async function dismissDialogs(page) {
	for (let round = 0; round < 4; round++) {
		for (const label of [/Turn on community plugins/i, /Trust author and enable/i, /Enable community plugins/i, /Trust author/i, /^Got it$/i, /^Later$/i, /^No thanks$/i, /^Dismiss$/i, /^Skip$/i]) {
			const btn = page.getByRole("button", { name: label });
			if (await btn.count()) {
				await btn.first().click({ timeout: 2000 }).catch(() => {});
				await sleep(400);
			}
		}
	}
}

async function shot(page, name) {
	const file = path.join(outDir, name);
	await page.screenshot({ path: file, scale: "device" });
	const size = pngSize(file);
	console.log(name, size);
	if (size.width < 2400) throw new Error(`${name} is ${size.width}px wide, need at least 2400`);
	return size;
}

async function cropShot(page, name, selector, pad = 32) {
	const metrics = await page.evaluate((sel) => {
		const nodes = [...document.querySelectorAll(sel)].filter((node) => {
			const rect = node.getBoundingClientRect();
			return rect.width > 8 && rect.height > 8;
		});
		if (!nodes.length) return null;
		const rects = nodes.map((node) => node.getBoundingClientRect());
		const x = Math.min(...rects.map((rect) => rect.x));
		const y = Math.min(...rects.map((rect) => rect.y));
		const right = Math.max(...rects.map((rect) => rect.right));
		const bottom = Math.max(...rects.map((rect) => rect.bottom));
		return { x, y, w: right - x, h: bottom - y, vw: window.innerWidth, vh: window.innerHeight };
	}, selector);
	if (!metrics || metrics.w < 40 || metrics.h < 40) throw new Error(`No crop target for ${selector}`);
	const cx = metrics.x + metrics.w / 2;
	const cy = metrics.y + metrics.h / 2;
	let w = Math.min(metrics.vw, metrics.w + pad * 2);
	let h = Math.min(metrics.vh, metrics.h + pad * 2);
	let x = cx - w / 2;
	let y = cy - h / 2;
	if (x < 0) x = 0;
	if (y < 0) y = 0;
	if (x + w > metrics.vw) x = Math.max(0, metrics.vw - w);
	if (y + h > metrics.vh) y = Math.max(0, metrics.vh - h);
	w = Math.min(w, metrics.vw - x);
	h = Math.min(h, metrics.vh - y);
	const file = path.join(outDir, name);
	await page.screenshot({
		path: file,
		scale: "device",
		clip: { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) },
	});
	const size = pngSize(file);
	console.log(name, size, { subject: metrics });
	if (size.width > metrics.vw * 2 - 20 && size.height > metrics.vh * 2 - 20) {
		throw new Error(`${name} crop is the full frame`);
	}
	return size;
}

async function assertFits(page, selector, label) {
	const over = await page.evaluate((sel) => {
		return [...document.querySelectorAll(sel)]
			.filter((el) => getComputedStyle(el).overflowY !== "hidden" && getComputedStyle(el).overflowX !== "hidden")
			.filter((el) => el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)
			.map((el) => ({
				cls: String(el.className).slice(0, 80),
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				scrollWidth: el.scrollWidth,
				clientWidth: el.clientWidth,
			}));
	}, selector);
	if (over.length) throw new Error(`${label} scrolls: ${JSON.stringify(over)}`);
}

async function frameQuiz(page) {
	const fit = await page.evaluate(() => {
		const quiz = document.querySelector(".gw-quiz");
		const question = document.querySelector(".gw-quiz-question");
		const reply = document.querySelector(".gw-messages .gw-msg.gw-assistant");
		const scroller = document.querySelector(".gw-messages");
		if (!quiz || !question || !reply || !scroller) return { ok: false, reason: "missing quiz pieces" };
		scroller.scrollTop = 0;
		const box = scroller.getBoundingClientRect();
		const q = question.getBoundingClientRect();
		const end = reply.getBoundingClientRect();
		const textFits = q.top >= box.top - 1 && end.bottom <= box.bottom - 1;
		if (textFits) scroller.style.overflowY = "hidden";
		return {
			ok: textFits,
			qTop: Math.round(q.top - box.top),
			endBot: Math.round(end.bottom - box.top),
			client: scroller.clientHeight,
			scroll: scroller.scrollHeight,
		};
	});
	console.log("quiz fit", fit);
	if (!fit.ok) throw new Error(`Quiz exchange does not fit: ${JSON.stringify(fit)}`);
}

async function assertClean(page, label) {
	const text = await page.evaluate(() => document.body.innerText);
	const banned = [
		[/stub tutor/i, "stub tutor copy"],
		[/@[a-z0-9.-]+\.[a-z]{2,}/i, "an email address"],
		[/e2e learner/i, "the e2e display name"],
		[/sk-[a-z0-9]/i, "a key"],
		[/api[_ ]?key/i, "an API key label"],
		[/loading tutor memory/i, "a loading line"],
		[/sync failed/i, "a sync error"],
		[/jonathan/i, "a personal name"],
	];
	for (const [re, why] of banned) {
		if (re.test(text)) throw new Error(`${label} shows ${why}`);
	}
	const notices = await page.locator(".notice").count();
	if (notices) throw new Error(`${label} has ${notices} notice(s)`);
}

const sizes = {};

async function main() {
	if (!existsSync(obsidianBin)) throw new Error(`Obsidian missing at ${obsidianBin}`);
	run("npx --yes tsx scripts/ad-captures/seed-demo-memory.mjs " + JSON.stringify(memoryFile) + " " + JSON.stringify(accountsFile));
	run(`GROUNDWORK_API_URL=http://127.0.0.1:${apiPort} npm run build -w packages/obsidian-plugin`);
	if (!existsSync(serverEntry)) run("npm run build -w packages/server");
	prepareVault();

	const upstream = startUpstream();
	await waitForHttp(`http://127.0.0.1:${upstreamPort}/v1/web-config`);
	const proxy = await startProxy();
	await waitForHttp(`http://127.0.0.1:${apiPort}/v1/web-config`);

	startXvfb();
	await sleep(400);
	const obsidian = startObsidian();
	await sleep(8000);
	const { browser, page } = await connectCdp();
	await dismissDialogs(page);
	closeStrayWindows();
	await sleep(400);
	await fitWindow(page);
	closeStrayWindows();
	await dismissDialogs(page);

	if (!(await page.locator(".gw-root").count())) {
		await page.keyboard.press("Control+p");
		await sleep(300);
		await page.keyboard.type("Groundwork: Open tutor", { delay: 12 });
		await page.keyboard.press("Enter");
		await sleep(1500);
		await dismissDialogs(page);
	}

	await page.waitForSelector('.gw-root[data-gw-ready="true"]', { timeout: 60_000 });
	await page.waitForSelector('.gw-root[data-gw-bootstrapped="true"]', { timeout: 120_000 });
	await page.locator(".gw-goalbar-label", { hasText: "Working on:" }).waitFor({ timeout: 20_000 });
	await page.waitForFunction(
		() => {
			const sel = document.querySelector(".gw-goal-select");
			return /Derivatives for Calc I/.test(sel?.selectedOptions?.[0]?.textContent ?? "");
		},
		{ timeout: 60_000 },
	);
	await page.waitForFunction(() => /\bLinked\b/.test(document.querySelector(".gw-statusbar")?.textContent ?? ""), { timeout: 60_000 });

	const tab = (id) => page.locator(`.gw-root [data-testid="gw-${id}-tab"]`);

	await tab("map").click();
	await page.waitForSelector(".gw-root.is-map .gw-force-canvas", { timeout: 30_000 });
	await page.waitForSelector(".gw-map-key", { timeout: 15_000 });
	await sleep(1600);
	await assertClean(page, "map");
	sizes["01-map.png"] = await shot(page, "01-map.png");
	sizes["01-map-crop.png"] = await cropShot(page, "01-map-crop.png", ".gw-root.is-map .gw-mapwrap", 8);

	await tab("learn").click();
	await page.waitForSelector(".gw-root .gw-quiz.is-done", { timeout: 20_000 });
	await page.waitForFunction(
		() => document.querySelectorAll(".gw-root .katex, .gw-root mjx-container, .gw-root .math").length >= 2,
		{ timeout: 20_000 },
	);
	await frameQuiz(page);
	await sleep(400);
	await assertFits(page, ".gw-messages", "quiz");
	await assertClean(page, "quiz");
	sizes["02-quiz.png"] = await shot(page, "02-quiz.png");
	sizes["02-quiz-crop.png"] = await cropShot(
		page,
		"02-quiz-crop.png",
		".gw-messages .gw-msg-row, .gw-messages .gw-quiz, .gw-messages .gw-msg.gw-assistant",
	);

	await tab("flashcards").click();
	await page.waitForSelector(".gw-root.is-flashcards .gw-fc-show", { timeout: 20_000 });
	await page.locator(".gw-root.is-flashcards .gw-fc-show").click();
	await page.waitForSelector(".gw-root.is-flashcards .gw-rb-again", { timeout: 10_000 });
	await page.waitForFunction(
		() => document.querySelectorAll(".gw-root.is-flashcards .katex, .gw-root.is-flashcards mjx-container").length >= 1,
		{ timeout: 15_000 },
	);
	await sleep(500);
	await assertFits(page, ".gw-fc-body, .gw-fc-main", "flashcards");
	await assertClean(page, "flashcards");
	sizes["05-flashcards.png"] = await shot(page, "05-flashcards.png");
	sizes["05-flashcards-crop.png"] = await cropShot(page, "05-flashcards-crop.png", ".gw-fcard, .gw-rb");

	await tab("goals").click();
	await page.waitForSelector(".gw-root.is-goals .gw-goal-title", { hasText: "Derivatives for Calc I", timeout: 15_000 });
	await page.waitForSelector(".gw-root.is-goals .gw-days", { timeout: 10_000 });
	await sleep(600);
	await page.evaluate(() => {
		const list = document.querySelector(".gw-concept-list");
		if (!list) return;
		const rows = [...list.querySelectorAll(".gw-concept-row")];
		const box = list.getBoundingClientRect();
		const clipped = rows.filter((row) => {
			const rect = row.getBoundingClientRect();
			return rect.bottom > box.bottom + 1 || rect.top < box.top - 1;
		});
		if (clipped.length) {
			throw new Error(`Goals list clips ${clipped.length} concept row(s)`);
		}
	});
	await assertFits(page, ".gw-goals, .gw-concept-list, .gw-work", "goals");
	await assertClean(page, "goals");
	sizes["06-goals.png"] = await shot(page, "06-goals.png");
	sizes["06-goals-crop.png"] = await cropShot(page, "06-goals-crop.png", ".gw-goal-hero", 8);

	await closeExtraPages(browser, page);
	await tab("learn").click();
	await page.locator('.gw-root button[aria-label="New session"]').click();
	await page.waitForSelector(".gw-root .gw-input", { timeout: 10_000 });
	await sleep(500);
	closeStrayWindows();

	const rawVideo = path.join(work, "exam-raw.mp4");
	const ffmpeg = track(
		spawn(
			"ffmpeg",
			[
				"-y",
				"-f",
				"x11grab",
				"-draw_mouse",
				"0",
				"-framerate",
				"30",
				"-video_size",
				"3200x2000",
				"-i",
				`${display}.0`,
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-crf",
				"16",
				"-pix_fmt",
				"yuv420p",
				rawVideo,
			],
			{ detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: display } },
		),
	);
	await sleep(400);
	const recordStarted = Date.now();
	await sleep(700);

	await page.locator(".gw-root input[type=file]").setInputFiles(examFile);
	await page.waitForSelector(".gw-file-chip", { timeout: 10_000 });
	await sleep(900);
	await page.locator(".gw-root .gw-input").click();
	await page.keyboard.type("Prep me for this practice exam.", { delay: 36 });
	await sleep(700);
	await page.locator('.gw-root button[aria-label="Send"]').click();
	await page.waitForSelector(".gw-root .gw-user-files, .gw-root .gw-file-name", { timeout: 20_000 });
	await page.getByText("I read the practice exam and saved a goal from it").waitFor({ timeout: 40_000 });
	await page.waitForFunction(
		() => {
			const sel = document.querySelector(".gw-goal-select");
			return /Prepare for MATH 151 practice/.test(sel?.selectedOptions?.[0]?.textContent ?? "");
		},
		{ timeout: 20_000 },
	);
	await page.waitForFunction(() => !document.querySelector(".gw-thinking"), { timeout: 15_000 });
	await sleep(2200);
	await assertClean(page, "exam chat");
	sizes["03-exam-chat.png"] = await shot(page, "03-exam-chat.png");
	await assertFits(page, ".gw-messages", "exam chat");
	sizes["03-exam-chat-crop.png"] = await cropShot(
		page,
		"03-exam-chat-crop.png",
		".gw-messages .gw-msg-row, .gw-messages .gw-tool, .gw-messages .gw-turn",
	);

	await tab("map").click();
	await page.waitForSelector(".gw-root.is-map .gw-force-canvas", { timeout: 20_000 });
	await page.waitForFunction(
		() => /Derivative of sine/.test(document.querySelector(".gw-path-title")?.textContent ?? ""),
		{ timeout: 20_000 },
	);
	await sleep(1600);
	await assertClean(page, "exam map");
	sizes["04-exam-map.png"] = await shot(page, "04-exam-map.png");
	sizes["04-exam-map-crop.png"] = await cropShot(page, "04-exam-map-crop.png", ".gw-root.is-map .gw-mapwrap", 8);
	const elapsed = Date.now() - recordStarted;
	if (elapsed < 24_000) await sleep(24_000 - elapsed);
	if (Date.now() - recordStarted > 30_000) console.warn("recording ran past 30s");
	die(ffmpeg, "SIGINT");
	for (let i = 0; i < 20 && ffmpeg.exitCode == null; i++) await sleep(300);

	const geo = windowGeometry();
	const cropX = Math.max(0, geo.X || 0);
	const cropY = Math.max(0, geo.Y || 0);
	const cropW = Math.min(3200 - cropX, geo.WIDTH || 1920) & ~1;
	const cropH = Math.min(2000 - cropY, geo.HEIGHT || 1080) & ~1;
	console.log("video crop", { cropX, cropY, cropW, cropH, elapsedMs: Date.now() - recordStarted });

	const deliver = path.join(outDir, "exam-goal-map.mp4");
	const hq = path.join(outDir, "exam-goal-map-hq.mp4");
	run(
		`ffmpeg -y -i ${JSON.stringify(rawVideo)} -vf "crop=${cropW}:${cropH}:${cropX}:${cropY},scale=1920:-2:flags=lanczos" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an ${JSON.stringify(deliver)}`,
	);
	run(
		`ffmpeg -y -i ${JSON.stringify(rawVideo)} -vf "crop=${cropW}:${cropH}:${cropX}:${cropY}" -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -movflags +faststart -an ${JSON.stringify(hq)}`,
	);

	const notes = {
		"01-map.png": "Map tab, goal Derivatives for Calc I pinned. Red goal at the top, highlighted path, faded off-path concepts, legend visible.",
		"01-map-crop.png": "Crop centered on the concept map, with margin for a later aspect-ratio cut.",
		"02-quiz.png": "Learn tab. Power-rule quiz with rendered math, a wrong answer, and the tutor's numerical re-teach.",
		"02-quiz-crop.png": "Crop of that quiz exchange.",
		"03-exam-chat.png": "Practice exam attached in chat, then the tutor's goal reply.",
		"03-exam-chat-crop.png": "Crop of the exam chat.",
		"04-exam-map.png": "Map of the new goal, Prepare for MATH 151 practice, pinned.",
		"04-exam-map-crop.png": "Crop of the exam goal map.",
		"05-flashcards.png": "Derivatives deck, answer shown, Again / Hard / Good / Easy.",
		"05-flashcards-crop.png": "Crop of the flashcard study view.",
		"06-goals.png": "Goals tab for Derivatives for Calc I, with the due date and progress.",
		"06-goals-crop.png": "Crop of the due date, pace, and progress ring.",
		"exam-goal-map.mp4": "24s H.264, 1920×1334, of attaching the practice exam, the tutor goal reply, then the new map.",
		"exam-goal-map-hq.mp4": "Same recording at 2880×2000.",
	};
	const lines = ["# Groundwork ad captures", "", "Real Obsidian, dark theme, local demo account. No product data.", ""];
	for (const [file, blurb] of Object.entries(notes)) {
		const full = path.join(outDir, file);
		if (file.endsWith(".png")) {
			const size = sizes[file] || pngSize(full);
			lines.push(`- \`${file}\` — ${size.width}×${size.height} — ${blurb}`);
		} else {
			const stat = readFileSync(full);
			lines.push(`- \`${file}\` — ${stat.length} bytes — ${blurb}`);
		}
	}
	await writeFile(path.join(outDir, "README.md"), lines.join("\n") + "\n");
	console.log(lines.join("\n"));

	await browser.close();
	die(obsidian);
	proxy.close();
	die(upstream);
	for (const child of children) die(child);
}

main().catch(async (err) => {
	console.error(err);
	for (const child of children) die(child);
	process.exit(1);
});
