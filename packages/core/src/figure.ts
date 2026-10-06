import type { Provider, ProviderRequest, ProviderResponse } from "./agent/types";
import { drawFigure } from "./figure-draw";
import type { KnowledgeStore } from "./store";

/**
 * A figure the tutor draws beside a lesson. The picture is an SVG plate: a
 * plot (including a static 3D view), a story arc, a map, a conjugation table,
 * or a sentence diagram. Matplotlib is not on the tutor runtime; a 3D figure
 * is the same kind of still export mplot3d would write to a file.
 */

export const FIGURE_KINDS = ["plot", "plot3d", "story", "map", "conjugation", "sentence"] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

export const STORY_STAGES = ["exposition", "rising", "climax", "falling", "resolution"] as const;
export type StoryStage = (typeof STORY_STAGES)[number];

export const WORD_ROLES = ["subject", "verb", "object", "complement", "modifier"] as const;

export interface PlotSeries {
	name?: string;
	/** Evaluated samples. Each y is the expression at that x, not a fitted curve. */
	points: Array<[number, number]>;
	/** x values where the expression was not finite. The stroke stops there. */
	breaks?: number[];
	mark: "line" | "scatter" | "bar";
}

export type FigureSpec =
	| {
			kind: "plot";
			title: string;
			caption?: string;
			xLabel?: string;
			yLabel?: string;
			xMin?: number;
			xMax?: number;
			yMin?: number;
			yMax?: number;
			series: PlotSeries[];
	  }
	| {
			kind: "plot3d";
			title: string;
			caption?: string;
			xLabel?: string;
			yLabel?: string;
			zLabel?: string;
			xMin: number;
			xMax: number;
			yMin: number;
			yMax: number;
			/** Rows of z values. Row 0 is yMin, the last row is yMax. */
			grid: number[][];
	  }
	| {
			kind: "story";
			title: string;
			caption?: string;
			beats: { stage: StoryStage; label: string }[];
	  }
	| {
			kind: "map";
			title: string;
			caption?: string;
			markers: { name: string; lat: number; lon: number; side?: string }[];
			movements?: { from: string; to: string; label?: string }[];
	  }
	| {
			kind: "conjugation";
			title: string;
			caption?: string;
			lemma: string;
			language?: string;
			tense: string;
			rows: { person: string; form: string }[];
			highlight?: string;
	  }
	| {
			kind: "sentence";
			title: string;
			caption?: string;
			words: { text: string; role: (typeof WORD_ROLES)[number]; of?: number }[];
	  };

/** Saved on the account and on the chat, so a session can show it again. */
export interface SessionFigure {
	id: string;
	anchor: string;
	title: string;
	caption?: string;
	kind: FigureKind;
	quote?: string;
	created: string;
	collapsed?: boolean;
	svg: string;
	spec: FigureSpec;
	sessionId?: string;
}

export const FIGURE_GUIDANCE = `# Figures
When a picture teaches the step better than another paragraph, call \`show_figure\` and then talk about what it shows. The learner sees it in the left margin of that turn. They can minimize it, and it is saved on their account.
- \`plot\`: a curve, points, or bars. Pass \`points\` as [x, y] pairs, or \`expr\` in the variable x. The curve is that expression evaluated on a fine grid and drawn through those points. It breaks at a gap or an asymptote instead of connecting across it. Operators are + - * / ^ and parentheses. Functions: sin, cos, tan, asin, acos, atan, exp, log, ln, log10, sqrt, abs. Constants: pi, e. Write 2*x, not 2x. \`^\` is right-associative, and \`-x^2\` means \`-(x^2)\`.
- \`plot3d\`: a surface, z from an \`expr\` in x and y (same functions). Each grid value is the expression. The picture is a still perspective view of those values.
- \`story\`: the shape of a narrative. Beats in order, each with a stage (exposition, rising, climax, falling, resolution) and a short label.
- \`map\`: places and movements. Each marker has a name, lat, and lon. \`side\` groups them (Allies, Axis). \`movements\` draw an arrow from one marker name to another. Use this for campaigns, routes, and migrations.
- \`conjugation\`: one verb. \`rows\` are person and form. \`highlight\` is the person or form to mark.
- \`sentence\`: a Reed-Kellogg diagram. \`words\` in order, each with text and a role (subject, verb, object, complement, modifier). A modifier's \`of\` is the index of the word it hangs from.
One figure per idea. Do not paste SVG. Mermaid stays for a goal's dependency map, not for these.`;

