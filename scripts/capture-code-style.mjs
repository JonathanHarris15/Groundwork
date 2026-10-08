#!/usr/bin/env node
/**
 * Before/after shots of tutor code: a Python block, a JavaScript block, and inline code.
 * Dark and light, from the real Obsidian plugin. Tag with CODE_STYLE_TAG=before|after.
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, cpSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.env.CODE_STYLE_TAG || "after";
const obsidianBin = process.env.OBSIDIAN_BIN?.trim() || path.join(root, "tmp/obsidian-install/squashfs-root/obsidian");
const vaultTemplate = path.join(root, "scripts/fixtures/obsidian-test-vault");
const vault = path.join(root, "tmp/gw-code-vault");
const pluginDist = path.join(root, "packages/obsidian-plugin/dist");
const pluginVault = path.join(vault, ".obsidian/plugins/groundwork");
const dataDir = path.join(root, "tmp/code-style-capture");
const outDir = "/opt/cursor/artifacts/code-style";
const port = 8791;
const cdpPort = 9336;
const obsidianConfig = path.join(process.env.HOME ?? "/tmp", ".config/obsidian/obsidian.json");
const serverEntry = path.join(root, "packages/server/dist/server.js");

const sample = [
	"A Python block, a JavaScript block, and inline code. Call `factorial(n)` and keep the two spaces in `x  =  1`.",
	"",
	"```python",
	"def factorial(n):",
	"    if n <= 1:",
	"        return 1",
	"    return n * factorial(n - 1)",
	"```",
	"",
	"```javascript",
	"function factorial(n) {",
	"    if (n <= 1) return 1;",
	"    return n * factorial(n - 1);",
	"}",
	"```",
	"",
	"The same function with no fences:",
	"",
	"def factorial(n):",
	"    if n <= 1:",
	"        return 1",
	"    return n * factorial(n - 1)",
	"",
	"One JavaScript line:",
	"",
	"const total = items.reduce((sum, item) => sum + item.price, 0);",
].join("\n");

if (!existsSync(obsidianBin)) {
	console.error(`Obsidian binary not found at ${obsidianBin}`);
	process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const now = new Date().toISOString();
const chat = {
	id: "code-style",
	title: "Code styling",
	created: now,
	updated: now,
	messages: [],
	messagesAt: 1,
	items: [{ kind: "assistant", text: sample }],
};
const baseMemoryPath = path.join(root, "tmp/calc-capture/tutor-memory.json");
const memory = existsSync(baseMemoryPath)
	? JSON.parse(readFileSync(baseMemoryPath, "utf8"))
	: { users: { local: { memory: { updatedAt: now, files: { "learner.md": "---\ntitle: Learner\n---\n" } }, knowledge: {} } } };
memory.users.local.memory.files[".groundwork/chats/code-style.json"] = `${JSON.stringify(chat)}\n`;
memory.users.local.memory.updatedAt = now;
writeFileSync(path.join(dataDir, "tutor-memory.json"), JSON.stringify(memory));
const accountsSrc = path.join(root, "tmp/calc-capture/accounts.json");
if (existsSync(accountsSrc)) copyFileSync(accountsSrc, path.join(dataDir, "accounts.json"));
else writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify({ users: { local: { plan: "included", period: "2026-10", spentUsd: 0, displayName: "Learner", email: "learner@groundwork.test" } } }));

function run(cmd) {
	execSync(cmd, { stdio: "inherit", cwd: root });
}

run(`GROUNDWORK_API_URL=http://127.0.0.1:${port} npm run build -w packages/obsidian-plugin`);
if (!existsSync(serverEntry)) run("npm run build -w packages/server");

if (existsSync(vault)) execSync(`rm -rf ${JSON.stringify(vault)}`);
cpSync(vaultTemplate, vault, { recursive: true });
writeFileSync(path.join(vault, "Welcome.md"), "");
mkdirSync(pluginVault, { recursive: true });
for (const file of ["main.js", "styles.css", "manifest.json"]) {
	copyFileSync(path.join(pluginDist, file), path.join(pluginVault, file));
}
writeFileSync(
	path.join(pluginVault, "data.json"),
	JSON.stringify({ provider: "demo", claudePath: "", claudeModel: "", model: "claude-sonnet-4-5", maxTokens: 8192, deviceName: "code-style", appearance: "dark", readFolders: [], writeFolders: [], accountToken: "e2e-local-token" }, null, 2),
);
writeFileSync(path.join(pluginVault, "e2e-account-token"), "e2e-local-token\n");
writeFileSync(path.join(pluginVault, "e2e-memory.json"), JSON.stringify({ files: memory.users.local.memory.files }, null, 2));
writeFileSync(path.join(vault, ".obsidian/appearance.json"), JSON.stringify({ theme: "obsidian", cssTheme: "" }, null, 2));
writeFileSync(
	path.join(vault, ".obsidian/workspace.json"),
	JSON.stringify({
		main: { id: "gw-main", type: "split", children: [{ id: "gw-leaf", type: "leaf", state: { type: "groundwork-chat", state: {}, icon: "graduation-cap", title: "Groundwork" } }], direction: "horizontal" },
		left: { id: "left-sidebar", type: "split", children: [], direction: "horizontal", width: 0, collapsed: true },
		right: { id: "right-sidebar", type: "split", children: [], direction: "horizontal", width: 0, collapsed: true },
		active: "gw-leaf",
		lastOpenFiles: [],
	}, null, 2),
);

mkdirSync(path.dirname(obsidianConfig), { recursive: true });
writeFileSync(obsidianConfig, JSON.stringify({ vaults: { gwcodevault00001: { path: vault, ts: Date.now(), open: true } } }));

const serverLog = "/tmp/groundwork-code-style-server.log";
const obsidianLog = "/tmp/obsidian-code-style.log";
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
		["-a", "--server-args=-screen 0 1600x2200x24", obsidianBin, "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=2", `--remote-debugging-port=${cdpPort}`, vault],
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
	await client.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1600, deviceScaleFactor: 2, mobile: false });

	async function dismiss() {
		for (const label of [/Turn on community plugins/i, /Trust author/i, /Enable community plugins/i, /^Open$/i, /Trust vault/i]) {
			const btn = page.getByRole("button", { name: label });
			if (await btn.count()) {
				await btn.first().click().catch(() => {});
				await sleep(400);
			}
		}
	}
	for (let i = 0; i < 8; i++) {
		await dismiss();
		await sleep(300);
	}
	if (!(await page.locator(".gw-root").count())) {
		await page.keyboard.press("Control+p");
		await sleep(400);
		await page.keyboard.type("Groundwork: Open tutor", { delay: 12 });
		await page.keyboard.press("Enter");
		await sleep(2000);
		await dismiss();
	}
	await page.waitForSelector('.gw-root[data-gw-bootstrapped="true"]', { timeout: 120_000 });
	await page.waitForSelector(".gw-assistant", { timeout: 30_000 });
	await page.getByText("factorial").first().waitFor({ timeout: 20_000 });
	await page.evaluate(() => {
		for (const side of document.querySelectorAll(".mod-left-split, .mod-right-split")) side.classList.add("is-collapsed");
	});
	await sleep(500);

	async function shoot(theme) {
		await page.evaluate((name) => {
			const root = document.querySelector(".gw-root");
			root.classList.remove("gw-theme-dark", "gw-theme-light", "gw-theme-obsidian");
			root.classList.add(`gw-theme-${name}`);
		}, theme);
		await sleep(300);
		const msg = page.locator(".gw-assistant").first();
		await msg.scrollIntoViewIfNeeded();
		await sleep(200);
		const box = await msg.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height };
		});
		const file = path.join(outDir, `${tag}-${theme}.png`);
		await page.screenshot({
			path: file,
			clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: Math.min(box.height + 16, 1500) },
			scale: "device",
		});
		const info = await page.evaluate(() => {
			const code = document.querySelector(".gw-assistant code");
			const pre = document.querySelector(".gw-assistant pre");
			const cs = code ? getComputedStyle(code) : null;
			const ps = pre ? getComputedStyle(pre) : null;
			return {
				inlineFont: cs?.fontFamily ?? "",
				inlineBg: cs?.backgroundColor ?? "",
				inlineWhiteSpace: cs?.whiteSpace ?? "",
				preWhiteSpace: ps?.whiteSpace ?? "",
				preOverflow: ps?.overflowX ?? "",
				langs: [...document.querySelectorAll(".gw-assistant code")].map((el) => el.className),
			};
		});
		console.log(tag, theme, file, JSON.stringify(info));
	}

	await shoot("dark");
	await shoot("light");
	console.log("CODE_STYLE_CAPTURE_OK", tag);
} catch (err) {
	console.error(err);
	try {
		const page = browser?.contexts?.()[0]?.pages?.()[0];
		if (page) await page.screenshot({ path: path.join(outDir, `${tag}-failure.png`) });
	} catch {
		/* no page */
	}
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {
		/* closed */
	}
	stop(obsidian);
	stop(server);
}
