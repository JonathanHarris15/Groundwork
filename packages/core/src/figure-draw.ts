import { landRings } from "./figure-land";
import type { FigureSpec } from "./figure";

const PAPER = "#f6f3ec";
const INK = "#1c1915";
const MUTED = "#5c564c";
const HAIR = "#d9d2c6";
const GRID = "#e7e1d6";
const SERIES = ["#1d6aab", "#1d7a56", "#a33b3b", "#8a5a12", "#5b4b8a", "#0f6e78"];
const SIDES = ["#1d6aab", "#a33b3b", "#1d7a56", "#8a5a12", "#5b4b8a"];

export function drawFigure(spec: FigureSpec): string {
	switch (spec.kind) {
		case "plot":
			return drawPlot(spec);
		case "plot3d":
			return drawPlot3d(spec);
		case "story":
			return drawStory(spec);
		case "map":
			return drawMap(spec);
		case "conjugation":
			return drawConjugation(spec);
		case "sentence":
			return drawSentence(spec);
	}
}

function svg(w: number, h: number, title: string, body: string, attrs = ""): string {
	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"${attrs ? ` ${attrs}` : ""}>`,
		`<title>${esc(title)}</title>`,
		`<rect width="${w}" height="${h}" fill="${PAPER}"/>`,
		body,
		`</svg>`,
	].join("");
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function text(x: number, y: number, value: string, opts: { size?: number; anchor?: "start" | "middle" | "end"; fill?: string; weight?: number } = {}): string {
	const size = opts.size ?? 13;
	const anchor = opts.anchor ?? "start";
	const fill = opts.fill ?? INK;
	const weight = opts.weight ?? 500;
	return `<text x="${n(x)}" y="${n(y)}" fill="${fill}" font-family="Jost, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(value)}</text>`;
}

function n(v: number): string {
	if (!Number.isFinite(v)) return "0";
	return String(Math.round(v * 10) / 10);
}

