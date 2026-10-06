import { describe, expect, it } from "vitest";
import { isTutorMemoryPath } from "../src/account";
import {
	auditFlashcardLibrary,
	buildStudyQueue,
	cardsInDeck,
	createDeck,
	createFlashcard,
	deleteDeck,
	emptyFlashcardLibrary,
	exportFlashcards,
	flashcardContentKey,
	flashcardQualityIssue,
	loadFlashcardLibrary,
	makeCard,
	parseCardFile,
	parseFlashcardLibrary,
	removeFlashcardMirrors,
	saveFlashcard,
	serializeCardMarkdown,
	serializeFlashcardLibrary,
	syncFlashcards,
	updateFlashcard,
} from "../src/flashcards";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore, PATHS } from "../src/store";
import { toolByName } from "../src/tools";

const NOW = new Date("2026-10-02T12:00:00.000Z");

function pair() {
	const memory = new MemoryVaultIO();
	const vault = new MemoryVaultIO();
	const store = new KnowledgeStore(memory, { context: vault, now: () => NOW });
	return { memory, vault, store };
}

describe("flashcard decks", () => {
	it("makes a card with no due date", () => {
		const card = makeCard({ deckId: "library", concept: "Base rates", front: "Why?", back: "False alarms.", now: NOW });
		expect(card).not.toHaveProperty("due");
		expect(card).not.toHaveProperty("state");
		expect(serializeCardMarkdown(card, "Library")).not.toMatch(/due:|intervalMinutes:|ease:/);
	});

	it("studies every card, including one an older file marked due later", () => {
		const later = makeCard({ id: "later", deckId: "d", concept: "Zed", front: "Later?", back: "Now.", now: NOW });
		const sooner = makeCard({ id: "sooner", deckId: "d", concept: "Aye", front: "Soon?", back: "Yes.", now: NOW });
		const lib = parseFlashcardLibrary({
			decks: [{ id: "d", title: "Deck" }],
			cards: [
				{ ...later, due: "2099-01-01T00:00:00.000Z", state: "review", intervalMinutes: 99_999, ease: 2.5 },
				sooner,
			],
		});
		expect(lib.cards[0]).not.toHaveProperty("due");
		expect(buildStudyQueue(lib.cards).map((c) => c.id)).toEqual(["sooner", "later"]);
	});

	it("leaves a card with a bad answer out of the deck session", () => {
		const ok = makeCard({ id: "ok", deckId: "d", concept: "Odds", front: "What is odds?", back: "A ratio.", now: NOW });
		const bad = makeCard({ id: "bad", deckId: "d", concept: "Calc", front: "Types?", back: "min, max, saddle", now: NOW });
		expect(buildStudyQueue([bad, ok]).map((c) => c.id)).toEqual(["ok"]);
	});
});

