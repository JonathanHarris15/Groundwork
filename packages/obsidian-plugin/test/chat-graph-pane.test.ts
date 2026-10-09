/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	setIcon(el: HTMLElement, icon: string) {
		el.dataset.icon = icon;
	},
}));

const proto = HTMLElement.prototype as unknown as Record<string, Function>;
proto.createEl = function createEl(this: HTMLElement, tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
	const el = document.createElement(tag);
	if (opts?.cls) el.className = opts.cls;
	if (opts?.text) el.textContent = opts.text;
	if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
	this.appendChild(el);
	return el;
};
proto.createDiv = function createDiv(this: HTMLElement, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
	return this.createEl("div", opts);
};
proto.createSpan = function createSpan(this: HTMLElement, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
	return this.createEl("span", opts);
};
proto.hasClass = function hasClass(this: HTMLElement, cls: string) {
	return this.classList.contains(cls);
};
proto.toggleClass = function toggleClass(this: HTMLElement, cls: string, force?: boolean) {
	this.classList.toggle(cls, force);
};
proto.setText = function setText(this: HTMLElement, text: string) {
	this.textContent = text;
};

const { createGraphPane } = await import("../src/force-graph-host");

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "../styles.css"), "utf8");
const hostSrc = readFileSync(join(root, "../src/force-graph-host.ts"), "utf8");
const graphSrc = readFileSync(join(root, "../src/graph-pane.ts"), "utf8");

describe("chat dependency map pane", () => {
	it("keeps the force host inside the bordered view, not absolute on the view itself", () => {
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		const { pane, view } = createGraphPane(parent, "Dependency map");

		expect(pane.className).toBe("gw-graph");
		expect(pane.querySelector(".gw-graph-view")?.classList.contains("gw-force-host")).toBe(false);
		expect(view.classList.contains("gw-force-slot")).toBe(true);
		expect(pane.contains(view)).toBe(true);
		expect(hostSrc).toMatch(/cls: "gw-graph-view"/);
		expect(hostSrc).not.toMatch(/gw-graph-view gw-force-host/);
		expect(graphSrc).toMatch(/captureWheel:\s*"when-active"/);
	});

	it("CSS keeps chat graph views in flow and hides crushing header labels early", () => {
		expect(css).toMatch(/\.gw-graph\s*>\s*\.gw-graph-view[\s\S]*?position:\s*relative/);
		expect(css).toMatch(/\.gw-graph-view\.gw-force-host[\s\S]*?position:\s*relative/);
		expect(css).toMatch(/@container \(max-width: 960px\)[\s\S]*?\.gw-actions-tools \.gw-icon-label\s*\{\s*display:\s*none/);
		expect(css).toMatch(/\.gw-graph\.is-active/);
	});
});
