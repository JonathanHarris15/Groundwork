import type { ForceGraphNode } from "./types";

/**
 * Goal mark and highlighted-path paint from the approved ads (DG-1A map SVG).
 * Sizes are the ad's user units. A goal disc there has radius 30; a regular
 * node has radius 19. Strokes scale by the node's radius over those.
 */
export const GOAL_FILL = "#2a1a1d";
export const GOAL_RING = "#E5484D";
export const GOAL_FLAG_FILL = "rgba(229,72,77,0.35)";
export const GOAL_DISC_RADIUS = 30;
export const GOAL_HALO_RADIUS = 40;
export const GOAL_HALO_STROKE = 2;
export const GOAL_HALO_OPACITY = 0.35;
export const GOAL_RING_STROKE = 4;
export const GOAL_FLAG_SCALE = 1.35;
export const GOAL_FLAG_STROKE = 2.4;

/** Ad path: green at the foundation end, blue at 55% of the rise, red at the goal. */
export const PATH_STOPS = [
	{ offset: 0, color: "#2DB560" },
	{ offset: 0.55, color: "#2E9BE6" },
	{ offset: 1, color: "#E5484D" },
] as const;
export const PATH_REFERENCE_RADIUS = 19;
export const PATH_GLOW_WIDTH = 12;
export const PATH_CORE_WIDTH = 4.5;
export const PATH_BLUR = 6;
export const PATH_GLOW_OPACITY = 0.8;
/** Concept-map nodes that are not goals use radius 13 (`r: 11` plus the graph's +2). */
export const CONCEPT_MAP_NODE_RADIUS = 13;

export function isGoalNode(node: Pick<ForceGraphNode, "tone" | "isTarget" | "isBuiltTarget">): boolean {
	if (node.tone === "goal") return true;
	return node.isTarget === true && node.isBuiltTarget !== true;
}

/** Ad stroke widths, scaled so they sit on a concept-map node the way they sit on the ad's r=19 disc. */
export function pathStrokeScale(nodeRadius = CONCEPT_MAP_NODE_RADIUS): number {
	return nodeRadius / PATH_REFERENCE_RADIUS;
}

/** Vertical ramp. `top` is the goal end (smaller y); `bottom` is the foundation end. */
export function highlightGradient(ctx: CanvasRenderingContext2D, top: number, bottom: number): CanvasGradient {
	const yBottom = bottom;
	const yTop = top === bottom ? top - 1 : top;
	const gradient = ctx.createLinearGradient(0, yBottom, 0, yTop);
	for (const stop of PATH_STOPS) gradient.addColorStop(stop.offset, stop.color);
	return gradient;
}

/** Dark disc, red ring, filled flag, and the soft outer ring. Caller sets globalAlpha for dimming. */
export function paintGoalMark(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
	const k = radius / GOAL_DISC_RADIUS;
	const alpha = ctx.globalAlpha;
	ctx.save();
	ctx.setLineDash([]);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	ctx.beginPath();
	ctx.arc(x, y, GOAL_HALO_RADIUS * k, 0, Math.PI * 2);
	ctx.strokeStyle = GOAL_RING;
	ctx.lineWidth = GOAL_HALO_STROKE * k;
	ctx.globalAlpha = alpha * GOAL_HALO_OPACITY;
	ctx.stroke();

	ctx.globalAlpha = alpha;
	ctx.beginPath();
	ctx.arc(x, y, radius, 0, Math.PI * 2);
	ctx.fillStyle = GOAL_FILL;
	ctx.fill();
	ctx.strokeStyle = GOAL_RING;
	ctx.lineWidth = GOAL_RING_STROKE * k;
	ctx.stroke();

	ctx.translate(x, y);
	ctx.scale(GOAL_FLAG_SCALE * k, GOAL_FLAG_SCALE * k);
	ctx.lineWidth = GOAL_FLAG_STROKE;
	ctx.strokeStyle = GOAL_RING;
	ctx.beginPath();
	ctx.moveTo(-5, 10);
	ctx.lineTo(-5, -10);
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(-5, -10);
	ctx.lineTo(6, -10);
	ctx.lineTo(3.5, -5.5);
	ctx.lineTo(6, -1);
	ctx.lineTo(-5, -1);
	ctx.closePath();
	ctx.fillStyle = GOAL_FLAG_FILL;
	ctx.fill();
	ctx.stroke();
	ctx.restore();
}
