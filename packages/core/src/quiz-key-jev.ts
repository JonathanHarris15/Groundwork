/**
 * A third check on a choice key, after the generator's worked answer and the
 * deterministic sign chart. The model is the one the jev/fastbrowse smoke
 * check uses. A question is not shown until this check confirms the key.
 */

import { buildUpstream, readUpstream, upstreamErrorMessage } from "./account/tutor";
import type { HttpClient } from "./http";
import { httpClient } from "./http";
import { QuizKeyError, signChartAnswer, signChartOption, type QuizKeyCheck } from "./quiz-key";
import type { FreeResponseJudgment, PreparedQuiz, QuizResponse } from "./quiz";
import { asRecord, asText, asUnknown } from "./unknown";

/** `FASTBROWSE_LLM_MODEL` in the jev smoke check. */
export const QUIZ_KEY_MODEL = "openai/gpt-6-luna";

/** Listed OpenRouter rates for gpt-6-luna, October 2026. */
export const QUIZ_KEY_INPUT_USD_PER_MILLION = 0.1;
export const QUIZ_KEY_OUTPUT_USD_PER_MILLION = 0.5;

/** Enough room for a short low-effort check plus the JSON verdict. */
const QUIZ_KEY_MAX_TOKENS = 256;
const FIELD_CAP = 700;

const QUIZ_KEY_SYSTEM = [
	"You check a multiple-choice key. Reply with one JSON object and no other text.",
	'{"matchesExplanation":boolean,"keyedCorrect":boolean,"anotherAlsoCorrect":boolean,"correctValue":string|null}',
	"matchesExplanation: the keyed option makes the same claim as the worked solution and explanation.",
	"keyedCorrect: that option is right.",
	"anotherAlsoCorrect: some other option is also right.",
	"correctValue: the value of the one right option, or null if none or more than one is right.",
	"When course names a preferred method, the keyed option follows that method and its notation. A different valid method is not also correct when the question asked for the preferred one.",
].join(" ");

const FREE_KEY_SYSTEM = [
	"You check a free-response reference answer. Reply with one JSON object and no other text.",
	'{"matchesExplanation":boolean,"referenceCorrect":boolean,"learnerCorrect":boolean|null,"correctedReference":string|null}',
	"matchesExplanation: the reference answer makes the same claim as the worked solution and explanation.",
	"referenceCorrect: the reference answer is right.",
	"learnerCorrect: the learner's answer is right, or null when no learner answer was given.",
	"correctedReference: a correct reference when the given one is wrong, otherwise null.",
	"When course names a preferred method, a different valid method is still a correct reference. Do not mark it wrong for using the other method.",
].join(" ");

export interface QuizKeyVerdict {
	matchesExplanation: boolean;
	keyedCorrect: boolean;
	anotherAlsoCorrect: boolean;
	correctValue: string | null;
}

export interface QuizKeyModelResult {
	verdict: QuizKeyVerdict;
	latencyMs: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	model: string;
}

export interface FreeKeyVerdict {
	matchesExplanation: boolean;
	referenceCorrect: boolean;
	learnerCorrect: boolean | null;
	correctedReference: string | null;
}

export interface FreeKeyModelResult {
	verdict: FreeKeyVerdict;
	latencyMs: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	model: string;
}

/** A free-response question, plus the learner's answer when this check is grading. */
export interface FreeKeySubject {
	question: string;
	explanation: string;
	solution?: string;
	reference: string;
	learnerAnswer?: string;
	courseBrief?: string;
}

/** The part of a choice question the check needs. A prepared quiz satisfies it. */
export interface QuizKeySubject {
	question: string;
	explanation: string;
	solution?: string;
	answer?: string;
	options: Array<{ label: string; value: string }>;
	correct: string[];
	format?: string;
	multiSelect?: boolean;
	reference?: string;
	keyCheck?: QuizKeyCheck;
	courseBrief?: string;
}