export const FIGURE_PROMPT = `# You draw one figure
The learner highlighted a passage and asked for a visualization. Reply with one JSON object and nothing else: no markdown fence, no explanation.

Choose the kind that fits the passage:
- plot — a function, a data series, or bars. Fields: title, kind "plot", xLabel, yLabel, series: [{ name, expr (in x) or points: [[x,y],...], mark: "line"|"scatter"|"bar" }]
- plot3d — a surface. Fields: title, kind "plot3d", expr (z in x and y), xMin, xMax, yMin, yMax, xLabel, yLabel, zLabel
- story — narrative shape. Fields: title, kind "story", beats: [{ stage: "exposition"|"rising"|"climax"|"falling"|"resolution", label }]
- map — places or movements. Fields: title, kind "map", markers: [{ name, lat, lon, side }], movements: [{ from, to, label }]
- conjugation — a verb table. Fields: title, kind "conjugation", lemma, language, tense, rows: [{ person, form }], highlight
- sentence — a grammar diagram. Fields: title, kind "sentence", words: [{ text, role: "subject"|"verb"|"object"|"complement"|"modifier", of }]

Expressions use + - * / ^, parentheses, sin cos tan asin acos atan exp log ln log10 sqrt abs, and pi and e. Write 2*x, not 2x.
Use the passage. Do not invent a quiz answer, and do not add a second figure.`;

const LESSON_CHARS = 12_000;

export function figureOpening(lesson: string, quote: string): string {
	return [
		`<lesson_so_far>\n${lesson.slice(-LESSON_CHARS).trim() || "(nothing yet)"}\n</lesson_so_far>`,
		`<highlighted_passage>\n${quote.trim()}\n</highlighted_passage>`,
		"Draw one figure for the highlighted passage.",
	].join("\n\n");
}

/** Pull a figure spec out of a model reply. */
export function figureFromModelText(text: string): FigureSpec {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const raw = fenced?.[1] ?? text;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("The reply did not include a figure.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		throw new Error("The figure was not valid JSON.");
	}
	return parseFigureSpec(parsed);
}

export function parseFigureSpec(value: unknown): FigureSpec {
	const o = object(value);
	const kind = string(o.kind, "kind");
	if (!FIGURE_KINDS.includes(kind as FigureKind)) throw new Error(`Unknown figure kind "${kind}".`);
	const title = clip(string(o.title, "title"), 140);
	const caption = optionalText(o.caption, 180);
	switch (kind) {
		case "plot":
			return { kind, title, caption, ...parsePlot(o) };
		case "plot3d":
			return { kind, title, caption, ...parsePlot3d(o) };
		case "story":
			return { kind, title, caption, beats: parseBeats(o.beats) };
		case "map":
			return { kind, title, caption, ...parseMap(o) };
		case "conjugation":
			return { kind, title, caption, ...parseConjugation(o) };
		case "sentence":
			return { kind, title, caption, words: parseWords(o.words) };
		default:
			throw new Error(`Unknown figure kind "${kind}".`);
	}
}

export function renderFigure(spec: FigureSpec): string {
	const svg = drawFigure(spec);
	if (svg.length > 300_000) throw new Error("That figure is too large.");
	if (svg.includes("<script") || svg.includes("<foreignObject")) throw new Error("The figure was not safe to draw.");
	return svg;
}

export function newFigureId(now = Date.now(), rand = Math.random()): string {
	return `fig_${now.toString(36)}${Math.floor(rand * 1e4).toString(36)}`;
}

export function figureFile(id: string): string {
	if (!/^fig_[a-z0-9]+$/.test(id)) throw new Error("Bad figure id.");
	return `.groundwork/figures/${id}.json`;
}

export async function saveFigure(
	store: KnowledgeStore,
	input: unknown,
	extra?: { quote?: string; sessionId?: string; anchor?: string; id?: string },
): Promise<SessionFigure> {
	const spec = parseFigureSpec(input);
	const svg = renderFigure(spec);
	const figure: SessionFigure = {
		id: extra?.id && /^fig_[a-z0-9]+$/.test(extra.id) ? extra.id : newFigureId(),
		anchor: extra?.anchor ?? "",
		title: spec.title,
		caption: spec.caption,
		kind: spec.kind,
		quote: extra?.quote,
		created: new Date().toISOString(),
		collapsed: false,
		svg,
		spec,
		sessionId: extra?.sessionId,
	};
	await store.writeFile(figureFile(figure.id), `${JSON.stringify(figure)}\n`);
	return figure;
}

