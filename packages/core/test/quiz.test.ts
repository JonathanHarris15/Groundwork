import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/prompt";
import { quizInputSchema } from "../src/tools";
import { familiarityLabel, gradeQuiz, needsJudgment, parseChatAnswer, parseFamiliarity, prepareQuiz } from "../src/quiz";

const base = {
	concept: "Slope of a line",
	question: "Slope through (1,2) and (3,8)?",
	options: [
		{ label: "3", value: "a" },
		{ label: "1/3", value: "b", misconception: "run over rise" },
		{ label: "6", value: "c" },
	],
	correctAnswer: "a",
	explanation: "rise over run",
	difficulty: 2,
	kind: "probe" as const,
};

describe("quiz", () => {
	it("grades by value regardless of shuffle", () => {
		const q = prepareQuiz(base);
		expect(gradeQuiz(q, { dontKnow: false, selected: ["a"] }).correct).toBe(true);
		const wrong = gradeQuiz(q, { dontKnow: false, selected: ["b"] });
		expect(wrong.outcome).toBe("incorrect");
		expect(wrong.misconception).toBe("run over rise");
	});

	it("treats I don't know as its own outcome", () => {
		const q = prepareQuiz(base);
		expect(gradeQuiz(q, { dontKnow: true, selected: [] }).outcome).toBe("dont_know");
	});

	it("rejects bad correct answers and manual don't-know options", () => {
		expect(() => prepareQuiz({ ...base, correctAnswer: "z" })).toThrow(/does not match/);
		expect(() => prepareQuiz({ ...base, options: [...base.options, { label: "I don't know", value: "idk" }] })).toThrow();
	});

	it("parses JSON-stringified multi-select answers and exact-set grades", () => {
		const q = prepareQuiz({ ...base, correctAnswer: '["a","c"]', multiSelect: true, shuffle: false });
		expect(q.correct).toEqual(["a", "c"]);
		expect(gradeQuiz(q, { dontKnow: false, selected: ["a"] }).correct).toBe(false);
		expect(gradeQuiz(q, { dontKnow: false, selected: ["c", "a"] }).correct).toBe(true);
	});

	it("parses chat answers by letter, number, or label", () => {
		const q = prepareQuiz({ ...base, shuffle: false });
		expect(parseChatAnswer(q, "A")).toEqual(["a"]);
		expect(parseChatAnswer(q, "(b)")).toEqual(["b"]);
		expect(parseChatAnswer(q, "2")).toEqual(["b"]);
		expect(parseChatAnswer(q, "6")).toEqual(["c"]);
		expect(parseChatAnswer(q, "1/3")).toEqual(["b"]);
		expect(parseChatAnswer(q, "a and c")).toEqual(["a", "c"]);
		const onScreen = { ...q, options: [q.options[1], q.options[2], q.options[0]] };
		expect(parseChatAnswer(onScreen, "A")).toEqual(["b"]);
		expect(parseChatAnswer(onScreen, "C")).toEqual(["a"]);
		expect(gradeQuiz(onScreen, { dontKnow: false, selected: parseChatAnswer(onScreen, "C") }).correct).toBe(true);
	});

	it("keys the sign chart of (u-1)(u-3) by the solved claim, not the wrong index", () => {
		const signs = {
			concept: "Sign of a product",
			question: "What are the signs of $p(u) = (u-1)(u-3)$ across $u<1$, $1<u<3$, and $u>3$?",
			solution: "p(0)=(0-1)(0-3)=3>0, p(2)=(2-1)(2-3)=-1<0, p(4)=(4-1)(4-3)=3>0.",
			answer: "positive, negative, positive",
			options: [
				{ label: "negative, positive, negative", value: "a" },
				{ label: "positive, negative, positive", value: "b" },
			],
			correctAnswer: "a",
			explanation: "Left of both roots the factors are negative, so the product is positive. Between the roots it is negative. Right of both roots it is positive. The signs are positive, negative, positive.",
			difficulty: 3,
			kind: "check" as const,
		};
		const shown = prepareQuiz(signs, () => 0);
		expect(shown.options.find((o) => shown.correct.includes(o.value))?.label).toBe("positive, negative, positive");
		expect(gradeQuiz(shown, { dontKnow: false, selected: ["b"] }).correct).toBe(true);
		expect(gradeQuiz(shown, { dontKnow: false, selected: ["a"] }).correct).toBe(false);
		const shuffled = prepareQuiz(signs, () => 0.99);
		expect(shuffled.options.find((o) => shuffled.correct.includes(o.value))?.label).toBe("positive, negative, positive");
		expect(gradeQuiz(shuffled, { dontKnow: false, selected: [shuffled.options.find((o) => o.label.startsWith("positive"))!.value] }).correct).toBe(true);
	});

	it("selects the worked claim when the key is only a letter", () => {
		const q = prepareQuiz({ ...base, answer: "1/3", correctAnswer: "a" });
		expect(q.correct).toEqual(["b"]);
		expect(gradeQuiz(q, { dontKnow: false, selected: ["b"] }).correct).toBe(true);
		expect(gradeQuiz(q, { dontKnow: false, selected: ["a"] }).correct).toBe(false);
	});

	it("re-verifies a stored sign-chart key at grade time", () => {
		const poisoned = {
			id: "q_poison",
			concept: "Sign of a product",
			question: "What are the signs of $p(u) = (u-1)(u-3)$ across $u<1$, $1<u<3$, and $u>3$?",
			format: "choice" as const,
			options: [
				{ label: "negative, positive, negative", value: "a" },
				{ label: "positive, negative, positive", value: "b" },
			],
			correct: ["a"],
			explanation: "At a point left of 1 the product is positive. Between the roots it is negative. Past 3 it is positive.",
			difficulty: 3,
			kind: "check" as const,
			multiSelect: false,
		};
		expect(gradeQuiz(poisoned, { dontKnow: false, selected: ["b"] }).correct).toBe(true);
		expect(gradeQuiz(poisoned, { dontKnow: false, selected: ["b"] }).correctLabels).toEqual(["positive, negative, positive"]);
		expect(gradeQuiz(poisoned, { dontKnow: false, selected: ["a"] }).correct).toBe(false);
	});

	it("does not show a sign chart whose explanation contradicts the check", () => {
		expect(() =>
			prepareQuiz({
				concept: "Sign of a product",
				question: "What are the signs of p(u) = (u-1)(u-3) across u<1, 1<u<3, u>3?",
				options: [
					{ label: "negative, positive, negative", value: "a" },
					{ label: "positive, negative, positive", value: "b" },
				],
				correctAnswer: "b",
				explanation: "The signs are negative, positive, negative.",
				difficulty: 3,
				kind: "check",
			}),
		).toThrow(/not shown/);
	});

	it("does not show a sign chart when no option matches the check", () => {
		expect(() =>
			prepareQuiz({
				...base,
				question: "What are the signs of $p(u)=(u-1)(u-3)$ across $u<1$, $1<u<3$, $u>3$?",
				options: [
					{ label: "negative, positive, negative", value: "a" },
					{ label: "negative, negative, negative", value: "b" },
				],
				correctAnswer: "a",
				explanation: "The signs are negative, positive, negative.",
			}),
		).toThrow(/not shown/);
	});
});

