import { describe, expect, it } from "vitest";
import { gradeQuiz, parseChatAnswer, prepareQuiz } from "../src/quiz";

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
	});
});