export function demoFigureFor(quote: string): FigureSpec {
	const q = quote.toLowerCase();
	if (/\b(surface|paraboloid|3d|three[- ]dimensional|saddle)\b/.test(q)) {
		return parseFigureSpec({
			kind: "plot3d",
			title: "A surface",
			caption: "z = x² − y²",
			expr: "x^2 - y^2",
			xMin: -2,
			xMax: 2,
			yMin: -2,
			yMax: 2,
			xLabel: "x",
			yLabel: "y",
			zLabel: "z",
		});
	}
	if (/\b(deriv|plot|graph|function|parabola|slope|integral|\bsin\b|\bcos\b)\b/.test(q)) {
		return parseFigureSpec({
			kind: "plot",
			title: "y = x²",
			caption: "The parabola the derivative reads as a slope.",
			xLabel: "x",
			yLabel: "y",
			series: [{ name: "x²", expr: "x^2", mark: "line" }],
			xMin: -3,
			xMax: 3,
		});
	}
	if (/\b(war|troop|army|battle|map|normandy|front|invade|campaign)\b/.test(q)) {
		return parseFigureSpec({
			kind: "map",
			title: "Western and eastern fronts",
			caption: "A lesson map, not a battle chart.",
			markers: [
				{ name: "London", lat: 51.5, lon: -0.12, side: "Allies" },
				{ name: "Normandy", lat: 49.3, lon: -0.6, side: "Allies" },
				{ name: "Berlin", lat: 52.5, lon: 13.4, side: "Axis" },
				{ name: "Stalingrad", lat: 48.7, lon: 44.5, side: "Axis" },
			],
			movements: [{ from: "Normandy", to: "Berlin", label: "1944–45" }],
		});
	}
	if (/\b(conjug|tense|hablar|verb ending|spanish|french|paradigm)\b/.test(q)) {
		return parseFigureSpec({
			kind: "conjugation",
			title: "hablar",
			lemma: "hablar",
			language: "Spanish",
			tense: "present indicative",
			highlight: "tú",
			rows: [
				{ person: "yo", form: "hablo" },
				{ person: "tú", form: "hablas" },
				{ person: "él / ella", form: "habla" },
				{ person: "nosotros", form: "hablamos" },
				{ person: "vosotros", form: "habláis" },
				{ person: "ellos", form: "hablan" },
			],
		});
	}
	if (/\b(sentence|grammar|clause|noun phrase|predicate|diagram)\b/.test(q)) {
		return parseFigureSpec({
			kind: "sentence",
			title: "The old dog chased the cat",
			words: [
				{ text: "The", role: "modifier", of: 2 },
				{ text: "old", role: "modifier", of: 2 },
				{ text: "dog", role: "subject" },
				{ text: "chased", role: "verb" },
				{ text: "the", role: "modifier", of: 5 },
				{ text: "cat", role: "object" },
			],
		});
	}
	const bit = quote.replace(/\s+/g, " ").trim().slice(0, 72) || "The turn";
	return parseFigureSpec({
		kind: "story",
		title: "Shape of the passage",
		beats: [
			{ stage: "exposition", label: "Where it starts" },
			{ stage: "rising", label: "What builds" },
			{ stage: "climax", label: bit },
			{ stage: "falling", label: "What follows" },
			{ stage: "resolution", label: "Where it lands" },
		],
	});
}

/** Scripted figure for the demo tutor, from the highlighted passage. */
export class DemoFigureProvider implements Provider {
	readonly name = "demo-figure";

	constructor(private readonly delayMs = 8) {}

	async complete(req: ProviderRequest): Promise<ProviderResponse> {
		const last = req.messages[req.messages.length - 1];
		const opening = typeof last?.content === "string" ? last.content : "";
		const quote = /<highlighted_passage>\n([\s\S]*?)\n<\/highlighted_passage>/.exec(opening)?.[1] ?? opening;
		const text = JSON.stringify(demoFigureFor(quote));
		const chunks = text.match(/[\s\S]{1,24}/g) ?? [];
		for (const chunk of chunks) {
			if (req.signal?.aborted) throw new Error("aborted");
			req.onText(chunk);
			if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
		}
		return { content: [{ type: "text", text }], stopReason: "end_turn" };
	}
}

