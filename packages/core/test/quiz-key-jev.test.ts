import { describe, expect, it } from "vitest";
import { MemoryVaultIO } from "../src/io";
import { recordQuizAnswer } from "../src/grading";
import { KnowledgeStore } from "../src/store";
import { gradeQuiz, prepareQuiz, type PreparedQuiz } from "../src/quiz";
import {
	QUIZ_KEY_MODEL,
	askQuizKeyModel,
	confirmQuizKey,
	quizKeyCostUsd,
	recheckQuizKey,
	remoteQuizKeyVerifier,
	type QuizKeyModelResult,
	type QuizKeyVerifier,
	type QuizKeyVerdict,
} from "../src/quiz-key-jev";
import { toolByName } from "../src/tools";
import type { HttpClient } from "../src/http";

const fixedNow = () => new Date("2026-10-14T12:00:00Z");

function makeStore() {
	return new KnowledgeStore(new MemoryVaultIO(), { now: fixedNow, device: "test" });
}

const slope = {
	concept: "Slope of a line",
	question: "Slope through (1, 2) and (3, 8)?",
	purpose: "Check rise over run.",
	options: [
		{ label: "3", value: "a" },
		{ label: "1/3", value: "b", misconception: "run over rise" },
		{ label: "6", value: "c" },
	],
	correctAnswer: "b",
	explanation: "Rise 6, run 2, so the slope is 3.",
	difficulty: 2,
	kind: "check" as const,
	shuffle: false,
};

const signs = {
	concept: "Sign of a product",
	question: "What are the signs of $p(u) = (u-1)(u-3)$ across $u<1$, $1<u<3$, and $u>3$?",
	purpose: "Check a sign chart.",
	solution: "p(0)=3>0, p(2)=-1<0, p(4)=3>0.",
	answer: "positive, negative, positive",
	options: [
		{ label: "negative, positive, negative", value: "a" },
		{ label: "positive, negative, positive", value: "b" },
	],
	correctAnswer: "a",
	explanation: "The signs are positive, negative, positive.",
	difficulty: 3,
	kind: "check" as const,
	shuffle: false,
};

function result(verdict: QuizKeyVerdict, over: Partial<QuizKeyModelResult> = {}): QuizKeyModelResult {
	return {
		model: QUIZ_KEY_MODEL,
		latencyMs: 18,
		costUsd: 0.00008,
		inputTokens: 400,
		outputTokens: 80,
		verdict,
		...over,
	};
}

function verifier(verdict: QuizKeyVerdict, calls?: { n: number }): QuizKeyVerifier {
	return {
		async verify() {
			if (calls) calls.n += 1;
			return result(verdict);
		},
	};
}

const pass = (value: string): QuizKeyVerdict => ({
	matchesExplanation: true,
	keyedCorrect: true,
	anotherAlsoCorrect: false,
	correctValue: value,
});

