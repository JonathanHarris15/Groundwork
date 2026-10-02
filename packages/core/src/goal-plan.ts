import type { ConceptStatus } from "./model";

/** A goal's deadline, stored as YYYY-MM-DD. */
export function parseIsoDate(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
	if (!match) return undefined;
	const iso = match[1];
	const [year, month, day] = iso.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
	return iso;
}

export function addDays(iso: string, days: number): string {
	const [year, month, day] = iso.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
	const start = Date.parse(`${from}T12:00:00Z`);
	const end = Date.parse(`${to}T12:00:00Z`);
	return Math.round((end - start) / 86_400_000);
}

/** New goals are due two weeks out when the learner has not named a date. */
export function defaultDue(today: string, days = 14): string {
	return addDays(today, days);
}

export function formatDue(iso: string, withWeekday = false): string {
	const [year, month, day] = iso.split("-").map(Number);
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "UTC",
		weekday: withWeekday ? "short" : undefined,
		month: "short",
		day: "numeric",
		year: year ? undefined : undefined,
	}).format(new Date(Date.UTC(year, month - 1, day)));
}

export function daysLeftPhrase(days: number): string {
	if (days === 0) return "today";
	if (days === 1) return "1 day";
	if (days === -1) return "1 day overdue";
	if (days < 0) return `${-days} days overdue`;
	return `${days} days`;
}

/**
 * Percents keyed by concept id, summing to 100.
 * Explicit weights are kept and the rest share what is left.
 * With no weights, required levels share the goal; otherwise every concept is equal.
 */
export function resolveWeights(
	ids: string[],
	stored: Record<string, number>,
	requiredLevels: Record<string, number> = {},
): Record<string, number> {
	const unique = [...new Set(ids.filter(Boolean))];
	if (!unique.length) return {};
	const explicit = unique.filter((id) => Number.isFinite(stored[id]) && stored[id] > 0);
	const out: Record<string, number> = {};
	if (explicit.length) {
		const used = explicit.reduce((sum, id) => sum + stored[id], 0);
		const rest = unique.filter((id) => !explicit.includes(id));
		const share = rest.length ? Math.max(0, 100 - used) / rest.length : 0;
		for (const id of explicit) out[id] = stored[id];
		for (const id of rest) out[id] = share;
	} else if (unique.some((id) => (requiredLevels[id] ?? 0) > 0)) {
		const sum = unique.reduce((total, id) => total + Math.max(1, requiredLevels[id] ?? 1), 0);
		for (const id of unique) out[id] = (Math.max(1, requiredLevels[id] ?? 1) / sum) * 100;
	} else {
		const share = 100 / unique.length;
		for (const id of unique) out[id] = share;
	}
	const sum = Object.values(out).reduce((total, n) => total + n, 0) || 1;
	for (const id of unique) out[id] = (out[id] / sum) * 100;
	return out;
}

export function conceptCompletion(status: ConceptStatus, current: number, built: boolean): number {
	if (built) return 1;
	if (status === "unassessed") return 0;
	return Math.min(1, Math.max(0, current));
}

export function weightedReadiness(
	nodes: Array<{ id: string; status: ConceptStatus; current: number }>,
	weights: Record<string, number>,
	built: (id: string) => boolean,
): number {
	let acc = 0;
	let sum = 0;
	for (const node of nodes) {
		const weight = weights[node.id] ?? 0;
		sum += weight;
		acc += weight * conceptCompletion(node.status, node.current, built(node.id));
	}
	return sum ? acc / sum : 0;
}

export type Pace = "ahead" | "on-pace" | "behind" | "done";
export type ScheduleDayKind = "studied" | "missed" | "today" | "future" | "focus" | "due";

export interface ScheduleDay {
	date: string;
	kind: ScheduleDayKind;
}

