import { describe, expect, it } from "vitest";
import { goalMermaid, type GraphNode } from "../src/graph";
import { buildFromGroundwork, buildSyntheticGraph } from "../src/force-graph/build";
import { forceGraphFromGoalMermaid, parseGoalMermaid } from "../src/force-graph/parse-mermaid";
import { runSimulation } from "../src/force-graph/simulation";
import { layoutGroundworkGraph } from "../src/groundwork-graph";

describe("force graph", () => {
	it("parses a set_goal mermaid map", () => {
		const nodes: GraphNode[] = [
			{ id: "a", title: "Limit", prerequisites: [], status: "solid", current: 1 },
			{ id: "b", title: "Derivative", prerequisites: ["a"], status: "learning", current: 0.4 },
			{ id: "c", title: "Chain rule", prerequisites: ["b"], status: "unassessed", current: 0 },
		];
		const source = goalMermaid(nodes, ["c"], []);
		const parsed = parseGoalMermaid(source);
		expect(parsed?.nodes.length).toBe(3);
		expect(parsed?.links.length).toBe(2);
		const data = forceGraphFromGoalMermaid(source);
		expect(data?.nodes.find((n) => n.title === "Chain rule")?.isTarget).toBe(true);
	});

	it("lays out a large synthetic graph without overlapping piles", () => {
		const data = buildSyntheticGraph(240, 2);
		const ticks = runSimulation(data.nodes, data.links, { width: 900, height: 600 }, 200);
		expect(ticks).toBeGreaterThan(10);
		const xs = data.nodes.map((n) => n.x);
		const ys = data.nodes.map((n) => n.y);
		expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(80);
		expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(80);
	});

	it("maps website groundwork data", () => {
		const concepts = [
			{ id: "a", title: "Prior", prerequisites: [], domain: "Bayes", status: "solid" as const },
			{ id: "b", title: "Posterior", prerequisites: ["a"], domain: "Bayes", status: "learning" as const },
		];
		const graph = layoutGroundworkGraph(concepts);
		const data = buildFromGroundwork(
			concepts.map((c) => ({ id: c.id, title: c.title, status: c.status })),
			graph,
		);
		expect(data.links.length).toBe(1);
		expect(data.nodes.every((n) => n.radius > 0)).toBe(true);
	});
});