function parsePlot(o: Record<string, unknown>): Omit<Extract<FigureSpec, { kind: "plot" }>, "kind" | "title" | "caption"> {
	const seriesIn = Array.isArray(o.series) ? o.series : [];
	if (!seriesIn.length || seriesIn.length > 6) throw new Error("A plot needs 1 to 6 series.");
	const xMin = optionalNum(o.xMin);
	const xMax = optionalNum(o.xMax);
	const series: PlotSeries[] = seriesIn.map((item, i) => {
		const s = object(item, `series ${i}`);
		const mark = s.mark === "scatter" || s.mark === "bar" || s.mark === "line" ? s.mark : "line";
		const name = optionalText(s.name, 60);
		let points = parsePoints(s.points);
		let breaks = parseBreaks(s.breaks);
		if (!points.length && typeof s.expr === "string") {
			const lo = xMin ?? -5;
			const hi = xMax ?? 5;
			const sampled = sampleCurve(s.expr, lo, hi, mark === "bar" ? 12 : 361);
			points = sampled.points;
			breaks = sampled.breaks;
		}
		if (points.length < (mark === "bar" ? 1 : 2)) throw new Error(`Series ${i} needs points or an expr in x.`);
		return { name, points, ...(breaks.length ? { breaks } : {}), mark };
	});
	return {
		xLabel: optionalText(o.xLabel, 40),
		yLabel: optionalText(o.yLabel, 40),
		xMin,
		xMax,
		yMin: optionalNum(o.yMin),
		yMax: optionalNum(o.yMax),
		series,
	};
}

function parsePlot3d(o: Record<string, unknown>): Omit<Extract<FigureSpec, { kind: "plot3d" }>, "kind" | "title" | "caption"> {
	const xMin = optionalNum(o.xMin) ?? -2;
	const xMax = optionalNum(o.xMax) ?? 2;
	const yMin = optionalNum(o.yMin) ?? -2;
	const yMax = optionalNum(o.yMax) ?? 2;
	if (!(xMax > xMin) || !(yMax > yMin)) throw new Error("plot3d ranges need a max greater than the min.");
	const steps = 18;
	let grid = parseGrid(o.grid);
	if (!grid.length && typeof o.expr === "string") grid = sampleSurface(o.expr, xMin, xMax, yMin, yMax, steps);
	if (grid.length < 2 || grid.some((row) => row.length < 2)) throw new Error("plot3d needs an expr in x and y, or a grid of z values.");
	return {
		xLabel: optionalText(o.xLabel, 40),
		yLabel: optionalText(o.yLabel, 40),
		zLabel: optionalText(o.zLabel, 40),
		xMin,
		xMax,
		yMin,
		yMax,
		grid,
	};
}

function parseBeats(value: unknown): { stage: StoryStage; label: string }[] {
	if (!Array.isArray(value) || value.length < 2 || value.length > 8) throw new Error("A story figure needs 2 to 8 beats.");
	return value.map((item, i) => {
		const b = object(item, `beat ${i}`);
		const stage = string(b.stage, `beat ${i} stage`);
		if (!STORY_STAGES.includes(stage as StoryStage)) throw new Error(`Beat ${i} has an unknown stage.`);
		return { stage: stage as StoryStage, label: clip(string(b.label, `beat ${i} label`), 80) };
	});
}

function parseMap(o: Record<string, unknown>): Omit<Extract<FigureSpec, { kind: "map" }>, "kind" | "title" | "caption"> {
	if (!Array.isArray(o.markers) || !o.markers.length || o.markers.length > 40) throw new Error("A map needs 1 to 40 markers.");
	const markers = o.markers.map((item, i) => {
		const m = object(item, `marker ${i}`);
		const lat = num(m.lat, `marker ${i} lat`);
		const lon = num(m.lon, `marker ${i} lon`);
		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error(`Marker ${i} is off the map.`);
		return { name: clip(string(m.name, `marker ${i} name`), 40), lat, lon, side: optionalText(m.side, 40) };
	});
	const names = new Set(markers.map((m) => m.name));
	let movements: { from: string; to: string; label?: string }[] | undefined;
	if (Array.isArray(o.movements)) {
		if (o.movements.length > 20) throw new Error("Too many movements.");
		movements = o.movements.map((item, i) => {
			const m = object(item, `movement ${i}`);
			const from = string(m.from, `movement ${i} from`);
			const to = string(m.to, `movement ${i} to`);
			if (!names.has(from) || !names.has(to)) throw new Error(`Movement ${i} must name markers on the map.`);
			return { from, to, label: optionalText(m.label, 40) };
		});
	}
	return { markers, movements };
}

