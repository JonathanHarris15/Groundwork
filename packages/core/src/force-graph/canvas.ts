import { masteryLabel } from "../mastery-tone";
import {
	highlightGradient,
	isGoalNode,
	paintGoalMark,
	PATH_BLUR,
	PATH_CORE_WIDTH,
	PATH_GLOW_OPACITY,
	PATH_GLOW_WIDTH,
	pathStrokeScale,
} from "./goal-mark";
import { createSimulationState, seedPositions, simulationTick } from "./simulation";
import { readGraphTheme, withAlpha, type GraphPaintTheme } from "./theme";
import type { ForceGraphData, ForceGraphLink, ForceGraphNode } from "./types";

export interface ForceGraphMountOptions {
	width?: number;
	height?: number;
	/** Initial fit after layout. */
	fit?: boolean;
	onNodeClick?: (nodeId: string) => void;
	onNodeHover?: (nodeId: string | null) => void;
	className?: string;
	/**
	 * When `"when-active"`, wheel zooms only after the learner clicks the map
	 * (host or nearest `.gw-graph` has `is-active`). Chat embeds use this so
	 * scrolling the lesson is not stolen. The full Map tab keeps `"always"`.
	 */
	captureWheel?: "always" | "when-active";
}

export interface ForceGraphHandle {
	fit(): void;
	zoomBy(factor: number, cx: number, cy: number): void;
	dispose(): void;
	setData(data: ForceGraphData): void;
	/** Rolling average frame rate (for harnesses). */
	getFps(): number;
	/** Current camera scale (for harnesses). */
	getScale(): number;
}

interface Camera {
	scale: number;
	tx: number;
	ty: number;
}

interface LabelLayout {
	x: number;
	y: number;
	alpha: number;
}

const MIN_SCALE = 0.08;
const MAX_SCALE = 8;
const LABEL_ZOOM_MIN = 0.45;
const LABEL_ZOOM_FULL = 1.05;
const LABEL_FONT_PX = 12;
/**
 * Wheel travel, in pixels, that doubles or halves the map.
 * A mouse notch is about 100px (~5%). A trackpad sends many small deltas,
 * so zoom follows finger travel instead of jumping 8% on every event.
 */
export const CONCEPT_MAP_WHEEL_PIXELS = 2000;
/** Fraction of queued wheel zoom applied each frame. The rest eases in. */
export const CONCEPT_MAP_WHEEL_EASE = 0.16;
const WHEEL_ZOOM_EPSILON = 0.0004;

/** Log-space zoom for one wheel event. Positive zooms in (scroll up). */
export function conceptMapWheelZoom(deltaY: number, deltaMode = 0, viewportHeight = 800): number {
	let pixels = deltaY;
	if (deltaMode === 1) pixels *= 40;
	else if (deltaMode === 2) pixels *= Math.max(1, viewportHeight);
	const clamped = Math.max(-280, Math.min(280, pixels));
	return -clamped / CONCEPT_MAP_WHEEL_PIXELS;
}

