import { describe, expect, it } from "vitest";
import { latexToPlain, normalizeTutorMarkdown } from "../src/tutor-markdown";
import { prepareQuiz } from "../src/quiz";

const GRADIENT_EXPLANATION =
	"$h$ is the composition of $g$ with the map $\\alpha \\mapsto x + \\alpha y$. That inner map has derivative $y$ (the $x$ is constant in $\\alpha$). The chain rule in matrix form multiplies Jacobians: the inner Jacobian is $y \\in \\mathbf{R}^{n \\times 1}$, the outer is ==$\\nabla g(x+\\alpha y)^\\top \\in \\mathbf{R}^{1\\times n}$==, giving ==$h'(\\alpha) = \\nabla g(x+\\alpha y)^\\top y = y^\\top \\nabla g(x+\\alpha y)$==, a $1\\times 1$ scalar — which is what the derivative of a scalar function of a scalar must be.";

describe("normalizeTutorMarkdown", () => {
	it("unwraps ==$math$== so Obsidian can typeset the formula", () => {
		const out = normalizeTutorMarkdown(GRADIENT_EXPLANATION);
		expect(out).not.toContain("==");
		expect(out).toContain("$\\nabla g(x+\\alpha y)^\\top \\in \\mathbf{R}^{1\\times n}$");
		expect(out).toContain("$h'(\\alpha) = \\nabla g(x+\\alpha y)^\\top y = y^\\top \\nabla g(x+\\alpha y)$");
		expect(out).toContain("$h$ is the composition of $g$");
	});

	it("does not typeset an English sentence as one math span", () => {
		const src = "$h is the composition of g with the map \\alpha \\mapsto x + \\alpha y$.";
		const out = normalizeTutorMarkdown(src);
		expect(out).toContain("h is the composition of g with the map");
		expect(out).toContain("$\\alpha \\mapsto x + \\alpha y$");
		expect(out).not.toMatch(/^\$h is the composition/);
	});

	it("turns a highlighted TeX formula into inline math", () => {
		expect(normalizeTutorMarkdown("==\\nabla g(x+\\alpha y)^\\top \\in \\mathbf{R}^{1\\times n}==")).toBe(
			"$\\nabla g(x+\\alpha y)^\\top \\in \\mathbf{R}^{1\\times n}$",
		);
	});

	it("trims spaces inside $ delimiters so Obsidian accepts the span", () => {
		expect(normalizeTutorMarkdown("slope is $ 3 $")).toBe("slope is $3$");
	});

	it("converts \\( \\) and \\[ \\] to dollar math", () => {
		expect(normalizeTutorMarkdown("see \\(x^2\\)")).toBe("see $x^2$");
		expect(normalizeTutorMarkdown("\\[a+b\\]")).toBe("\n$$\na+b\n$$\n");
	});

	it("leaves fenced code alone", () => {
		const src = "before\n```\n$not math$ ==keep==\n```\nafter $\\alpha$";
		const out = normalizeTutorMarkdown(src);
		expect(out).toContain("$not math$ ==keep==");
		expect(out).toContain("after $\\alpha$");
	});

	it("is idempotent", () => {
		const once = normalizeTutorMarkdown(GRADIENT_EXPLANATION);
		expect(normalizeTutorMarkdown(once)).toBe(once);
	});

	it("repairs quiz explanations at prepare time", () => {
		const q = prepareQuiz({
			concept: "Gradient",
			question: "What is $ h'(\\alpha) $?",
			options: [
				{ label: "==$\\nabla g^\\top y$==", value: "a" },
				{ label: "$ g $", value: "b" },
			],
			correctAnswer: "a",
			explanation: GRADIENT_EXPLANATION,
			difficulty: 3,
			kind: "check",
			shuffle: false,
		});
		expect(q.question).toBe("What is $h'(\\alpha)$?");
		expect(q.options[0].label).toBe("$\\nabla g^\\top y$");
		expect(q.explanation).not.toContain("==");
		expect(q.explanation).toContain("$h$ is the composition of $g$");
	});
});

describe("latexToPlain", () => {
	it("strips dollars and renders common commands", () => {
		expect(latexToPlain("Slope through $(1,2)$ and $(3,8)$?")).toBe("Slope through (1,2) and (3,8)?");
		expect(latexToPlain("$\\frac{1}{3}$")).toBe("(1)/(3)");
		expect(latexToPlain("$\\alpha \\mapsto x$")).toBe("α ↦ x");
	});
});
