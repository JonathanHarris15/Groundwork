/**
 * Quiz and ask_user copy is shown with MathJax/KaTeX-style `$…$` / `$$…$$`.
 * Broken delimiters or TeX left outside math mode must not reach the learner.
 */

import type { PreparedQuiz } from "./quiz";
import { QuizKeyError } from "./quiz-key";
import type { QuizKeySubject } from "./quiz-key-jev";

const FENCE_LINE = /^(```+|~~~+)/;

/** TeX commands that must sit inside math delimiters when shown on a card. */
const TEX_OUTSIDE_MATH = /\\(?:hat|bar|top|bot|frac|dfrac|mathbf|mathrm|mathbb|mathit|mathcal|cdot|times|neq|leq|geq|approx|equiv|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|phi|omega|nabla|sum|prod|int|partial|infty|ldots|cdots|left|right|text|operatorname)\b/;

/** `$` jammed inside a token (`c$tops`) — usually a split `c^\top` or bad pairing. */
const MANGLED_DOLLAR = /[A-Za-z0-9]\$[A-Za-z]/;

/** Superscript/subscript outside math delimiters. */
const SUPER_OUTSIDE = /[A-Za-z0-9](?:\^|_)(?:\{[^}]*\}|[A-Za-z0-9])/;

/** Unicode stand-ins for `\bar{…}` / accents when LaTeX was dropped. */
const UNICODE_MATH_SUB = /[ūŪȳȲḇḂẖḦ]/;

export interface MathFieldIssue {
	field: string;
	text: string;
	reasons: string[];
}

export function mathDefects(md: string): string[] {
	if (!md?.trim()) return [];
	const reasons: string[] = [];
	for (const part of splitFences(md)) {
		if (part.fence) continue;
		reasons.push(...scanPart(part.text));
	}
	return [...new Set(reasons)];
}

export function quizMathIssues(quiz: QuizKeySubject & { details?: string; purpose?: string; reference?: string }): MathFieldIssue[] {
	const fields: Array<{ field: string; text: string | undefined }> = [
		{ field: "question", text: quiz.question },
		{ field: "details", text: quiz.details },
		{ field: "purpose", text: quiz.purpose },
		{ field: "solution", text: quiz.solution },
		{ field: "answer", text: quiz.answer },
		{ field: "explanation", text: quiz.explanation },
		{ field: "reference", text: quiz.reference },
	];
	for (let index = 0; index < (quiz.options?.length ?? 0); index++) {
		const option = quiz.options![index];
		fields.push({ field: `options[${index}].label`, text: option.label });
	}
	const out: MathFieldIssue[] = [];
	for (const { field, text } of fields) {
		if (!text?.trim()) continue;
		const reasons = mathDefects(text);
		if (reasons.length) out.push({ field, text, reasons });
	}
	return out;
}

export function assertQuizMath(quiz: QuizKeySubject & { details?: string; purpose?: string; reference?: string }): void {
	const issues = quizMathIssues(quiz);
	if (!issues.length) return;
	throw new QuizKeyError(formatMathRefusal(issues));
}

export function assertAskUserMath(input: { question?: string; details?: string; options?: string[] }): void {
	const fields: Array<{ field: string; text: string | undefined }> = [
		{ field: "question", text: input.question },
		{ field: "details", text: input.details },
	];
	for (let index = 0; index < (input.options?.length ?? 0); index++) {
		fields.push({ field: `options[${index}]`, text: input.options![index] });
	}
	const issues: MathFieldIssue[] = [];
	for (const { field, text } of fields) {
		if (!text?.trim()) continue;
		const reasons = mathDefects(text);
		if (reasons.length) issues.push({ field, text, reasons });
	}
	if (!issues.length) return;
	throw new QuizKeyError(formatMathRefusal(issues, "ask_user"));
}

function formatMathRefusal(issues: MathFieldIssue[], tool = "quiz"): string {
	const lines = issues.flatMap((issue) => [
		`- ${issue.field}: ${issue.reasons.join("; ")}`,
		`  Original: ${clip(issue.text)}`,
	]);
	return [
		`Broken math in ${tool === "quiz" ? "this question" : "this prompt"} was not shown. Wrap each formula in $…$ or $$…$$, keep delimiters balanced, and do not leave TeX commands outside math mode. Then call ${tool} again.`,
		...lines,
	].join("\n");
}

function clip(text: string, cap = 220): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

function scanPart(text: string): string[] {
	const reasons: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (text.startsWith("$$", i)) {
			const end = text.indexOf("$$", i + 2);
			if (end < 0) {
				reasons.push("unclosed display math (`$$`)");
				break;
			}
			const inner = text.slice(i + 2, end);
			if (braceImbalance(inner)) reasons.push("unbalanced `{` `}` inside display math");
			i = end + 2;
			continue;
		}
		if (text[i] === "\\" && text[i + 1] === "$") {
			i += 2;
			continue;
		}
		if (text[i] === "`") {
			const tick = /^`+/.exec(text.slice(i))![0];
			const end = text.indexOf(tick, i + tick.length);
			i = end < 0 ? text.length : end + tick.length;
			continue;
		}
		if (text[i] === "$") {
			if (/[A-Za-z0-9]/.test(text[i - 1] ?? "") && /[A-Za-z]/.test(text[i + 1] ?? "")) {
				reasons.push("dollar sign inside a token (for example `c$tops` from a split `c^\\top`)");
				i++;
				continue;
			}
			if (/\s/.test(text[i + 1] ?? " ")) {
				reasons.push("stray `$` delimiter");
				i++;
				continue;
			}
			const end = closingInlineDollar(text, i + 1);
			if (end < 0) {
				reasons.push("unclosed inline math (`$`)");
				break;
			}
			const inner = text.slice(i + 1, end);
			if (inner.includes("$")) reasons.push("nested `$` inside inline math");
			if (MANGLED_DOLLAR.test(inner)) reasons.push("dollar sign inside a token (for example `c$tops` from a split `c^\\top`)");
			if (braceImbalance(inner)) reasons.push("unbalanced `{` `}` inside inline math");
			i = end + 1;
			continue;
		}
		const proseStart = i;
		while (i < text.length) {
			if (text.startsWith("$$", i) || text[i] === "$" || text[i] === "`") break;
			if (text[i] === "\\" && text[i + 1] === "$") {
				i += 2;
				continue;
			}
			i++;
		}
		const prose = text.slice(proseStart, i);
		reasons.push(...proseDefects(prose, text.slice(0, proseStart)));
	}
	return reasons;
}