export interface QuizKeyVerifier {
	verify(quiz: QuizKeySubject, signal?: AbortSignal): Promise<QuizKeyModelResult>;
	verifyFree?(quiz: FreeKeySubject, signal?: AbortSignal): Promise<FreeKeyModelResult>;
}

export function quizKeyCostUsd(usage: { input: number; output: number }): number {
	const cost = (usage.input * QUIZ_KEY_INPUT_USD_PER_MILLION + usage.output * QUIZ_KEY_OUTPUT_USD_PER_MILLION) / 1_000_000;
	return Math.round(cost * 1e8) / 1e8;
}

export function parseQuizKeyVerdict(text: string): QuizKeyVerdict | null {
	const raw = jsonObject(text);
	return raw ? verdictFrom(raw) : null;
}

export function parseFreeKeyVerdict(text: string): FreeKeyVerdict | null {
	const raw = jsonObject(text);
	return raw ? freeVerdictFrom(raw) : null;
}

export function parseFreeKeySubject(body: unknown): FreeKeySubject | null {
	const record = asRecord(body);
	if (!record || record.format !== "free") return null;
	const question = asText(record.question).trim();
	const reference = asText(record.reference ?? record.referenceAnswer).trim();
	if (!question || !reference) return null;
	const solution = asText(record.solution).trim();
	const learner = asText(record.learnerAnswer).trim();
	return {
		question,
		explanation: asText(record.explanation).trim(),
		solution: solution || undefined,
		reference,
		learnerAnswer: learner || undefined,
	};
}

export function parseQuizKeySubject(body: unknown): QuizKeySubject | null {
	const record = asRecord(body);
	if (!record || record.format === "free") return null;
	const question = asText(record.question).trim();
	if (!question) return null;
	const optionsRaw = record.options;
	if (!Array.isArray(optionsRaw) || optionsRaw.length < 2 || optionsRaw.length > 8) return null;
	const options: Array<{ label: string; value: string }> = [];
	const seen = new Set<string>();
	for (const item of optionsRaw) {
		const option = asRecord(item);
		if (!option) return null;
		const label = asText(option.label).trim();
		const value = asText(option.value).trim();
		if (!label || !value || seen.has(value)) return null;
		seen.add(value);
		options.push({ label, value });
	}
	const correctRaw = Array.isArray(record.correct) ? record.correct : [];
	const correct = correctRaw.filter((item): item is string => typeof item === "string" && seen.has(item));
	if (correct.length !== 1) return null;
	const solution = asText(record.solution).trim();
	const answer = asText(record.answer).trim();
	return {
		question,
		explanation: asText(record.explanation).trim(),
		solution: solution || undefined,
		answer: answer || undefined,
		options,
		correct,
		format: record.format === "free" ? "free" : "choice",
		multiSelect: record.multiSelect === true,
	};
}

export function asQuizKeyModelResult(value: unknown): QuizKeyModelResult | null {
	const parsed = modelEnvelope(value);
	if (!parsed) return null;
	const verdict = verdictFrom(parsed.verdict);
	if (!verdict) return null;
	return { ...parsed.envelope, verdict };
}

export function asFreeKeyModelResult(value: unknown): FreeKeyModelResult | null {
	const parsed = modelEnvelope(value);
	if (!parsed) return null;
	const verdict = freeVerdictFrom(parsed.verdict);
	if (!verdict) return null;
	return { ...parsed.envelope, verdict };
}

/**
 * Ask gpt-6-luna, through the same OpenRouter messages call the tutor uses.
 * Reasoning stays on low so a check stays a fraction of a cent.
 */
export async function askQuizKeyModel(http: HttpClient, apiKey: string, quiz: QuizKeySubject, signal?: AbortSignal): Promise<QuizKeyModelResult> {
	const checked = await completeCheck(http, apiKey, QUIZ_KEY_SYSTEM, quizKeyUser(quiz), signal);
	const verdict = parseQuizKeyVerdict(checked.text);
	if (!verdict) throw new Error("The quiz key check did not return a verdict.");
	return { ...checked.result, verdict };
}