export interface GoalSchedule {
	start: string;
	due: string;
	today: string;
	daysLeft: number;
	elapsed: number;
	span: number;
	studiedDays: number;
	elapsedDays: number;
	pace: Pace;
	readiness: number;
	days: ScheduleDay[];
}

export function buildSchedule(input: {
	start?: string;
	due?: string;
	today: string;
	studied?: string[];
	readiness: number;
	status?: "active" | "paused" | "done";
}): GoalSchedule | null {
	const today = parseIsoDate(input.today);
	const due = parseIsoDate(input.due);
	if (!today || !due) return null;
	const start = parseIsoDate(input.start) ?? today;
	const from = start <= due ? start : due;
	const to = due;
	const studied = new Set((input.studied ?? []).map((d) => parseIsoDate(d)).filter((d): d is string => !!d));
	const span = Math.max(1, daysBetween(from, to));
	const elapsed = Math.min(span, Math.max(0, daysBetween(from, today)));
	const focus = new Set([addDays(to, -1), addDays(to, -2)]);
	const days: ScheduleDay[] = [];
	for (let date = from; date <= to; date = addDays(date, 1)) {
		let kind: ScheduleDayKind;
		if (date === to) kind = "due";
		else if (date === today) kind = "today";
		else if (date > today && focus.has(date)) kind = "focus";
		else if (date > today) kind = "future";
		else if (studied.has(date)) kind = "studied";
		else kind = "missed";
		days.push({ date, kind });
	}
	const studiedDays = [...studied].filter((date) => date >= from && date <= today).length;
	const elapsedDays = Math.max(1, days.filter((day) => day.date <= today).length);
	let pace: Pace;
	if (input.status === "done" || input.readiness >= 0.995) pace = "done";
	else {
		const time = elapsed / span;
		if (input.readiness >= time + 0.12) pace = "ahead";
		else if (input.readiness + 0.08 >= time) pace = "on-pace";
		else pace = "behind";
	}
	return {
		start: from,
		due: to,
		today,
		daysLeft: daysBetween(today, to),
		elapsed,
		span,
		studiedDays,
		elapsedDays,
		pace,
		readiness: input.readiness,
		days,
	};
}

export function sessionEstimate(openCount: number): number {
	if (openCount <= 0) return 0;
	return Math.max(1, Math.ceil(openCount / 2));
}

export type MapVisual = "known" | "learning" | "shaky" | "rusty" | "ghost" | "goal" | "beyond" | "dim";

export interface MapSourceNode {
	id: string;
	title: string;
	prerequisites: string[];
	status: ConceptStatus;
	current: number;
	inGoal: boolean;
	role?: "target" | "built" | "path";
}

export interface ConceptMapNode {
	id: string;
	title: string;
	x: number;
	y: number;
	r: number;
	visual: MapVisual;
	step?: number;
	next: boolean;
	subtitle?: string;
	caption?: string;
}

export interface ConceptMapEdge {
	from: string;
	to: string;
	kind: "built" | "ahead" | "faint" | "dim";
}

export interface PathStep {
	id: string;
	title: string;
	visual: MapVisual;
	meta: string;
	step?: number;
	rank: number;
}

export interface ConceptMapModel {
	nodes: ConceptMapNode[];
	edges: ConceptMapEdge[];
	steps: PathStep[];
	viewBox: string;
	width: number;
	height: number;
	nextId?: string;
	goalNodeId?: string;
	inPlace: number;
	total: number;
}

function visualFor(status: ConceptStatus, built: boolean): MapVisual {
	if (built) return "known";
	if (status === "unassessed") return "ghost";
	if (status === "shaky") return "shaky";
	if (status === "rusty") return "rusty";
	return "learning";
}