describe("flashcard vault mirror", () => {
	it("keeps cards on the account and copies markdown only when asked", async () => {
		const { memory, vault, store } = pair();
		await store.upsertConcept({ title: "Base rates", summary: "A positive test is often a false alarm when the disease is rare." });
		const card = await createFlashcard(
			store,
			{ concept: "Base rates", front: "Why is a positive result often wrong?", back: "False alarms outnumber real cases.", deckId: "exam-2", deckTitle: "Exam 2" },
			NOW,
		);
		expect(vault.files.has("Groundwork/flashcards/Base rates.md")).toBe(false);
		expect(vault.files.has("submissions/flashcards/Base rates.md")).toBe(false);
		expect(isTutorMemoryPath(".groundwork/flashcards.json")).toBe(true);
		expect(isTutorMemoryPath("Groundwork/flashcards/Base rates.md")).toBe(false);
		const saved = await loadFlashcardLibrary(memory);
		expect(saved.cards.map((c) => c.id)).toEqual([card.id]);
		const written = await exportFlashcards(store, ["Groundwork", "submissions"], NOW);
		expect(written).toEqual(["Groundwork/flashcards", "submissions/flashcards"]);
		for (const folder of written) {
			const note = await vault.read(`${folder}/Base rates.md`);
			expect(note).toContain("Why is a positive result often wrong?");
			expect(note).toContain("False alarms outnumber real cases.");
			expect(parseCardFile(note)?.kind).toBe("card");
			expect(await vault.read(`${folder}/Exam 2.md`)).toContain("[[Base rates]]");
		}
		expect(vault.files.has("notes/flashcards/Base rates.md")).toBe(false);
	});

	it("pulls a hand edit back onto the account and does not push account edits into the vault", async () => {
		const { memory, vault, store } = pair();
		const card = await createFlashcard(store, { concept: "Base rates", front: "Why?", back: "Answer A", deckId: "library", deckTitle: "Library" }, NOW);
		const path = "Groundwork/flashcards/Base rates.md";
		expect(vault.files.has(path)).toBe(false);
		await exportFlashcards(store, ["Groundwork"], NOW);
		const edited = (await vault.read(path)).replace("Answer A", "Answer B");
		expect(edited).toContain(`contentKey: ${card.contentKey}`);
		await vault.write(path, edited);
		const lib = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(lib.cards[0].back).toBe("Answer B");
		expect(await vault.read(path)).toContain("Answer B");
		expect(await vault.read(path)).toContain(`contentKey: ${card.contentKey}`);

		await exportFlashcards(store, ["Groundwork"], NOW);
		const cloud = await loadFlashcardLibrary(memory);
		cloud.cards[0].back = "Answer C";
		cloud.cards[0].contentKey = flashcardContentKey("Base rates", "Why?", "Answer C");
		await memory.write(".groundwork/flashcards.json", `${JSON.stringify(cloud, null, 2)}\n`);
		const kept = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(kept.cards[0].back).toBe("Answer C");
		expect(await vault.read(path)).toContain("Answer B");
		expect(await vault.read(path)).not.toContain("Answer C");
	});

	it("imports a new card note and does not delete a file that is not a card", async () => {
		const { vault, store } = pair();
		await vault.write("Groundwork/homework.md", "hand this in\n");
		const note = serializeCardMarkdown(
			{ ...makeCard({ id: "fc_hand", deckId: "library", concept: "Odds", front: "What is odds?", back: "A ratio.", now: NOW }), contentKey: "stale" },
			"Library",
		);
		await vault.write("Groundwork/flashcards/Odds.md", note);
		await vault.write("Groundwork/flashcards/scratch.md", "just a note\n");
		const lib = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(lib.cards.map((c) => c.concept)).toContain("Odds");
		expect(await vault.read("Groundwork/homework.md")).toBe("hand this in\n");
		expect(await vault.read("Groundwork/flashcards/scratch.md")).toBe("just a note\n");
		await removeFlashcardMirrors(vault, ["Groundwork"]);
		expect(vault.files.has("Groundwork/flashcards/Odds.md")).toBe(false);
		expect(await vault.read("Groundwork/homework.md")).toBe("hand this in\n");
		expect(await vault.read("Groundwork/flashcards/scratch.md")).toBe("just a note\n");
	});

	it("does not make cards from teaching notes, even when an older account asked for that", async () => {
		const { memory, store } = pair();
		await store.upsertConcept({
			title: "Base rates",
			summary: "Why does a rare disease make a positive test hard to trust?\n\nAbout 10 false alarms show up for every real case.",
		});
		await store.setGoal({ title: "Exam 2", targets: ["Base rates"], nodes: [{ title: "Base rates" }] }, { judgments: "off" });
		const seeded = emptyFlashcardLibrary(NOW);
		seeded.addFromTeachingNotes = true;
		await memory.write(PATHS.flashcards, serializeFlashcardLibrary(seeded));
		const first = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(first.cards).toHaveLength(0);
		expect(first.decks).toHaveLength(0);
		expect(first.addFromTeachingNotes).toBe(true);
	});

	it("rejects multi-answer flashcards and flags existing junk on load", () => {
		expect(flashcardQualityIssue("What are the types of critical point?", "min, max, saddle")).toMatch(/atomic|list/i);
		expect(flashcardQualityIssue("What type of critical point has det < 0?", "saddle")).toBeNull();
		const lib = emptyFlashcardLibrary(NOW);
		const bad = makeCard({ deckId: "library", concept: "Calc", front: "Types?", back: "min, max, saddle", now: NOW });
		expect(bad.qualityIssue).toBeTruthy();
		bad.qualityIssue = undefined;
		lib.cards.push(bad);
		expect(auditFlashcardLibrary(lib)).toBe(true);
		expect(lib.cards[0].qualityIssue).toBeTruthy();
	});

	it("drops the account copy on reset", async () => {
		const { memory, store } = pair();
		await createFlashcard(store, { concept: "Odds", front: "What is odds?", back: "A ratio." }, NOW);
		expect(memory.files.has(".groundwork/flashcards.json")).toBe(true);
		await store.resetVault();
		expect(memory.files.has(".groundwork/flashcards.json")).toBe(false);
	});
});