/** The same OpenRouter check for a free-response reference, and for a written answer at grade time. */
export async function askFreeKeyModel(http: HttpClient, apiKey: string, quiz: FreeKeySubject, signal?: AbortSignal): Promise<FreeKeyModelResult> {
	const checked = await completeCheck(http, apiKey, FREE_KEY_SYSTEM, freeKeyUser(quiz), signal);
	const verdict = parseFreeKeyVerdict(checked.text);
	if (!verdict) throw new Error("The quiz key check did not return a verdict.");
	return { ...checked.result, verdict };
}

/** Confirm the key that would be shown. A miss, a disagreement, or a failed call throws and the card stays hidden. */
export async function confirmQuizKey<T extends QuizKeySubject>(quiz: T, verifier?: QuizKeyVerifier, signal?: AbortSignal): Promise<T> {
	if (quiz.format === "free") return confirmFreeKey(quiz, verifier, signal);
	if (!needsModelKeyCheck(quiz) || !verifier || quiz.keyCheck) return quiz;
	let result: QuizKeyModelResult;
	try {
		result = await verifier.verify(quiz, signal);
	} catch (err) {
		if (err instanceof QuizKeyError) throw err;
		throw new QuizKeyError("The independent key check did not answer. Call quiz again. The question was not shown.");
	}
	const decision = decideKey(quiz, result.verdict);
	if ("refuse" in decision) throw new QuizKeyError(decision.refuse);
	return stamp(quiz, decision.correct, result);
}

/**
 * The same check at grade time, for a question that was shown without one.
 * A failed call leaves the deterministic key in place. A confirmed or repaired
 * key replaces the stored one, so a right selection is not marked wrong.
 */
export async function recheckQuizKey<T extends QuizKeySubject>(quiz: T, verifier?: QuizKeyVerifier, signal?: AbortSignal): Promise<T> {
	if (!needsModelKeyCheck(quiz) || !verifier || quiz.keyCheck) return quiz;
	let result: QuizKeyModelResult;
	try {
		result = await verifier.verify(quiz, signal);
	} catch {
		return quiz;
	}
	const decision = decideKey(quiz, result.verdict);
	if ("correct" in decision) return stamp(quiz, decision.correct, result);
	const acceptable = knownCorrect(quiz, result.verdict);
	if (!acceptable.length) return quiz;
	return stamp(quiz, acceptable, result);
}

/**
 * Confirm a free-response reference before the card is shown.
 * With no free-response checker, the question is shown as written.
 * A failed call, a reference that does not match its explanation, or a wrong
 * reference with no replacement keeps the card hidden.
 */
export async function confirmFreeKey<T extends QuizKeySubject>(quiz: T, verifier?: QuizKeyVerifier, signal?: AbortSignal): Promise<T> {
	if (quiz.format !== "free" || !verifier?.verifyFree || quiz.keyCheck) return quiz;
	const reference = quiz.reference?.trim() ?? "";
	if (!reference) throw new QuizKeyError("A free-response question needs a reference answer. The question was not shown.");
	let result: FreeKeyModelResult;
	try {
		result = await verifier.verifyFree(freeSubject(quiz, reference), signal);
	} catch (err) {
		if (err instanceof QuizKeyError) throw err;
		throw new QuizKeyError("The independent key check did not answer. Call quiz again. The question was not shown.");
	}
	const decision = decideFree(reference, result.verdict);
	if ("refuse" in decision) throw new QuizKeyError(decision.refuse);
	return stampFree(quiz, decision.reference, result);
}

/**
 * A written answer that matches the verified reference, or that the key check
 * accepts, is correct. A check that says otherwise leaves the existing judgment.
 * A correct judgment is left as it is.
 */
