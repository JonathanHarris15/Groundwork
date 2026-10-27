import { describe, expect, it } from "vitest";
import { QuizKeyError } from "../src/quiz-key";
import { confirmQuizKey } from "../src/quiz-key-jev";
import { assertQuizMath, mathDefects, preparedQuizMathIssues } from "../src/quiz-math";
import { prepareQuiz } from "../src/quiz";
import { normalizeTutorMarkdown } from "../src/tutor-markdown";

describe("mathDefects", () => {
	it("accepts well-wrapped inline and display math", () => {
		expect(mathDefects("What is $c^\\top \\hat{y}$?")).toEqual([]);
		expect(mathDefects("$$\nc^\\top P s = r\n$$")).toEqual([]);
	});

	it("flags mangled dollars like c$tops from a split transpose", () => {
		expect(mathDefects("c$tops + r")).toContain("dollar sign inside a token (for example `c$tops` from a split `c^\\top`)");
		expect(mathDefects("c$topP + $ū = 0")).toContain("dollar sign inside a token (for example `c$tops` from a split `c^\\top`)");
	});

	it("flags TeX and superscripts left outside delimiters", () => {
		expect(mathDefects("c^T\\hat{y} = r")).toEqual(
			expect.arrayContaining(["superscript or subscript outside math delimiters", "TeX command outside math delimiters"]),
		);
	});

	it("allows plain numeric exponents in prose", () => {
		expect(mathDefects("Differentiate x^3 from the definition.")).toEqual([]);
	});

	it("flags unbalanced dollar delimiters", () => {
		expect(mathDefects("$c^\\top P s + r \\neq r$")).toEqual([]);
		expect(mathDefects("$c^\\top P s + r \\neq r")).toContain("unclosed inline math (`$`)");
	});
});

describe("assertQuizMath", () => {
	const base = {
		concept: "Constraints",
		question: "What does $c^\\top \\hat{y}$ simplify to?",
		options: [
			{ label: "$r$", value: "a" },
			{ label: "$0$", value: "b" },
		],
		correctAnswer: "a",
		explanation: "Use $c^\\top P = 0$.",
		difficulty: 3,
		kind: "check" as const,
		shuffle: false,
	};

	it("allows a clean question after prepareQuiz normalization", () => {
		const quiz = prepareQuiz(base, () => 0);
		expect(() => assertQuizMath(quiz)).not.toThrow();
	});

	it("refuses screenshot-style broken option labels", () => {
		const broken = prepareQuiz(
			{
				...base,
				options: [
					{ label: "c^T$\\hat{y} = 0 \\cdot s + r = r$", value: "a" },
					{ label: "c^T$\\hat{y} = c$tops + r$ \\neq r$", value: "b" },
					{ label: "c^T$\\hat{y} = c$topP + $ū = 0$", value: "c" },
					{ label: "c^T$\\hat{y} = r \\cdot (s + 1)$", value: "d" },
				],
				correctAnswer: "a",
			},
			() => 0,
		);
		const issues = preparedQuizMathIssues(broken);
		expect(issues.length).toBeGreaterThan(0);
		expect(() => assertQuizMath(broken)).toThrow(QuizKeyError);
		expect(() => assertQuizMath(broken)).toThrow(/not shown/);
		expect(() => assertQuizMath(broken)).toThrow(/options\[/);
	});

	it("runs before confirmQuizKey shows the card", async () => {
		const quiz = prepareQuiz(
			{
				...base,
				options: [
					{ label: "$r$", value: "a" },
					{ label: "c$tops", value: "b" },
				],
				correctAnswer: "a",
			},
			() => 0,
		);
		await expect(confirmQuizKey(quiz, undefined)).rejects.toThrow(/not shown/);
	});
});

describe("normalizeTutorMarkdown transpose merge", () => {
	it("merges c^ with \\top into one inline math span", () => {
		expect(normalizeTutorMarkdown("c^\\top")).toBe("$c^\\top$");
	});
});