describe("flashcard editing", () => {
	it("changes the wording and does not add a due date", async () => {
		const { store } = pair();
		const card = await createFlashcard(store, { concept: "Odds", front: "What is odds?", back: "A ratio." }, NOW);
		const edited = await updateFlashcard(store, card.id, { concept: "Odds", front: "What formula gives the odds of an event with probability p?", back: "p / (1 − p)." }, NOW);
		expect(edited.id).toBe(card.id);
		expect(edited.front).toBe("What formula gives the odds of an event with probability p?");
		expect(edited).not.toHaveProperty("due");
		const saved = await loadFlashcardLibrary(store.io);
		expect(saved.cards).toHaveLength(1);
		expect(saved.cards[0].back).toBe("p / (1 − p).");
	});

	it("refuses a list answer", async () => {
		const { store } = pair();
		const card = await createFlashcard(store, { concept: "Calc", front: "Which critical point has det < 0?", back: "saddle" }, NOW);
		await expect(updateFlashcard(store, card.id, { concept: "Calc", front: "Types?", back: "min, max, saddle" }, NOW)).rejects.toThrow();
	});
});

describe("flashcard tools", () => {
	it("saves a card on the account and lists the deck", async () => {
		const { vault, store } = pair();
		const saved = await toolByName("save_flashcard")!.run(
			{ concept: "Base rates", front: "Why 9%?", back: "False alarms.", deck: "Exam 2" },
			{ store, access: { readFolders: [], writeFolders: ["Groundwork"] } },
		);
		expect(saved.isError).toBeFalsy();
		expect(saved.text).toContain("stays on the account");
		expect(vault.files.has("Groundwork/flashcards/Base rates.md")).toBe(false);
		const listed = await toolByName("list_flashcards")!.run({}, { store });
		expect(listed.text).toContain("Why 9%?");
		expect(listed.text).toContain("Decks: Exam 2 (1)");
		expect(listed.text).not.toMatch(/due/i);
		const lib = await loadFlashcardLibrary(store.io);
		expect(lib.decks[0]).toMatchObject({ id: "exam-2", title: "Exam 2" });
		expect(lib.decks[0].goalId).toBeUndefined();
		const empty = await toolByName("save_flashcard")!.run({ concept: " ", front: "", back: "x" }, { store });
		expect(empty.isError).toBe(true);
	});
});