function parseConjugation(o: Record<string, unknown>): Omit<Extract<FigureSpec, { kind: "conjugation" }>, "kind" | "title" | "caption"> {
	if (!Array.isArray(o.rows) || o.rows.length < 1 || o.rows.length > 16) throw new Error("A conjugation needs 1 to 16 rows.");
	const rows = o.rows.map((item, i) => {
		const r = object(item, `row ${i}`);
		return { person: clip(string(r.person, `row ${i} person`), 40), form: clip(string(r.form, `row ${i} form`), 60) };
	});
	return {
		lemma: clip(string(o.lemma, "lemma"), 60),
		language: optionalText(o.language, 40),
		tense: clip(string(o.tense, "tense"), 60),
		rows,
		highlight: optionalText(o.highlight, 60),
	};
}

function parseWords(value: unknown): { text: string; role: (typeof WORD_ROLES)[number]; of?: number }[] {
	if (!Array.isArray(value) || value.length < 2 || value.length > 24) throw new Error("A sentence diagram needs 2 to 24 words.");
	return value.map((item, i) => {
		const w = object(item, `word ${i}`);
		const role = string(w.role, `word ${i} role`);
		if (!WORD_ROLES.includes(role as (typeof WORD_ROLES)[number])) throw new Error(`Word ${i} has an unknown role.`);
		const of = w.of === undefined ? undefined : num(w.of, `word ${i} of`);
		if (of !== undefined && (!Number.isInteger(of) || of < 0 || of >= value.length || of === i)) throw new Error(`Word ${i} does not hang from a word in the sentence.`);
		return { text: clip(string(w.text, `word ${i}`), 40), role: role as (typeof WORD_ROLES)[number], of };
	});
}

function parsePoints(value: unknown): Array<[number, number]> {
	if (!Array.isArray(value)) return [];
	if (value.length > 500) throw new Error("Too many points.");
	return value.map((pair, i) => {
		if (!Array.isArray(pair) || pair.length < 2) throw new Error(`Point ${i} must be [x, y].`);
		return [num(pair[0], `point ${i} x`), num(pair[1], `point ${i} y`)] as [number, number];
	});
}

function parseGrid(value: unknown): number[][] {
	if (!Array.isArray(value)) return [];
	if (value.length > 40) throw new Error("The surface grid is too fine.");
	return value.map((row, r) => {
		if (!Array.isArray(row) || row.length > 40) throw new Error("The surface grid is too fine.");
		return row.map((z, c) => num(z, `grid ${r},${c}`));
	});
}

function sampleCurve(expr: string, lo: number, hi: number, steps: number): { points: Array<[number, number]>; breaks: number[] } {
	const fn = compileExpr(expr, ["x"]);
	const points: Array<[number, number]> = [];
	const breaks: number[] = [];
	for (let i = 0; i < steps; i++) {
		const x = lo + ((hi - lo) * i) / (steps - 1);
		const y = fn({ x });
		if (Number.isFinite(y)) points.push([x, y]);
		else breaks.push(x);
	}
	if (points.length < 2) throw new Error(`Could not plot "${expr}".`);
	return { points, breaks };
}

function parseBreaks(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	if (value.length > 400) throw new Error("Too many gaps in a curve.");
	return value.map((x, i) => num(x, `break ${i}`));
}

function sampleSurface(expr: string, xMin: number, xMax: number, yMin: number, yMax: number, steps: number): number[][] {
	const fn = compileExpr(expr, ["x", "y"]);
	const grid: number[][] = [];
	let finite = 0;
	for (let r = 0; r < steps; r++) {
		const y = yMin + ((yMax - yMin) * r) / (steps - 1);
		const row: number[] = [];
		for (let c = 0; c < steps; c++) {
			const x = xMin + ((xMax - xMin) * c) / (steps - 1);
			const z = fn({ x, y });
			row.push(Number.isFinite(z) ? z : Number.NaN);
			if (Number.isFinite(z)) finite++;
		}
		grid.push(row);
	}
	if (finite < 4) throw new Error(`Could not plot "${expr}".`);
	return grid;
}

