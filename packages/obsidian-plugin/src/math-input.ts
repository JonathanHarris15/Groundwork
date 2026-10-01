/**
 * Split a free-response answer into prose and TeX, using the same `$` / `$$`
 * rules Obsidian uses to typeset math. The caret's formula stays "live" so it
 * can be edited as source; every other closed formula can render in place.
 */

const FENCE_LINE = /^(```+|~~~+)/;

export interface MathSpan {
	tex: string;
	display: boolean;
	raw: string;
	start: number;
	end: number;
}

export type AnswerPiece =
	| { kind: "text"; text: string; start: number; end: number }
	| ({ kind: "math"; live: boolean } & MathSpan);

interface OpenSpan {
	start: number;
	/** Exclusive end of the still-open region (end of the fence-free run). */
	end: number;
}

export function segmentAnswer(source: string, caret: number | null): AnswerPiece[] {
	const ranges = mathSpans(source);
	const pieces: AnswerPiece[] = [];
	let cursor = 0;
	for (const range of ranges) {
		if (range.start > cursor) {
			pieces.push({ kind: "text", text: source.slice(cursor, range.start), start: cursor, end: range.start });
		}
		const live = caret !== null && caret > range.start && caret < range.end;
		pieces.push({ kind: "math", ...range, live });
		cursor = range.end;
	}
	if (cursor < source.length) pieces.push({ kind: "text", text: source.slice(cursor), start: cursor, end: source.length });
	return pieces;
}

export type MathContext = "inside" | "inline-open" | "display-open" | "outside";

/**
 * Where an insertion at `caret` would land. "inside" is a formula already
 * being typed or a closed one. "*-open" means the caret sits just after a
 * fresh `$` or `$$` that has no body yet.
 */
export function mathContext(source: string, caret: number): MathContext {
	const at = clamp(caret, source.length);
	if (insideMath(source, at)) return "inside";
	if (at >= 2 && source.startsWith("$$", at - 2) && !escaped(source, at - 2) && !endsSpan(source, at)) return "display-open";
	if (at >= 1 && source[at - 1] === "$" && !escaped(source, at - 1) && !endsSpan(source, at)) return "inline-open";
	return "outside";
}

/**
 * Insert a LaTeX snippet. `template` may contain one `|` where the caret
 * should land (the `|` is not inserted). Outside math the snippet is wrapped
 * in `$...$`; a slotless snippet leaves the caret after the closer so the new
 * formula renders immediately.
 */
export function insertLatex(source: string, start: number, end: number, template: string): { source: string; caret: number } {
	const from = clamp(Math.min(start, end), source.length);
	const to = clamp(Math.max(start, end), source.length);
	const base = source.slice(0, from) + source.slice(to);
	const mark = template.indexOf("|");
	const body = mark < 0 ? template : template.slice(0, mark) + template.slice(mark + 1);
	const local = mark < 0 ? body.length : mark;
	const mode = mathContext(base, from);
	let insertion: string;
	let caretIn: number;
	const unclosed = mode === "inside" ? unclosedAt(base, from) : null;
	if (unclosed && from === unclosed.end) {
		const closer = base.startsWith("$$", unclosed.start) ? "$$" : "$";
		insertion = body + closer;
		caretIn = mark < 0 ? insertion.length : local;
	} else if (mode === "inside") {
		insertion = body;
		caretIn = local;
	} else if (mode === "display-open") {
		insertion = `${body}$$`;
		caretIn = mark < 0 ? insertion.length : local;
	} else if (mode === "inline-open") {
		insertion = `${body}$`;
		caretIn = mark < 0 ? insertion.length : local;
	} else {
		const prev = base[from - 1] ?? "";
		const gap = prev && !/[\s([{]/.test(prev) ? " " : "";
		insertion = `${gap}$${body}$`;
		caretIn = mark < 0 ? insertion.length : gap.length + 1 + local;
	}
	return { source: base.slice(0, from) + insertion + base.slice(from), caret: from + caretIn };
}

function clamp(n: number, max: number): number {
	return Math.max(0, Math.min(n, max));
}

function escaped(s: string, index: number): boolean {
	let slashes = 0;
	for (let k = index - 1; k >= 0 && s[k] === "\\"; k--) slashes++;
	return slashes % 2 === 1;
}

function endsSpan(source: string, caret: number): boolean {
	return mathSpans(source).some((span) => span.end === caret);
}

/** An unclosed `$` / `$$` whose region contains `caret`, if the caret is still inside it. */
function unclosedAt(source: string, caret: number): OpenSpan | null {
	return openSpans(source).find((span) => caret > span.start && caret <= span.end) ?? null;
}

/** True when `caret` is strictly inside a formula, including one not yet closed. */
function insideMath(source: string, caret: number): boolean {
	if (mathSpans(source).some((span) => caret > span.start && caret < span.end)) return true;
	return openSpans(source).some((span) => caret > span.start && caret <= span.end);
}

function fenceRuns(source: string): Array<{ fence: boolean; start: number; end: number }> {
	if (!source) return [];
	const lines = source.split("\n");
	const lineAt: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineAt.push(offset);
		offset += line.length + 1;
	}
	const out: Array<{ fence: boolean; start: number; end: number }> = [];
	let fence: string | null = null;
	let startLine = 0;
	const emit = (endLine: number, isFence: boolean) => {
		if (endLine <= startLine) return;
		const start = lineAt[startLine] ?? 0;
		const end = endLine < lines.length ? (lineAt[endLine] ?? source.length) : source.length;
		out.push({ fence: isFence, start, end });
		startLine = endLine;
	};
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (fence) {
			if (trimmed.startsWith(fence)) {
				emit(i + 1, true);
				fence = null;
			}
			continue;
		}
		const marker = FENCE_LINE.exec(trimmed);
		if (marker) {
			emit(i, false);
			fence = marker[1];
		}
	}
	emit(lines.length, !!fence);
	return out;
}

function mathSpans(source: string): MathSpan[] {
	const spans: MathSpan[] = [];
	for (const run of fenceRuns(source)) {
		if (run.fence) continue;
		scanRun(source, run.start, run.end, spans, null);
	}
	return spans;
}

function openSpans(source: string): OpenSpan[] {
	const open: OpenSpan[] = [];
	for (const run of fenceRuns(source)) {
		if (run.fence) continue;
		scanRun(source, run.start, run.end, null, open);
	}
	return open;
}

function scanRun(source: string, from: number, limit: number, spans: MathSpan[] | null, open: OpenSpan[] | null): void {
	let i = from;
	while (i < limit) {
		const c = source[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "`") {
			const tick = /^`+/.exec(source.slice(i, limit))?.[0] ?? "`";
			const end = source.indexOf(tick, i + tick.length);
			i = end < 0 || end >= limit ? i + tick.length : end + tick.length;
			continue;
		}
		if (source.startsWith("$$", i)) {
			const end = source.indexOf("$$", i + 2);
			if (end < 0 || end >= limit) {
				open?.push({ start: i, end: limit });
				break;
			}
			const tex = source
				.slice(i + 2, end)
				.replace(/\n[ \t]*(?:>[ \t]?)+/g, "\n")
				.trim();
			if (tex) spans?.push({ tex, display: true, raw: source.slice(i, end + 2), start: i, end: end + 2 });
			i = end + 2;
			continue;
		}
		if (c === "$") {
			const match = probeDollar(source, i, limit);
			if (match.type === "closed") {
				spans?.push({ tex: source.slice(i + 1, match.end), display: false, raw: source.slice(i, match.end + 1), start: i, end: match.end + 1 });
				i = match.end + 1;
				continue;
			}
			if (match.type === "open") {
				open?.push({ start: i, end: limit });
				break;
			}
			i++;
			continue;
		}
		i++;
	}
}

function probeDollar(s: string, i: number, limit: number): { type: "closed"; end: number } | { type: "open" } | { type: "no" } {
	if (i + 1 >= limit || /\s/.test(s[i + 1] ?? " ")) return { type: "no" };
	for (let j = i + 1; j < limit; j++) {
		if (s[j] === "\\") {
			j++;
			continue;
		}
		if (s[j] === "`" || (s[j] === "\n" && s[j + 1] === "\n")) return { type: "no" };
		if (s[j] !== "$") continue;
		const next = j + 1 < limit ? (s[j + 1] ?? "") : "";
		if (/\s/.test(s[j - 1] ?? "") || /\d/.test(next)) return { type: "no" };
		return { type: "closed", end: j };
	}
	return { type: "open" };
}
