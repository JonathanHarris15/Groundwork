import { describe, expect, it } from "vitest";
import { toBoard } from "../src/goal-board";
import type { GoalReport } from "@groundwork/core";

type Node = GoalReport["nodes"][0];

function report(nodes: Array<Partial<Node> & { id: string }>, built: string[] = []): GoalReport {
	return {
		goal: {
			id: "g1",
			title: "Exam",
			status: "active",
			due: "2026-12-01",
			targets: [nodes[0].id],
			built,
			nodes: nodes.map((node) => node.id),
			weights: {},
			requiredLevels: {},
		},
		nodes: nodes.map((node) => ({
			title: node.id,
			prerequisites: [],
			status: "unassessed",
			current: 0,
			role: "path",
			...node,
		})),
	} as GoalReport;
}

const timing = (weights: Record<string, number>) => ({ weights, readiness: 0.5, schedule: null });

describe("toBoard concept rows", () => {
	it("treats solid mastery as known even when the map marks the node as the goal focus", () => {
		const board = toBoard(report([{ id: "c1", title: "Limits", status: "solid", current: 1, role: "target" }]), timing({ c1: 15 }));
		const row = board.concepts[0];
		expect(row.complete).toBe(100);
		expect(row.state).toBe("Solid");
		expect(row.tone).toBe("solid");
		expect(row.known).toBe(true);
	});

	it("gives a known concept a review action instead of a locked button", () => {
		const board = toBoard(report([{ id: "c1", status: "solid", current: 1 }]), timing({ c1: 100 }));
		expect(board.concepts[0].action).toBe("review");
	});

	it("names states in the legend's words and keeps Learn for learning", () => {
		const board = toBoard(
			report([
				{ id: "a", status: "learning", current: 0.4 },
				{ id: "b", status: "unassessed" },
				{ id: "c", status: "rusty", current: 0.5 },
			]),
			timing({ a: 50, b: 30, c: 20 }),
		);
		const byId = new Map(board.concepts.map((row) => [row.id, row]));
		expect(byId.get("a")).toMatchObject({ state: "Learning", tone: "learning", action: "learn" });
		expect(byId.get("b")).toMatchObject({ state: "Not started", tone: "unstarted", action: "start" });
		expect(byId.get("c")).toMatchObject({ state: "Rusty", tone: "rusty", action: "quiz" });
	});

	it("lists shaky and rusty concepts for the shaky-spots quiz", () => {
		const board = toBoard(
			report([
				{ id: "a", status: "shaky", current: 0.7 },
				{ id: "b", status: "rusty", current: 0.6 },
				{ id: "c", status: "solid", current: 0.9 },
			]),
			timing({ a: 40, b: 40, c: 20 }),
		);
		expect(board.shaky.sort()).toEqual(["a", "b"]);
	});

	it("counts solid concepts the way the table marks them", () => {
		const board = toBoard(
			report(
				[
					{ id: "a", status: "solid", current: 0.9 },
					{ id: "b", status: "learning", current: 0.3 },
					{ id: "c", status: "learning", current: 0.3 },
				],
				["c"],
			),
			timing({ a: 34, b: 33, c: 33 }),
		);
		expect(board.knownCount).toBe(2);
		expect(board.inPlace).toBe(2);
		expect(board.concepts.filter((row) => row.known)).toHaveLength(2);
	});
});