export async function acceptFreeAnswer(
	quiz: PreparedQuiz,
	response: QuizResponse,
	judgment: FreeResponseJudgment | undefined,
	verifier?: QuizKeyVerifier,
	signal?: AbortSignal,
): Promise<FreeResponseJudgment | undefined> {
	if (quiz.format !== "free" || !judgment || response.dontKnow || !response.text?.trim()) return judgment;
	if (sameAnswer(response.text, quiz.reference ?? "")) return { ...judgment, outcome: "correct" };
	if (judgment.outcome === "correct" || judgment.slip === true || !verifier?.verifyFree) return judgment;
	try {
		const result = await verifier.verifyFree(freeSubject(quiz, quiz.reference ?? "", response.text), signal);
		if (result.verdict.learnerCorrect) return { ...judgment, outcome: "correct" };
		return judgment;
	} catch {
		return judgment;
	}
}

/** Calls the Groundwork server. The OpenRouter key never leaves that server. */
export function remoteQuizKeyVerifier(baseUrl: string, fetchImpl: HttpClient = httpClient(), authorization?: () => Promise<string | null>): QuizKeyVerifier {
	const root = baseUrl.replace(/\/$/, "");
	return {
		async verify(quiz, signal) {
			const token = await authorization?.();
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (token) headers.authorization = `Bearer ${token}`;
			const res = await fetchImpl(`${root}/v1/quiz-key`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					question: quiz.question,
					explanation: quiz.explanation,
					solution: quiz.solution,
					answer: quiz.answer,
					options: quiz.options.map((option) => ({ label: option.label, value: option.value })),
					correct: quiz.correct,
				}),
				signal,
			});
			if (!res.ok) throw new Error(`Quiz key check failed (${res.status}).`);
			const parsed = asQuizKeyModelResult(await res.json());
			if (!parsed) throw new Error("Quiz key check returned no verdict.");
			return parsed;
		},
		async verifyFree(quiz, signal) {
			const token = await authorization?.();
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (token) headers.authorization = `Bearer ${token}`;
			const res = await fetchImpl(`${root}/v1/quiz-key`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					format: "free",
					question: quiz.question,
					explanation: quiz.explanation,
					solution: quiz.solution,
					reference: quiz.reference,
					learnerAnswer: quiz.learnerAnswer,
				}),
				signal,
			});
			if (!res.ok) throw new Error(`Quiz key check failed (${res.status}).`);
			const parsed = asFreeKeyModelResult(await res.json());
			if (!parsed) throw new Error("Quiz key check returned no verdict.");
			return parsed;
		},
	};
}

function needsModelKeyCheck(quiz: QuizKeySubject): boolean {
	return quiz.format !== "free" && quiz.multiSelect !== true && quiz.correct.length === 1 && quiz.options.length >= 2;
}

function decideKey(quiz: QuizKeySubject, verdict: QuizKeyVerdict): { correct: string[] } | { refuse: string } {
	const keyed = quiz.correct[0] ?? "";
	const named = optionFor(quiz.options, verdict.correctValue);
	const math = signChartOption(quiz.question, quiz.options);
	const computed = signChartAnswer(quiz.question);
	if (computed && !math) {
		return {
			refuse: `An independent check says the answer is "${computed.join(", ")}", and no option says that. Fix the options and call quiz again. The question was not shown.`,
		};
	}
	const confirmed = verdict.matchesExplanation && verdict.keyedCorrect && !verdict.anotherAlsoCorrect;
	if (confirmed) {
		if ((named && named.value !== keyed) || (math && math.value !== keyed)) {
			return { refuse: "The model check and an independent check disagree. Recompute and call quiz again. The question was not shown." };
		}
		if (!keyed) return { refuse: "The key check did not confirm a single correct option. Recompute and call quiz again. The question was not shown." };
		return { correct: [keyed] };
	}
	if (verdict.anotherAlsoCorrect) {
		return { refuse: "More than one option is correct. Rewrite the question so only one option is right, then call quiz again. The question was not shown." };
	}
	if (named && (!computed || math?.value === named.value)) return { correct: [named.value] };
	return { refuse: "The model check and an independent check disagree. Recompute and call quiz again. The question was not shown." };
}

