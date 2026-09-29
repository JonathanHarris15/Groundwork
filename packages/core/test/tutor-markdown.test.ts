import { describe, expect, it } from "vitest";
import { latexToPlain, mathSources, normalizeTutorMarkdown } from "../src/tutor-markdown";
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

	it("undoes one extra level of escaping from tool arguments", () => {
		const src =
			"Multiply out:\\n\\n$$Mx = (uv^\\\\top)x = u(v^\\\\top x)$$\\n\\nNow $v^\\\\top x$ is $(1\\\\times 3)(3\\\\times 1)$ and $v$ lives in $\\\\mathbf{R}^3$. So\\n\\n$\\\\nabla f \\\\neq 0$";
		const out = normalizeTutorMarkdown(src);
		expect(out).not.toMatch(/\\\\|\\n(?!abla|eq)/);
		expect(out).toContain("$$\nMx = (uv^\\top)x = u(v^\\top x)\n$$");
		expect(out).toContain("$(1\\times 3)(3\\times 1)$");
		expect(out).toContain("$\\mathbf{R}^3$");
		expect(out).toContain("\n\nNow");
		expect(out).toContain("$\\nabla f \\neq 0$");
	});

	it("keeps real TeX line breaks and \\n-macros when nothing is over-escaped", () => {
		const src = "$$\\begin{aligned} a &= 1 \\\\ b &= 2 \\end{aligned}$$ and $\\nabla f \\neq 0$";
		expect(normalizeTutorMarkdown(src)).toContain("a &= 1 \\\\ b &= 2");
		expect(normalizeTutorMarkdown(src)).toContain("$\\nabla f \\neq 0$");
	});

	it("keeps display math inside a callout so it cannot swallow the prose after it", () => {
		const src = [
			"> [!note] Root",
			"> $x^\\top A x$ is a **scalar**, written out it is",
			"> $$x^\\top A x = \\sum_{i,j} A_{ij}x_ix_j.$$",
			"",
			"This is just what the shapes force: $(1\\times n)(n\\times 1)$. Now:",
			"",
			"> $$",
			"> \\nabla(x^\\top A x) = (A + A^\\top)x",
			"> $$",
			"",
			"The two terms are a row-read and a column-read.",
		].join("\n");
		const out = normalizeTutorMarkdown(src);
		expect(out).toContain("> $$\n> x^\\top A x = \\sum_{i,j} A_{ij}x_ix_j.\n> $$\n\nThis is just what");
		expect(out).toContain("> $$\n> \\nabla(x^\\top A x) = (A + A^\\top)x\n> $$\n\nThe two terms");
		for (const line of out.split("\n")) if (line.includes("$$")) expect(line.startsWith(">")).toBe(true);
		expect(normalizeTutorMarkdown(out)).toBe(out);
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

describe("mathSources", () => {
	it("lists inline and display formulas in document order", () => {
		const md = "Let $M = B^\\top B$ where\n\n$$\nx^\\top M x \\ge 0\n$$\n\nso $M$ is PSD.";
		expect(mathSources(md)).toEqual([
			{ tex: "M = B^\\top B", display: false },
			{ tex: "x^\\top M x \\ge 0", display: true },
			{ tex: "M", display: false },
		]);
	});

	it("skips code, escaped dollars, and prices", () => {
		const md = "It costs \\$5 or $ 3 and $4, see `$x$` and\n```\n$y$\n```\nthen $z$.";
		expect(mathSources(md)).toEqual([{ tex: "z", display: false }]);
	});

	it("strips callout prefixes from display math", () => {
		const md = "> [!note]\n> $$\n> a^2 + b^2\n> $$";
		expect(mathSources(md)).toEqual([{ tex: "a^2 + b^2", display: true }]);
	});
});
