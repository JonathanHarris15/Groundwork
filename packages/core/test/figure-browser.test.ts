import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { PYODIDE_INDEX, PYTHON_WORKER_SOURCE } from "../src/figure-python";

const chrome = ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome"].find((path) => existsSync(path));

describe.skipIf(!chrome)("python worker in a browser", () => {
	it("writes the figure without a system Python", async () => {
		const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
		try {
			const page = await browser.newPage();
			const result = await page.evaluate(
				async ({ source, indexURL }) => {
					const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
					return await new Promise<Record<string, unknown>>((resolve) => {
						const timer = window.setTimeout(() => resolve({ type: "timeout" }), 90_000);
						worker.onmessage = (event: MessageEvent) => {
							const data = event.data as { type?: string };
							if (data?.type === "ready") {
								worker.postMessage({
									type: "run",
									source: "open('figure.svg','w').write('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"40\"><circle cx=\"8\" cy=\"20\" r=\"4\"/></svg>')",
								});
							} else if (data?.type === "done" || data?.type === "error") {
								window.clearTimeout(timer);
								resolve(event.data as Record<string, unknown>);
							}
						};
						worker.onerror = () => {
							window.clearTimeout(timer);
							resolve({ type: "worker-error" });
						};
						worker.postMessage({ type: "load", indexURL });
					});
				},
				{ source: PYTHON_WORKER_SOURCE, indexURL: PYODIDE_INDEX },
			);
			expect(result.type).toBe("done");
			const files = result.files as Record<string, string>;
			const svg = Buffer.from(files["figure.svg"] ?? "", "base64").toString("utf8");
			expect(svg).toContain("<circle");
		} finally {
			await browser.close();
		}
	}, 120_000);
});
