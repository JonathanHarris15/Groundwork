import { MAX_FAMILIARITY, type EvidenceKind, type Outcome } from "./model";
import { normalizeTutorMarkdown } from "./tutor-markdown";

export type QuizFormat = "choice" | "free";

export interface QuizOptionInput {
	label: string;
	value?: string;
	/** For a distractor: the belief someone would have to hold to pick it. Recorded when chosen. */
	misconception?: string;
}

export interface QuizInput {
	concept: string;
	question: string;
	details?: string;
	/** Shown above the question: what this checks and how it moves them toward their goal. */
	purpose?: string;
	/** "choice" (default) is graded instantly; "free" is a typed answer (LaTeX allowed) the tutor grades. */
	format?: QuizFormat;
	options?: QuizOptionInput[];
	correctAnswer?: string | string[];
	/** Free response: the model answer, shown after grading. */
	referenceAnswer?: string;
	/** Free response: what full credit and partial credit require. */
	rubric?: string;
	explanation: string;
	difficulty: number;
	kind?: EvidenceKind;
	multiSelect?: boolean;
	shuffle?: boolean;
}

export interface QuizOption {
	label: string;
	value: string;
	misconception?: string;
}

export interface PreparedQuiz {
	id: string;
	concept: string;
	question: string;
	details?: string;
	purpose?: string;
	format: QuizFormat;
	options: QuizOption[];
	correct: string[];
	reference?: string;
	rubric?: string;
	explanation: string;
	difficulty: number;
	kind: EvidenceKind;
	multiSelect: boolean;
}

export interface QuizResponse {
	dontKnow: boolean;
	selected: string[];
	/** For "I don't know": 0 = never seen this … MAX_FAMILIARITY = very familiar, almost have it. */
	familiarity?: number;
	/** Free response: the learner's answer (markdown + LaTeX). */
	text?: string;
	note?: string;
}

export interface QuizGrade {
	outcome: Outcome;
	correct: boolean;
	selectedLabels: string[];
	correctLabels: string[];
	misconception?: string;
	/** Free response: the tutor's feedback on what they wrote. */
	feedback?: string;
	/** The understanding was right; only a non-conceptual slip went wrong. */
	slip?: boolean;
}

/** The tutor's judgment of a free-response answer. */
export interface FreeResponseJudgment {
	outcome: "correct" | "partial" | "incorrect";
	feedback?: string;
	misconception?: string;
	/** Right method, careless error (arithmetic, sign, copying, typo). Recorded as correct with a slip, whatever outcome says. */
	slip?: boolean;
}

export const FAMILIARITY_LABELS = [
	"I've never seen this",
	"Seen it before, can't place it",
	"Rings a bell, but I'm not sure",
	"Very familiar, I almost have it",
] as const;

export function clampFamiliarity(n: unknown): number | undefined {
	const v = typeof n === "number" ? n : typeof n === "string" && n.trim() ? Number(n) : NaN;
	if (!Number.isFinite(v)) return undefined;
	return Math.min(MAX_FAMILIARITY, Math.max(0, Math.round(v)));
}

export function familiarityLabel(n: number | undefined): string {
	return FAMILIARITY_LABELS[clampFamiliarity(n) ?? 0];
}

