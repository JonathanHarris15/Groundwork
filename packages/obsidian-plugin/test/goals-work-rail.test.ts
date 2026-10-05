/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderGoalsPane } from "../src/goals-pane";
import type { GoalBoardView } from "../src/goal-board";

const board = (): GoalBoardView => ({
	id: "exam",
	title: "Exam prep",
	status: "active",
	due: "2026-12-01",
	dueLabel: "Dec 1",
	daysLeft: 12,
	pace: "on-pace",
	startLabel: "Sep 1",
	studiedDays: 3,
	elapsedDays: 10,
	readiness: 0.4,
	knownCount: 2,
	conceptCount: 5,
	nextTitle: "Limits",
	nextAfter: "Derivatives",
	sessions: 3,
	shaky: ["Chain rule"],
	heaviest: { title: "Integration", weight: 40 },
	days: [],
	concepts: [],
	inPlace: 2,
	total: 5,
	map: { nodes: [], edges: [], goalNodeId: "", steps: [], inPlace: 2, total: 5 },
});

describe("goals work rail", () => {
	it("renders title-only action buttons without time estimates", () => {
		const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
		const parent = dom.window.document.body;
		renderGoalsPane(parent, [board()], "exam", {
			onSelect: () => {},
			onCreate: () => {},
			onDue: () => {},
			onWeight: () => {},
			onOpen: () => {},
			onPractice: () => {},
			onMap: () => {},
			onDocs: () => {},
			onDelete: () => {},
		});
		const buttons = [...parent.querySelectorAll(".gw-work-btn")].map((b) => b.textContent?.trim() ?? "");
		expect(buttons).toContain("Continue the path");
		expect(buttons).toContain("Practice exam");
		expect(buttons.some((t) => /\d+m/.test(t))).toBe(false);
		expect(parent.textContent).not.toContain("Weights come from the goal");
		expect(parent.querySelector(".gw-path-why")).toBeNull();
	});
});
