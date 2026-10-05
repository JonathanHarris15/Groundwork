import { describe, expect, it } from "vitest";
import { goalMermaid, type GraphNode } from "../src/graph";
import { buildFromGroundwork, buildSyntheticGraph } from "../src/force-graph/build";
import { TONE_FALLBACK_COLORS } from "../src/force-graph/colors";
import { MASTERY_LABEL, MASTERY_TONES } from "../src/mastery-tone";
import { forceGraphFromGoalMermaid, parseGoalMermaid } from "../src/force-graph/parse-mermaid";
import { clusterCentroids, runSimulation } from "../src/force-graph/simulation";
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

	it("lays out a large synthetic graph into separated domain islands", () => {
		const data = buildSyntheticGraph(240, 2);
		const ticks = runSimulation(data.nodes, data.links, { width: 900, height: 600 }, 280);
		expect(ticks).toBeGreaterThan(10);
		const xs = data.nodes.map((n) => n.x);
		const ys = data.nodes.map((n) => n.y);
		expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(200);
		expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(200);
		const cents = [...clusterCentroids(data.nodes).entries()];
		expect(cents.length).toBeGreaterThan(2);
		let minDist = Infinity;
		for (let i = 0; i < cents.length; i++) {
			for (let j = i + 1; j < cents.length; j++) {
				const a = cents[i]![1];
				const b = cents[j]![1];
				minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.y - b.y));
			}
		}
		expect(minDist).toBeGreaterThan(60);
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
		expect(data.layout).toBe("layered");
		expect(data.nodes.every((n) => n.radius > 0)).toBe(true);
		expect(data.nodes.find((n) => n.id === "b")!.y).toBeLessThan(data.nodes.find((n) => n.id === "a")!.y);
	});

	it("draws website nodes and legend in the mastery tones, not subject colors", () => {
		const concepts = [
			{ id: "a", title: "Prior", prerequisites: [], domain: "Bayes", status: "solid" as const },
			{ id: "b", title: "Posterior", prerequisites: ["a"], domain: "Bayes", status: "rusty" as const },
			{ id: "c", title: "Eigenvalues", prerequisites: [], domain: "Linear algebra", status: "unassessed" as const },
		];
		const graph = layoutGroundworkGraph(concepts);
		const data = buildFromGroundwork(concepts, graph);
		const node = (id: string) => data.nodes.find((n) => n.id === id)!;
		expect(node("a")).toMatchObject({ tone: "solid", color: TONE_FALLBACK_COLORS.solid, open: false });
		expect(node("b")).toMatchObject({ tone: "rusty", color: TONE_FALLBACK_COLORS.rusty });
		expect(node("c")).toMatchObject({ tone: "unstarted", color: TONE_FALLBACK_COLORS.unstarted, open: true });
		const subjects = new Set(graph.legend.map((item) => item.color));
		expect(data.nodes.some((n) => subjects.has(n.color))).toBe(false);
		const tones = data.legend.filter((item) => !item.key.startsWith("edge-"));
		expect(tones.map((item) => item.label)).toEqual(MASTERY_TONES.map((tone) => MASTERY_LABEL[tone]));
		expect(data.legend.some((item) => item.label === "Bayes")).toBe(false);
	});

	it("names a node's state once in its hover text", () => {
		const concepts = [{ id: "a", title: "Prior", prerequisites: [], domain: "Bayes", status: "learning" as const }];
		const graph = layoutGroundworkGraph(concepts);
		expect(buildFromGroundwork(concepts, graph).nodes[0]!.actionHint).toBe("find it in the list below");
		expect(buildFromGroundwork(concepts, graph, { studyHints: true }).nodes[0]!.actionHint).toBe("click to keep learning");
	});
});
