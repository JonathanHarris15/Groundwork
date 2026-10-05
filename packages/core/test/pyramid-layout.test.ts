import { describe, expect, it } from "vitest";
import { buildFromConceptMap } from "../src/force-graph/build";
import { conceptLayerRanks, placePyramidLayout } from "../src/force-graph/pyramid-layout";
import { buildConceptMap } from "../src/goal-plan";
import { layoutGroundworkGraph } from "../src/groundwork-graph";

describe("pyramid layout", () => {
	it("puts foundations lower on the canvas than dependents", () => {
		const ranks = conceptLayerRanks([
			{ id: "a", title: "Limits", prerequisites: [] },
			{ id: "b", title: "Derivative", prerequisites: ["a"] },
			{ id: "c", title: "Chain rule", prerequisites: ["b"] },
		]);
		const pos = placePyramidLayout(
			[
				{ id: "a", title: "Limits" },
				{ id: "b", title: "Derivative" },
				{ id: "c", title: "Chain rule" },
			],
			ranks,
			{ width: 400, height: 360 },
		);
		expect(pos.get("a")!.y).toBeGreaterThan(pos.get("b")!.y);
		expect(pos.get("b")!.y).toBeGreaterThan(pos.get("c")!.y);
	});

	it("pins the working goal to the top layer", () => {
		const map = buildConceptMap({
			goalTitle: "Exam",
			nodes: [
				{ id: "a", title: "Base", prerequisites: [], status: "solid", current: 1, inGoal: true, role: "built" },
				{ id: "b", title: "Peak", prerequisites: ["a"], status: "ghost", current: 0, inGoal: true, role: "target" },
				{ id: "c", title: "Extra", prerequisites: [], status: "solid", current: 1, inGoal: false },
			],
			weights: { b: 50 },
		});
		expect(map.nodes.some((n) => n.id === "c")).toBe(true);
		const goal = map.nodes.find((n) => n.id === "b")!;
		const base = map.nodes.find((n) => n.id === "a")!;
		expect(goal.y).toBeLessThan(base.y);
		const data = buildFromConceptMap(map);
		expect(data.layout).toBe("layered");
		expect(data.legend.some((item) => item.label.includes("Solid arrow"))).toBe(true);
	});

	it("stacks subjects in one pyramid instead of side-by-side clusters", () => {
		const graph = layoutGroundworkGraph([
			{ id: "prior", title: "Prior", prerequisites: [], domain: "Bayes" },
			{ id: "conditional", title: "Conditional", prerequisites: ["prior"], domain: "Bayes" },
			{ id: "eigen", title: "Eigenvectors", prerequisites: ["conditional"], domain: "Linear algebra" },
		]);
		const prior = graph.nodes.find((n) => n.id === "prior")!;
		const eigen = graph.nodes.find((n) => n.id === "eigen")!;
		expect(prior.y).toBeGreaterThan(eigen.y);
		expect(graph.edges.find((e) => e.from === "conditional" && e.to === "eigen")?.bridge).toBe(true);
	});
});
