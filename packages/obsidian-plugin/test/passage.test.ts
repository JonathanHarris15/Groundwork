/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { findQuoteRange } from "../src/aside";
import { clampSelection, passageOf } from "../src/passage";

function lesson(): { root: HTMLElement; turn: HTMLElement; sosc: HTMLElement } {
	document.body.innerHTML = `
		<div id="root">
			<div id="outside">margin</div>
			<div class="gw-turn" data-anchor="item:1">
				<div class="gw-msg-row">
					<div class="gw-who">Groundwork</div>
					<div class="gw-msg gw-assistant">
						<p id="open">Good—that's still solid. Now let's establish the foundation for SOSC.</p>
						<h2>Ground: The journey from necessary to sufficient</h2>
						<p id="sosc">Second-order sufficient condition (SOSC) flips this arrow.</p>
					</div>
				</div>
			</div>
		</div>`;
	const turn = document.querySelector(".gw-turn") as HTMLElement;
	const sosc = document.getElementById("sosc") as HTMLElement;
	return { root: document.getElementById("root") as HTMLElement, turn, sosc };
}

describe("highlight anchor", () => {
	it("finds assistant prose under the avatar row", () => {
		const { turn } = lesson();
		expect(turn.querySelector(":scope > .gw-msg")).toBeNull();
		expect(passageOf(turn).classList.contains("gw-assistant")).toBe(true);
	});

	it("keeps a margin drag on the paragraph that was highlighted", () => {
		const { turn, sosc } = lesson();
		const outside = document.getElementById("outside") as HTMLElement;
		const range = document.createRange();
		range.setStart(outside.firstChild as Text, 0);
		range.setEnd(sosc.firstChild as Text, (sosc.firstChild as Text).length);
		clampSelection(range, turn);
		const text = range.toString();
		expect(text).toContain("SOSC");
		expect(text).not.toContain("still solid");
		const found = findQuoteRange(passageOf(turn), text.trim());
		expect(found?.toString()).toContain("SOSC");
		expect(found?.startContainer.parentElement?.id).toBe("sosc");
	});
});
