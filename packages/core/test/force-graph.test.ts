/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { goalMermaid, type GraphNode } from "../src/graph";
import { buildFromGroundwork, buildSyntheticGraph } from "../src/force-graph/build";
import {
	CONCEPT_MAP_WHEEL_EASE,
	CONCEPT_MAP_WHEEL_PIXELS,
	conceptMapWheelZoom,
	mountForceGraph,
} from "../src/force-graph/canvas";
import { TONE_FALLBACK_COLORS } from "../src/force-graph/colors";
import { MASTERY_LABEL, MASTERY_TONES } from "../src/mastery-tone";
import { forceGraphFromGoalMermaid, parseGoalMermaid } from "../src/force-graph/parse-mermaid";
import { clusterCentroids, runSimulation } from "../src/force-graph/simulation";
import { layoutGroundworkGraph } from "../src/groundwork-graph";

const g = globalThis as typeof globalThis & {
	createEl?: (tag: string) => HTMLElement;
	createDiv?: () => HTMLElement;
	ResizeObserver?: typeof ResizeObserver;
};

g.createEl = (tag: string) => document.createElement(tag);
g.createDiv = () => document.createElement("div");
g.ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

HTMLCanvasElement.prototype.getContext = () =>
	({
		setTransform() {},
		clearRect() {},
		beginPath() {},
		moveTo() {},
		lineTo() {},
		stroke() {},
		fill() {},
		arc() {},
		fillText() {},
		strokeText() {},
		save() {},
		restore() {},
		translate() {},
		scale() {},
		measureText: () => ({ width: 40 }),
	}) as unknown as CanvasRenderingContext2D;

if (typeof PointerEvent === "undefined") {
	(globalThis as unknown as { PointerEvent: typeof Event }).PointerEvent = class PointerEvent extends Event {
		button: number;
		clientX: number;
		clientY: number;
		pointerId: number;
		constructor(type: string, init: PointerEventInit = {}) {
			super(type, init);
			this.button = init.button ?? 0;
			this.clientX = init.clientX ?? 0;
			this.clientY = init.clientY ?? 0;
			this.pointerId = init.pointerId ?? 1;
		}
	} as unknown as typeof PointerEvent;
}

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

	it("zooms the concept map with wheel travel, not a fixed jump per event", () => {
		const notch = conceptMapWheelZoom(100, 0);
		expect(notch).toBeCloseTo(-100 / CONCEPT_MAP_WHEEL_PIXELS);
		expect(Math.abs(notch)).toBeLessThan(Math.log(1.08));
		const tick = conceptMapWheelZoom(4, 0);
		expect(Math.abs(tick)).toBeLessThan(Math.abs(notch) / 10);
		// Twenty tiny trackpad ticks used to be twenty 8% jumps.
		const burst = 20 * Math.abs(conceptMapWheelZoom(4, 0));
		expect(burst).toBeLessThan(Math.log(1.08) * 3);
		expect(conceptMapWheelZoom(-100, 0)).toBeGreaterThan(0);
		expect(conceptMapWheelZoom(10000, 0)).toBeCloseTo(-280 / CONCEPT_MAP_WHEEL_PIXELS);
		expect(conceptMapWheelZoom(3, 1)).toBeCloseTo(conceptMapWheelZoom(120, 0));
		const queued = conceptMapWheelZoom(100, 0);
		const firstFrame = queued * CONCEPT_MAP_WHEEL_EASE;
		expect(Math.abs(firstFrame)).toBeLessThan(Math.abs(queued));
	});

	it("names a node's state once in its hover text", () => {
		const concepts = [{ id: "a", title: "Prior", prerequisites: [], domain: "Bayes", status: "learning" as const }];
		const graph = layoutGroundworkGraph(concepts);
		expect(buildFromGroundwork(concepts, graph).nodes[0]!.actionHint).toBe("find it in the list below");
		expect(buildFromGroundwork(concepts, graph, { studyHints: true }).nodes[0]!.actionHint).toBe("click to keep learning");
	});

	it("chat maps ignore wheel until clicked, then release it on outside click", () => {
		const pane = document.createElement("div");
		pane.className = "gw-graph";
		const host = document.createElement("div");
		pane.appendChild(host);
		document.body.appendChild(pane);
		Object.defineProperty(host, "clientWidth", { value: 400, configurable: true });
		Object.defineProperty(host, "clientHeight", { value: 320, configurable: true });
		host.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 320, width: 400, height: 320, toJSON() {} });

		const handle = mountForceGraph(
			host,
			{ nodes: [{ id: "a", title: "Prior", x: 0, y: 0, vx: 0, vy: 0, radius: 8, color: "#000", cluster: "x", status: "solid", tone: "solid" }], links: [], legend: [] },
			{ captureWheel: "when-active", fit: false },
		);
		const canvas = host.querySelector("canvas")!;
		canvas.getBoundingClientRect = host.getBoundingClientRect;

		const wheel = (target: EventTarget) => {
			const e = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
			const prevented = !target.dispatchEvent(e) || e.defaultPrevented;
			return prevented;
		};

		expect(wheel(canvas)).toBe(false);
		expect(pane.classList.contains("is-active")).toBe(false);

		canvas.setPointerCapture = () => undefined;
		canvas.releasePointerCapture = () => undefined;
		canvas.hasPointerCapture = () => false;

		canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, bubbles: true }));
		expect(pane.classList.contains("is-active")).toBe(true);
		expect(wheel(canvas)).toBe(true);

		document.body.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 1, clientY: 1, bubbles: true }));
		expect(pane.classList.contains("is-active")).toBe(false);
		expect(wheel(canvas)).toBe(false);

		handle.dispose();
		pane.remove();
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
