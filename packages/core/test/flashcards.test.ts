import { describe, expect, it } from "vitest";
import { isTutorMemoryPath } from "../src/account";
import {
	applyRating,
	auditFlashcardLibrary,
	buildStudyQueue,
	cardsInDeck,
	createDeck,
	createFlashcard,
	DEFAULT_DECK_ID,
	DEFAULT_DECK_TITLE,
	deleteDeck,
	deleteFlashcard,
	emptyFlashcardLibrary,
	exportFlashcards,
	flashcardContentKey,
	flashcardQualityIssue,
	formatInterval,
	loadFlashcardLibrary,
	makeCard,
	parseCardFile,
	previewIntervals,
	rateFlashcard,
	removeFlashcardMirrors,
	renameDeck,
	scheduledMinutes,
	saveFlashcard,
	serializeCardMarkdown,
	serializeFlashcardLibrary,
	syncFlashcards,
	updateFlashcard,
} from "../src/flashcards";
import { MemoryVaultIO } from "../src/io";
import { FLASHCARD_CREDIT } from "../src/model";
import { KnowledgeStore, PATHS } from "../src/store";
import { toolByName } from "../src/tools";

const NOW = new Date("2026-10-02T12:00:00.000Z");

function pair() {
	const memory = new MemoryVaultIO();
	const vault = new MemoryVaultIO();
	const store = new KnowledgeStore(memory, { context: vault, now: () => NOW });
	return { memory, vault, store };
}

describe("flashcard schedule", () => {
	it("shows again in a minute, hard in ten, and a review good in days", () => {
		const card = makeCard({ deckId: "library", concept: "Base rates", front: "Why?", back: "False alarms.", now: NOW });
		expect(previewIntervals(card).map((p) => p.label)).toEqual(["in 1 min", "in 10 min", "in 1 day", "in 4 days"]);
		const review = { ...card, state: "review" as const, intervalMinutes: 24 * 60, ease: 2 };
		expect(formatInterval(scheduledMinutes(review, "good"))).toBe("in 2 days");
		expect(scheduledMinutes(review, "again")).toBe(1);
	});

	it("sends a miss back to learning and keeps an easy card in review", () => {
		const card = makeCard({ deckId: "exam-2", concept: "Base rates", front: "Why?", back: "False alarms.", now: NOW });
		const learned = applyRating(card, "good", NOW);
		expect(learned.state).toBe("review");
		expect(learned.intervalMinutes).toBe(24 * 60);
		const missed = applyRating(learned, "again", NOW);
		expect(missed.state).toBe("learning");
		expect(missed.lapses).toBe(1);
		expect(missed.intervalMinutes).toBe(1);
		const easy = applyRating(learned, "easy", NOW);
		expect(easy.state).toBe("review");
		expect(easy.reps).toBe(2);
	});

	it("studies learning cards before reviews, and caps new cards", () => {
		const learning = { ...makeCard({ id: "l", deckId: "d", concept: "A", front: "a", back: "a", now: NOW }), state: "learning" as const, due: NOW.toISOString() };
		const review = { ...makeCard({ id: "r", deckId: "d", concept: "B", front: "b", back: "b", now: NOW }), state: "review" as const, due: NOW.toISOString() };
		const fresh = Array.from({ length: 3 }, (_, i) => makeCard({ id: `n${i}`, deckId: "d", concept: `N${i}`, front: "q", back: "a", now: NOW }));
		const queue = buildStudyQueue([review, ...fresh, learning], NOW, { limitNew: 2 });
		expect(queue.map((c) => c.id)).toEqual(["l", "r", "n0", "n1"]);
	});
});

