import { describe, expect, it } from "vitest";
import { isTutorMemoryPath } from "../src/account";
import {
	applyRating,
	auditFlashcardLibrary,
	buildStudyQueue,
	createFlashcard,
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
	scheduledMinutes,
	serializeCardMarkdown,
	syncFlashcards,
} from "../src/flashcards";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
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

	it("makes one card from a teaching note and does not move mastery when rated", async () => {
		const { store } = pair();
		await store.upsertConcept({
			title: "Base rates",
			summary: "Why does a rare disease make a positive test hard to trust?\n\nAbout 10 false alarms show up for every real case.",
		});
		await store.setGoal({ title: "Exam 2", targets: ["Base rates"], nodes: [{ title: "Base rates" }] }, { judgments: "off" });
		const first = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(first.cards).toHaveLength(1);
		expect(first.cards[0].deckId).toBe("exam-2");
		expect(first.cards[0].front).toContain("rare disease");
		expect(first.cards[0].back).toContain("false alarms");
		const again = await syncFlashcards(store, ["Groundwork"], NOW);
		expect(again.cards).toHaveLength(1);

		const graded = await rateFlashcard(store, first.cards[0].id, "again", NOW);
		expect(graded.lapses).toBe(0);
		expect(graded.state).toBe("learning");
		const concept = (await store.concepts()).get("base-rates");
		expect(concept?.stats.attempts).toBe(0);
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
		const empty = await toolByName("save_flashcard")!.run({ concept: " ", front: "", back: "x" }, { store });
		expect(empty.isError).toBe(true);
	});
});
