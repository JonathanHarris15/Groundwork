/**
 * Heavy and new flashcards are paid plans (Bring your own model or Groundwork).
 * Free stays on Light. Decks already on the account stay readable.
 * Public copy may name the $6 and $20 prices. It does not name a dollar amount of credit.
 */

import type { ChatMessage } from "../agent/types";
import { PATHS } from "../store";
import { parseFlashcardLibrary, type Flashcard, type FlashcardLibrary, type FlashDeck } from "../flashcards";
import type { PlanId } from "./plans";
import type { AccountView } from "./usage";

export const HEAVY_REQUIRES_UPGRADE = "heavy_requires_upgrade";
export const FLASHCARDS_REQUIRE_UPGRADE = "flashcards_require_upgrade";

/** Readable by a 0.2.x plugin, which shows `error` and does not know the code. */
export const HEAVY_UPGRADE_ERROR =
	"Heavy is on the paid plans. Free stays on Light. Groundwork is $20 a month and includes Heavy. Bring your own model is $6 a month and uses your own model and key.";

export const FLASHCARDS_UPGRADE_ERROR =
	"Flashcards are on the paid plans. You can still review decks you already have. Groundwork is $20 a month. Bring your own model is $6 a month.";

/** What the tutor says in the chat when a Free account asks for new cards. */
export const FREE_FLASHCARD_REPLY = "Flashcards are on the paid plans. You can still review decks you already have.";

/** Added to the system prompt so the tutor does not offer cards on Free. */
export const FREE_FLASHCARD_NOTE = `# Flashcards
This account is on Free. Do not offer to make flashcards. If they ask for cards, say that flashcards are on the paid plans, in one or two sentences, and stop. They can still review decks they already have.`;

const WRITE_FLASHCARDS = /\b(make|create|generate|write|add|build|save|edit|update|change|new)\b/i;

export function paidPlan(plan: PlanId | null | undefined): boolean {
	return plan === "byom" || plan === "included";
}

/** Hosted Heavy is the Groundwork plan. Bring your own model does not use it. */
export function hostedHeavyAllowed(view: Pick<AccountView, "plan" | "ownModel">): boolean {
	return view.plan === "included" && !view.ownModel;
}

export function asksToWriteFlashcards(text: string): boolean {
	if (!/\bflashcards?\b/i.test(text)) return false;
	return WRITE_FLASHCARDS.test(text);
}

/** A hosted turn that would create or rewrite cards. Listing or reviewing is not this. */
export function isHostedFlashcardGeneration(messages: ChatMessage[]): boolean {
	if (asksToWriteFlashcards(lastUserText(messages))) return true;
	return messages.some((message) => {
		if (!Array.isArray(message.content)) return false;
		return message.content.some((block) => block.type === "tool_use" && block.name === "save_flashcard");
	});
}

/**
 * True when the flashcards file gains a deck or card, or changes a question, answer, concept, deck, or deck name.
 * Rating a card, deleting one, or leaving the file alone is not a write.
 */
export function flashcardFileWrites(before: string | undefined, after: string | undefined): boolean {
	if (after == null || before === after) return false;
	let previous: FlashcardLibrary;
	let next: FlashcardLibrary;
	try {
		previous = before ? parseFlashcardLibrary(JSON.parse(before)) : emptyEnough();
		next = parseFlashcardLibrary(JSON.parse(after));
	} catch {
		return true;
	}
	return libraryWrites(previous, next);
}

export function flashcardsPath(): string {
	return PATHS.flashcards;
}

function emptyEnough(): FlashcardLibrary {
	return { updatedAt: "", addFromTeachingNotes: false, decks: [], cards: [], retiredDeckIds: [], retiredCardIds: [] };
}

function libraryWrites(before: FlashcardLibrary, after: FlashcardLibrary): boolean {
	const cards = new Map(before.cards.map((card) => [card.id, card]));
	for (const card of after.cards) {
		const prior = cards.get(card.id);
		if (!prior || cardIdentity(prior) !== cardIdentity(card)) return true;
	}
	const decks = new Map(before.decks.map((deck) => [deck.id, deck]));
	for (const deck of after.decks) {
		const prior = decks.get(deck.id);
		if (!prior || deckIdentity(prior) !== deckIdentity(deck)) return true;
	}
	return false;
}

function cardIdentity(card: Flashcard): string {
	return `${card.deckId}\n${card.concept}\n${card.front}\n${card.back}`;
}

function deckIdentity(deck: FlashDeck): string {
	return `${deck.title}\n${deck.goalId ?? ""}`;
}

function lastUserText(messages: ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const parts: string[] = [];
		for (const block of message.content) {
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
		if (parts.length) return parts.join(" ");
	}
	return "";
}