function drawPlot(spec: Extract<FigureSpec, { kind: "plot" }>): string {
	const w = 640;
	const captionH = spec.caption ? 20 : 0;
	const h = 400 + captionH;
	const left = 58;
	const right = 24;
	const top = spec.series.some((s) => s.name) ? 64 : 46;
	const bottom = 46 + captionH;
	const series = spec.series.map((s, i) => ({
		name: s.name?.trim() || "",
		mark: s.mark ?? "line",
		color: SERIES[i % SERIES.length],
		points: s.points,
		breaks: s.breaks ?? [],
	}));
	let x0 = spec.xMin ?? Infinity;
	let x1 = spec.xMax ?? -Infinity;
	let y0 = spec.yMin ?? Infinity;
	let y1 = spec.yMax ?? -Infinity;
	const autoX = spec.xMin === undefined || spec.xMax === undefined;
	const autoY = spec.yMin === undefined || spec.yMax === undefined;
	if (autoX || autoY) {
		const xs: number[] = [];
		const ys: number[] = [];
		for (const s of series) {
			for (const [x, y] of s.points) {
				if (Number.isFinite(x)) xs.push(x);
				if (Number.isFinite(y)) ys.push(y);
			}
		}
		if (autoX) {
			x0 = Math.min(...xs);
			x1 = Math.max(...xs);
		}
		if (autoY) {
			const span = yLimits(ys.filter((y) => Number.isFinite(y)));
			y0 = span.min;
			y1 = span.max;
		}
	}
	if (!(x1 > x0)) {
		x0 -= 1;
		x1 += 1;
	}
	if (!(y1 > y0)) {
		y0 -= 1;
		y1 += 1;
	}
	if (autoX) {
		const pad = (x1 - x0) * 0.04;
		x0 -= pad;
		x1 += pad;
	}
	if (autoY) {
		const pad = (y1 - y0) * 0.08 || 1;
		y0 -= pad;
		y1 += pad;
	}
	const px = (x: number) => left + ((x - x0) / (x1 - x0)) * (w - left - right);
	const py = (y: number) => top + (1 - (y - y0) / (y1 - y0)) * (h - top - bottom);
	const parts: string[] = [];
	parts.push(text(left, 28, spec.title, { size: 16, weight: 600 }));
	const ticks = 5;
	for (let i = 0; i < ticks; i++) {
		const tx = x0 + ((x1 - x0) * i) / (ticks - 1);
		const ty = y0 + ((y1 - y0) * i) / (ticks - 1);
		const xx = px(tx);
		const yy = py(ty);
		parts.push(`<line x1="${n(xx)}" y1="${top}" x2="${n(xx)}" y2="${h - bottom}" stroke="${GRID}" stroke-width="1"/>`);
		parts.push(`<line x1="${left}" y1="${n(yy)}" x2="${w - right}" y2="${n(yy)}" stroke="${GRID}" stroke-width="1"/>`);
		parts.push(text(xx, h - bottom + 16, formatTick(tx), { size: 11, anchor: "middle", fill: MUTED, weight: 400 }));
		parts.push(text(left - 8, yy + 4, formatTick(ty), { size: 11, anchor: "end", fill: MUTED, weight: 400 }));
	}
	parts.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${h - bottom}" stroke="${INK}" stroke-width="1.2"/>`);
	parts.push(`<line x1="${left}" y1="${h - bottom}" x2="${w - right}" y2="${h - bottom}" stroke="${INK}" stroke-width="1.2"/>`);
	if (spec.xLabel) parts.push(text((left + w - right) / 2, h - captionH - 8, spec.xLabel, { size: 12, anchor: "middle", fill: MUTED, weight: 400 }));
	if (spec.yLabel) {
		const yMid = (top + h - bottom) / 2;
		parts.push(
			`<text x="16" y="${n(yMid)}" fill="${MUTED}" font-family="Jost, sans-serif" font-size="12" text-anchor="middle" transform="rotate(-90 16 ${n(yMid)})">${esc(spec.yLabel)}</text>`,
		);
	}
	series.forEach((s) => {
		if (s.mark === "bar") {
			const span = (w - left - right) / Math.max(series[0].points.length, 1);
			const width = Math.max(4, span * 0.62);
			for (const [x, y] of s.points) {
				if (!Number.isFinite(y)) continue;
				const cx = px(x);
				const yv = Math.min(y1, Math.max(y0, y));
				const topY = py(yv);
				const base = py(Math.min(y1, Math.max(y0, 0 >= y0 && 0 <= y1 ? 0 : y0)));
				const yRect = Math.min(topY, base);
				const bh = Math.abs(base - topY);
				parts.push(`<rect x="${n(cx - width / 2)}" y="${n(yRect)}" width="${n(width)}" height="${n(Math.max(bh, 1))}" fill="${s.color}" opacity="0.9"/>`);
			}
			return;
		}
		const drawn = s.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= x0 && x <= x1 && y >= y0 && y <= y1);
		if (s.mark === "line") {
			for (const seg of curveSegments(s.points, s.breaks, x0, x1, y0, y1)) {
				if (seg.length < 2) continue;
				const d = seg.map((p, i) => `${i ? "L" : "M"}${n(px(p[0]))} ${n(py(p[1]))}`).join(" ");
				parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`);
			}
		}
		if (s.mark === "scatter" || (s.mark === "line" && drawn.length < 24)) {
			for (const [x, y] of drawn) {
				parts.push(`<circle cx="${n(px(x))}" cy="${n(py(y))}" r="3.2" fill="${PAPER}" stroke="${s.color}" stroke-width="1.6"/>`);
			}
		}
	});
	const named = series.filter((s) => s.name);
	named.forEach((s, i) => {
		const x = w - right - 140;
		const y = 22 + i * 16;
		parts.push(`<line x1="${x}" y1="${y - 4}" x2="${x + 16}" y2="${y - 4}" stroke="${s.color}" stroke-width="2.2"/>`);
		parts.push(text(x + 22, y, s.name, { size: 12, fill: MUTED, weight: 400 }));
	});
	if (spec.caption) parts.push(text(left, h - 8, spec.caption, { size: 12, fill: MUTED, weight: 400 }));
	const plotW = w - left - right;
	const plotH = h - top - bottom;
	const frame = `data-x0="${x0}" data-x1="${x1}" data-y0="${y0}" data-y1="${y1}" data-left="${left}" data-top="${top}" data-plot-width="${plotW}" data-plot-height="${plotH}"`;
	return svg(w, h, spec.title, parts.join(""), frame);
}

function drawPlot3d(spec: Extract<FigureSpec, { kind: "plot3d" }>): string {
	const w = 640;
	const h = 460;
	const grid = spec.grid;
	let zMin = Infinity;
	let zMax = -Infinity;
	for (const row of grid) {
		for (const z of row) {
			if (!Number.isFinite(z)) continue;
			zMin = Math.min(zMin, z);
			zMax = Math.max(zMax, z);
		}
	}
	if (!(zMax > zMin)) {
		zMin -= 1;
		zMax += 1;
	}
	const rows = grid.length;
	const cols = grid[0].length;
	const xMin = spec.xMin;
	const xMax = spec.xMax;
	const yMin = spec.yMin;
	const yMax = spec.yMax;
	const yaw = -0.6;
	const pitch = 0.62;
	const project = (x: number, y: number, z: number) => {
		const x1 = x * Math.cos(yaw) - y * Math.sin(yaw);
		const y1 = x * Math.sin(yaw) + y * Math.cos(yaw);
		const y2 = y1 * Math.cos(pitch) - z * Math.sin(pitch);
		const z2 = y1 * Math.sin(pitch) + z * Math.cos(pitch);
		return { sx: x1, sy: -z2, depth: y2 };
	};
	type Quad = { d: string; depth: number; z: number };
	const quads: Quad[] = [];
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	const placed: Array<Array<{ sx: number; sy: number; depth: number } | null>> = [];
	for (let r = 0; r < rows; r++) {
		placed[r] = [];
		for (let c = 0; c < cols; c++) {
			const z = grid[r][c];
			if (!Number.isFinite(z)) {
				placed[r][c] = null;
				continue;
			}
			const x = xMin + ((xMax - xMin) * c) / (cols - 1);
			const y = yMin + ((yMax - yMin) * r) / (rows - 1);
			const p = project(x, y, z);
			placed[r][c] = p;
			minX = Math.min(minX, p.sx);
			maxX = Math.max(maxX, p.sx);
			minY = Math.min(minY, p.sy);
			maxY = Math.max(maxY, p.sy);
		}
	}
	const spanX = maxX - minX || 1;
	const spanY = maxY - minY || 1;
	const plotW = w - 80;
	const plotH = h - 100;
	const scale = Math.min(plotW / spanX, plotH / spanY);
	const ox = 40 + (plotW - spanX * scale) / 2 - minX * scale;
	const oy = 56 + (plotH - spanY * scale) / 2 - minY * scale;
	const map = (p: { sx: number; sy: number }) => ({ x: ox + p.sx * scale, y: oy + p.sy * scale });
	for (let r = 0; r < rows - 1; r++) {
		for (let c = 0; c < cols - 1; c++) {
			const a = placed[r][c];
			const b = placed[r][c + 1];
			const d = placed[r + 1][c];
			const e = placed[r + 1][c + 1];
			if (!a || !b || !d || !e) continue;
			const pa = map(a);
			const pb = map(b);
			const pd = map(d);
			const pe = map(e);
			const z = (grid[r][c] + grid[r][c + 1] + grid[r + 1][c] + grid[r + 1][c + 1]) / 4;
			quads.push({
				d: `M${n(pa.x)} ${n(pa.y)} L${n(pb.x)} ${n(pb.y)} L${n(pe.x)} ${n(pe.y)} L${n(pd.x)} ${n(pd.y)} Z`,
				depth: (a.depth + b.depth + d.depth + e.depth) / 4,
				z,
			});
		}
	}
	quads.sort((p, q) => p.depth - q.depth);
	const parts: string[] = [];
	parts.push(text(28, 28, spec.title, { size: 16, weight: 600 }));
	for (const q of quads) {
		const t = (q.z - zMin) / (zMax - zMin);
		parts.push(`<path d="${q.d}" fill="${ramp(t)}" stroke="${INK}" stroke-opacity="0.18" stroke-width="0.4"/>`);
	}
	const labels = [spec.xLabel, spec.yLabel, spec.zLabel].filter(Boolean).join("  ·  ");
	if (labels) parts.push(text(28, h - 28, labels, { size: 12, fill: MUTED, weight: 400 }));
	if (spec.caption) parts.push(text(28, h - 12, spec.caption, { size: 12, fill: MUTED, weight: 400 }));
	return svg(w, h, spec.title, parts.join(""));
}

function ramp(t: number): string {
	const u = Math.min(1, Math.max(0, t));
	const a = [214, 228, 240];
	const b = [29, 106, 171];
	const c = a.map((v, i) => Math.round(v + (b[i] - v) * u));
	return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const STAGE_HEIGHT: Record<string, number> = {
	exposition: 0.18,
	rising: 0.58,
	climax: 0.96,
	falling: 0.46,
	resolution: 0.16,
};

function drawStory(spec: Extract<FigureSpec, { kind: "story" }>): string {
	const w = 680;
	const h = 400;
	const left = 36;
	const right = 36;
	const base = 300;
	const top = 78;
	const beats = spec.beats;
	const pts = beats.map((b, i) => {
		const x = left + (beats.length === 1 ? (w - left - right) / 2 : ((w - left - right) * i) / (beats.length - 1));
		const height = STAGE_HEIGHT[b.stage] ?? 0.4;
		const y = base - height * (base - top);
		return { ...b, x, y };
	});
	const parts: string[] = [];
	parts.push(text(left, 32, spec.title, { size: 16, weight: 600 }));
	let d = `M ${n(pts[0].x)} ${n(base)}`;
	pts.forEach((p, i) => {
		if (i === 0) d += ` L ${n(p.x)} ${n(p.y)}`;
		else {
			const prev = pts[i - 1];
			const mx = (prev.x + p.x) / 2;
			d += ` C ${n(mx)} ${n(prev.y)}, ${n(mx)} ${n(p.y)}, ${n(p.x)} ${n(p.y)}`;
		}
	});
	const last = pts[pts.length - 1];
	const fill = `${d} L ${n(last.x)} ${n(base)} Z`;
	parts.push(`<path d="${fill}" fill="#1d6aab" opacity="0.1"/>`);
	parts.push(`<path d="${d}" fill="none" stroke="#1d6aab" stroke-width="2.4" stroke-linejoin="round"/>`);
	parts.push(`<line x1="${left}" y1="${base}" x2="${w - right}" y2="${base}" stroke="${HAIR}" stroke-width="1"/>`);
	for (const p of pts) {
		const climax = p.stage === "climax";
		parts.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${climax ? 6 : 4.5}" fill="${climax ? "#8a5a12" : PAPER}" stroke="${climax ? "#8a5a12" : "#1d6aab"}" stroke-width="2"/>`);
		const stage = stageName(p.stage);
		parts.push(text(p.x, p.y - 14, stage, { size: 11, anchor: "middle", fill: climax ? "#8a5a12" : MUTED, weight: 600 }));
		const lines = wrapLabel(p.label, 18);
		lines.forEach((line, i) => {
			parts.push(text(p.x, base + 22 + i * 14, line, { size: 12, anchor: "middle", weight: 400 }));
		});
	}
	if (spec.caption) parts.push(text(left, h - 12, spec.caption, { size: 12, fill: MUTED, weight: 400 }));
	return svg(w, h, spec.title, parts.join(""));
}

function stageName(stage: string): string {
	if (stage === "rising") return "Rising action";
	if (stage === "falling") return "Falling action";
	return stage.slice(0, 1).toUpperCase() + stage.slice(1);
}

function wrapLabel(value: string, max: number): string[] {
	const words = value.split(/\s+/);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const next = line ? `${line} ${word}` : word;
		if (next.length > max && line) {
			lines.push(line);
			line = word;
		} else line = next;
		if (lines.length === 2) break;
	}
	if (lines.length < 3 && line) lines.push(line);
	return lines.slice(0, 3);
}

