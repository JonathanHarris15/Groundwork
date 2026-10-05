import { describe, expect, it, vi } from "vitest";
import { emptyFlashcardLibrary, makeCard, type Goal } from "@groundwork/core";

vi.mock("obsidian", () => ({ Notice: class {} }));
const { libraryDecks } = await import("../src/flashcards-library-pane");

const NOW = new Date("2026-10-02T12:00:00.000Z");
const goal = (id: string, title: string, status: Goal["status"]) => ({ id, title, status, targets: [], built: [], nodes: [] }) as unknown as Goal;

describe("libraryDecks", () => {
	const goals = [goal("g2", "Statistics", "done"), goal("g1", "Calculus fluency", "active"), goal("g3", "Linear algebra", "paused")];
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

	it("lists one deck per goal, active first, and other decks only when they hold cards", () => {
		expect(libraryDecks(lib, goals).map((d) => d.title)).toEqual(["Calculus fluency", "Linear algebra", "Statistics", "Loose ends"]);
	});

	it("folds a deck linked to a goal into that goal's deck", () => {
		expect(libraryDecks(lib, goals).filter((d) => d.title === "Calculus fluency")).toHaveLength(1);
	});

	it("lets the learner study any goal deck except a finished goal's", () => {
		const decks = libraryDecks(lib, goals);
		expect(decks.find((d) => d.id === "g1")?.studyGoalId).toBe("g1");
		expect(decks.find((d) => d.id === "g3")).toMatchObject({ note: "Paused", studyGoalId: "g3" });
		expect(decks.find((d) => d.id === "g2")).toMatchObject({ note: "Done", studyGoalId: undefined });
	});
});