/** Read a familiarity level out of how the learner phrased "I don't know" in chat. */
export function parseFamiliarity(text: string): number | undefined {
	const t = text.toLowerCase();
	if (/almost|tip of (my|the) tongue|very familiar|so close|nearly/.test(t)) return 3;
	if (/never (seen|heard)|no idea|new to me|clueless|no clue/.test(t)) return 0;
	if (/rings? a bell|familiar|vaguely|sort of|kind of/.test(t)) return 2;
	if (/seen (it|this)|heard of|can'?t (place|remember|recall)|forgot/.test(t)) return 1;
	return undefined;
}

export function prepareQuiz(input: QuizInput, random: () => number = Math.random): PreparedQuiz {
	const format: QuizFormat = input.format === "free" ? "free" : "choice";
	const base = {
		id: `q_${Date.now().toString(36)}${Math.floor(random() * 1e6).toString(36)}`,
		concept: input.concept,
		question: normalizeTutorMarkdown(String(input.question ?? "").trim()),
		details: input.details?.trim() ? normalizeTutorMarkdown(input.details.trim()) : undefined,
		purpose: input.purpose?.trim() ? normalizeTutorMarkdown(input.purpose.trim()) : undefined,
		explanation: normalizeTutorMarkdown(input.explanation?.trim() ?? ""),
		difficulty: Math.min(5, Math.max(1, Math.round(input.difficulty || 3))),
		kind: input.kind ?? "check",
	};
	if (!base.question) throw new Error("A quiz needs a question.");

	if (format === "free") {
		const reference = String(input.referenceAnswer ?? "").trim();
		if (!reference) throw new Error("A free-response question needs a referenceAnswer (the model answer).");
		return {
			...base,
			format,
			options: [],
			correct: [],
			reference: normalizeTutorMarkdown(reference),
			rubric: input.rubric?.trim() ? normalizeTutorMarkdown(input.rubric.trim()) : undefined,
			multiSelect: false,
		};
	}

	const seen = new Set<string>();
	const options: QuizOption[] = [];
	for (const o of input.options ?? []) {
		const label = String(o.label ?? "").trim();
		if (!label) continue;
		const value = String(o.value ?? label).trim();
		if (seen.has(value)) throw new Error(`Duplicate option value "${value}".`);
		seen.add(value);
		options.push({ label: normalizeTutorMarkdown(label), value, misconception: o.misconception?.trim() || undefined });
	}
	if (options.length < 2) throw new Error('A multiple-choice quiz needs at least two options. For a typed answer use format "free" with a referenceAnswer.');
	if (options.some((o) => /^(i don'?t know|not sure|i'?m not sure)$/i.test(o.label))) {
		throw new Error('Do not add an "I don\'t know" option; one is always shown automatically.');
	}

	const correct = coerceAnswer(input.correctAnswer ?? "").map((v) => v.trim());
	if (!correct.length) throw new Error("correctAnswer is required.");
	for (const v of correct) {
		if (!seen.has(v)) {
			throw new Error(`correctAnswer "${v}" does not match any option value (${[...seen].map((s) => `"${s}"`).join(", ")}).`);
		}
	}
	const multiSelect = input.multiSelect ?? correct.length > 1;
	if (!multiSelect && correct.length > 1) throw new Error("Several correct answers require multiSelect: true.");

	if (input.shuffle !== false) {
		for (let i = options.length - 1; i > 0; i--) {
			const j = Math.floor(random() * (i + 1));
			[options[i], options[j]] = [options[j], options[i]];
		}
	}

	return { ...base, format, options, correct: [...new Set(correct)], multiSelect };
}

/** Models sometimes send a multi-select answer as a JSON-encoded string. */
function coerceAnswer(answer: string | string[]): string[] {
	if (Array.isArray(answer)) return answer.map(String);
	const t = String(answer ?? "").trim();
	if (t.startsWith("[") && t.endsWith("]")) {
		try {
			const parsed = JSON.parse(t);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch {
			// fall through: treat as a literal value
		}
	}
	return t ? [t] : [];
}

/** A free-response answer needs the tutor's judgment unless the learner said "I don't know". */
export function needsJudgment(quiz: PreparedQuiz, response: QuizResponse): boolean {
	return quiz.format === "free" && !response.dontKnow;
}

export function gradeQuiz(quiz: PreparedQuiz, response: QuizResponse, judgment?: FreeResponseJudgment): QuizGrade {
	const label = (v: string) => quiz.options.find((o) => o.value === v)?.label ?? v;
	const correctLabels = quiz.format === "free" ? [quiz.reference ?? ""] : quiz.correct.map(label);
	if (response.dontKnow) {
		return { outcome: "dont_know", correct: false, selectedLabels: [], correctLabels };
	}
	if (quiz.format === "free") {
		if (!judgment) throw new Error("A free-response answer is graded by the tutor: pass a judgment.");
		const slip = judgment.slip === true;
		const outcome = slip ? "correct" : judgment.outcome === "correct" || judgment.outcome === "partial" ? judgment.outcome : "incorrect";
		return {
			outcome,
			correct: outcome === "correct",
			selectedLabels: response.text ? [response.text] : [],
			correctLabels,
			misconception: outcome !== "correct" ? judgment.misconception?.trim() || undefined : undefined,
			feedback: judgment.feedback?.trim() ? normalizeTutorMarkdown(judgment.feedback.trim()) : undefined,
			...(slip ? { slip } : {}),
		};
	}
	const sel = [...new Set(response.selected)];
	const ok = sel.length === quiz.correct.length && sel.every((v) => quiz.correct.includes(v));
	const wrongPicks = sel.filter((v) => !quiz.correct.includes(v));
	const misconception = wrongPicks
		.map((v) => quiz.options.find((o) => o.value === v)?.misconception)
		.filter(Boolean)
		.join("; ");
	return {
		outcome: ok ? "correct" : "incorrect",
		correct: ok,
		selectedLabels: sel.map(label),
		correctLabels,
		misconception: !ok && misconception ? misconception : undefined,
	};
}

/** Resolve a free-form answer from chat ("B", "2", "b and d", an option value or label) to option values. */
export function parseChatAnswer(quiz: PreparedQuiz, answer: string | string[]): string[] {
	const parts = Array.isArray(answer)
		? answer
		: String(answer)
				.split(/,|\band\b|&|\s+/i)
				.map((s) => s.trim())
				.filter(Boolean);
	const out: string[] = [];
	for (const raw of parts) {
		const p = raw.replace(/[().:]/g, "").trim();
		const byValue = quiz.options.find((o) => o.value === raw || o.value === p);
		const byLabel = quiz.options.find((o) => o.label.toLowerCase() === raw.toLowerCase());
		let byLetter: QuizOption | undefined;
		if (/^[a-z]$/i.test(p)) byLetter = quiz.options[p.toLowerCase().charCodeAt(0) - 97];
		else if (/^\d+$/.test(p)) byLetter = quiz.options[Number(p) - 1];
		const hit = byValue ?? byLabel ?? byLetter;
		if (hit && !out.includes(hit.value)) out.push(hit.value);
	}
	if (!out.length && !Array.isArray(answer)) {
		const whole = quiz.options.find((o) => o.label.toLowerCase() === String(answer).trim().toLowerCase());
		if (whole) out.push(whole.value);
	}
	return out;
}

export const letter = (i: number) => String.fromCharCode(65 + i);
