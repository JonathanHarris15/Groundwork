/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { buildConceptMap, buildFromConceptMap, describeConceptProgress, type ForceGraphData } from "@groundwork/core";

vi.mock("../src/force-graph-host", () => ({ mountConceptMapGraph: vi.fn(), mountInteractiveGraph: vi.fn() }));

const { renderMapPane, renderStartedVaultMap } = await import("../src/map-pane");

const model = buildConceptMap({
	goalTitle: "Linear algebra",
	nodes: [
		{ id: "vectors", title: "Vectors", prerequisites: [], status: "solid", current: 0.95, inGoal: true, role: "path" },
		{ id: "matrices", title: "Matrices", prerequisites: ["vectors"], status: "learning", current: 0.4, inGoal: true, role: "path" },
		{ id: "determinants", title: "Determinants", prerequisites: ["matrices"], status: "unassessed", current: 0, inGoal: true, role: "path" },
		{ id: "eigenvalues", title: "Eigenvalues", prerequisites: ["determinants"], status: "unassessed", current: 0, inGoal: true, role: "target" },
		{ id: "proofs", title: "Proof by induction", prerequisites: [], status: "rusty", current: 0.5, inGoal: true, role: "path" },
	],
	weights: { eigenvalues: 60, determinants: 20, matrices: 10, vectors: 5, proofs: 5 },
	nextId: "matrices",
});

describe("path panel and graph share one mastery mark", () => {
	it("paints every path row with the same tone as its node", () => {
		const parent = document.createElement("div");
		renderMapPane(parent, model, {});
		const graph = new Map(buildFromConceptMap(model).nodes.map((node) => [node.title, node]));
		const rows = [...parent.querySelectorAll<HTMLElement>(".gw-step")];
		expect(rows).toHaveLength(model.steps.length);
		for (const row of rows) {
			const title = row.querySelector(".gw-step-name")!.textContent!;
			const node = graph.get(title)!;
			expect(row.querySelector<HTMLElement>(".gw-step-n")!.dataset.tone).toBe(node.tone);
			expect(row.classList.contains("is-off")).toBe(!!node.faded);
		}
	});

	it("labels rows in the legend's words, never internal names", () => {
		const parent = document.createElement("div");
		renderMapPane(parent, model, {});
		const metas = [...parent.querySelectorAll(".gw-step-meta")].map((el) => el.textContent);
		const legend = [...parent.querySelectorAll(".gw-map-key .gw-key-item")].map((el) => el.textContent);
		for (const meta of metas) expect([...legend, "Next"]).toContain(meta);
		expect(metas.join(" ")).not.toMatch(/\b(ghost|dim|known|visual)\b/);
	});

	it("clicking a row studies that concept the way clicking its node does", () => {
		const onStudy = vi.fn();
		const parent = document.createElement("div");
		renderMapPane(parent, model, { onStudy });
		const row = (title: string) => [...parent.querySelectorAll<HTMLElement>(".gw-step")].find((el) => el.textContent?.includes(title))!;
		row("Vectors").click();
		expect(onStudy).toHaveBeenLastCalledWith("Vectors", "review");
		row("Matrices").click();
		expect(onStudy).toHaveBeenLastCalledWith("Matrices", "start");
	});
});

describe("map legend", () => {
	it("shows tones, the goal, next, and off-path marks when a goal is pinned", () => {
		const parent = document.createElement("div");
		renderMapPane(parent, model, {});
		const tones = [...parent.querySelectorAll<HTMLElement>(".gw-map-key .gw-tone-dot")].map((el) => el.dataset.tone);
		expect(tones).toEqual(["solid", "shaky", "learning", "rusty", "unstarted", "goal", "learning"]);
		expect(parent.querySelector(".gw-map-key")!.textContent).toContain("Off the path");
		expect(parent.querySelector(".gw-prog-label")!.textContent).toBe(describeConceptProgress(model.inPlace, model.total));
	});

	it("still shows a legend with no goal pinned", () => {
		const data: ForceGraphData = {
			nodes: [{ id: "a", title: "Vectors", x: 0, y: 0, vx: 0, vy: 0, radius: 6, color: "#000", cluster: "x", status: "solid", tone: "solid" }],
			links: [],
			legend: [],
		};
		const parent = document.createElement("div");
		renderStartedVaultMap(parent, data, {});
		const items = [...parent.querySelectorAll(".gw-map-key .gw-key-item")].map((el) => el.textContent);
		expect(items).toEqual(["Solid", "Shaky", "Learning", "Rusty"]);
	});
});