describe("flashcard vault mirror", () => {
	it("keeps the schedule on the account and copies markdown only when asked", async () => {
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

describe("flashcard mastery credit", () => {
	const HOUR = 3_600_000;
	const at = (ms: number) => new Date(NOW.getTime() + ms);

	async function quizzed(store: KnowledgeStore) {
		await store.upsertConcept({ title: "Base rates" });
		await store.recordEvidence("Base rates", { kind: "check", outcome: "correct", difficulty: 3, ts: NOW.toISOString() });
		await store.recordEvidence("Base rates", { kind: "check", outcome: "partial", difficulty: 3, ts: at(60_000).toISOString() });
		return createFlashcard(store, { concept: "Base rates", front: "Why is a positive test often wrong?", back: "False alarms." }, NOW);
	}

	it("gives a quizzed concept a small nudge and never counts as a quiz attempt", async () => {
		const { store } = pair();
		const card = await quizzed(store);
		const before = (await store.concepts()).get("base-rates")!.stats;
		await rateFlashcard(store, card.id, "good", at(HOUR));
		const after = (await store.concepts()).get("base-rates")!.stats;
		expect(after.ability).toBeGreaterThan(before.ability);
		expect(after.ability - before.ability).toBeLessThanOrEqual(FLASHCARD_CREDIT.windowCap + 1e-9);
		expect(after.attempts).toBe(before.attempts);
		expect(after.lastEvidence).toBe(before.lastEvidence);
		const events = await store.evidenceFor("base-rates");
		expect(events.filter((e) => e.source === "flashcard")).toHaveLength(1);
	});

	it("caps a burst of ratings inside any 4-hour window", async () => {
		const { store } = pair();
		const card = await quizzed(store);
		const before = (await store.concepts()).get("base-rates")!.stats;
		for (let i = 0; i < 40; i++) await rateFlashcard(store, card.id, i % 2 ? "easy" : "good", at(HOUR + i * 5 * 60_000));
		const after = (await store.concepts()).get("base-rates")!.stats;
		expect(after.ability - before.ability).toBeLessThanOrEqual(FLASHCARD_CREDIT.windowCap + 1e-9);
		expect(after.status).not.toBe("solid");
	});

	it("cannot complete a concept even when spread across many windows", async () => {
		const { store } = pair();
		const card = await quizzed(store);
		for (let w = 0; w < 30; w++) {
			for (let i = 0; i < 5; i++) await rateFlashcard(store, card.id, "easy", at(HOUR + w * 5 * HOUR + i * 60_000));
		}
		const stats = (await store.concepts()).get("base-rates")!.stats;
		expect(stats.mastery).toBeLessThan(0.8);
		expect(stats.status).not.toBe("solid");
	});

	it("leaves an unquizzed concept unassessed and skips Again", async () => {
		const { store } = pair();
		await store.upsertConcept({ title: "Odds" });
		const card = await createFlashcard(store, { concept: "Odds", front: "What is odds?", back: "A ratio." }, NOW);
		for (let i = 0; i < 10; i++) await rateFlashcard(store, card.id, "easy", at(i * 60_000));
		await rateFlashcard(store, card.id, "again", at(HOUR));
		expect((await store.concepts()).get("odds")!.stats.status).toBe("unassessed");
		expect((await store.evidenceFor("odds")).filter((e) => e.source === "flashcard")).toHaveLength(10);
	});

	it("keeps flashcard ratings out of the concept's quiz history", async () => {
		const { memory, store } = pair();
		const card = await quizzed(store);
		await rateFlashcard(store, card.id, "good", at(HOUR));
		const note = await memory.read((await store.concepts()).get("base-rates")!.path);
		expect(note).toContain("Quiz history");
		expect(note).not.toContain("Why is a positive test often wrong?");
	});
});

describe("flashcard editing", () => {
	it("changes the wording and keeps the schedule", async () => {
		const { store } = pair();
		const card = await createFlashcard(store, { concept: "Odds", front: "What is odds?", back: "A ratio." }, NOW);
		const rated = await rateFlashcard(store, card.id, "good", NOW);
		const edited = await updateFlashcard(store, card.id, { concept: "Odds", front: "What formula gives the odds of an event with probability p?", back: "p / (1 − p)." }, NOW);
		expect(edited.front).toBe("What formula gives the odds of an event with probability p?");
		expect(edited.state).toBe(rated.state);
		expect(edited.due).toBe(rated.due);
		expect(edited.reps).toBe(rated.reps);
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
	it("saves a card on the account and lists it when due", async () => {
		const { vault, store } = pair();
		const saved = await toolByName("save_flashcard")!.run(
			{ concept: "Base rates", front: "Why 9%?", back: "False alarms.", deck: "Exam 2" },
			{ store, access: { readFolders: [], writeFolders: ["Groundwork"] } },
		);
		expect(saved.isError).toBeFalsy();
		expect(saved.text).toContain("stays on the account");
		expect(vault.files.has("Groundwork/flashcards/Base rates.md")).toBe(false);
		const due = await toolByName("list_due_flashcards")!.run({}, { store });
		expect(due.text).toContain("Why 9%?");
		expect(due.text).toContain("Decks: Exam 2");
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

describe("deck rename and delete", () => {
	it("renames a deck and keeps its id and cards", async () => {
		const { store } = pair();
		const deck = await createDeck(store, "Nightly drills", NOW);
		const card = await createFlashcard(
			store,
			{ concept: "Odds", front: "What is odds?", back: "A ratio.", deckId: deck.id, deckTitle: deck.title },
			NOW,
		);
		const renamed = await renameDeck(store, deck.id, "Morning drills", NOW);
		expect(renamed).toMatchObject({ id: "nightly-drills", title: "Morning drills" });
		const lib = await loadFlashcardLibrary(store.io);
		expect(lib.cards.map((c) => c.id)).toEqual([card.id]);
		expect(lib.cards[0].deckId).toBe("nightly-drills");
		expect(lib.decks.map((d) => d.title)).toEqual(["Morning drills"]);
	});

	it("rejects an empty name, a duplicate name, the pane name, and a missing deck", async () => {
		const { store } = pair();
		const deck = await createDeck(store, "Nightly drills", NOW);
		await createDeck(store, "Exam morning", NOW);
		await expect(renameDeck(store, deck.id, "  ", NOW)).rejects.toThrow(/name/);
		await expect(renameDeck(store, deck.id, "Exam morning", NOW)).rejects.toThrow(/already has that name/);
		await expect(renameDeck(store, deck.id, "Library", NOW)).rejects.toThrow(/pane/);
		await expect(renameDeck(store, "missing", "Something else", NOW)).rejects.toThrow(/already gone/);
		await expect(createDeck(store, "Library", NOW)).rejects.toThrow(/pane/);
		const lib = await loadFlashcardLibrary(store.io);
		expect(lib.decks.find((d) => d.id === deck.id)?.title).toBe("Nightly drills");
	});

	it("removes the deck and its cards from the account and leaves exported notes in the vault", async () => {
		const { vault, store } = pair();
		const card = await createFlashcard(
			store,
			{ concept: "Base rates", front: "Why 9%?", back: "False alarms.", deckId: "exam-2", deckTitle: "Exam 2" },
			NOW,
		);
		await createFlashcard(store, { concept: "Odds", front: "What is odds?", back: "A ratio.", deckId: "keep", deckTitle: "Keep" }, NOW);
		await exportFlashcards(store, ["Groundwork"], NOW);
		const path = "Groundwork/flashcards/Base rates.md";
		const note = await vault.read(path);
		await deleteDeck(store, "exam-2", NOW);
		const lib = await loadFlashcardLibrary(store.io);
		expect(lib.decks.map((d) => d.id)).toEqual(["keep"]);
		expect(lib.cards.map((c) => c.deckId)).toEqual(["keep"]);
		expect(lib.retiredDeckIds).toContain("exam-2");
		expect(lib.retiredCardIds).toContain(card.id);
		expect(await vault.read(path)).toBe(note);
	});

	it("does not bring a deleted deck or its cards back on sync or export", async () => {
		const { vault, store } = pair();
		const card = await createFlashcard(
			store,
			{ concept: "Base rates", front: "Why 9%?", back: "False alarms.", deckId: "exam-2", deckTitle: "Exam 2" },
			NOW,
		);
		const kept = await createFlashcard(
			store,
			{ concept: "Odds", front: "What is odds?", back: "A ratio.", deckId: "keep", deckTitle: "Keep" },
			NOW,
		);
		await exportFlashcards(store, ["Groundwork"], NOW);
		const path = "Groundwork/flashcards/Base rates.md";
		const edited = (await vault.read(path)).replace("False alarms.", "Rare cases.");
		await vault.write(path, edited);
		await deleteDeck(store, "exam-2", NOW);

		const synced = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(synced.decks.map((d) => d.id)).toEqual(["keep"]);
		expect(synced.cards.map((c) => c.id)).toEqual([kept.id]);
		expect(await vault.read(path)).toContain("Rare cases.");
		expect(await vault.read(path)).toContain(card.id);

		await exportFlashcards(store, ["Groundwork"], NOW);
		const after = await loadFlashcardLibrary(store.io);
		expect(after.decks.map((d) => d.id)).toEqual(["keep"]);
		expect(after.cards.map((c) => c.id)).toEqual([kept.id]);
		expect(vault.files.has(path)).toBe(true);
		expect(await vault.read(path)).toContain(card.id);
	});

	it("starts a fresh deck when the same name is saved again, and still ignores the old notes", async () => {
		const { vault, store } = pair();
		const old = await createFlashcard(
			store,
			{ concept: "Base rates", front: "Why 9%?", back: "False alarms.", deckId: "exam-2", deckTitle: "Exam 2" },
			NOW,
		);
		await exportFlashcards(store, ["Groundwork"], NOW);
		const path = "Groundwork/flashcards/Base rates.md";
		await deleteDeck(store, "exam-2", NOW);
		const saved = await toolByName("save_flashcard")!.run(
			{ concept: "Base rates", front: "What swamps the signal?", back: "False alarms.", deck: "Exam 2" },
			{ store },
		);
		expect(saved.isError).toBeFalsy();
		expect(saved.text).toContain("Exam 2");
		const lib = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(lib.decks.map((d) => d.title)).toEqual(["Exam 2"]);
		expect(lib.cards).toHaveLength(1);
		expect(lib.cards[0].id).not.toBe(old.id);
		expect(lib.cards[0].front).toBe("What swamps the signal?");
		expect(lib.retiredCardIds).toContain(old.id);
		expect(await vault.read(path)).toContain(old.id);
		await exportFlashcards(store, ["Groundwork"], NOW);
		expect(await vault.read(path)).toContain(old.id);
		const again = await loadFlashcardLibrary(store.io);
		expect(again.cards).toHaveLength(1);
		expect(again.cards[0].front).toBe("What swamps the signal?");
	});

	it("does not bring a deleted card back from its exported note", async () => {
		const { vault, store } = pair();
		const card = await createFlashcard(store, { concept: "Odds", front: "What is odds?", back: "A ratio.", deckId: "keep", deckTitle: "Keep" }, NOW);
		await exportFlashcards(store, ["Groundwork"], NOW);
		const path = "Groundwork/flashcards/Odds.md";
		await deleteFlashcard(store, card.id, NOW);
		const lib = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(lib.cards).toHaveLength(0);
		expect(lib.decks.map((d) => d.id)).toEqual(["keep"]);
		expect(await vault.read(path)).toContain(card.id);
	});

	it("renames the old Library deck to Unsorted and will not delete it", async () => {
		const { memory, store } = pair();
		const seeded = emptyFlashcardLibrary(NOW);
		seeded.decks.push({ id: DEFAULT_DECK_ID, title: "Library" });
		seeded.cards.push(makeCard({ id: "fc_loose", deckId: DEFAULT_DECK_ID, concept: "Odds", front: "What is odds?", back: "A ratio.", now: NOW }));
		await memory.write(PATHS.flashcards, serializeFlashcardLibrary(seeded));
		const lib = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(lib.decks.find((d) => d.id === DEFAULT_DECK_ID)?.title).toBe(DEFAULT_DECK_TITLE);
		const disk = JSON.parse(await memory.read(PATHS.flashcards)) as { decks: Array<{ title: string }> };
		expect(disk.decks[0].title).toBe("Unsorted");
		await expect(deleteDeck(store, DEFAULT_DECK_ID, NOW)).rejects.toThrow(/stays/);
		expect((await loadFlashcardLibrary(store.io)).cards).toHaveLength(1);
		const renamed = await renameDeck(store, DEFAULT_DECK_ID, "Inbox", NOW);
		expect(renamed).toMatchObject({ id: DEFAULT_DECK_ID, title: "Inbox" });
		const saved = await saveFlashcard(store, { concept: "Odds", front: "What is a payoff?", back: "A ratio.", deck: "Library" }, NOW);
		expect(saved.deckTitle).toBe("Inbox");
		expect(saved.card.deckId).toBe(DEFAULT_DECK_ID);
	});

	it("keeps a catch-all the learner already renamed, and avoids a title clash", async () => {
		const { memory, store } = pair();
		const named = emptyFlashcardLibrary(NOW);
		named.decks.push({ id: DEFAULT_DECK_ID, title: "Inbox" });
		await memory.write(PATHS.flashcards, serializeFlashcardLibrary(named));
		expect((await syncFlashcards(store, [], NOW)).decks[0].title).toBe("Inbox");

		const clash = emptyFlashcardLibrary(NOW);
		clash.decks.push({ id: DEFAULT_DECK_ID, title: "Library" }, { id: "other", title: "Unsorted" });
		await memory.write(PATHS.flashcards, serializeFlashcardLibrary(clash));
		const lib = await syncFlashcards(store, [], NOW);
		expect(lib.decks.find((d) => d.id === DEFAULT_DECK_ID)?.title).toBe("Unsorted cards");
		expect(lib.decks.find((d) => d.id === "other")?.title).toBe("Unsorted");
	});

	it("sends a card with no deck to Unsorted", async () => {
		const { store } = pair();
		const saved = await toolByName("save_flashcard")!.run({ concept: "Odds", front: "What is odds?", back: "A ratio." }, { store });
		expect(saved.isError).toBeFalsy();
		expect(saved.text).toContain("Unsorted");
		const due = await toolByName("list_due_flashcards")!.run({}, { store });
		expect(due.text).toContain("Decks: Unsorted");
		const lib = await loadFlashcardLibrary(store.io);
		expect(lib.decks[0]).toMatchObject({ id: DEFAULT_DECK_ID, title: DEFAULT_DECK_TITLE });
	});
});

describe("flashcard interval cap", () => {
	it("keeps compounding easy ratings inside a valid date", () => {
		let card = makeCard({ deckId: "library", concept: "Odds", front: "What is odds?", back: "A ratio.", now: NOW });
		for (let i = 0; i < 60; i++) card = applyRating(card, "easy", NOW);
		expect(Number.isNaN(Date.parse(card.due))).toBe(false);
		expect(card.intervalMinutes).toBe(36_500 * 24 * 60);
	});
});