describe("free response", () => {
	const free = {
		concept: "Derivative",
		question: "Find $f'(x)$ for $f(x) = x^3$.",
		format: "free" as const,
		referenceAnswer: "$f'(x) = 3x^2$",
		rubric: "Full credit: $3x^2$. Partial: right power rule, wrong coefficient.",
		explanation: "Power rule.",
		difficulty: 3,
		kind: "check" as const,
	};

	it("needs a reference answer instead of options", () => {
		const q = prepareQuiz(free);
		expect(q.format).toBe("free");
		expect(q.options).toEqual([]);
		expect(q.reference).toBe("$f'(x) = 3x^2$");
		expect(() => prepareQuiz({ ...free, referenceAnswer: "" })).toThrow(/referenceAnswer/);
	});

	it("is graded by the tutor's judgment, except for I don't know", () => {
		const q = prepareQuiz(free);
		const typed = { dontKnow: false, selected: [], text: "$3x^2$" };
		expect(needsJudgment(q, typed)).toBe(true);
		expect(() => gradeQuiz(q, typed)).toThrow(/judgment/);
		const partial = gradeQuiz(q, typed, { outcome: "partial", feedback: "Right rule, check the coefficient.", misconception: "drops the exponent" });
		expect(partial.outcome).toBe("partial");
		expect(partial.feedback).toContain("coefficient");
		expect(partial.misconception).toBe("drops the exponent");
		expect(gradeQuiz(q, typed, { outcome: "correct", misconception: "ignored" }).misconception).toBeUndefined();

		const idk = { dontKnow: true, selected: [], familiarity: 2 };
		expect(needsJudgment(q, idk)).toBe(false);
		expect(gradeQuiz(q, idk).outcome).toBe("dont_know");
	});

	it("still requires options for multiple choice", () => {
		expect(() => prepareQuiz({ ...base, options: [] })).toThrow(/format "free"/);
	});
});

describe("orientation", () => {
	it("keeps the purpose shown above the question", () => {
		expect(prepareQuiz({ ...base, purpose: "  Checking slope, which the derivative is built on. " }).purpose).toBe("Checking slope, which the derivative is built on.");
	});

	it("tells the tutor the learner has not read its files", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("The learner sees only this conversation");
		expect(prompt).toContain("Define every symbol and term the first time you use it");
		expect(prompt).toContain("Always show where this is going");
		expect(quizInputSchema.required).toContain("purpose");
		const fields = Object.keys(quizInputSchema.properties ?? {});
		expect(fields.indexOf("solution")).toBeLessThan(fields.indexOf("options"));
		expect(fields.indexOf("answer")).toBeLessThan(fields.indexOf("options"));
		expect(fields.indexOf("answer")).toBeLessThan(fields.indexOf("correctAnswer"));
	});
});

describe("familiarity", () => {
	it("labels the ends of the slider", () => {
		expect(familiarityLabel(0)).toBe("I've never seen this");
		expect(familiarityLabel(3)).toBe("Very familiar, I almost have it");
		expect(familiarityLabel(9)).toBe("Very familiar, I almost have it");
	});

	it("reads familiarity out of chat phrasing", () => {
		expect(parseFamiliarity("idk, never seen this")).toBe(0);
		expect(parseFamiliarity("I don't know, I've seen it but can't remember")).toBe(1);
		expect(parseFamiliarity("not sure, rings a bell")).toBe(2);
		expect(parseFamiliarity("it's on the tip of my tongue")).toBe(3);
		expect(parseFamiliarity("B")).toBeUndefined();
	});
});