describe("named decks", () => {
	it("keeps decks separate from goals and lets one concept live in more than one deck", async () => {
		const { store } = pair();
		await store.setGoal({ title: "Exam 2", targets: ["Base rates"], nodes: [{ title: "Base rates" }] }, { judgments: "off" });
		const deck = await createDeck(store, "Nightly drills", NOW);
		expect(deck).toEqual({ id: "nightly-drills", title: "Nightly drills" });
		expect((await createDeck(store, "nightly drills", NOW)).id).toBe(deck.id);
		const card = await createFlashcard(
			store,
			{ concept: "Base rates", front: "Why 9%?", back: "False alarms.", deckId: deck.id, deckTitle: deck.title },
			NOW,
		);
		const saved = await saveFlashcard(store, { concept: "Base rates", front: "What swamps the signal?", back: "False alarms.", deck: "Exam morning" }, NOW);
		expect(saved.deckTitle).toBe("Exam morning");
		expect(saved.card.deckId).toBe("exam-morning");
		const lib = await loadFlashcardLibrary(store.io);
		expect(lib.decks.map((d) => d.id).sort()).toEqual(["exam-morning", "nightly-drills"]);
		expect(lib.decks.every((d) => d.goalId === undefined)).toBe(true);
		expect(cardsInDeck(lib, "nightly-drills").map((c) => c.id)).toEqual([card.id]);
		expect(cardsInDeck(lib, "exam-morning")).toHaveLength(1);
		expect(cardsInDeck(lib, "exam-2")).toHaveLength(0);
	});

	it("returns only the cards stored in that deck", () => {
		const lib = {
			...emptyFlashcardLibrary(),
			decks: [
				{ id: "deck-calc", title: "Calculus fluency", goalId: "g1" },
				{ id: "g1", title: "Limits" },
				{ id: "other", title: "Other" },
			],
			cards: [
				makeCard({ id: "linked", deckId: "deck-calc", concept: "Derivative", front: "d/dx x^2?", back: "2x", now: NOW }),
				makeCard({ id: "own", deckId: "g1", concept: "Limit", front: "What is a limit?", back: "A value approached.", now: NOW }),
				makeCard({ id: "elsewhere", deckId: "other", concept: "Odds", front: "What is odds?", back: "A ratio.", now: NOW }),
			],
		};
		expect(cardsInDeck(lib, "g1").map((c) => c.id)).toEqual(["own"]);
		expect(cardsInDeck(lib, "deck-calc").map((c) => c.id)).toEqual(["linked"]);
		expect(cardsInDeck(lib, "other").map((c) => c.id)).toEqual(["elsewhere"]);
	});
});

describe("delete a deck", () => {
	it("removes the deck and its cards, and does not restore exported notes", async () => {
		const { vault, store } = pair();
		const deck = await createDeck(store, "Nightly drills", NOW);
		const kept = await createDeck(store, "Exam morning", NOW);
		await createFlashcard(store, { concept: "Base rates", front: "Why 9%?", back: "False alarms.", deckId: deck.id, deckTitle: deck.title }, NOW);
		await createFlashcard(store, { concept: "Odds", front: "What is odds?", back: "A ratio.", deckId: kept.id, deckTitle: kept.title }, NOW);
		await exportFlashcards(store, ["Groundwork"], NOW);
		expect(vault.files.has("Groundwork/flashcards/Base rates.md")).toBe(true);

		await deleteDeck(store, deck.id, ["Groundwork"], NOW);
		const lib = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(lib.decks.map((d) => d.id)).toEqual(["exam-morning"]);
		expect(lib.cards.map((c) => c.concept)).toEqual(["Odds"]);
		expect(vault.files.has("Groundwork/flashcards/Base rates.md")).toBe(false);
		expect(vault.files.has("Groundwork/flashcards/Nightly drills deck.md") || vault.files.has("Groundwork/flashcards/Nightly drills.md")).toBe(false);
		expect(await vault.read("Groundwork/flashcards/Odds.md")).toContain("A ratio.");
	});

	it("refuses a deck that is already gone", async () => {
		const { store } = pair();
		await expect(deleteDeck(store, "missing", [], NOW)).rejects.toThrow(/already gone/);
	});
});
