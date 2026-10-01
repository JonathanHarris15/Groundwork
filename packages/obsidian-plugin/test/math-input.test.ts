import { mathSources } from "@groundwork/core";
import { describe, expect, it } from "vitest";
import { insertLatex, mathContext, segmentAnswer } from "../src/math-input";

const SAMPLES = [
	"The value is $x^2+1$.",
	"$$\n\\int_0^1 x\\,dx\n$$",
	"cost is $5 and then $x$",
	"slope is $ 3 $",
	"before\n```\n$not math$\n```\nafter $\\alpha$",
	"a $b$ c $d$",
	"unclosed $x^2",
	"$$ not closed $x$",
	"escaped \\$x$ is not math, but $\\alpha$ is",
	"$x$$y$",
];

describe("segmentAnswer", () => {
	it("finds the same formulas Obsidian would typeset", () => {
		for (const sample of SAMPLES) {
			const got = segmentAnswer(sample, null)
				.filter((p) => p.kind === "math")
				.map((p) => ({ tex: p.tex, display: p.display }));
			expect(got, sample).toEqual(mathSources(sample));
		}
	});

	it("keeps only the formula under the caret as source", () => {
		const source = "see $x^2$ now";
		const inside = segmentAnswer(source, source.indexOf("x^2"));
		const math = inside.find((p) => p.kind === "math");
		expect(math?.kind === "math" && math.live).toBe(true);

		const after = segmentAnswer(source, source.length);
		const rendered = after.find((p) => p.kind === "math");
		expect(rendered?.kind === "math" && rendered.live).toBe(false);
	});

	it("round-trips the original string", () => {
		for (const sample of SAMPLES) {
			const back = segmentAnswer(sample, null).map((p) => (p.kind === "text" ? p.text : p.raw)).join("");
			expect(back).toBe(sample);
		}
	});
});

describe("insertLatex", () => {
	it("wraps a symbol in dollars and leaves the caret after it", () => {
		expect(insertLatex("answer ", 7, 7, "\\alpha")).toEqual({ source: "answer $\\alpha$", caret: 15 });
		expect(insertLatex("answer", 6, 6, "\\alpha")).toEqual({ source: "answer $\\alpha$", caret: 15 });
	});

	it("drops the caret inside a fraction so it can be filled in", () => {
		const next = insertLatex("", 0, 0, "\\frac{|}{}");
		expect(next.source).toBe("$\\frac{}{}$");
		expect(next.source.slice(0, next.caret)).toBe("$\\frac{");
	});

	it("inserts into a formula that is already open", () => {
		expect(insertLatex("$x", 2, 2, "^{|}")).toEqual({ source: "$x^{}$", caret: 4 });
	});

	it("closes a fresh dollar instead of stacking another pair", () => {
		expect(insertLatex("$", 1, 1, "\\alpha")).toEqual({ source: "$\\alpha$", caret: 8 });
		expect(insertLatex("$$", 2, 2, "\\alpha")).toEqual({ source: "$$\\alpha$$", caret: 10 });
	});

	it("does not treat the closer of a finished formula as a new opener", () => {
		expect(mathContext("$x$", 3)).toBe("outside");
		expect(insertLatex("$x$", 3, 3, "\\beta")).toEqual({ source: "$x$ $\\beta$", caret: 11 });
	});

	it("replaces the selection", () => {
		expect(insertLatex("ab", 0, 2, "\\pi")).toEqual({ source: "$\\pi$", caret: 5 });
	});
});