function drawMap(spec: Extract<FigureSpec, { kind: "map" }>): string {
	const w = 720;
	const h = 460;
	const margin = 28;
	const bounds = mapBounds(spec.markers);
	const project = (lon: number, lat: number) => {
		const x = margin + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (w - margin * 2);
		const y = 48 + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * (h - 48 - 56);
		return [x, y] as const;
	};
	const parts: string[] = [];
	parts.push(text(margin, 30, spec.title, { size: 16, weight: 600 }));
	for (let lon = Math.ceil(bounds.minLon / 30) * 30; lon < bounds.maxLon; lon += 30) {
		const [x] = project(lon, bounds.minLat);
		parts.push(`<line x1="${n(x)}" y1="48" x2="${n(x)}" y2="${h - 56}" stroke="${GRID}" stroke-width="1"/>`);
	}
	for (let lat = Math.ceil(bounds.minLat / 30) * 30; lat < bounds.maxLat; lat += 30) {
		const [, y] = project(bounds.minLon, lat);
		parts.push(`<line x1="${margin}" y1="${n(y)}" x2="${w - margin}" y2="${n(y)}" stroke="${GRID}" stroke-width="1"/>`);
	}
	for (const ring of landRings()) {
		const d = ring
			.map(([lon, lat], i) => {
				const [x, y] = project(lon, lat);
				return `${i ? "L" : "M"}${n(x)} ${n(y)}`;
			})
			.join(" ");
		parts.push(`<path d="${d} Z" fill="#e4ddd0" stroke="#8a8478" stroke-width="0.8" stroke-linejoin="round"/>`);
	}
	const sideColor = new Map<string, string>();
	const colorFor = (side: string | undefined) => {
		const key = side?.trim() || "";
		if (!key) return INK;
		const existing = sideColor.get(key);
		if (existing) return existing;
		const color = SIDES[sideColor.size % SIDES.length];
		sideColor.set(key, color);
		return color;
	};
	const at = new Map<string, readonly [number, number]>();
	for (const m of spec.markers) at.set(m.name, project(m.lon, m.lat));
	for (const move of spec.movements ?? []) {
		const a = at.get(move.from);
		const b = at.get(move.to);
		if (!a || !b) continue;
		const mx = (a[0] + b[0]) / 2;
		const my = (a[1] + b[1]) / 2 - 28;
		const id = `arrow-${parts.length}`;
		parts.push(`<defs><marker id="${id}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6 Z" fill="${INK}"/></marker></defs>`);
		parts.push(`<path d="M${n(a[0])} ${n(a[1])} Q${n(mx)} ${n(my)} ${n(b[0])} ${n(b[1])}" fill="none" stroke="${INK}" stroke-width="1.4" marker-end="url(#${id})"/>`);
		if (move.label) parts.push(text(mx, my - 6, move.label, { size: 11, anchor: "middle", fill: MUTED, weight: 400 }));
	}
	for (const m of spec.markers) {
		const [x, y] = at.get(m.name)!;
		const color = colorFor(m.side);
		parts.push(`<circle cx="${n(x)}" cy="${n(y)}" r="5" fill="${color}" stroke="${PAPER}" stroke-width="1.5"/>`);
		parts.push(text(x + 8, y - 8, m.name, { size: 12, weight: 600 }));
	}
	let legendX = margin;
	for (const [side, color] of sideColor) {
		parts.push(`<circle cx="${legendX + 5}" cy="${h - 24}" r="4.5" fill="${color}"/>`);
		parts.push(text(legendX + 14, h - 20, side, { size: 12, weight: 500 }));
		legendX += 14 + side.length * 7 + 18;
	}
	if (spec.caption) parts.push(text(w - margin, h - 20, spec.caption, { size: 12, anchor: "end", fill: MUTED, weight: 400 }));
	return svg(w, h, spec.title, parts.join(""));
}

