/**
 * Compact upgrade prompt for Heavy and new flashcards.
 * Prices match the site. A dollar amount of hosted credit is not shown.
 */

import type { ChatMessage } from "@groundwork/core";
import { FREE_FLASHCARD_REPLY, type PlanId } from "@groundwork/core";

export type UpgradeTopic = "heavy" | "flashcards";
export type PaidCheckoutPlan = "byom" | "included";

interface UpgradeCopy {
	title: string;
	detail: string;
	groundworkHint: string;
	byomHint: string;
}

const COPY: Record<UpgradeTopic, UpgradeCopy> = {
	heavy: {
		title: "Heavy is a paid plan",
		detail: "Free stays on Light.",
		groundworkHint: "Includes Heavy.",
		byomHint: "Your own model and key.",
	},
	flashcards: {
		title: "Flashcards are a paid plan",
		detail: "You can still review decks you already have.",
		groundworkHint: "Includes flashcards.",
		byomHint: "Your own model and key.",
	},
};

/** What a Light/Heavy click should do. Free never saves Heavy. */
export function tutorWeightClick(
	plan: PlanId | null | undefined,
	current: "light" | "heavy",
	next: "light" | "heavy",
): "save" | "heavy_prompt" | "ignore" {
	if (next === "heavy" && plan !== "included") return "heavy_prompt";
	if (current === next) return "ignore";
	return "save";
}

/** Drop the refused user turn and the "(stopped)" reply the agent inserts after an error. */
export function scrubRefusedTurn(messages: ChatMessage[]): ChatMessage[] {
	const next = messages.slice();
	const last = next[next.length - 1];
	if (last?.role === "assistant" && messageText(last).trim() === "(stopped)") next.pop();
	const user = next[next.length - 1];
	if (user?.role === "user") next.pop();
	return next;
}

/** Keep the question, and replace the stopped reply with the short paid-plan answer. */
export function flashcardRefusalHistory(messages: ChatMessage[]): ChatMessage[] {
	const next = messages.slice();
	const reply: ChatMessage = { role: "assistant", content: [{ type: "text", text: FREE_FLASHCARD_REPLY }] };
	const last = next[next.length - 1];
	if (last?.role === "assistant" && messageText(last).trim() === "(stopped)") next[next.length - 1] = reply;
	else next.push(reply);
	return next;
}

export function renderUpgradePrompt(
	parent: HTMLElement,
	topic: UpgradeTopic,
	handlers: { onPlan: (plan: PaidCheckoutPlan) => void; onDismiss: () => void },
): HTMLElement {
	const copy = COPY[topic];
	parent.querySelector(".gw-upgrade")?.remove();
	const dialog = parent.createDiv({
		cls: "gw-upgrade",
		attr: { role: "dialog", "aria-labelledby": "gw-upgrade-title" },
	});
	dialog.createEl("h2", { cls: "gw-upgrade-title", text: copy.title, attr: { id: "gw-upgrade-title" } });
	dialog.createEl("p", { cls: "gw-upgrade-detail", text: copy.detail });
	const actions = dialog.createDiv({ cls: "gw-upgrade-actions" });
	const groundwork = planButton(actions, "Groundwork, $20/month", copy.groundworkHint, "gw-lib-btn mod-cta");
	groundwork.addEventListener("click", () => handlers.onPlan("included"));
	const byom = planButton(actions, "Bring your own model, $6/month", copy.byomHint, "gw-lib-btn");
	byom.addEventListener("click", () => handlers.onPlan("byom"));
	const dismiss = actions.createEl("button", { cls: "gw-lib-btn", text: "Not now", attr: { type: "button" } });
	dismiss.addEventListener("click", () => {
		dialog.remove();
		handlers.onDismiss();
	});
	groundwork.focus();
	return dialog;
}

function planButton(parent: HTMLElement, label: string, hint: string, cls: string): HTMLElement {
	const button = parent.createEl("button", { cls, attr: { type: "button" } });
	button.createSpan({ text: label });
	button.createSpan({ cls: "gw-upgrade-hint", text: hint });
	return button;
}

function messageText(message: ChatMessage): string {
	if (typeof message.content === "string") return message.content;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}
