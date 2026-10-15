import { describe, expect, it } from "vitest";
import { FIGURE_DRAW_RETRY, figureFailureMessage, PYTHON_WORKER_SOURCE } from "../src/figure-python";

describe("figure failure copy", () => {
	it("replaces the node:url loader error with a retry", () => {
		const message = figureFailureMessage(new Error("Failed to fetch dynamically imported module: node:url"));
		expect(message).toBe(FIGURE_DRAW_RETRY);
		expect(message).toContain("Try again");
		expect(message).not.toMatch(/node:url/);
	});

	it("keeps a Python error and tells the learner to try again", () => {
		expect(figureFailureMessage(new Error("Python did not write figure.png."))).toBe("Python did not write figure.png. Try again.");
	});

	it("does not stack retry sentences", () => {
		expect(figureFailureMessage(FIGURE_DRAW_RETRY)).toBe(FIGURE_DRAW_RETRY);
	});
});

describe("figure worker source", () => {
	it("forces the browser runtime and does not add an unsafe dynamic import", () => {
		expect(PYTHON_WORKER_SOURCE).toContain("useBrowserRuntime");
		expect(PYTHON_WORKER_SOURCE).toContain("proc.browser = true");
		expect(PYTHON_WORKER_SOURCE).not.toMatch(/\beval\s*\(/);
		expect(PYTHON_WORKER_SOURCE).not.toMatch(/\bnew Function\b/);
		expect(PYTHON_WORKER_SOURCE).not.toMatch(/\bimport\s*\(/);
	});
});