function ranksOf(nodes: Array<{ id: string; prerequisites: string[] }>): Map<string, number> {
	const ids = new Set(nodes.map((node) => node.id));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const memo = new Map<string, number>();
	const visiting = new Set<string>();
	const rank = (id: string): number => {
		const cached = memo.get(id);
		if (cached != null) return cached;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const node = byId.get(id);
		const priors = (node?.prerequisites ?? []).filter((id) => ids.has(id));
		const value = priors.length ? 1 + Math.max(...priors.map(rank)) : 0;
		visiting.delete(id);
		memo.set(id, value);
		return value;
	};
	for (const node of nodes) rank(node.id);
	return memo;
}

function place(
	nodes: Array<{ id: string; title: string }>,
	rank: Map<string, number>,
	originY: number,
	row: number,
): Map<string, { x: number; y: number }> {
	const columns = new Map<number, Array<{ id: string; title: string }>>();
	for (const node of nodes) {
		const key = rank.get(node.id) ?? 0;
		const list = columns.get(key) ?? [];
		list.push(node);
		columns.set(key, list);
	}
	const out = new Map<string, { x: number; y: number }>();
	for (const [key, list] of columns) {
		list.sort((a, b) => a.title.localeCompare(b.title));
		const x = 88 + key * 168;
		const top = originY - ((list.length - 1) * row) / 2;
		list.forEach((node, index) => out.set(node.id, { x, y: top + index * row }));
	}
	return out;
}

