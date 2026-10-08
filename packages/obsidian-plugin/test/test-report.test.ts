/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PreparedQuiz, PreparedTest, TestReport } from "@groundwork/core";
import { TestCard, readableTestInstructions, testScoreMark } from "../src/cards";

vi.mock("obsidian", () => ({
	setIcon(el: HTMLElement, icon: string) {
		el.dataset.icon = icon;
	},
}));

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, Function>;
	proto.empty = function empty(this: HTMLElement) {
		this.replaceChildren();
	};
	proto.setText = function setText(this: HTMLElement, text: string) {
		this.textContent = text;
	};
	proto.addClass = function addClass(this: HTMLElement, cls: string) {
		this.classList.add(cls);
	};
	proto.removeClass = function removeClass(this: HTMLElement, ...cls: string[]) {
		for (const name of cls) this.classList.remove(name);
	};
	proto.toggleClass = function toggleClass(this: HTMLElement, cls: string, force?: boolean) {
		this.classList.toggle(cls, force);
	};
	proto.createEl = function createEl(this: HTMLElement, tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
		const el = this.ownerDocument.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		if (opts?.attr) {
			for (const [key, value] of Object.entries(opts.attr)) el.setAttribute(key, value);
		}
		this.append(el);
		return el;
	};
	proto.createDiv = function createDiv(this: HTMLElement, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
		return this.createEl("div", opts);
	};
	proto.createSpan = function createSpan(this: HTMLElement, opts?: { cls?: string; text?: string }) {
		return this.createEl("span", opts);
	};
});

const quiz = (id: string, concept: string): PreparedQuiz => ({
	id,
	concept,
	question: "Question?",
	format: "choice",
	options: [
		{ label: "right", value: "right" },
		{ label: "wrong", value: "wrong" },
	],
	correct: ["right"],
	explanation: "Because.",
	difficulty: 2,
	kind: "test",
	multiSelect: false,
});

describe("readableTestInstructions", () => {
	it("replaces the broken LaTeX placeholder with a plain instruction", () => {
		expect(readableTestInstructions("Answer every question, then press **Submit test**. Use $...$ for math in a written answer. No feedback until you submit.")).toBe(
			"Answer every question, then press **Submit test**. Type math in the math field. No feedback until you submit.",
		);
		expect(readableTestInstructions("Use $$...$$ for math in written answers.")).toBe("Type math in the math field.");
		expect(testScoreMark(1)).toBe("is-good");
		expect(testScoreMark(0.65)).toBe("is-ok");
		expect(testScoreMark(0.33)).toBe("is-low");
	});
});

describe("practice test results card", () => {
	it("shows each belief once, labels mastery, and orders rows by this test's score", async () => {
		document.body.innerHTML = "";
		const host = document.createElement("div");
		host.className = "gw-root";
		document.body.append(host);
		const test: PreparedTest = {
			id: "t1",
			title: "Calc 1 final · Practice 1",
			instructions: "Use $...$ for math in a written answer.",
			questions: [quiz("q1", "Limits"), quiz("q4", "Chain rule"), quiz("q7", "Chain rule")],
		};
		const seen: string[] = [];
		const card = new TestCard(
			host,
			test,
			async (el, md) => {
				seen.push(md);
				el.textContent = md;
			},
			undefined,
			() => {},
		);
		const report: TestReport = {
			testId: "t1",
			title: test.title,
			date: "2026-10-08T00:00:00.000Z",
			earned: 1,
			possible: 3,
			percent: 1 / 3,
			notePath: "tests/results.md",
			results: [
				{ id: "q1", number: 1, concept: "Limits", difficulty: 2, format: "choice", outcome: "incorrect", points: 0, response: { dontKnow: false, selected: ["wrong"] }, grade: { outcome: "incorrect", correct: false, selectedLabels: [], correctLabels: [], misconception: "plugs in early" } },
				{ id: "q4", number: 4, concept: "Chain rule", difficulty: 2, format: "choice", outcome: "incorrect", points: 0, response: { dontKnow: false, selected: ["wrong"] }, grade: { outcome: "incorrect", correct: false, selectedLabels: [], correctLabels: [], misconception: "forgets the inner derivative" } },
				{ id: "q7", number: 7, concept: "Chain rule", difficulty: 3, format: "choice", outcome: "incorrect", points: 0, response: { dontKnow: false, selected: ["wrong"] }, grade: { outcome: "incorrect", correct: false, selectedLabels: [], correctLabels: [], misconception: "forgets the inner derivative" } },
			],
			byConcept: [
				{ concept: "Power rule", earned: 2, possible: 2, percent: 1, questions: [2, 6], status: "learning", now: 0.2 },
				{ concept: "Chain rule", earned: 1, possible: 3, percent: 1 / 3, questions: [4, 7, 9], status: "learning", now: 0.3 },
				{ concept: "Product rule", earned: 1, possible: 1, percent: 1, questions: [3], status: "shaky", now: 0.7 },
			],
			misconceptions: [
				{ concept: "Chain rule", misconception: "forgets the inner derivative", questions: [4] },
				{ concept: "Chain rule", misconception: "forgets the inner derivative", questions: [7] },
				{ concept: "Limits", misconception: "plugs in early", questions: [1] },
			],
		};
		card.showReport(report);
		expect(seen[0]).toBe("Type math in the math field.");
		expect(host.querySelector(".gw-note-link")?.textContent).toBe("Open results note");
		expect(host.querySelector(".gw-test-concepts .gw-free-label")?.textContent).toBe("This test, lowest score first");
		const names = [...host.querySelectorAll(".gw-test-concept .gw-mastery-label > span:first-child")].map((el) => el.textContent);
		expect(names).toEqual(["Chain rule", "Power rule", "Product rule"]);
		expect(host.querySelector(".gw-test-concept")?.textContent).toContain("Mastery");
		expect(host.querySelector(".gw-test-concept .gw-bar-fill")?.className).toContain("is-low");
		expect(host.querySelectorAll(".gw-test-concept .gw-bar-fill.is-good")).toHaveLength(2);
		const beliefs = [...host.querySelectorAll(".gw-test-misconceptions .gw-misconception")].map((el) => el.textContent);
		expect(beliefs).toEqual(["Chain rule: forgets the inner derivative (Q4, Q7)", "Limits: plugs in early (Q1)"]);
	});
});
