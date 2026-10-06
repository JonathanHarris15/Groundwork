import { describe, expect, it } from "vitest";
import { buildConceptMap } from "../src/goal-plan";
import { buildFromConceptMap } from "../src/force-graph/build";
import {
	GOAL_DISC_RADIUS,
	GOAL_FILL,
	GOAL_FLAG_FILL,
	GOAL_FLAG_SCALE,
	GOAL_FLAG_STROKE,
	GOAL_HALO_OPACITY,
	GOAL_HALO_RADIUS,
	GOAL_HALO_STROKE,
	GOAL_RING,
	GOAL_RING_STROKE,
	highlightGradient,
	isGoalNode,
	paintGoalMark,
	PATH_STOPS,
} from "../src/force-graph/goal-mark";

type Op = { kind: string; detail: unknown };

function recordingContext() {
	const ops: Op[] = [];
	const state = {
		globalAlpha: 1,
		lineWidth: 1,
		strokeStyle: "" as string,
		fillStyle: "" as string,
		lineCap: "butt",
		lineJoin: "miter",
		filter: "none",
	};
	const stack: Array<typeof state> = [];
	const ctx = {
		get globalAlpha() {
			return state.globalAlpha;
		},
		set globalAlpha(value: number) {
			state.globalAlpha = value;
		},
		get lineWidth() {
			return state.lineWidth;
		},
		set lineWidth(value: number) {
			state.lineWidth = value;
		},
		get strokeStyle() {
			return state.strokeStyle;
		},
		set strokeStyle(value: string) {
			state.strokeStyle = value;
		},
		get fillStyle() {
			return state.fillStyle;
		},
		set fillStyle(value: string) {
			state.fillStyle = value;
		},
		set lineCap(value: string) {
			state.lineCap = value;
		},
		set lineJoin(value: string) {
			state.lineJoin = value;
		},
		save() {
			stack.push({ ...state });
			ops.push({ kind: "save", detail: null });
		},
		restore() {
			const prev = stack.pop();
			if (prev) Object.assign(state, prev);
			ops.push({ kind: "restore", detail: null });
		},
		setLineDash() {},
		beginPath() {
			ops.push({ kind: "begin", detail: null });
		},
		arc(x: number, y: number, r: number) {
			ops.push({ kind: "arc", detail: { x, y, r, stroke: state.strokeStyle, width: state.lineWidth, alpha: state.globalAlpha, fill: state.fillStyle } });
		},
		moveTo(x: number, y: number) {
			ops.push({ kind: "move", detail: { x, y } });
		},
		lineTo(x: number, y: number) {
			ops.push({ kind: "line", detail: { x, y } });
		},
		closePath() {
			ops.push({ kind: "close", detail: null });
		},
		translate(x: number, y: number) {
			ops.push({ kind: "translate", detail: { x, y } });
		},
		scale(x: number, y: number) {
			ops.push({ kind: "scale", detail: { x, y, width: state.lineWidth } });
		},
		stroke() {
			ops.push({ kind: "stroke", detail: { stroke: state.strokeStyle, width: state.lineWidth, alpha: state.globalAlpha } });
		},
		fill() {
			ops.push({ kind: "fill", detail: { fill: state.fillStyle, alpha: state.globalAlpha } });
		},
		createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
			const stops: Array<[number, string]> = [];
			ops.push({ kind: "gradient", detail: { x0, y0, x1, y1, stops } });
			return { addColorStop: (offset: number, color: string) => stops.push([offset, color]) };
		},
	};
	return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

