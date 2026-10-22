/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { tagMath, tagMathChrome } from "../src/math-source";

describe("display math chrome", () => {
	it("tags a mark around display math and the assistive layer", () => {
		const root = document.createElement("div");
		root.innerHTML = `
			<mark><div class="math math-block">E</div></mark>
			<mark><span class="math math-inline">x</span></mark>
			<div class="MathJax" display="true" jax="CHTML">
				<span unselectable="on" display="block">mml</span>
			</div>
		`;
		tagMathChrome(root);
		const marks = [...root.querySelectorAll("mark")];
		expect(marks[0]?.classList.contains("gw-mark-math")).toBe(true);
		expect(marks[1]?.classList.contains("gw-mark-math")).toBe(false);
		expect(root.querySelector("[display='block']")?.classList.contains("gw-math-assistive")).toBe(true);
	});

	it("tags a mark when the only display signal is a MathJax container", () => {
		const root = document.createElement("div");
		const mark = document.createElement("mark");
		const jax = document.createElement("span");
		jax.setAttribute("jax", "CHTML");
		jax.setAttribute("display", "true");
		mark.append(jax);
		root.append(mark);
		tagMath(root, "no formulas here");
		expect(mark.classList.contains("gw-mark-math")).toBe(true);
	});
});