function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function mountForceGraph(host: HTMLElement, data: ForceGraphData, options: ForceGraphMountOptions = {}): ForceGraphHandle {
	const canvas = createEl("canvas");
	canvas.className = options.className ?? "gw-force-canvas";
	canvas.setAttribute("role", "img");
	canvas.setAttribute("aria-label", "Interactive concept graph");
	host.replaceChildren(canvas);

	const tip = createDiv();
	tip.className = "gw-force-tip";
	tip.hidden = true;
	host.append(tip);

	let nodes: ForceGraphNode[] = data.nodes.map(cloneNode);
	let links: ForceGraphLink[] = data.links.map((link) => ({ ...link }));
	let layoutMode: "force" | "layered" = data.layout ?? "force";
	const sim = createSimulationState();
	let width = options.width ?? (host.clientWidth || 640);
	let height = options.height ?? (host.clientHeight || 360);
	const camera: Camera = { scale: 1, tx: 0, ty: 0 };
	let hovered: string | null = null;
	let dragged: string | null = null;
	let panning = false;
	let lastX = 0;
	let lastY = 0;
	let downX = 0;
	let downY = 0;
	let panVx = 0;
	let panVy = 0;
	let lastMoveAt = 0;
	let wheelLog = 0;
	let wheelX = width / 2;
	let wheelY = height / 2;
	let raf = 0;
	let alive = true;
	let layoutFitted = false;
	let fpsFrames = 0;
	let fpsLast = performance.now();
	let fpsValue = 60;
	let neighborCache: Map<string, Set<string>> | null = null;
	let theme: GraphPaintTheme = readGraphTheme(host);
	const applyTipTheme = () => {
		tip.style.color = theme.tipText;
		tip.style.background = theme.tipBg;
		tip.style.borderColor = theme.tipBorder;
	};
	const refreshTheme = () => {
		theme = readGraphTheme(host);
		applyTipTheme();
	};
	applyTipTheme();
	host.addEventListener("groundwork-graph-theme", refreshTheme);
	const themeObserver = new MutationObserver(refreshTheme);
	themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

	const neighborsOf = () => {
		if (!neighborCache) {
			neighborCache = new Map();
			for (const link of links) {
				const a = neighborCache.get(link.from) ?? new Set();
				a.add(link.to);
				neighborCache.set(link.from, a);
				const b = neighborCache.get(link.to) ?? new Set();
				b.add(link.from);
				neighborCache.set(link.to, b);
			}
		}
		return neighborCache;
	};

	const invalidateNeighbors = () => {
		neighborCache = null;
	};

	const resize = () => {
		const rect = host.getBoundingClientRect();
		width = Math.max(120, Math.floor(rect.width));
		height = Math.max(120, Math.floor(rect.height));
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		canvas.width = Math.floor(width * dpr);
		canvas.height = Math.floor(height * dpr);
		const ctx = canvas.getContext("2d");
		if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	};

	const worldToScreen = (x: number, y: number) => ({
		x: x * camera.scale + camera.tx,
		y: y * camera.scale + camera.ty,
	});

	const screenToWorld = (x: number, y: number) => ({
		x: (x - camera.tx) / camera.scale,
		y: (y - camera.ty) / camera.scale,
	});

	const fit = () => {
		wheelLog = 0;
		if (!nodes.length) {
			camera.scale = 1;
			camera.tx = width / 2;
			camera.ty = height / 2;
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const node of nodes) {
			minX = Math.min(minX, node.x - node.radius - 12);
			maxX = Math.max(maxX, node.x + node.radius + 12);
			minY = Math.min(minY, node.y - node.radius - 12);
			maxY = Math.max(maxY, node.y + node.radius + 12);
		}
		const pad = 36;
		const bw = maxX - minX || 1;
		const bh = maxY - minY || 1;
		const scale = Math.min((width - pad * 2) / bw, (height - pad * 2) / bh, MAX_SCALE);
		camera.scale = Math.max(MIN_SCALE, scale);
		camera.tx = (width - (minX + maxX) * camera.scale) / 2;
		camera.ty = (height - (minY + maxY) * camera.scale) / 2;
		layoutFitted = true;
	};

	const pick = (clientX: number, clientY: number): string | null => {
		const rect = canvas.getBoundingClientRect();
		const w = screenToWorld(clientX - rect.left, clientY - rect.top);
		let best: string | null = null;
		let bestD = Infinity;
		for (const node of nodes) {
			const d = Math.hypot(node.x - w.x, node.y - w.y);
			const hit = node.radius + 8 / camera.scale;
			if (d <= hit && d < bestD) {
				bestD = d;
				best = node.id;
			}
		}
		return best;
	};

	const smoothstep = (edge0: number, edge1: number, x: number) => {
		const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
		return t * t * (3 - 2 * t);
	};

	const measureLabel = (ctx: CanvasRenderingContext2D, title: string) => {
		const text = title.length > 36 ? `${title.slice(0, 35)}…` : title;
		const w = ctx.measureText(text).width;
		return { text, w, h: LABEL_FONT_PX };
	};

	const layoutLabels = (ctx: CanvasRenderingContext2D): Map<string, LabelLayout> => {
		const out = new Map<string, LabelLayout>();
		const zoomFade = smoothstep(LABEL_ZOOM_MIN, LABEL_ZOOM_FULL, camera.scale);
		const neighbors = hovered ? neighborsOf().get(hovered) : null;
		const placed: Array<{ x: number; y: number; w: number; h: number }> = [];

		ctx.font = `${LABEL_FONT_PX}px Jost, system-ui, sans-serif`;
		const candidates: Array<{ node: ForceGraphNode; priority: number; alpha: number }> = [];
		for (const node of nodes) {
			const pinned = node.id === hovered || neighbors?.has(node.id);
			const alpha = pinned ? 1 : zoomFade * (node.label ? 1 : 0.65);
			if (!pinned && alpha < 0.04) continue;
			const priority = pinned ? 10_000 + node.radius : node.radius * 10 + (node.label ? 50 : 0);
			candidates.push({ node, priority, alpha });
		}
		candidates.sort((a, b) => b.priority - a.priority);

		for (const { node, alpha } of candidates) {
			const { w, h } = measureLabel(ctx, node.title);
			const base = worldToScreen(node.x, node.y + node.radius + 5);
			const offsets = [
				{ x: 0, y: 0 },
				{ x: 0, y: h + 2 },
				{ x: w * 0.35, y: 0 },
				{ x: -w * 0.35, y: 0 },
				{ x: 0, y: -(h + 6) },
			];
			let chosen = offsets[0];
			for (const off of offsets) {
				const box = {
					x: base.x - w / 2 + off.x,
					y: base.y + off.y,
					w,
					h,
				};
				const hit = placed.some(
					(p) => box.x < p.x + p.w + 2 && box.x + box.w + 2 > p.x && box.y < p.y + p.h + 2 && box.y + box.h + 2 > p.y,
				);
				if (!hit) {
					chosen = off;
					placed.push(box);
					break;
				}
			}
			out.set(node.id, { x: base.x + chosen.x, y: base.y + chosen.y, alpha });
		}
		return out;
	};

	const draw = () => {
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, width, height);
		const neighbors = hovered ? neighborsOf().get(hovered) : null;
		const fade = hovered != null;

		ctx.save();
		ctx.translate(camera.tx, camera.ty);
		ctx.scale(camera.scale, camera.scale);

		const byId = new Map(nodes.map((n) => [n.id, n]));
		const linkEnds = (link: ForceGraphLink, a: ForceGraphNode, b: ForceGraphNode) => {
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const len = Math.hypot(dx, dy) || 1;
			const ux = dx / len;
			const uy = dy / len;
			const insetStart = link.highlight ? a.radius : a.radius + 2;
			const insetEnd = link.highlight ? b.radius : b.radius + 4;
			return {
				ux,
				uy,
				start: { x: a.x + ux * insetStart, y: a.y + uy * insetStart },
				end: { x: b.x - ux * insetEnd, y: b.y - uy * insetEnd },
			};
		};
		const dimLink = (link: ForceGraphLink) =>
			fade && hovered !== link.from && hovered !== link.to && !neighbors?.has(link.from) && !neighbors?.has(link.to);

		let pathTop = Infinity;
		let pathBottom = -Infinity;
		for (const link of links) {
			if (!link.highlight) continue;
			const a = byId.get(link.from);
			const b = byId.get(link.to);
			if (!a || !b) continue;
			pathTop = Math.min(pathTop, a.y, b.y);
			pathBottom = Math.max(pathBottom, a.y, b.y);
		}
		const pathGradient = Number.isFinite(pathTop) ? highlightGradient(ctx, pathTop, pathBottom) : null;
		const pathScale = pathStrokeScale();

		for (const link of links) {
			if (link.highlight) continue;
			const a = byId.get(link.from);
			const b = byId.get(link.to);
			if (!a || !b) continue;
			const dim = dimLink(link);
			const { ux, uy, start, end } = linkEnds(link, a, b);
			ctx.beginPath();
			ctx.moveTo(start.x, start.y);
			ctx.lineTo(end.x, end.y);
			ctx.strokeStyle = link.bridge ? theme.linkBridge : theme.link;
			ctx.lineWidth = (link.bridge ? 1.1 : 1.7) / camera.scale;
			ctx.globalAlpha = dim ? 0.1 : 1;
			if (link.bridge) ctx.setLineDash([5 / camera.scale, 4 / camera.scale]);
			else ctx.setLineDash([]);
			ctx.stroke();
			ctx.setLineDash([]);
			const head = 5 / camera.scale;
			ctx.beginPath();
			ctx.moveTo(end.x, end.y);
			ctx.lineTo(end.x - ux * head - uy * head * 0.6, end.y - uy * head + ux * head * 0.6);
			ctx.lineTo(end.x - ux * head + uy * head * 0.6, end.y - uy * head - ux * head * 0.6);
			ctx.closePath();
			ctx.fillStyle = link.bridge ? theme.linkBridge : theme.link;
			ctx.globalAlpha = dim ? 0.1 : 1;
			ctx.fill();
		}

		if (pathGradient) {
			const k = pathScale;
			for (const link of links) {
				if (!link.highlight) continue;
				const a = byId.get(link.from);
				const b = byId.get(link.to);
				if (!a || !b) continue;
				const dim = dimLink(link);
				const { start, end } = linkEnds(link, a, b);
				ctx.save();
				ctx.setLineDash([]);
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				ctx.strokeStyle = pathGradient;
				ctx.beginPath();
				ctx.moveTo(start.x, start.y);
				ctx.lineTo(end.x, end.y);
				ctx.globalAlpha = (dim ? 0.1 : 1) * PATH_GLOW_OPACITY;
				ctx.lineWidth = PATH_GLOW_WIDTH * k;
				ctx.filter = `blur(${PATH_BLUR * k * camera.scale}px)`;
				ctx.stroke();
				ctx.filter = "none";
				ctx.globalAlpha = dim ? 0.1 : 1;
				ctx.lineWidth = PATH_CORE_WIDTH * k;
				ctx.stroke();
				ctx.restore();
			}
		}
		ctx.globalAlpha = 1;
		ctx.filter = "none";

		for (const node of nodes) {
			const dim = fade && node.id !== hovered && !neighbors?.has(node.id);
			const strength = node.faded ? 0.45 : 1;
			const color = (node.tone && theme.tones[node.tone]) || node.color;
			ctx.globalAlpha = (dim ? 0.16 : 1) * strength;
			const r = node.radius;
			if (isGoalNode(node)) {
				paintGoalMark(ctx, node.x, node.y, r);
				ctx.globalAlpha = 1;
				continue;
			}
			if (node.isNext) {
				ctx.beginPath();
				ctx.arc(node.x, node.y, r + 7, 0, Math.PI * 2);
				ctx.strokeStyle = withAlpha(theme.next, 0.9);
				ctx.lineWidth = 2 / camera.scale;
				ctx.stroke();
			} else if (node.needsAttention) {
				ctx.beginPath();
				ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
				ctx.strokeStyle = withAlpha(theme.warn, 0.75);
				ctx.lineWidth = 1.5 / camera.scale;
				ctx.setLineDash([4 / camera.scale, 3 / camera.scale]);
				ctx.stroke();
				ctx.setLineDash([]);
			}
			if (node.open) {
				ctx.beginPath();
				ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
				ctx.strokeStyle = color;
				ctx.lineWidth = 1.8 / camera.scale;
				ctx.setLineDash([3 / camera.scale, 2.5 / camera.scale]);
				ctx.stroke();
				ctx.setLineDash([]);
			} else {
				ctx.beginPath();
				ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
				ctx.fillStyle = color;
				ctx.globalAlpha = (dim ? 0.08 : 0.22) * strength;
				ctx.fill();
				ctx.globalAlpha = (dim ? 0.2 : 1) * strength;
				ctx.beginPath();
				ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
				ctx.fillStyle = color;
				ctx.fill();
				ctx.strokeStyle = withAlpha(theme.nodeRing, 0.85);
				ctx.lineWidth = 1.1 / camera.scale;
				ctx.stroke();
			}
			ctx.globalAlpha = 1;
		}
		ctx.restore();

		const labels = layoutLabels(ctx);
		ctx.save();
		ctx.font = `${LABEL_FONT_PX}px Jost, system-ui, sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (const node of nodes) {
			const layout = labels.get(node.id);
			if (!layout) continue;
			const { text } = measureLabel(ctx, node.title);
			ctx.globalAlpha = layout.alpha * (fade && node.id !== hovered && !neighbors?.has(node.id) ? 0.35 : 1) * (node.faded ? 0.7 : 1);
			ctx.fillStyle = theme.label;
			ctx.strokeStyle = theme.labelHalo;
			ctx.lineWidth = 3;
			ctx.lineJoin = "round";
			ctx.strokeText(text, layout.x, layout.y);
			ctx.fillText(text, layout.x, layout.y);
		}
		ctx.restore();
	};

	const tick = () => {
		if (!alive) return;
		const now = performance.now();
		fpsFrames += 1;
		if (now - fpsLast >= 1000) {
			fpsValue = fpsFrames;
			fpsFrames = 0;
			fpsLast = now;
		}

		if (!panning && !dragged && (Math.abs(panVx) > 0.2 || Math.abs(panVy) > 0.2)) {
			camera.tx += panVx;
			camera.ty += panVy;
			panVx *= 0.9;
			panVy *= 0.9;
		}

		if (Math.abs(wheelLog) >= WHEEL_ZOOM_EPSILON) {
			const step = wheelLog * (prefersReducedMotion() ? 1 : CONCEPT_MAP_WHEEL_EASE);
			wheelLog -= step;
			const beforeScale = camera.scale;
			zoomBy(Math.exp(step), wheelX, wheelY);
			if (camera.scale === beforeScale) wheelLog = 0;
		} else {
			wheelLog = 0;
		}

		const settling = layoutMode === "force" && (sim.alpha > 0.012 || dragged != null);
		if (nodes.length && settling) {
			simulationTick(nodes, links, sim, { width, height, dragId: dragged });
		} else if (!layoutFitted && options.fit !== false && (layoutMode === "layered" || sim.alpha < 0.025)) {
			fit();
		}

		draw();
		raf = window.requestAnimationFrame(tick);
	};

	const relayout = () => {
		invalidateNeighbors();
		if (layoutMode === "layered") {
			sim.alpha = 0;
			sim.tick = 0;
			layoutFitted = false;
			return;
		}
		seedPositions(nodes, width, height);
		sim.alpha = 1;
		sim.tick = 0;
		layoutFitted = false;
	};

	const setData = (next: ForceGraphData) => {
		layoutMode = next.layout ?? "force";
		nodes = next.nodes.map(cloneNode);
		links = next.links.map((link) => ({ ...link }));
		relayout();
	};

	resize();
	relayout();
	raf = window.requestAnimationFrame(tick);

	const ro = new ResizeObserver(() => {
		resize();
		if (options.fit !== false) window.requestAnimationFrame(() => fit());
	});
	ro.observe(host);

	const wheelMode = options.captureWheel ?? "always";
	const wheelActive = () =>
		wheelMode === "always" ||
		host.classList.contains("is-active") ||
		!!host.closest(".gw-graph.is-active");

	const onWheel = (e: WheelEvent) => {
		if (!wheelActive()) return;
		e.preventDefault();
		e.stopPropagation();
		const rect = canvas.getBoundingClientRect();
		wheelX = e.clientX - rect.left;
		wheelY = e.clientY - rect.top;
		const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
		wheelLog += conceptMapWheelZoom(delta, e.deltaMode, rect.height);
		wheelLog = Math.max(-1.2, Math.min(1.2, wheelLog));
	};

	const zoomBy = (factor: number, cx: number, cy: number) => {
		const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));
		if (next === camera.scale) return;
		const before = screenToWorld(cx, cy);
		camera.scale = next;
		const after = screenToWorld(cx, cy);
		camera.tx += (after.x - before.x) * camera.scale;
		camera.ty += (after.y - before.y) * camera.scale;
	};

	const zoomByNow = (factor: number, cx: number, cy: number) => {
		wheelLog = 0;
		zoomBy(factor, cx, cy);
	};

	const setHover = (id: string | null) => {
		if (hovered === id) return;
		hovered = id;
		options.onNodeHover?.(id);
		if (id) {
			const node = nodes.find((n) => n.id === id);
			if (node) {
				const lines = [node.title];
				if (node.status) lines.push(masteryLabel(node.status));
				if (node.actionHint) lines.push(node.actionHint);
				tip.textContent = lines.join(" · ");
			} else tip.textContent = "";
			tip.hidden = false;
		} else tip.hidden = true;
	};

	const activateWheel = () => {
		if (wheelMode !== "when-active") return;
		host.classList.add("is-active");
		host.closest(".gw-graph")?.classList.add("is-active");
	};

	const onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0) return;
		activateWheel();
		panVx = 0;
		panVy = 0;
		wheelLog = 0;
		const id = pick(e.clientX, e.clientY);
		lastX = e.clientX;
		lastY = e.clientY;
		downX = e.clientX;
		downY = e.clientY;
		lastMoveAt = performance.now();
		if (id) {
			dragged = id;
			const node = nodes.find((n) => n.id === id);
			if (node && layoutMode === "force") node.fixed = true;
			if (layoutMode === "force") sim.alpha = Math.max(sim.alpha, 0.55);
			canvas.setPointerCapture(e.pointerId);
			host.classList.add("is-dragging-node");
		} else {
			panning = true;
			canvas.setPointerCapture(e.pointerId);
			host.classList.add("is-panning");
		}
	};

	const onPointerMove = (e: PointerEvent) => {
		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;
		const dt = Math.max(8, performance.now() - lastMoveAt);
		lastMoveAt = performance.now();
		lastX = e.clientX;
		lastY = e.clientY;
		if (dragged) {
			const node = nodes.find((n) => n.id === dragged);
			if (node) {
				const rect = canvas.getBoundingClientRect();
				const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
				node.x = w.x;
				node.y = w.y;
				node.vx = 0;
				node.vy = 0;
				if (layoutMode === "force") sim.alpha = Math.max(sim.alpha, 0.5);
			}
			return;
		}
		if (panning) {
			camera.tx += dx;
			camera.ty += dy;
			panVx = (dx / dt) * 14;
			panVy = (dy / dt) * 14;
			return;
		}
		setHover(pick(e.clientX, e.clientY));
	};

	const endPointer = (e: PointerEvent) => {
		const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
		if (dragged) {
			const node = nodes.find((n) => n.id === dragged);
			if (node && layoutMode === "force") node.fixed = false;
			if (moved < 6) options.onNodeClick?.(dragged);
			dragged = null;
			if (layoutMode === "force") sim.alpha = Math.max(sim.alpha, 0.35);
		}
		panning = false;
		host.classList.remove("is-dragging-node", "is-panning");
		if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
	};

	const deactivateWheel = (e: PointerEvent | KeyboardEvent) => {
		if (wheelMode !== "when-active") return;
		if (e instanceof KeyboardEvent) {
			if (e.key !== "Escape") return;
		} else if (host.contains(e.target as Node) || host.closest(".gw-graph")?.contains(e.target as Node)) {
			return;
		}
		host.classList.remove("is-active");
		host.closest(".gw-graph")?.classList.remove("is-active");
	};

	canvas.addEventListener("wheel", onWheel, { passive: false });
	canvas.addEventListener("pointerdown", onPointerDown);
	canvas.addEventListener("pointermove", onPointerMove);
	canvas.addEventListener("pointerup", endPointer);
	canvas.addEventListener("pointercancel", endPointer);
	canvas.addEventListener("pointerleave", () => setHover(null));
	if (wheelMode === "when-active") {
		document.addEventListener("pointerdown", deactivateWheel, true);
		document.addEventListener("keydown", deactivateWheel, true);
	}

	return {
		fit,
		zoomBy: zoomByNow,
		setData,
		getFps: () => fpsValue,
		getScale: () => camera.scale,
		dispose: () => {
			alive = false;
			window.cancelAnimationFrame(raf);
			themeObserver.disconnect();
			host.removeEventListener("groundwork-graph-theme", refreshTheme);
			ro.disconnect();
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("pointerdown", onPointerDown);
			canvas.removeEventListener("pointermove", onPointerMove);
			canvas.removeEventListener("pointerup", endPointer);
			canvas.removeEventListener("pointercancel", endPointer);
			if (wheelMode === "when-active") {
				document.removeEventListener("pointerdown", deactivateWheel, true);
				document.removeEventListener("keydown", deactivateWheel, true);
			}
			host.classList.remove("is-active");
			host.closest(".gw-graph")?.classList.remove("is-active");
			host.replaceChildren();
		},
	};
}

function cloneNode(node: ForceGraphNode): ForceGraphNode {
	return { ...node, vx: 0, vy: 0, fixed: false };
}