export function buildConceptMap(input: {
	goalTitle: string;
	dueLabel?: string;
	nodes: MapSourceNode[];
	weights?: Record<string, number>;
	scope: "path" | "all";
	showGhosts: boolean;
	nextId?: string;
	builtIds?: Iterable<string>;
}): ConceptMapModel {
	const weights = input.weights ?? {};
	const built = new Set(input.builtIds ?? []);
	const inGoal = input.nodes.filter((node) => node.inGoal);
	const goalIds = new Set(inGoal.map((node) => node.id));
	const openTargets = inGoal.filter((node) => node.role === "target" && !built.has(node.id));
	const targetPool = openTargets.length ? openTargets : inGoal.filter((node) => node.role === "target");
	const pool = targetPool.length ? targetPool : inGoal;
	const goalNodeId = pool
		.slice()
		.sort((a, b) => (weights[b.id] ?? 0) - (weights[a.id] ?? 0) || a.title.localeCompare(b.title))[0]?.id;

	const beyond = input.nodes
		.filter((node) => !node.inGoal && node.prerequisites.some((id) => id === goalNodeId || goalIds.has(id)))
		.sort((a, b) => Number(b.prerequisites.includes(goalNodeId ?? "")) - Number(a.prerequisites.includes(goalNodeId ?? "")) || a.title.localeCompare(b.title))
		.slice(0, 3);
	const beyondIds = new Set(beyond.map((node) => node.id));
	const dim =
		input.scope === "all"
			? input.nodes
					.filter((node) => !node.inGoal && !beyondIds.has(node.id))
					.sort((a, b) => a.title.localeCompare(b.title))
					.slice(0, 12)
			: [];

	const chosen = [...inGoal, ...beyond, ...dim].filter((node) => input.showGhosts || node.id === goalNodeId || visualFor(node.status, built.has(node.id)) !== "ghost");
	const visible = new Map(chosen.map((node) => [node.id, node]));
	const main = chosen.filter((node) => node.inGoal || beyondIds.has(node.id));
	const mainRanks = ranksOf(main.map((node) => ({ id: node.id, prerequisites: node.prerequisites.filter((id) => visible.has(id) && (goalIds.has(id) || beyondIds.has(id))) })));
	const mainPos = place(main, mainRanks, 250, 112);
	const dimRanks = ranksOf(dim.filter((node) => visible.has(node.id)).map((node) => ({ id: node.id, prerequisites: node.prerequisites.filter((id) => visible.has(id)) })));
	const dimPos = place(
		dim.filter((node) => visible.has(node.id)),
		dimRanks,
		460,
		78,
	);

	let ghost = 0;
	const ghostOrder = inGoal
		.filter((node) => visible.has(node.id) && node.id !== goalNodeId && visualFor(node.status, built.has(node.id)) === "ghost")
		.sort((a, b) => (mainRanks.get(a.id) ?? 0) - (mainRanks.get(b.id) ?? 0) || a.title.localeCompare(b.title));
	const ghostStep = new Map(ghostOrder.map((node) => [node.id, ++ghost]));

	const nodes: ConceptMapNode[] = [];
	for (const node of chosen) {
		const pos = mainPos.get(node.id) ?? dimPos.get(node.id);
		if (!pos) continue;
		const base = visualFor(node.status, built.has(node.id));
		let visual: MapVisual = base;
		if (node.id === goalNodeId) visual = "goal";
		else if (beyondIds.has(node.id)) visual = "beyond";
		else if (!node.inGoal) visual = "dim";
		const subtitle = visual === "goal" ? `Goal · ${input.goalTitle}${input.dueLabel ? `, ${input.dueLabel}` : ""}` : undefined;
		nodes.push({
			id: node.id,
			title: node.title,
			x: pos.x,
			y: pos.y,
			r: visual === "goal" ? 22 : visual === "dim" || visual === "beyond" ? 8 : visual === "ghost" ? 12 : 11,
			visual,
			step: ghostStep.get(node.id),
			next: node.id === input.nextId && visual !== "goal",
			subtitle,
			caption: visual === "beyond" ? "unlocks after goal" : undefined,
		});
	}

	const byId = new Map(nodes.map((node) => [node.id, node]));
	const edges: ConceptMapEdge[] = [];
	for (const node of chosen) {
		if (!byId.has(node.id)) continue;
		for (const prior of node.prerequisites) {
			if (!byId.has(prior) || prior === node.id) continue;
			const from = byId.get(prior)!;
			const to = byId.get(node.id)!;
			let kind: ConceptMapEdge["kind"] = "ahead";
			if (from.visual === "dim" || to.visual === "dim") kind = "dim";
			else if (from.visual === "beyond" || to.visual === "beyond") kind = "faint";
			else if (from.visual === "known" && (to.visual === "known" || to.visual === "shaky" || to.visual === "learning" || to.visual === "rusty")) kind = "built";
			edges.push({ from: prior, to: node.id, kind });
		}
	}

	const steps: PathStep[] = inGoal
		.filter((node) => byId.has(node.id))
		.map((node) => {
			const drawn = byId.get(node.id)!;
			const meta =
				drawn.visual === "goal"
					? "goal"
					: drawn.next
						? "next"
						: drawn.visual === "known"
							? "known"
							: drawn.visual === "ghost"
								? "ghost"
								: drawn.visual;
			return { id: node.id, title: node.title, visual: drawn.visual, meta, step: drawn.step, rank: mainRanks.get(node.id) ?? 0 };
		})
		.sort((a, b) => a.rank - b.rank || Number(a.visual === "goal") - Number(b.visual === "goal") || a.title.localeCompare(b.title));

	let minX = 40;
	let minY = 36;
	let maxX = 320;
	let maxY = 280;
	for (const node of nodes) {
		minX = Math.min(minX, node.x - 70);
		maxX = Math.max(maxX, node.x + Math.max(70, node.title.length * 3.6));
		minY = Math.min(minY, node.y - node.r - (node.next ? 28 : 16));
		maxY = Math.max(maxY, node.y + node.r + (node.subtitle || node.caption ? 48 : 28));
	}
	const width = Math.max(480, maxX - minX + 48);
	const height = Math.max(320, maxY - minY + 36);
	const inPlace = inGoal.filter((node) => built.has(node.id)).length;
	return {
		nodes,
		edges,
		steps,
		viewBox: `${minX} ${minY} ${width} ${height}`,
		width,
		height,
		nextId: input.nextId,
		goalNodeId,
		inPlace,
		total: inGoal.length,
	};
}
