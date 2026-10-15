import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { PYODIDE_INDEX, PYTHON_WORKER_SOURCE } from "../src/figure-python";

const chrome = ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome"].find((candidate) => existsSync(candidate));
const logistic = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/fixtures/logistic-l2-figure.py"), "utf8");

/** Electron's renderer exposes Node's process. Pyodide then dynamic-imports node:url. */
const electronProcess = `globalThis.process = { versions: { node: "22.14.0" }, type: "worker", env: {}, browser: false };\n`;

describe.skipIf(!chrome)("python worker in a browser", () => {
	it("writes the figure without a system Python", async () => {
		const result = await runWorker(PYTHON_WORKER_SOURCE, "open('figure.svg','w').write('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"40\"><circle cx=\"8\" cy=\"20\" r=\"4\"/></svg>')");
		expect(result.type).toBe("done");
		const files = result.files as Record<string, string>;
		const svg = Buffer.from(files["figure.svg"] ?? "", "base64").toString("utf8");
		expect(svg).toContain("<circle");
	}, 120_000);

	it("draws a numpy matplotlib surface when Electron's process is present", async () => {
		const result = await runWorker(`${electronProcess}${PYTHON_WORKER_SOURCE}`, logistic);
		const message = String(result.message ?? "");
		expect(message).not.toMatch(/node:url/);
		expect(message).not.toMatch(/dynamically imported module/);
		expect(result.type, message).toBe("done");
		const files = result.files as Record<string, string>;
		const png = Buffer.from(files["figure.png"] ?? "", "base64");
		expect(png.byteLength).toBeGreaterThan(1_000);
		expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	}, 180_000);
});

async function runWorker(source: string, program: string): Promise<Record<string, unknown>> {
	const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
	try {
		const page = await browser.newPage();
		return await page.evaluate(
			async ({ workerSource, indexURL, program: python }) => {
				const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
				return await new Promise<Record<string, unknown>>((resolve) => {
					const timer = window.setTimeout(() => resolve({ type: "timeout" }), 170_000);
					worker.onmessage = (event: MessageEvent) => {
						const data = event.data as { type?: string };
						if (data?.type === "ready") worker.postMessage({ type: "run", source: python });
						else if (data?.type === "done" || data?.type === "error") {
							window.clearTimeout(timer);
							resolve(event.data as Record<string, unknown>);
						}
					};
					worker.onerror = (event: ErrorEvent) => {
						window.clearTimeout(timer);
						resolve({ type: "worker-error", message: String(event.message || event) });
					};
					worker.postMessage({ type: "load", indexURL });
				});
			},
			{ workerSource: source, indexURL: PYODIDE_INDEX, program },
		);
	} finally {
		await browser.close();
	}
}
