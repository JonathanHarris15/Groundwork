/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { renderGoalsPane, type GoalsPaneHandlers } from "../src/goals-pane";
import type { GoalBoardView, GoalConceptRow } from "../src/goal-board";

const row = (title: string, over: Partial<GoalConceptRow>): GoalConceptRow => ({
	id: title.toLowerCase(),
	title,
	weight: 20,
	complete: 40,
	state: "Learning",
	tone: "learning",
	next: false,
	known: false,
	action: "learn",
	...over,
});

const board = (over: Partial<GoalBoardView> = {}): GoalBoardView => ({
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
	map: { nodes: [], edges: [], goalNodeId: "", steps: [], inPlace: 2, total: 5, viewBox: "0 0 1 1", width: 1, height: 1 },
	...over,
});

function handlers(over: Partial<GoalsPaneHandlers> = {}): GoalsPaneHandlers {
	return {
		onSelect: () => {},
		onCreate: () => {},
		onDue: () => {},
		onWeight: () => {},
		onOpen: () => {},
		onPractice: () => {},
		onMap: () => {},
		onDocs: () => {},
		onDelete: () => {},
		...over,
	};
}

describe("goals work rail", () => {
	it("renders title-only action buttons without time estimates", () => {
		const parent = document.createElement("div");
		renderGoalsPane(parent, [board()], "exam", handlers());
		const buttons = [...parent.querySelectorAll(".gw-work-btn")].map((b) => b.textContent?.trim() ?? "");
		expect(buttons).toContain("Continue the path");
		expect(buttons).toContain("Practice exam");
		expect(buttons.some((t) => /\d+m/.test(t))).toBe(false);
		expect(parent.textContent).not.toContain("Weights come from the goal");
		expect(parent.querySelector(".gw-path-why")).toBeNull();
		expect(parent.querySelector(".gw-kicker .gw-goal-flag path")?.getAttribute("d")).toBe("M5 21V4M5 4h11l-2 4 2 4H5");
	});

	it("never shows a Continue button with nowhere to go", () => {
		const parent = document.createElement("div");
		renderGoalsPane(parent, [board({ nextTitle: undefined })], "exam", handlers());
		const buttons = [...parent.querySelectorAll(".gw-work-btn")];
		expect(buttons.map((b) => b.textContent)).not.toContain("Continue the path");
		expect(buttons.find((b) => b.textContent === "Practice exam")?.classList.contains("is-primary")).toBe(true);
	});

	it("quizzes every shaky spot it names", () => {
		const onOpen = vi.fn();
		const parent = document.createElement("div");
		renderGoalsPane(parent, [board({ shaky: ["Chain rule", "Limits"] })], "exam", handlers({ onOpen }));
		const quiz = [...parent.querySelectorAll<HTMLButtonElement>(".gw-work-btn")].find((b) => b.textContent === "Quiz my shaky spots");
		quiz?.click();
		expect(onOpen).toHaveBeenCalledWith("Chain rule and Limits", "quiz");
	});
});

describe("goals concept table", () => {
	it("Known is a live button that starts a review; Learn still starts learning", () => {
		const onOpen = vi.fn();
		const parent = document.createElement("div");
		const concepts = [
			row("Eigenvalues", { state: "Solid", tone: "solid", known: true, action: "review", complete: 100 }),
			row("Determinants", {}),
		];
		renderGoalsPane(parent, [board({ concepts })], "exam", handlers({ onOpen }));
		const actions = [...parent.querySelectorAll<HTMLButtonElement>(".gw-row-action")];
		const known = actions.find((b) => b.textContent?.includes("Known"))!;
		expect(known.disabled).toBe(false);
		known.click();
		expect(onOpen).toHaveBeenCalledWith("Eigenvalues", "review");
		actions.find((b) => b.textContent === "Learn")!.click();
		expect(onOpen).toHaveBeenLastCalledWith("Determinants", "learn");
	});

	it("fills only the next concept's action, however many are unstarted", () => {
		const parent = document.createElement("div");
		const unstarted = { state: "Not started", tone: "unstarted", action: "start", complete: 0 } as const;
		const concepts = [row("Limit", unstarted), row("Slope", { ...unstarted, state: "Next", next: true }), row("Secant line", unstarted)];
		renderGoalsPane(parent, [board({ concepts })], "exam", handlers());
		const actions = [...parent.querySelectorAll<HTMLButtonElement>(".gw-row-action")];
		expect(actions.map((b) => b.textContent)).toEqual(["Start", "Start", "Start"]);
		expect(actions.map((b) => b.classList.contains("is-primary"))).toEqual([false, true, false]);
	});

	it("draws the state as a toned pill and the dot in the same tone", () => {
		const parent = document.createElement("div");
		renderGoalsPane(parent, [board({ concepts: [row("Eigenvalues", { state: "Rusty", tone: "rusty", action: "quiz" })] })], "exam", handlers());
		const pill = parent.querySelector<HTMLElement>(".gw-state .gw-status")!;
		expect(pill.dataset.tone).toBe("rusty");
		expect(pill.textContent).toBe("Rusty");
		expect(parent.querySelector<HTMLElement>(".gw-concept-name .gw-tone-dot")!.dataset.tone).toBe("rusty");
		expect(parent.querySelector<HTMLElement>(".gw-complete-bar span")!.dataset.tone).toBe("rusty");
	});
});
