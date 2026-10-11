/**
 * @vitest-environment jsdom
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage } from "@groundwork/core";
import { flashcardRefusalHistory, renderUpgradePrompt, scrubRefusedTurn, tutorWeightClick } from "../src/upgrade-prompt";

beforeAll(() => {
	const proto = HTMLElement.prototype as HTMLElement & {
		empty: () => void;
		createEl: (tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => HTMLElement;
		createDiv: (opts?: { cls?: string; attr?: Record<string, string> }) => HTMLElement;
		createSpan: (opts?: { cls?: string; text?: string }) => HTMLElement;
	};
	proto.empty = function empty() {
		this.replaceChildren();
	};
	proto.createEl = function createEl(tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
		const el = this.ownerDocument.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		if (opts?.attr) {
			for (const [key, value] of Object.entries(opts.attr)) el.setAttribute(key, value);
		}
		this.append(el);
		return el;
	};
	proto.createDiv = function createDiv(opts) {
		return this.createEl("div", opts);
	};
	proto.createSpan = function createSpan(opts) {
		return this.createEl("span", opts);
	};
});

const user: ChatMessage = { role: "user", content: "Explain a limit with Heavy." };
const stopped: ChatMessage = { role: "assistant", content: [{ type: "text", text: "(stopped)" }] };

describe("upgrade prompt", () => {
	it("keeps Free on Light and lets Groundwork save Heavy", () => {
		expect(tutorWeightClick("free", "light", "heavy")).toBe("heavy_prompt");
		expect(tutorWeightClick("free", "heavy", "heavy")).toBe("heavy_prompt");
		expect(tutorWeightClick("free", "light", "light")).toBe("ignore");
		expect(tutorWeightClick("included", "light", "heavy")).toBe("save");
		expect(tutorWeightClick("included", "heavy", "heavy")).toBe("ignore");
		expect(tutorWeightClick("byom", "light", "heavy")).toBe("heavy_prompt");
	});

	it("drops a refused Heavy turn and keeps a flashcard question with a short answer", () => {
		expect(scrubRefusedTurn([user, stopped])).toEqual([]);
		const kept = flashcardRefusalHistory([user, stopped]);
		expect(kept[0]).toEqual(user);
		expect(JSON.stringify(kept[1])).toContain("paid plans");
		expect(JSON.stringify(kept[1])).not.toContain("(stopped)");
	});

	it("offers Groundwork at $20 and Bring your own model at $6, in both topics", () => {
		for (const topic of ["heavy", "flashcards"] as const) {
			const parent = document.createElement("div");
			document.body.append(parent);
			const plans: string[] = [];
			let dismissed = false;
			const dialog = renderUpgradePrompt(parent, topic, {
				onPlan: (plan) => plans.push(plan),
				onDismiss: () => {
					dismissed = true;
				},
			});
			expect(dialog.getAttribute("role")).toBe("dialog");
			expect(dialog.querySelector("h2")?.id).toBe("gw-upgrade-title");
			expect(dialog.textContent).toContain("$20/month");
			expect(dialog.textContent).toContain("$6/month");
			expect(dialog.textContent).toContain("Not now");
			expect(dialog.textContent).not.toMatch(/\$12/);
			for (const button of dialog.querySelectorAll("button")) expect(button.getAttribute("type")).toBe("button");
			[...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Groundwork"))?.click();
			[...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Bring your own model"))?.click();
			[...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Not now")?.click();
			expect(plans).toEqual(["included", "byom"]);
			expect(dismissed).toBe(true);
			expect(parent.querySelector(".gw-upgrade")).toBeNull();
			parent.remove();
		}
	});
});