function mapBounds(markers: { lat: number; lon: number }[]): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
	if (!markers.length) return { minLon: -180, maxLon: 180, minLat: -58, maxLat: 80 };
	let minLon = Infinity;
	let maxLon = -Infinity;
	let minLat = Infinity;
	let maxLat = -Infinity;
	for (const m of markers) {
		minLon = Math.min(minLon, m.lon);
		maxLon = Math.max(maxLon, m.lon);
		minLat = Math.min(minLat, m.lat);
		maxLat = Math.max(maxLat, m.lat);
	}
	const dLon = maxLon - minLon;
	const dLat = maxLat - minLat;
	if (dLon > 140 || dLat > 80) return { minLon: -180, maxLon: 180, minLat: -58, maxLat: 80 };
	const padLon = Math.max(8, dLon * 0.35);
	const padLat = Math.max(6, dLat * 0.45);
	return {
		minLon: Math.max(-180, minLon - padLon),
		maxLon: Math.min(180, maxLon + padLon),
		minLat: Math.max(-58, minLat - padLat),
		maxLat: Math.min(84, maxLat + padLat),
	};
}

function drawConjugation(spec: Extract<FigureSpec, { kind: "conjugation" }>): string {
	const w = 560;
	const rowH = 38;
	const head = 78;
	const h = head + spec.rows.length * rowH + (spec.caption ? 36 : 20);
	const parts: string[] = [];
	parts.push(`<rect x="24" y="20" width="${w - 48}" height="${head - 28}" rx="10" fill="#1c1915"/>`);
	parts.push(text(40, 46, spec.lemma, { size: 18, fill: PAPER, weight: 600 }));
	const sub = [spec.language, spec.tense].filter(Boolean).join(" · ");
	if (sub) parts.push(text(40, 64, sub, { size: 12, fill: "#e7e1d6", weight: 400 }));
	spec.rows.forEach((row, i) => {
		const y = head + i * rowH;
		const hit = spec.highlight && (spec.highlight === row.person || spec.highlight === row.form);
		if (hit) parts.push(`<rect x="24" y="${y}" width="${w - 48}" height="${rowH}" fill="#f3e0c4"/>`);
		else if (i % 2 === 0) parts.push(`<rect x="24" y="${y}" width="${w - 48}" height="${rowH}" fill="#efeae2"/>`);
		if (hit) parts.push(`<rect x="24" y="${y}" width="4" height="${rowH}" fill="#8a5a12"/>`);
		parts.push(text(44, y + 24, row.person, { size: 14, fill: MUTED, weight: 400 }));
		parts.push(text(220, y + 24, row.form, { size: 16, weight: 600 }));
	});
	parts.push(`<rect x="24" y="20" width="${w - 48}" height="${head - 28 + spec.rows.length * rowH}" rx="10" fill="none" stroke="${HAIR}"/>`);
	if (spec.caption) parts.push(text(28, h - 12, spec.caption, { size: 12, fill: MUTED, weight: 400 }));
	return svg(w, h, spec.title, parts.join(""));
}

