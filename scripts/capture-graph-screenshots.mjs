#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = "/opt/cursor/artifacts/screenshots";
mkdirSync(out, { recursive: true });

const viewports = [
	{ name: "1280x800", width: 1280, height: 800 },
	{ name: "390x844", width: 390, height: 844 },
	{ name: "2560x1440", width: 2560, height: 1440 },
];

async function waitForServer(url, ms = 60000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// retry
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("server did not start");
}

const server = spawn("npm", ["run", "start", "-w", "packages/server"], { cwd: root, stdio: "ignore", env: { ...process.env, PORT: "8787" } });

try {
	await waitForServer("http://127.0.0.1:8787/graph-harness.html");
	const { chromium } = await import("playwright");
	const browser = await chromium.launch({ headless: true });
	for (const vp of viewports) {
		const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
		await page.goto("http://127.0.0.1:8787/graph-harness.html", { waitUntil: "networkidle" });
		await page.waitForTimeout(1200);
		await page.screenshot({ path: path.join(out, `graph-harness-${vp.name}.png`), fullPage: vp.width < 500 });
		await page.close();
	}
	await browser.close();
	console.log(`Wrote screenshots to ${out}`);
} finally {
	server.kill("SIGTERM");
}
