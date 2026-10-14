/**
 * The keyed option is chosen after the question is solved.
 * A letter or an index is not an answer. A sign chart is checked by
 * substituting a point in each interval, and that check wins over the key.
 */

import { compileExpr } from "./figure";

export interface KeyOption {
	label: string;
	value: string;
}

export interface ChoiceKeyInput {
	question: string;
	explanation: string;
	solution?: string;
	answer?: string;
	options: KeyOption[];
	stated: string[];
	multiSelect: boolean;
}

/** Enough of a prepared choice question to re-check the key at grade time. */
export interface GradedChoice {
	format: string;
	multiSelect: boolean;
	question: string;
	explanation: string;
	solution?: string;
	answer?: string;
	options: KeyOption[];
	correct: string[];
}

const SIGN = /^(?:positive|pos|\+|negative|neg|−|–|-)$/i;

/** Thrown before a card is shown. The tutor has to send the question again. */
export class QuizKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QuizKeyError";
	}
}

/**
 * The option values to grade and to highlight. An independent check replaces
 * a stored key that points at a different claim.
 */
export function choiceKey(quiz: GradedChoice): string[] {
	if (quiz.format === "free" || quiz.multiSelect) return quiz.correct;
	const math = signChartAnswer(quiz.question);
	if (math) {
		const hit = matchSigns(quiz.options, math);
		if (hit) return [hit.value];
	}
	const explained = statedSignsOption(quiz.options, `${quiz.solution ?? ""}\n${quiz.explanation}`);
	if (explained && !quiz.correct.includes(explained.value)) return [explained.value];
	const claim = matchClaim(quiz.options, quiz.answer);
	if (claim) return [claim.value];
	return quiz.correct;
}

/**
 * Bind the key before the question is shown. The worked claim wins over a
 * letter or an index. A computable sign chart wins over both, and a
 * disagreement is refused instead of shown.
 */
export function settleChoice(input: ChoiceKeyInput): string[] {
	if (input.multiSelect) return input.stated;
	const math = signChartAnswer(input.question);
	const claim = matchClaim(input.options, input.answer);
	const fromSolution = statedSigns(input.solution ?? "");
	const fromExplanation = statedSigns(input.explanation);
	if (fromSolution && fromExplanation && !sameSigns(fromSolution, fromExplanation)) {
		throw new QuizKeyError(
			"The worked solution and the explanation name different answers. Recompute and call quiz again. The question was not shown.",
		);
	}
	if (math) {
		const hit = matchSigns(input.options, math);
		if (!hit) {
			throw new QuizKeyError(
				`An independent check says the answer is "${math.join(", ")}", and no option says that. Fix the options and call quiz again. The question was not shown.`,
			);
		}
		if (claim && claim.value !== hit.value) {
			throw new QuizKeyError(
				`The worked answer and an independent check disagree. The check says "${math.join(", ")}". Recompute and call quiz again. The question was not shown.`,
			);
		}
		const prose = fromExplanation ?? fromSolution;
		if (prose && !sameSigns(prose, math)) {
			throw new QuizKeyError(
				`The explanation and an independent check disagree. The check says "${math.join(", ")}". Recompute and call quiz again. The question was not shown.`,
			);
		}
		return [hit.value];
	}
	if (claim) return [claim.value];
	return input.stated;
}

function matchClaim(options: KeyOption[], answer: string | undefined): KeyOption | undefined {
	const text = answer?.trim() ?? "";
	if (!text || isIndexToken(text)) return undefined;
	const want = norm(text);
	return options.find((option) => norm(option.label) === want || norm(option.value) === want);
}

function isIndexToken(text: string): boolean {
	return /^[a-z]$/i.test(text) || /^\d+$/.test(text);
}

function statedSignsOption(options: KeyOption[], text: string): KeyOption | undefined {
	const signs = statedSigns(text);
	if (!signs) return undefined;
	return matchSigns(options, signs);
}

function matchSigns(options: KeyOption[], signs: string[]): KeyOption | undefined {
	return options.find((option) => sameSigns(parseSignList(option.label), signs));
}

function sameSigns(a: string[] | null, b: string[] | null): boolean {
	return !!a && !!b && a.length === b.length && a.every((sign, i) => sign === b[i]);
}