describe("goal mark", () => {
	it("treats a goal tone and an open target as the flag node", () => {
		expect(isGoalNode({ tone: "goal" })).toBe(true);
		expect(isGoalNode({ isTarget: true })).toBe(true);
		expect(isGoalNode({ isTarget: true, isBuiltTarget: true })).toBe(false);
		expect(isGoalNode({ tone: "solid" })).toBe(false);
	});

	it("paints the ad's disc, ring, halo, and flag at the ad's radius", () => {
		const { ctx, ops } = recordingContext();
		paintGoalMark(ctx, 80, 40, GOAL_DISC_RADIUS);
		const arcs = ops.filter((op) => op.kind === "arc").map((op) => op.detail as { r: number });
		expect(arcs.map((arc) => arc.r)).toEqual([GOAL_HALO_RADIUS, GOAL_DISC_RADIUS]);
		const halo = ops.find((op) => op.kind === "stroke");
		expect(halo?.detail).toMatchObject({ stroke: GOAL_RING, width: GOAL_HALO_STROKE, alpha: GOAL_HALO_OPACITY });
		const fills = ops.filter((op) => op.kind === "fill").map((op) => op.detail);
		expect(fills[0]).toMatchObject({ fill: GOAL_FILL, alpha: 1 });
		expect(fills[1]).toMatchObject({ fill: GOAL_FLAG_FILL });
		const ring = ops.filter((op) => op.kind === "stroke")[1];
		expect(ring?.detail).toMatchObject({ stroke: GOAL_RING, width: GOAL_RING_STROKE, alpha: 1 });
		expect(ops.find((op) => op.kind === "scale")?.detail).toMatchObject({ x: GOAL_FLAG_SCALE, y: GOAL_FLAG_SCALE });
		const flagStroke = ops.filter((op) => op.kind === "stroke").at(-1);
		expect(flagStroke?.detail).toMatchObject({ stroke: GOAL_RING, width: GOAL_FLAG_STROKE });
		const moves = ops.filter((op) => op.kind === "move" || op.kind === "line").map((op) => op.detail);
		expect(moves).toEqual([
			{ x: -5, y: 10 },
			{ x: -5, y: -10 },
			{ x: -5, y: -10 },
			{ x: 6, y: -10 },
			{ x: 3.5, y: -5.5 },
			{ x: 6, y: -1 },
			{ x: -5, y: -1 },
		]);
	});

	it("scales the halo and ring with the node", () => {
		const { ctx, ops } = recordingContext();
		paintGoalMark(ctx, 0, 0, 15);
		const arcs = ops.filter((op) => op.kind === "arc").map((op) => (op.detail as { r: number }).r);
		expect(arcs[0]).toBeCloseTo(GOAL_HALO_RADIUS / 2);
		expect(arcs[1]).toBeCloseTo(15);
	});

	it("ramps the highlighted path from green through blue to red", () => {
		const { ctx, ops } = recordingContext();
		highlightGradient(ctx, 100, 400);
		const gradient = ops.find((op) => op.kind === "gradient")?.detail as { y0: number; y1: number; stops: Array<[number, string]> };
		expect(gradient.y0).toBe(400);
		expect(gradient.y1).toBe(100);
		expect(gradient.stops).toEqual(PATH_STOPS.map((stop) => [stop.offset, stop.color]));
	});

	it("glows every edge on the chain up to the goal", () => {
		const model = buildConceptMap({
			goalTitle: "Goal",
			nodes: [
				{ id: "a", title: "Algebra", prerequisites: [], status: "solid", current: 1, inGoal: true, role: "path" },
				{ id: "b", title: "Limits", prerequisites: ["a"], status: "shaky", current: 0.4, inGoal: true, role: "path" },
				{ id: "c", title: "Power rule", prerequisites: ["b"], status: "learning", current: 0.2, inGoal: true, role: "path" },
				{ id: "g", title: "Derivative of sine", prerequisites: ["c"], status: "unassessed", current: 0, inGoal: true, role: "target" },
				{ id: "off", title: "Graphing", prerequisites: ["a"], status: "solid", current: 1, inGoal: false, role: "path" },
			],
		});
		const data = buildFromConceptMap(model);
		const highlighted = data.links.filter((link) => link.highlight).map((link) => `${link.from}->${link.to}`);
		expect(highlighted).toEqual(expect.arrayContaining(["a->b", "b->c", "c->g"]));
		expect(data.links.find((link) => link.to === "off")?.highlight).toBe(false);
		expect(data.nodes.find((node) => node.id === "g")?.tone).toBe("goal");
	});
});