type Node = { op: "num"; v: number } | { op: "var"; name: string } | { op: "neg"; a: Node } | { op: "bin"; op2: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node } | { op: "call"; name: string; args: Node[] };

const FUNCS: Record<string, (args: number[]) => number> = {
	sin: ([x]) => Math.sin(x),
	cos: ([x]) => Math.cos(x),
	tan: ([x]) => Math.tan(x),
	asin: ([x]) => Math.asin(x),
	acos: ([x]) => Math.acos(x),
	atan: ([x]) => Math.atan(x),
	exp: ([x]) => Math.exp(x),
	log: ([x]) => Math.log(x),
	ln: ([x]) => Math.log(x),
	log10: ([x]) => Math.log10(x),
	sqrt: ([x]) => Math.sqrt(x),
	abs: ([x]) => Math.abs(x),
};

export function compileExpr(source: string, vars: string[]): (env: Record<string, number>) => number {
	const s = source.replace(/\s+/g, "");
	if (!s || s.length > 200) throw new Error("Write a short expression.");
	let i = 0;
	const peek = () => s[i];
	const eat = (c: string) => {
		if (s[i] !== c) throw new Error(`Expected "${c}" in "${source}".`);
		i++;
	};
	const expr = (): Node => {
		let node = term();
		while (peek() === "+" || peek() === "-") {
			const op2 = peek() as "+" | "-";
			i++;
			node = { op: "bin", op2, a: node, b: term() };
		}
		return node;
	};
	const term = (): Node => {
		let node = unary();
		while (peek() === "*" || peek() === "/") {
			const op2 = peek() as "*" | "/";
			i++;
			node = { op: "bin", op2, a: node, b: unary() };
		}
		return node;
	};
	const unary = (): Node => {
		if (peek() === "-") {
			i++;
			return { op: "neg", a: unary() };
		}
		if (peek() === "+") {
			i++;
			return unary();
		}
		return power();
	};
	const power = (): Node => {
		const node = primary();
		if (peek() === "^") {
			i++;
			return { op: "bin", op2: "^", a: node, b: unary() };
		}
		return node;
	};
	const primary = (): Node => {
		if (peek() === "(") {
			eat("(");
			const node = expr();
			eat(")");
			return node;
		}
		if (/[0-9.]/.test(peek() ?? "")) {
			const start = i;
			while (/[0-9.]/.test(peek() ?? "")) i++;
			const v = Number(s.slice(start, i));
			if (!Number.isFinite(v)) throw new Error(`Bad number in "${source}".`);
			return { op: "num", v };
		}
		if (/[A-Za-z]/.test(peek() ?? "")) {
			const start = i;
			while (/[A-Za-z0-9]/.test(peek() ?? "")) i++;
			const name = s.slice(start, i);
			if (peek() === "(") {
				if (!FUNCS[name]) throw new Error(`Unknown function "${name}".`);
				eat("(");
				const args = [expr()];
				eat(")");
				return { op: "call", name, args };
			}
			if (name === "pi") return { op: "num", v: Math.PI };
			if (name === "e") return { op: "num", v: Math.E };
			if (!vars.includes(name)) throw new Error(`"${name}" is not a variable here. Use ${vars.join(" and ")}.`);
			return { op: "var", name };
		}
		throw new Error(`Can't read "${source}".`);
	};
	const tree = expr();
	if (i !== s.length) throw new Error(`Can't read the rest of "${source}".`);
	const evalNode = (node: Node, env: Record<string, number>): number => {
		switch (node.op) {
			case "num":
				return node.v;
			case "var":
				return env[node.name];
			case "neg":
				return -evalNode(node.a, env);
			case "call":
				return FUNCS[node.name](node.args.map((a) => evalNode(a, env)));
			case "bin": {
				const a = evalNode(node.a, env);
				const b = evalNode(node.b, env);
				if (node.op2 === "+") return a + b;
				if (node.op2 === "-") return a - b;
				if (node.op2 === "*") return a * b;
				if (node.op2 === "/") return a / b;
				return a ** b;
			}
		}
	};
	return (env) => evalNode(tree, env);
}

function object(value: unknown, label = "figure"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
	return value.trim();
}

function optionalText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return clip(value.trim(), max);
}

function clip(value: string, max: number): string {
	const clean = value.replace(/[\u0000-\u001f]/g, "").trim();
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function num(value: unknown, label: string): number {
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
	return n;
}

function optionalNum(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return num(value, "range");
}
