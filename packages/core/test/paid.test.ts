import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/agent/types";
import { emptyFlashcardLibrary, makeCard, serializeFlashcardLibrary } from "../src/flashcards";
import {
	asksToWriteFlashcards,
	FLASHCARDS_UPGRADE_ERROR,
	flashcardFileWrites,
	HEAVY_UPGRADE_ERROR,
	isHostedFlashcardGeneration,
} from "../src/account/paid";

function saved(front = "What is a limit?", title = "Limits"): string {
	const lib = emptyFlashcardLibrary(new Date("2026-10-02T00:00:00.000Z"));
	lib.decks.push({ id: "limits", title });
	lib.cards.push(makeCard({ id: "c1", deckId: "limits", concept: "Limit", front, back: "A value", now: new Date("2026-10-02T00:00:00.000Z") }));
	return serializeFlashcardLibrary(lib);
}

describe("paid flashcards", () => {
	it("treats a request to make cards as generation, and a review as not", () => {
		expect(asksToWriteFlashcards("Please make flashcards for limits.")).toBe(true);
		expect(asksToWriteFlashcards("Add a new flashcard about the chain rule.")).toBe(true);
		expect(asksToWriteFlashcards("I reviewed my flashcards, now teach me the chain rule.")).toBe(false);
		expect(asksToWriteFlashcards("Study my flashcards.")).toBe(false);
		const messages: ChatMessage[] = [
			{ role: "user", content: "What is due?" },
			{ role: "assistant", content: [{ type: "tool_use", id: "1", name: "save_flashcard", input: {} }] },
		];
		expect(isHostedFlashcardGeneration(messages)).toBe(true);
		expect(isHostedFlashcardGeneration([{ role: "user", content: "List my flashcards." }])).toBe(false);
	});

	it("allows a rating or a delete, and refuses a new card, an edit, or a rename", () => {
		const before = saved();
		expect(flashcardFileWrites(undefined, before)).toBe(true);
		expect(flashcardFileWrites(before, before)).toBe(false);
		const rated = JSON.parse(before) as { cards: Array<{ reps: number }> };
		rated.cards[0].reps = 4;
		expect(flashcardFileWrites(before, JSON.stringify(rated))).toBe(false);
		const edited = JSON.parse(before) as { cards: Array<{ front: string }> };
		edited.cards[0].front = "Define a limit.";
		expect(flashcardFileWrites(before, JSON.stringify(edited))).toBe(true);
		const renamed = JSON.parse(before) as { decks: Array<{ title: string }> };
		renamed.decks[0].title = "Derivatives";
		expect(flashcardFileWrites(before, JSON.stringify(renamed))).toBe(true);
		const removed = JSON.parse(before) as { cards: unknown[] };
		removed.cards = [];
		expect(flashcardFileWrites(before, JSON.stringify(removed))).toBe(false);
	});

	it("names the $6 and $20 prices and not a dollar amount of credit", () => {
		for (const text of [HEAVY_UPGRADE_ERROR, FLASHCARDS_UPGRADE_ERROR]) {
			expect(text).toContain("$20");
			expect(text).toContain("$6");
			expect(text).not.toMatch(/\$12/);
		}
	});
});
