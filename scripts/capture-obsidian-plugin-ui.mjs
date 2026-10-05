#!/usr/bin/env node
/**
 * Static harness screenshots for the Groundwork Obsidian panel (no Electron).
 * Output: /opt/cursor/artifacts/obsidian-plugin-ui/
 */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessDir = path.join(root, "packages/obsidian-plugin/test/ui-harness");
const stylesheet = path.join(root, "packages/obsidian-plugin/styles.css");
const outDir = "/opt/cursor/artifacts/obsidian-plugin-ui";
mkdirSync(outDir, { recursive: true });

const sizes = [
  { name: "sidebar-280", width: 280, height: 720 },
  { name: "sidebar-360", width: 360, height: 800 },
  { name: "pane-1280", width: 1280, height: 800 },
  { name: "pane-1920", width: 1920, height: 1080 },
];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  // index.html links ../../styles.css, which an HTTP root resolves to /styles.css.
  const target = file === "/styles.css" ? stylesheet : path.join(harnessDir, file);
  if (target !== stylesheet && !target.startsWith(harnessDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  import("node:fs/promises")
    .then((fs) => fs.readFile(target))
    .then((buf) => {
      const ext = path.extname(target);
      const type =
        ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : ext === ".html" ? "text/html" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(buf);
    })
    .catch(() => {
      res.writeHead(404);
      res.end();
    });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(base, { waitUntil: "networkidle" });
const states = await page.evaluate(() => window.harness.states);

for (const state of states) {
  await page.evaluate((id) => window.harness.render(id), state);
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(80);
    const file = path.join(outDir, `${state}-${size.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
  }
}

await browser.close();
server.close();
console.log(`Wrote ${states.length * sizes.length} screenshots to ${outDir}`);
