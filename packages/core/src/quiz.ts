import type { EvidenceKind, Outcome } from "./model";

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
	options: QuizOptionInput[];
	correctAnswer: string | string[];
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
	options: QuizOption[];
	correct: string[];
	explanation: string;
	difficulty: number;
	kind: EvidenceKind;
	multiSelect: boolean;
}

export interface QuizResponse {
	dontKnow: boolean;
	selected: string[];
	note?: string;
}

export interface QuizGrade {
	outcome: Outcome;
	correct: boolean;
	selectedLabels: string[];
	correctLabels: string[];
	misconception?: string;
}

export function prepareQuiz(input: QuizInput, random: () => number = Math.random): PreparedQuiz {
	const seen = new Set<string>();
	const options: QuizOption[] = [];
	for (const o of input.options ?? []) {
		const label = String(o.label ?? "").trim();
		if (!label) continue;
		const value = String(o.value ?? label).trim();
		if (seen.has(value)) throw new Error(`Duplicate option value "${value}".`);
		seen.add(value);
		options.push({ label, value, misconception: o.misconception?.trim() || undefined });
	}
	if (options.length < 2) throw new Error("A quiz needs at least two options.");
	if (options.some((o) => /^(i don'?t know|not sure|i'?m not sure)$/i.test(o.label))) {
		throw new Error('Do not add an "I don\'t know" option; one is always shown automatically.');
	}

	const correct = coerceAnswer(input.correctAnswer).map((v) => v.trim());
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

	return {
		id: `q_${Date.now().toString(36)}${Math.floor(random() * 1e6).toString(36)}`,
		concept: input.concept,
		question: input.question.trim(),
		details: input.details?.trim() || undefined,
		options,
		correct: [...new Set(correct)],
		explanation: input.explanation?.trim() ?? "",
		difficulty: Math.min(5, Math.max(1, Math.round(input.difficulty || 3))),
		kind: input.kind ?? "check",
		multiSelect,
	};
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

export function gradeQuiz(quiz: PreparedQuiz, response: QuizResponse): QuizGrade {
	const label = (v: string) => quiz.options.find((o) => o.value === v)?.label ?? v;
	const correctLabels = quiz.correct.map(label);
	if (response.dontKnow) {
		return { outcome: "dont_know", correct: false, selectedLabels: [], correctLabels };
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
