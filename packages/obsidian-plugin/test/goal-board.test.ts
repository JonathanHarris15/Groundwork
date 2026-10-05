import { describe, expect, it } from "vitest";
import { toBoard } from "../src/goal-board";
import type { GoalReport } from "@groundwork/core";

function minimalReport(overrides: Partial<GoalReport["nodes"][0]> = {}): GoalReport {
	return {
		goal: {
			id: "g1",
			title: "Exam",
			status: "active",
			due: "2026-12-01",
			targets: ["c1"],
			built: [],
			nodes: ["c1"],
			weights: {},
			requiredLevels: {},
		},
		nodes: [
			{
				id: "c1",
				title: "Limits",
				prerequisites: [],
				status: "solid",
				current: 1,
				role: "target",
				...overrides,
			},
		],
	};
}

describe("toBoard concept rows", () => {
	it("treats solid mastery as known even when the map marks the node as the goal focus", () => {
		const report = minimalReport();
		const board = toBoard(
			report,
			{ weights: { c1: 15 }, readiness: 1, schedule: null },
			undefined,
		);
		const row = board.concepts[0];
		expect(row.complete).toBe(100);
		expect(row.state).toBe("Solid");
		expect(row.color).toBe("#3CC56F");
		expect(row.action).toBe("known");
	});
});