function drawSentence(spec: Extract<FigureSpec, { kind: "sentence" }>): string {
	const words = spec.words;
	const baselineIdx = words.map((word, i) => ({ word, i })).filter(({ word }) => word.role !== "modifier");
	if (!baselineIdx.length) return svg(640, 220, spec.title, text(24, 40, spec.title, { size: 16, weight: 600 }));
	const mods = new Map<number, number[]>();
	words.forEach((word, i) => {
		if (word.role !== "modifier") return;
		const host = word.of ?? baselineIdx[0].i;
		const list = mods.get(host) ?? [];
		list.push(i);
		mods.set(host, list);
	});
	const char = 8;
	const gap = 36;
	const slots = baselineIdx.map(({ word, i }) => ({
		i,
		text: word.text,
		w: Math.max(28, word.text.length * char + 8),
		mods: mods.get(i)?.length ?? 0,
	}));
	let x = 48;
	const placed = slots.map((slot) => {
		const at = x + slot.w / 2;
		x += slot.w + gap;
		return { ...slot, x: at };
	});
	const width = Math.max(640, x + 24);
	const depth = Math.max(...placed.map((p) => p.mods), 0);
	const baseY = 86;
	const height = baseY + 36 + depth * 48 + (spec.caption ? 28 : 16);
	const parts: string[] = [];
	parts.push(text(24, 28, spec.title, { size: 16, weight: 600 }));
	const x0 = placed[0].x - placed[0].w / 2;
	const x1 = placed[placed.length - 1].x + placed[placed.length - 1].w / 2;
	parts.push(`<line x1="${n(x0)}" y1="${baseY}" x2="${n(x1)}" y2="${baseY}" stroke="${INK}" stroke-width="1.6"/>`);
	for (let s = 0; s < placed.length - 1; s++) {
		const a = placed[s];
		const b = placed[s + 1];
		const bar = (a.x + a.w / 2 + b.x - b.w / 2) / 2;
		const through = words[a.i].role === "subject" && words[b.i].role === "verb";
		const y0 = through ? baseY - 22 : baseY - 20;
		const y1 = through ? baseY + 22 : baseY;
		parts.push(`<line x1="${n(bar)}" y1="${y0}" x2="${n(bar)}" y2="${y1}" stroke="${INK}" stroke-width="1.6"/>`);
	}
	for (const slot of placed) {
		parts.push(text(slot.x, baseY - 8, slot.text, { size: 15, anchor: "middle", weight: 600 }));
		const list = mods.get(slot.i) ?? [];
		list.forEach((modIndex, k) => {
			const mod = words[modIndex];
			const spread = (k - (list.length - 1) / 2) * 54;
			const x2 = slot.x + spread;
			const y2 = baseY + 36 + k * 8;
			parts.push(`<line x1="${n(slot.x)}" y1="${baseY}" x2="${n(x2)}" y2="${y2}" stroke="${INK}" stroke-width="1.3"/>`);
			parts.push(text(x2, y2 + 16, mod.text, { size: 14, anchor: "middle", weight: 400 }));
		});
	}
	if (spec.caption) parts.push(text(24, height - 10, spec.caption, { size: 12, fill: MUTED, weight: 400 }));
	return svg(width, height, spec.title, parts.join(""));
}

