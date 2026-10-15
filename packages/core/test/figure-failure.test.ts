import { describe, expect, it } from "vitest";
import { figureIsVisible, figureReadsVault, PARABOLOID_FIGURE_SOURCE } from "../src/figure";
import { FIGURE_DRAW_RETRY, figureFailureMessage, PYTHON_WORKER_SOURCE } from "../src/figure-python";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import { toolByName, type ToolUI } from "../src/tools";

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

	it("hides a sandbox probe that tried to import a PDF library", () => {
		const message = figureFailureMessage(new Error("ModuleNotFoundError: No module named 'pypdf'\n  File \"/home/pyodide/lib/python3.13/site-packages\""));
		expect(message).toBe("The figure sandbox cannot read vault files. Use read_vault_file.");
		expect(message).not.toMatch(/pyodide|pypdf|PyPDF2/);
	});
});

describe("figure vault probes", () => {
	it("does not draw a card when the program tries to read a vault PDF", async () => {
		expect(figureReadsVault(PARABOLOID_FIGURE_SOURCE)).toBe(false);
		expect(figureIsVisible({ svg: "" })).toBe(false);
		expect(figureIsVisible({ svg: "<svg></svg>" })).toBe(true);
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		let shown = 0;
		const ui: ToolUI = {
			async quiz() {
				return null;
			},
			async ask() {
				return null;
			},
			showFigure() {
				shown += 1;
			},
		};
		const tool = toolByName("show_figure")!;
		for (const source of [
			"import pypdf\nprint(pypdf)",
			"import os\nprint(os.listdir('/home/pyodide'))",
			"import PyPDF2\nPyPDF2.PdfReader('review_lec_1-5.pdf')",
		]) {
			const result = await tool.run({ title: "Environment Check", kind: "program", language: "python", source }, { store, ui, session: { id: "s" } });
			expect(result.isError).toBe(true);
			expect(result.text).toContain("read_vault_file");
			expect(result.text).not.toMatch(/\/home\/pyodide|No module named/);
		}
		expect(shown).toBe(0);
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
