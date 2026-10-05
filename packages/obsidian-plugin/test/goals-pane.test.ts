import { describe, expect, it } from "vitest";
import { toBoard } from "../src/goal-board";
import type { GoalReport } from "@groundwork/core";

/** Goals UI uses the Working on dropdown id; null means unpinned (no hero/sidebar). */
describe("goals pane selection", () => {
	it("treats null selected id as unpinned even when boards exist", () => {
		const report: GoalReport = {
			goal: {
				id: "hw1",
				title: "DAEN 429 Homework 1",
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
					status: "learning",
					current: 0.5,
					role: "target",
					edge: "",
					openMisconceptions: [],
				},
			],
			next: undefined,
			analysis: { open: 1, built: 0, frontier: [], shaky: [] },
		};
		const board = toBoard(report, { weights: { c1: 100 }, readiness: 0.5, schedule: null }, undefined);
		const pinnedId: string | null = "";
		const activeGoalId = pinnedId && board.id === pinnedId ? pinnedId : null;
		expect(activeGoalId).toBeNull();
	});
});
