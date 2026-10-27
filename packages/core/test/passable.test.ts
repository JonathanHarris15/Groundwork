import { describe, expect, it } from "vitest";
import { buildConceptMap, type MapSourceNode } from "../src/goal-plan";
import { isPassable } from "../src/graph";

describe("isPassable", () => {
	it("matches weighted readiness: built, solid, or current at/above passable", () => {
		expect(isPassable("solid", 0.9)).toBe(true);
		expect(isPassable("learning", 0.54)).toBe(true);
		expect(isPassable("learning", 0.49)).toBe(false);
		expect(isPassable("unassessed", 0)).toBe(false);
		expect(isPassable("rusty", 0.55)).toBe(true);
		expect(isPassable("learning", 0.2, { built: true })).toBe(true);
	});
});

describe("concept map goal flags", () => {
	const hw4: MapSourceNode[] = [
		{ id: "dead", title: "Dead neurons in neural networks", prerequisites: [], status: "learning", current: 0.6, inGoal: true, role: "target" },
		{ id: "opt", title: "Deep learning optimization algorithms", prerequisites: [], status: "learning", current: 0.71, inGoal: true, role: "target" },
		{ id: "hyper", title: "Hyperplane projection layer", prerequisites: [], status: "solid", current: 0.86, inGoal: true, role: "target" },
		{ id: "back", title: "Backpropagation with skip connections", prerequisites: ["dead", "opt", "hyper"], status: "learning", current: 0.54, inGoal: true, role: "target" },
	];

	it("paints mastery tones on passable targets instead of red goal flags", () => {
		const map = buildConceptMap({
			goalTitle: "DAEN 429 Homework 4 Mastery",
			nodes: hw4,
			weights: { back: 40, dead: 20, opt: 20, hyper: 20 },
		});
		expect(map.inPlace).toBe(4);
		expect(map.nodes.some((node) => node.tone === "goal")).toBe(false);
		expect(map.steps.some((step) => step.label === "Goal")).toBe(false);
		expect(map.nodes.find((node) => node.id === "back")?.tone).toBe("learning");
	});
});
