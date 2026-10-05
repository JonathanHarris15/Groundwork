import { createSimulationState, runSimulation, simulationTick } from "./simulation";
import type { ForceGraphData, ForceGraphLink, ForceGraphNode } from "./types";

export interface ForceGraphMountOptions {
	width?: number;
	height?: number;
	/** Initial fit after layout. */
	fit?: boolean;
	onNodeClick?: (nodeId: string) => void;
	onNodeHover?: (nodeId: string | null) => void;
	className?: string;
}

export interface ForceGraphHandle {
	fit(): void;
	zoomBy(factor: number, cx: number, cy: number): void;
	dispose(): void;
	setData(data: ForceGraphData): void;
}

interface Camera {
	scale: number;
	tx: number;
	ty: number;
}

const MIN_SCALE = 0.12;
const MAX_SCALE = 6;

export function mountForceGraph(host: HTMLElement, data: ForceGraphData, options: ForceGraphMountOptions = {}): ForceGraphHandle {
	const canvas = document.createElement("canvas");
	canvas.className = options.className ?? "gw-force-canvas";
	canvas.setAttribute("role", "img");
	canvas.setAttribute("aria-label", "Interactive concept graph");
	host.replaceChildren(canvas);

	const tip = document.createElement("div");
	tip.className = "gw-force-tip";
	tip.hidden = true;
	host.append(tip);

	let nodes: ForceGraphNode[] = data.nodes.map(cloneNode);
	let links: ForceGraphLink[] = data.links.map((link) => ({ ...link }));
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
	let raf = 0;
	let alive = true;
	let labelZoom = 0.85;

	const neighborMap = () => {
		const out = new Map<string, Set<string>>();
		for (const link of links) {
			const a = out.get(link.from) ?? new Set();
			a.add(link.to);
			out.set(link.from, a);
			const b = out.get(link.to) ?? new Set();
			b.add(link.from);
			out.set(link.to, b);
		}
		return out;
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
			minX = Math.min(minX, node.x - node.radius - 8);
			maxX = Math.max(maxX, node.x + node.radius + 8);
			minY = Math.min(minY, node.y - node.radius - 8);
			maxY = Math.max(maxY, node.y + node.radius + 8);
		}
		const pad = 28;
		const bw = maxX - minX || 1;
		const bh = maxY - minY || 1;
		const scale = Math.min((width - pad * 2) / bw, (height - pad * 2) / bh, MAX_SCALE);
		camera.scale = Math.max(MIN_SCALE, scale);
		camera.tx = (width - (minX + maxX) * camera.scale) / 2;
		camera.ty = (height - (minY + maxY) * camera.scale) / 2;
	};

	const pick = (clientX: number, clientY: number): string | null => {
		const rect = canvas.getBoundingClientRect();
		const w = screenToWorld(clientX - rect.left, clientY - rect.top);
		let best: string | null = null;
		let bestD = Infinity;
		for (const node of nodes) {
			const d = Math.hypot(node.x - w.x, node.y - w.y);
			const hit = node.radius + 6 / camera.scale;
			if (d <= hit && d < bestD) {
				bestD = d;
				best = node.id;
			}
		}
		return best;
	};

	const draw = () => {
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, width, height);
		const neighbors = hovered ? neighborMap().get(hovered) : null;
		const fade = hovered != null;

		ctx.save();
		ctx.translate(camera.tx, camera.ty);
		ctx.scale(camera.scale, camera.scale);

		const byId = new Map(nodes.map((n) => [n.id, n]));
		for (const link of links) {
			const a = byId.get(link.from);
			const b = byId.get(link.to);
			if (!a || !b) continue;
			const dim =
				fade && hovered !== link.from && hovered !== link.to && !neighbors?.has(link.from) && !neighbors?.has(link.to);
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const len = Math.hypot(dx, dy) || 1;
			const ux = dx / len;
			const uy = dy / len;
			const start = { x: a.x + ux * (a.radius + 2), y: a.y + uy * (a.radius + 2) };
			const end = { x: b.x - ux * (b.radius + 4), y: b.y - uy * (b.radius + 4) };
			ctx.beginPath();
			ctx.moveTo(start.x, start.y);
			ctx.lineTo(end.x, end.y);
			ctx.strokeStyle = link.bridge ? "rgba(127,132,142,0.45)" : "rgba(127,132,142,0.7)";
			ctx.lineWidth = (link.bridge ? 1.2 : 1.6) / camera.scale;
			ctx.globalAlpha = dim ? 0.12 : 1;
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
			ctx.fillStyle = link.bridge ? "rgba(127,132,142,0.45)" : "rgba(127,132,142,0.7)";
			ctx.fill();
		}
		ctx.globalAlpha = 1;

		const showLabels = camera.scale >= labelZoom;
		for (const node of nodes) {
			const dim = fade && node.id !== hovered && !neighbors?.has(node.id);
			ctx.globalAlpha = dim ? 0.18 : 1;
			const r = node.radius;
			if (node.isNext) {
				ctx.beginPath();
				ctx.arc(node.x, node.y, r + 7, 0, Math.PI * 2);
				ctx.strokeStyle = "rgba(69, 169, 240, 0.85)";
				ctx.lineWidth = 2 / camera.scale;
				ctx.stroke();
			} else if (node.needsAttention) {
				ctx.beginPath();
				ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
				ctx.strokeStyle = "rgba(247, 169, 62, 0.75)";
				ctx.lineWidth = 1.5 / camera.scale;
				ctx.setLineDash([4 / camera.scale, 3 / camera.scale]);
				ctx.stroke();
				ctx.setLineDash([]);
			}
			if (node.open) {
				ctx.beginPath();
				ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2);
				ctx.strokeStyle = node.color;
				ctx.lineWidth = 1.6 / camera.scale;
				ctx.stroke();
			} else {
				ctx.beginPath();
				ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
				ctx.fillStyle = node.color;
				ctx.globalAlpha = dim ? 0.1 : 0.2;
				ctx.fill();
				ctx.globalAlpha = dim ? 0.22 : 1;
				ctx.beginPath();
				ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
				ctx.fillStyle = node.color;
				ctx.fill();
				ctx.strokeStyle = "rgba(255,255,255,0.85)";
				ctx.lineWidth = 1.1 / camera.scale;
				ctx.stroke();
			}
			if (node.isTarget && !node.isBuiltTarget) {
				ctx.beginPath();
				ctx.moveTo(node.x, node.y - r - 5);
				ctx.lineTo(node.x + r + 4, node.y);
				ctx.lineTo(node.x, node.y + r + 5);
				ctx.lineTo(node.x - r - 4, node.y);
				ctx.closePath();
				ctx.strokeStyle = node.color;
				ctx.lineWidth = 1.8 / camera.scale;
				ctx.stroke();
			}
			if (showLabels && (node.label || node.id === hovered)) {
				ctx.font = `${12 / camera.scale}px Jost, system-ui, sans-serif`;
				ctx.fillStyle = "rgba(230,232,236,0.95)";
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				const title = node.title.length > 32 ? `${node.title.slice(0, 31)}…` : node.title;
				ctx.fillText(title, node.x, node.y + r + 6 / camera.scale);
			}
			ctx.globalAlpha = 1;
		}
		ctx.restore();
	};

	const tick = () => {
		if (!alive) return;
		if (nodes.length && sim.alpha > 0.02 && !dragged) {
			simulationTick(nodes, links, sim, { width, height });
		}
		draw();
		raf = window.requestAnimationFrame(tick);
	};

	const relayout = () => {
		sim.alpha = 1;
		runSimulation(nodes, links, { width, height }, 180);
		if (options.fit !== false) fit();
	};

	const setData = (next: ForceGraphData) => {
		nodes = next.nodes.map(cloneNode);
		links = next.links.map((link) => ({ ...link }));
		relayout();
	};

	resize();
	relayout();
	raf = window.requestAnimationFrame(tick);

	const ro = new ResizeObserver(() => {
		resize();
		if (options.fit !== false) fit();
	});
	ro.observe(host);

	const onWheel = (e: WheelEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const rect = canvas.getBoundingClientRect();
		const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
		zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
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

	const setHover = (id: string | null) => {
		if (hovered === id) return;
		hovered = id;
		options.onNodeHover?.(id);
		if (id) {
			const node = nodes.find((n) => n.id === id);
			if (node) {
				const lines = [node.title];
				if (node.status) lines.push(statusLabel(node.status));
				if (node.actionHint) lines.push(node.actionHint);
				tip.textContent = lines.join(" · ");
			} else tip.textContent = "";
			tip.hidden = false;
		} else tip.hidden = true;
	};

	const onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0) return;
		const rect = canvas.getBoundingClientRect();
		const id = pick(e.clientX, e.clientY);
		lastX = e.clientX;
		lastY = e.clientY;
		downX = e.clientX;
		downY = e.clientY;
		if (id) {
			dragged = id;
			const node = nodes.find((n) => n.id === id);
			if (node) node.fixed = true;
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
				sim.alpha = 0.35;
			}
			return;
		}
		if (panning) {
			camera.tx += dx;
			camera.ty += dy;
			return;
		}
		setHover(pick(e.clientX, e.clientY));
	};

	const endPointer = (e: PointerEvent) => {
		const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
		if (dragged) {
			const node = nodes.find((n) => n.id === dragged);
			if (node) node.fixed = false;
			if (moved < 6) options.onNodeClick?.(dragged);
			dragged = null;
		}
		panning = false;
		host.classList.remove("is-dragging-node", "is-panning");
		if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
	};

	canvas.addEventListener("wheel", onWheel, { passive: false });
	canvas.addEventListener("pointerdown", onPointerDown);
	canvas.addEventListener("pointermove", onPointerMove);
	canvas.addEventListener("pointerup", endPointer);
	canvas.addEventListener("pointercancel", endPointer);
	canvas.addEventListener("pointerleave", () => setHover(null));

	return {
		fit,
		zoomBy,
		setData,
		dispose: () => {
			alive = false;
			window.cancelAnimationFrame(raf);
			ro.disconnect();
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("pointerdown", onPointerDown);
			canvas.removeEventListener("pointermove", onPointerMove);
			canvas.removeEventListener("pointerup", endPointer);
			canvas.removeEventListener("pointercancel", endPointer);
			host.replaceChildren();
		},
	};
}

function cloneNode(node: ForceGraphNode): ForceGraphNode {
	return { ...node, vx: 0, vy: 0, fixed: false };
}

function statusLabel(status: NonNullable<ForceGraphNode["status"]>): string {
	if (status === "solid") return "Solid";
	if (status === "learning") return "Learning";
	if (status === "shaky") return "Shaky";
	if (status === "rusty") return "Rusty";
	return "Not quizzed";
}