describe("quiz key model check", () => {
	it("prices a short gpt-6-luna check from the listed rates", () => {
		expect(quizKeyCostUsd({ input: 400, output: 80 })).toBe(0.00008);
		expect(QUIZ_KEY_MODEL).toBe("openai/gpt-6-luna");
	});

	it("confirms a key that matches the explanation and is the only correct option", async () => {
		const calls = { n: 0 };
		const quiz = await confirmQuizKey(prepareQuiz(slope, () => 0), verifier(pass("b"), calls));
		expect(quiz.correct).toEqual(["b"]);
		expect(quiz.keyCheck).toMatchObject({ model: QUIZ_KEY_MODEL, latencyMs: 18, costUsd: 0.00008, correct: ["b"] });
		await confirmQuizKey(quiz, verifier(pass("b"), calls));
		expect(calls.n).toBe(1);
	});

	it("fixes a wrong key when the model names one correct option", async () => {
		const quiz = await confirmQuizKey(
			prepareQuiz(slope, () => 0),
			verifier({ matchesExplanation: false, keyedCorrect: false, anotherAlsoCorrect: false, correctValue: "a" }),
		);
		expect(quiz.correct).toEqual(["a"]);
		expect(gradeQuiz(quiz, { dontKnow: false, selected: ["a"] }).correct).toBe(true);
		expect(gradeQuiz(quiz, { dontKnow: false, selected: ["b"] }).correct).toBe(false);
	});

	it("does not show a question when another option is also correct", async () => {
		await expect(
			confirmQuizKey(
				prepareQuiz(slope, () => 0),
				verifier({ matchesExplanation: true, keyedCorrect: true, anotherAlsoCorrect: true, correctValue: "b" }),
			),
		).rejects.toThrow(/not shown/);
	});

	it("does not show a question when the model check and the sign chart disagree", async () => {
		const settled = prepareQuiz(signs, () => 0);
		expect(settled.correct).toEqual(["b"]);
		await expect(
			confirmQuizKey(
				settled,
				verifier({ matchesExplanation: false, keyedCorrect: false, anotherAlsoCorrect: false, correctValue: "a" }),
			),
		).rejects.toThrow(/not shown/);
	});

	it("does not show a question when the model check does not answer", async () => {
		const down: QuizKeyVerifier = {
			async verify() {
				throw new Error("down");
			},
		};
		await expect(confirmQuizKey(prepareQuiz(slope, () => 0), down)).rejects.toThrow(/not shown/);
	});

	it("hides the card when the quiz tool's check refuses", async () => {
		const store = makeStore();
		await store.upsertConcept({ title: "Slope of a line", summary: "Rise over run." });
		let shown: PreparedQuiz | null = null;
		const quiz = toolByName("quiz");
		await expect(
			quiz?.run(slope, {
				store,
				keyVerifier: verifier({ matchesExplanation: false, keyedCorrect: false, anotherAlsoCorrect: true, correctValue: "a" }),
				ui: {
					async quiz(q) {
						shown = q;
						return { dontKnow: false, selected: ["a"] };
					},
					async ask() {
						return null;
					},
				},
			}),
		).rejects.toThrow(/not shown/);
		expect(shown).toBeNull();
	});

	it("shows a choice question only after the mocked check confirms it", async () => {
		const store = makeStore();
		await store.upsertConcept({ title: "Slope of a line", summary: "Rise over run." });
		let shown: PreparedQuiz | null = null;
		const quiz = toolByName("quiz");
		const out = await quiz?.run(slope, {
			store,
			keyVerifier: verifier({ matchesExplanation: false, keyedCorrect: false, anotherAlsoCorrect: false, correctValue: "a" }),
			ui: {
				async quiz(q) {
					shown = q;
					return { dontKnow: false, selected: ["a"] };
				},
				async ask() {
					return null;
				},
			},
		});
		expect(shown?.correct).toEqual(["a"]);
		expect(shown?.keyCheck?.costUsd).toBe(0.00008);
		expect(shown?.keyCheck?.latencyMs).toBe(18);
		expect(out?.isError).toBeFalsy();
		expect(String(out?.text)).toContain("CORRECTLY");
	});

	it("keeps the deterministic check when no model verifier is configured", async () => {
		const store = makeStore();
		await store.upsertConcept({ title: "Sign of a product", summary: "Sign chart." });
		let shown: PreparedQuiz | null = null;
		const quiz = toolByName("quiz");
		await quiz?.run(signs, {
			store,
			ui: {
				async quiz(q) {
					shown = q;
					return null;
				},
				async ask() {
					return null;
				},
			},
		});
		expect(shown?.correct).toEqual(["b"]);
		expect(shown?.keyCheck).toBeUndefined();
	});

	it("does not show a practice test when any choice key is unconfirmed", async () => {
		const store = makeStore();
		await store.upsertConcept({ title: "Slope of a line", summary: "Rise over run." });
		let shown = false;
		let calls = 0;
		const test = toolByName("practice_test");
		await expect(
			test?.run(
				{
					title: "Slope check",
					objective: "Rise over run.",
					questions: [slope, { ...slope, question: "Slope through (0, 0) and (2, 6)?" }],
				},
				{
					store,
					keyVerifier: {
						async verify() {
							calls += 1;
							if (calls === 1) return result(pass("b"));
							return result({ matchesExplanation: false, keyedCorrect: false, anotherAlsoCorrect: true, correctValue: null });
						},
					},
					ui: {
						async quiz() {
							return null;
						},
						async test() {
							shown = true;
							return null;
						},
						async ask() {
							return null;
						},
					},
				},
			),
		).rejects.toThrow(/not shown/);
		expect(shown).toBe(false);
		expect(calls).toBe(2);
	});

	it("grades a right selection when the stored key was wrong", async () => {
		const calls = { n: 0 };
		const quiz = prepareQuiz(slope, () => 0);
		expect(quiz.correct).toEqual(["b"]);
		const checked = await recheckQuizKey(
			quiz,
			verifier({ matchesExplanation: false, keyedCorrect: false, anotherAlsoCorrect: false, correctValue: "a" }, calls),
		);
		expect(gradeQuiz(checked, { dontKnow: false, selected: ["a"] }).correct).toBe(true);
		expect(gradeQuiz(checked, { dontKnow: false, selected: ["b"] }).correct).toBe(false);
		const store = makeStore();
		await store.upsertConcept({ title: "Slope of a line", summary: "Rise over run." });
		const outcome = await recordQuizAnswer(store, checked, { dontKnow: false, selected: ["a"] }, undefined, undefined, verifier(pass("a"), calls));
		expect(outcome.grade.correct).toBe(true);
		expect(outcome.grade.correctLabels).toEqual(["3"]);
		expect(calls.n).toBe(1);
	});

	it("does not mark the sign-chart answer wrong when the model check sides with the stored key", async () => {
		const quiz = prepareQuiz(signs, () => 0);
		quiz.correct = ["a"];
		const checked = await recheckQuizKey(quiz, verifier(pass("a")));
		expect(gradeQuiz(checked, { dontKnow: false, selected: ["b"] }).correct).toBe(true);
		expect(gradeQuiz(checked, { dontKnow: false, selected: ["a"] }).correct).toBe(false);
	});

	it("still grades the sign chart when the model check fails", async () => {
		const quiz = prepareQuiz(signs, () => 0);
		quiz.correct = ["a"];
		const checked = await recheckQuizKey(quiz, {
			async verify() {
				throw new Error("down");
			},
		});
		expect(checked.keyCheck).toBeUndefined();
		expect(gradeQuiz(checked, { dontKnow: false, selected: ["b"] }).correct).toBe(true);
	});

	it("asks OpenRouter for a small low-effort verdict and prices the reported tokens", async () => {
		let sent: { url: string; body: Record<string, unknown>; authorization: string } | null = null;
		const http: HttpClient = async (url, init) => {
			sent = { url, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown>, authorization: init?.headers?.authorization ?? "" };
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => null },
				async text() {
					return "";
				},
				async json() {
					return {
						content: [{ type: "text", text: '{"matchesExplanation":true,"keyedCorrect":true,"anotherAlsoCorrect":false,"correctValue":"b"}' }],
						stop_reason: "end_turn",
						usage: { input_tokens: 400, output_tokens: 80 },
					};
				},
				async arrayBuffer() {
					return new ArrayBuffer(0);
				},
				body: null,
			};
		};
		const verdict = await askQuizKeyModel(http, "sk-or-test-secret", prepareQuiz(slope, () => 0));
		expect(sent?.url).toBe("https://openrouter.ai/api/v1/messages");
		expect(sent?.authorization).toBe("Bearer sk-or-test-secret");
		expect(sent?.body.model).toBe("openai/gpt-6-luna");
		expect(sent?.body.max_tokens).toBeLessThanOrEqual(256);
		expect(sent?.body.reasoning).toEqual({ effort: "low" });
		expect(sent?.body.tools).toBeUndefined();
		expect(JSON.stringify(sent?.body)).not.toContain("sk-or-test-secret");
		expect(verdict.costUsd).toBe(0.00008);
		expect(verdict.latencyMs).toBeGreaterThanOrEqual(0);
		expect(verdict.verdict.correctValue).toBe("b");
	});

	it("refuses an unparsable model reply", async () => {
		const http: HttpClient = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: () => null },
			async text() {
				return "";
			},
			async json() {
				return { content: [{ type: "text", text: "looks fine" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } };
			},
			async arrayBuffer() {
				return new ArrayBuffer(0);
			},
			body: null,
		});
		await expect(askQuizKeyModel(http, "sk-or-test", prepareQuiz(slope, () => 0))).rejects.toThrow(/verdict/);
	});

	it("reads a verdict from the server route shape", async () => {
		const http: HttpClient = async (url, init) => {
			expect(url).toBe("https://groundwork.test/v1/quiz-key");
			expect(init?.headers?.authorization).toBe("Bearer token");
			expect(init?.body).not.toContain("sk-or");
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => null },
				async text() {
					return "";
				},
				async json() {
					return { ...result(pass("a")) };
				},
				async arrayBuffer() {
					return new ArrayBuffer(0);
				},
				body: null,
			};
		};
		const verdict = await remoteQuizKeyVerifier("https://groundwork.test/", http, async () => "token").verify(prepareQuiz(slope, () => 0));
		expect(verdict.verdict.correctValue).toBe("a");
		expect(verdict.costUsd).toBe(0.00008);
	});
});