/**
 * Full min and max, unless a handful of samples are far beyond the rest
 * (an asymptote). Those spikes would flatten a true curve into the axis.
 */
function yLimits(ys: number[]): { min: number; max: number } {
	if (!ys.length) return { min: -1, max: 1 };
	const sorted = ys.slice().sort((a, b) => a - b);
	const min = sorted[0];
	const max = sorted[sorted.length - 1];
	const at = (p: number) => {
		const i = (sorted.length - 1) * p;
		const lo = Math.floor(i);
		const hi = Math.ceil(i);
		return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
	};
	const robust = at(0.95) - at(0.05);
	if (!(max - min > robust * 8 && robust > 0)) return { min, max };
	const pad = robust * 0.5 || 1;
	return { min: at(0.05) - pad, max: at(0.95) + pad };
}

/** Strokes stop at a non-finite sample or where the curve leaves the frame, so a gap is not drawn as data. */
function curveSegments(
	points: Array<[number, number]>,
	breaks: number[],
	x0: number,
	x1: number,
	y0: number,
	y1: number,
): Array<Array<[number, number]>> {
	const marks: Array<{ x: number; y: number; break: boolean }> = [
		...points.map(([x, y]) => ({ x, y, break: false })),
		...breaks.map((x) => ({ x, y: Number.NaN, break: true })),
	];
	marks.sort((a, b) => a.x - b.x || Number(a.break) - Number(b.break));
	const out: Array<Array<[number, number]>> = [];
	let cur: Array<[number, number]> = [];
	const flush = () => {
		if (cur.length) out.push(cur);
		cur = [];
	};
	for (const mark of marks) {
		const inside = Number.isFinite(mark.x) && Number.isFinite(mark.y) && mark.x >= x0 && mark.x <= x1 && mark.y >= y0 && mark.y <= y1;
		if (mark.break || !inside) {
			flush();
			continue;
		}
		cur.push([mark.x, mark.y]);
	}
	flush();
	return out;
}

function formatTick(v: number): string {
	if (!Number.isFinite(v)) return "";
	const abs = Math.abs(v);
	if (abs !== 0 && (abs >= 10000 || abs < 0.01)) return v.toExponential(0);
	const rounded = Math.round(v * 100) / 100;
	return String(rounded);
}