function knownCorrect(quiz: QuizKeySubject, verdict: QuizKeyVerdict): string[] {
	const math = signChartOption(quiz.question, quiz.options);
	if (math) return [math.value];
	const values: string[] = [];
	if (verdict.keyedCorrect && quiz.correct[0]) values.push(quiz.correct[0]);
	const named = optionFor(quiz.options, verdict.correctValue);
	if (named && !values.includes(named.value)) values.push(named.value);
	return values;
}

function stamp<T extends QuizKeySubject>(quiz: T, correct: string[], result: QuizKeyModelResult): T {
	quiz.correct = [...correct];
	quiz.keyCheck = {
		model: result.model,
		latencyMs: result.latencyMs,
		costUsd: result.costUsd,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		correct: [...correct],
	};
	return quiz;
}

function optionFor(options: Array<{ label: string; value: string }>, value: string | null): { label: string; value: string } | undefined {
	const text = value?.trim() ?? "";
	if (!text) return undefined;
	return options.find((option) => option.value === text) ?? options.find((option) => option.label.trim().toLowerCase() === text.toLowerCase());
}

function quizKeyUser(quiz: QuizKeySubject): string {
	return JSON.stringify({
		question: clip(quiz.question),
		solution: clip(quiz.solution),
		explanation: clip(quiz.explanation),
		keyedValue: quiz.correct[0] ?? "",
		options: quiz.options.map((option) => ({ value: option.value, label: clip(option.label, 300) })),
		...(quiz.courseBrief ? { course: clip(quiz.courseBrief, 900) } : {}),
	});
}

function clip(text: string | undefined, cap = FIELD_CAP): string {
	const value = (text ?? "").replace(/\s+/g, " ").trim();
	return value.length > cap ? `${value.slice(0, cap)}…` : value;
}