/** The sign tuple a solution states after it has finished the arithmetic. */
function statedSigns(text: string): string[] | null {
	const plain = text.replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/\$[^$]*\$/g, " ");
	const cue = /(?:the signs are|the sign pattern is|so the signs(?: are)?|therefore the signs(?: are)?|thus the signs(?: are)?)\s+([^.]+)/i.exec(plain);
	if (!cue) return null;
	return parseSignList(cue[1] ?? "");
}

function parseSignList(text: string): string[] | null {
	const parts = text
		.split(/,|\/|\bthen\b|\band\b/i)
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length < 2) return null;
	const signs: string[] = [];
	for (const part of parts) {
		const token = signToken(part);
		if (!token) return null;
		signs.push(token);
	}
	return signs;
}

function signToken(part: string): "positive" | "negative" | null {
	const token = part.toLowerCase().replace(/[$*.]/g, "").trim();
	if (!SIGN.test(token)) return null;
	return token === "+" || token === "positive" || token === "pos" ? "positive" : "negative";
}

/**
 * Signs of a factored expression on the intervals named in the question.
 * Null when this is not that kind of question. The key is not an input.
 */
export function signChartAnswer(question: string): string[] | null {
	const text = question
		.replace(/\\(?:leq|le|lt)/g, "<")
		.replace(/\\(?:geq|ge|gt)/g, ">")
		.replace(/\\(?:left|right|,|;)/g, "")
		.replace(/\$/g, " ");
	const eq = /[a-z]\s*\(\s*([a-z])\s*\)\s*=\s*([^.;\n]+)/i.exec(text);
	if (!eq) return null;
	const variable = eq[1].toLowerCase();
	const expr = (eq[2] ?? "").split(/\b(?:across|over|for|on|where|when)\b/i)[0]?.trim().replace(/[,.]$/, "") ?? "";
	if (!expr) return null;
	const spans = intervals(text).filter((span) => span.variable === variable);
	if (spans.length < 2) return null;
	let fn: (env: Record<string, number>) => number;
	try {
		fn = compileExpr(implicitProduct(expr), [variable]);
	} catch {
		return null;
	}
	const signs: string[] = [];
	for (const span of spans) {
		const sign = signAt(fn, variable, span);
		if (!sign) return null;
		signs.push(sign);
	}
	return signs;
}

function intervals(text: string): Array<{ lo: number; hi: number; variable: string }> {
	const out: Array<{ lo: number; hi: number; variable: string }> = [];
	const re = /(-?\d+(?:\.\d+)?)\s*<\s*([a-z])\s*<\s*(-?\d+(?:\.\d+)?)|([a-z])\s*<\s*(-?\d+(?:\.\d+)?)|([a-z])\s*>\s*(-?\d+(?:\.\d+)?)/gi;
	for (const match of text.matchAll(re)) {
		if (match[1] != null) out.push({ lo: Number(match[1]), hi: Number(match[3]), variable: match[2].toLowerCase() });
		else if (match[4] != null) out.push({ lo: Number.NEGATIVE_INFINITY, hi: Number(match[5]), variable: match[4].toLowerCase() });
		else out.push({ lo: Number(match[7]), hi: Number.POSITIVE_INFINITY, variable: match[6].toLowerCase() });
	}
	return out;
}

function implicitProduct(expr: string): string {
	return expr.replace(/\s+/g, "").replace(/\)\(/g, ")*(").replace(/(\d)\(/g, "$1*(").replace(/([a-z])\(/g, "$1*(").replace(/\)([a-z0-9])/g, ")*$1");
}

function signAt(fn: (env: Record<string, number>) => number, variable: string, span: { lo: number; hi: number }): "positive" | "negative" | null {
	for (const x of samples(span.lo, span.hi)) {
		let y: number;
		try {
			y = fn({ [variable]: x });
		} catch {
			continue;
		}
		if (!Number.isFinite(y) || y === 0) continue;
		return y > 0 ? "positive" : "negative";
	}
	return null;
}

function samples(lo: number, hi: number): number[] {
	if (lo === Number.NEGATIVE_INFINITY) return [hi - 1, hi - 2, hi - 0.5];
	if (hi === Number.POSITIVE_INFINITY) return [lo + 1, lo + 2, lo + 0.5];
	return [lo + (hi - lo) / 2, lo + (hi - lo) * 0.25, lo + (hi - lo) * 0.75];
}

function norm(text: string): string {
	return text.toLowerCase().replace(/\$/g, "").replace(/\s+/g, " ").replace(/[.]/g, "").trim();
}
