import { describe, expect, it, vi } from "vitest";
import { emptyFlashcardLibrary, makeCard } from "@groundwork/core";

vi.mock("obsidian", () => ({ Notice: class {} }));
const { libraryDecks } = await import("../src/flashcards-library-pane");

const NOW = new Date("2026-10-02T12:00:00.000Z");

describe("libraryDecks", () => {
	const lib = {
		...emptyFlashcardLibrary(),
		decks: [
			{ id: "deck-calc", title: "Calculus fluency", goalId: "g1" },
			{ id: "loose", title: "Loose ends" },
			{ id: "empty", title: "Empty" },
		],
		cards: [
			makeCard({ id: "a", deckId: "deck-calc", concept: "Derivative", front: "d/dx x^2?", back: "2x", now: NOW }),
			makeCard({ id: "b", deckId: "loose", concept: "Odds", front: "What is odds?", back: "A ratio.", now: NOW }),
		],
	};

	it("lists every deck, including an empty one, and ignores goals", () => {
		expect(libraryDecks(lib).map((d) => d.title)).toEqual(["Calculus fluency", "Empty", "Loose ends"]);
		expect(libraryDecks(lib).map((d) => d.id)).toEqual(["deck-calc", "empty", "loose"]);
	});
});