function proseDefects(prose: string, before: string): string[] {
	if (!prose) return [];
	const reasons: string[] = [];
	if (MANGLED_DOLLAR.test(prose)) reasons.push("dollar sign inside a token (for example `c$tops` from a split `c^\\top`)");
	if (TEX_OUTSIDE_MATH.test(prose)) reasons.push("TeX command outside math delimiters");
	if (SUPER_OUTSIDE.test(prose)) reasons.push("superscript or subscript outside math delimiters");
	if (UNICODE_MATH_SUB.test(prose)) reasons.push("unicode math symbol where LaTeX delimiters were expected");
	if (countStrayDollars(prose)) reasons.push("unbalanced `$` delimiters");
	if (before.endsWith("$") && orphanMathFragment(prose)) {
		reasons.push("math `$` closed too early (orphan fragment after a formula)");
	}
	return reasons;
}

function orphanMathFragment(prose: string): boolean {
	const t = prose.trimStart();
	return /^[A-Za-z]{2,}\s*[+*/=^-]/.test(t);
}

function closingInlineDollar(s: string, from: number): number {
	for (let j = from; j < s.length; j++) {
		if (s[j] === "\\") {
			j++;
			continue;
		}
		if (s[j] === "`" || (s[j] === "\n" && s[j + 1] === "\n")) return -1;
		if (s[j] !== "$") continue;
		return /\s/.test(s[j - 1]) || /\d/.test(s[j + 1] ?? "") ? -1 : j;
	}
	return -1;
}

function braceImbalance(inner: string): boolean {
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		if (inner[i] === "\\") {
			i++;
			continue;
		}
		if (inner[i] === "{") depth++;
		else if (inner[i] === "}") depth--;
		if (depth < 0) return true;
	}
	return depth !== 0;
}

function countStrayDollars(segment: string): boolean {
	let n = 0;
	for (let i = 0; i < segment.length; i++) {
		if (segment[i] === "\\" && segment[i + 1] === "$") {
			i++;
			continue;
		}
		if (segment[i] === "$") n++;
	}
	return n % 2 !== 0;
}

function splitFences(md: string): Array<{ fence: boolean; text: string }> {
	const out: Array<{ fence: boolean; text: string }> = [];
	const lines = md.split("\n");
	let fence: string | null = null;
	let start = 0;
	const emit = (end: number, isFence: boolean) => {
		if (end <= start) return;
		const text = lines.slice(start, end).join("\n");
		if (end < lines.length) out.push({ fence: isFence, text: text + "\n" });
		else out.push({ fence: isFence, text });
		start = end;
	};
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (fence) {
			if (t.startsWith(fence)) {
				emit(i + 1, true);
				fence = null;
			}
			continue;
		}
		const m = FENCE_LINE.exec(t);
		if (m) {
			emit(i, false);
			fence = m[1];
		}
	}
	emit(lines.length, !!fence);
	return out;
}

/** Prepared quiz fields after normalization — used in tests and Obsidian UI gates. */
export function preparedQuizMathIssues(quiz: PreparedQuiz): MathFieldIssue[] {
	return quizMathIssues(quiz);
}
