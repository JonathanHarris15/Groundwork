/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { paintMarkdown } from "../src/markdown-face";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function renderAs(html: string) {
	const calls: string[] = [];
	const render = async (el: HTMLElement, markdown: string) => {
		calls.push(markdown);
		el.innerHTML = html;
	};
	return { calls, render };
}

describe("paintMarkdown", () => {
	it("shows the plain text at once, then swaps in the rendered markdown alone", async () => {
		const parent = document.createElement("div");
		const { calls, render } = renderAs('<p>What is <mjx-container>x²</mjx-container>?</p>');
		paintMarkdown(parent, "span", "gw-fc-card-back", "What is $x^2$?", render);
		expect(parent.innerHTML).toBe('<span class="gw-fc-card-back">What is $x^2$?</span>');
		await settle();
		expect(calls).toEqual(["What is $x^2$?"]);
		expect(parent.children).toHaveLength(1);
		expect(parent.firstElementChild!.className).toBe("gw-fc-card-back");
		expect(parent.textContent).toBe("What is x²?");
	});

	it("keeps the plain text when rendering yields nothing or fails", async () => {
		const parent = document.createElement("div");
		paintMarkdown(parent, "div", "gw-fcard-md", "Limit", renderAs("").render);
		paintMarkdown(parent, "div", "gw-fcard-md", "Slope", async () => {
			throw new Error("no renderer");
		});
		await settle();
		expect([...parent.children].map((c) => c.textContent)).toEqual(["Limit", "Slope"]);
	});

	it("leaves plain text alone without a renderer", () => {
		const parent = document.createElement("div");
		paintMarkdown(parent, "span", "", "Plain", undefined);
		expect(parent.innerHTML).toBe("<span>Plain</span>");
	});
});
