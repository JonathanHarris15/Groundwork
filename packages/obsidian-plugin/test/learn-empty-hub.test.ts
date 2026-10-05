import { describe, expect, it } from "vitest";
import { isSingleLearnEmptyHub, LEARN_EMPTY_HERO_TITLE, learnEmptyHubCounts } from "../src/ui-invariants";

/** Minimal DOM stand-in so we can assert hub duplication without a browser. */
function messagesRoot(html: string): ParentNode {
	const root = { innerHTML: html };
	return {
		querySelectorAll(selector: string): Element[] {
			if (selector === ".gw-messages > .gw-empty") {
				const matches = html.match(/<div class="gw-empty"/g);
				return (matches ?? []).map(() => ({}) as Element);
			}
			if (selector === ".gw-messages > .gw-empty .gw-hero h2") {
				const re = /<h2>([^<]*)<\/h2>/g;
				const out: Element[] = [];
				let m: RegExpExecArray | null;
				while ((m = re.exec(html))) {
					if (m[1] === LEARN_EMPTY_HERO_TITLE) out.push({ textContent: m[1] } as Element);
				}
				return out;
			}
			return [];
		},
	} as ParentNode;
}

describe("learn empty hub counts", () => {
	it("expects one empty block and one hero title", () => {
		const root = messagesRoot(
			`<div class="gw-messages"><div class="gw-empty"><div class="gw-hero"><h2>${LEARN_EMPTY_HERO_TITLE}</h2></div></div></div>`,
		);
		expect(isSingleLearnEmptyHub(root)).toBe(true);
		expect(learnEmptyHubCounts(root)).toEqual({ emptyBlocks: 1, heroTitles: 1 });
	});

	it("flags stacked duplicate hubs", () => {
		const root = messagesRoot(
			`<div class="gw-messages"><div class="gw-empty"><div class="gw-hero"><h2>${LEARN_EMPTY_HERO_TITLE}</h2></div></div><div class="gw-empty"><div class="gw-hero"><h2>${LEARN_EMPTY_HERO_TITLE}</h2></div></div></div>`,
		);
		expect(isSingleLearnEmptyHub(root)).toBe(false);
		expect(learnEmptyHubCounts(root).emptyBlocks).toBe(2);
	});
});