function verdictFrom(value: unknown): QuizKeyVerdict | null {
	const record = asRecord(value);
	if (!record) return null;
	if (typeof record.matchesExplanation !== "boolean") return null;
	if (typeof record.keyedCorrect !== "boolean") return null;
	if (typeof record.anotherAlsoCorrect !== "boolean") return null;
	if (record.correctValue !== null && typeof record.correctValue !== "string") return null;
	return {
		matchesExplanation: record.matchesExplanation,
		keyedCorrect: record.keyedCorrect,
		anotherAlsoCorrect: record.anotherAlsoCorrect,
		correctValue: typeof record.correctValue === "string" ? record.correctValue : null,
	};
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function billedUsage(body: unknown, reported: { input: number; output: number }): { input: number; output: number } {
	const usage = asRecord(asRecord(body)?.usage);
	const reasoning = usage ? count(usage.reasoning_tokens) : 0;
	return { input: reported.input, output: Math.max(reported.output, reasoning) };
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

async function completeCheck(
	http: HttpClient,
	apiKey: string,
	system: string,
	user: string,
	signal?: AbortSignal,
): Promise<{ text: string; result: Omit<QuizKeyModelResult, "verdict"> }> {
	const call = {
		system,
		messages: [{ role: "user" as const, content: user }],
		tools: [],
		maxTokens: QUIZ_KEY_MAX_TOKENS,
		model: QUIZ_KEY_MODEL,
	};
	const upstream = buildUpstream({ action: "key", provider: "openrouter", model: QUIZ_KEY_MODEL, key: "user" }, apiKey, call);
	const payload = asRecord(upstream.body);
	if (!payload) throw new Error("Could not build the quiz key check.");
	delete payload.tools;
	payload.reasoning = { effort: "low" };
	const started = Date.now();
	const res = await http(upstream.url, {
		method: "POST",
		headers: upstream.headers,
		body: JSON.stringify(payload),
		signal,
	});
	const latencyMs = Math.max(0, Date.now() - started);
	const body = await res.json();
	if (!res.ok) throw new Error(upstreamErrorMessage(body, [apiKey]));
	const read = readUpstream(upstream.kind, body);
	if (!read.ok) throw new Error(read.error);
	const text = read.result.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
	const usage = billedUsage(body, read.result.usage);
	return {
		text,
		result: {
			latencyMs,
			costUsd: quizKeyCostUsd(usage),
			inputTokens: usage.input,
			outputTokens: usage.output,
			model: QUIZ_KEY_MODEL,
		},
	};
}

function decideFree(reference: string, verdict: FreeKeyVerdict): { reference: string } | { refuse: string } {
	if (verdict.matchesExplanation && verdict.referenceCorrect) return { reference };
	const corrected = verdict.correctedReference?.trim() ?? "";
	if (!verdict.referenceCorrect && corrected) return { reference: corrected };
	if (!verdict.referenceCorrect) {
		return { refuse: "The reference answer is wrong and the check did not supply a replacement. Recompute and call quiz again. The question was not shown." };
	}
	return { refuse: "The reference answer does not match the explanation. Recompute and call quiz again. The question was not shown." };
}

function stampFree<T extends QuizKeySubject>(quiz: T, reference: string, result: FreeKeyModelResult): T {
	quiz.reference = reference;
	quiz.keyCheck = {
		model: result.model,
		latencyMs: result.latencyMs,
		costUsd: result.costUsd,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		correct: [],
	};
	return quiz;
}

function freeSubject(
	quiz: { question: string; explanation: string; solution?: string; courseBrief?: string },
	reference: string,
	learnerAnswer?: string,
): FreeKeySubject {
	const learner = learnerAnswer?.trim();
	return {
		question: quiz.question,
		explanation: quiz.explanation,
		solution: quiz.solution,
		reference,
		learnerAnswer: learner || undefined,
		courseBrief: quiz.courseBrief,
	};
}

function freeKeyUser(quiz: FreeKeySubject): string {
	return JSON.stringify({
		question: clip(quiz.question),
		solution: clip(quiz.solution),
		explanation: clip(quiz.explanation),
		reference: clip(quiz.reference),
		learnerAnswer: clip(quiz.learnerAnswer),
		...(quiz.courseBrief ? { course: clip(quiz.courseBrief, 900) } : {}),
	});
}

function sameAnswer(written: string, reference: string): boolean {
	const left = normalizeAnswer(written);
	const right = normalizeAnswer(reference);
	return left.length > 0 && left === right;
}

function normalizeAnswer(text: string): string {
	return text
		.toLowerCase()
		.replace(/\$+/g, "")
		.replace(/\\[a-z]+/gi, "")
		.replace(/[{}]/g, "")
		.replace(/[.,;:!?'"`]/g, "")
		.replace(/\s+/g, "");
}

function jsonObject(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		return asUnknown(JSON.parse(text.slice(start, end + 1)));
	} catch {
		return undefined;
	}
}

function modelEnvelope(value: unknown): { verdict: unknown; envelope: Omit<QuizKeyModelResult, "verdict"> } | null {
	const record = asRecord(value);
	if (!record) return null;
	const latencyMs = finite(record.latencyMs);
	const costUsd = finite(record.costUsd);
	const inputTokens = finite(record.inputTokens);
	const outputTokens = finite(record.outputTokens);
	if (latencyMs === null || costUsd === null || inputTokens === null || outputTokens === null) return null;
	const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : QUIZ_KEY_MODEL;
	return { verdict: record.verdict, envelope: { latencyMs, costUsd, inputTokens, outputTokens, model } };
}

function freeVerdictFrom(value: unknown): FreeKeyVerdict | null {
	const record = asRecord(value);
	if (!record) return null;
	if (typeof record.matchesExplanation !== "boolean") return null;
	if (typeof record.referenceCorrect !== "boolean") return null;
	if (record.learnerCorrect !== null && typeof record.learnerCorrect !== "boolean") return null;
	if (record.correctedReference !== null && typeof record.correctedReference !== "string") return null;
	const corrected = typeof record.correctedReference === "string" ? record.correctedReference.trim() : "";
	return {
		matchesExplanation: record.matchesExplanation,
		referenceCorrect: record.referenceCorrect,
		learnerCorrect: typeof record.learnerCorrect === "boolean" ? record.learnerCorrect : null,
		correctedReference: corrected || null,
	};
}
