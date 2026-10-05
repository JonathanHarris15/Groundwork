import { Notice } from "obsidian";
import {
	cardsInDeck,
	createFlashcard,
	deleteFlashcard,
	exportFlashcards,
	loadFlashcardLibrary,
	syncFlashcards,
	type Flashcard,
	type FlashcardLibrary,
	type Goal,
	type KnowledgeStore,
} from "@groundwork/core";

export interface FlashcardsLibraryHost {
	store: KnowledgeStore;
	writeFolders: () => string[];
	goals: () => Promise<Goal[]>;
}

export async function renderFlashcardsLibrary(parent: HTMLElement, host: FlashcardsLibraryHost): Promise<void> {
	parent.empty();
	const section = parent.createDiv({ cls: "gw-lib-section gw-lib-flashcards" });
	section.createDiv({
		cls: "gw-lib-help",
		text: "One deck per goal. Edit cards here, then study them in the Flashcards tab. Export writes a copy into your vault when you choose a write folder.",
	});

	let lib: FlashcardLibrary;
	let goals: Goal[] = [];
	try {
		lib = await syncFlashcards(host.store, host.writeFolders());
		goals = await host.goals();
	} catch (err) {
		section.createDiv({ cls: "gw-error", text: err instanceof Error ? err.message : String(err) });
		return;
	}

	const decks = [...lib.decks].sort((a, b) => a.title.localeCompare(b.title));
	if (!decks.length) {
		section.createDiv({ cls: "gw-lib-empty", text: "No decks yet. Pin a goal and save cards from teaching, or add a card below." });
	}

	const layout = section.createDiv({ cls: "gw-fc-lib-layout" });
	const deckList = layout.createDiv({ cls: "gw-fc-lib-decks" });
	const main = layout.createDiv({ cls: "gw-fc-lib-main" });

	let selectedDeckId = decks[0]?.id ?? "";

	const deckCards = (): Flashcard[] =>
		selectedDeckId ? cardsInDeck(lib, selectedDeckId, goals) : lib.cards;

	const drawDecks = () => {
		deckList.empty();
		deckList.createEl("p", { cls: "gw-fc-k", text: "Decks" });
		for (const deck of decks) {
			const row = deckList.createEl("button", {
				cls: `gw-fc-lib-deck${deck.id === selectedDeckId ? " is-on" : ""}`,
				attr: { type: "button" },
			});
			row.createSpan({ text: deck.title });
			const n = cardsInDeck(lib, deck.id, goals).length;
			row.createSpan({ cls: "gw-fc-lib-deck-n", text: String(n) });
			row.addEventListener("click", () => {
				selectedDeckId = deck.id;
				drawDecks();
				drawCards();
			});
		}
	};

	const drawCards = () => {
		main.empty();
		const head = main.createDiv({ cls: "gw-fc-lib-head" });
		const deck = decks.find((d) => d.id === selectedDeckId);
		head.createEl("h3", { text: deck?.title ?? "Cards" });
		const tools = head.createDiv({ cls: "gw-fc-lib-tools" });
		const exportBtn = tools.createEl("button", { cls: "gw-lib-btn", text: "Export to vault", attr: { type: "button" } });
		exportBtn.addEventListener("click", () => void exportDeck(host, lib));
		const addBtn = tools.createEl("button", { cls: "gw-lib-btn mod-cta", text: "Add card", attr: { type: "button" } });
		addBtn.addEventListener("click", () => drawComposer(main, host, deck?.id ?? "library", deck?.title ?? "Library", redraw));

		const cards = [...deckCards()].sort((a, b) => a.concept.localeCompare(b.concept) || a.front.localeCompare(b.front));
		if (!cards.length) {
			main.createDiv({ cls: "gw-lib-empty", text: "No cards in this deck yet." });
			return;
		}
		const list = main.createDiv({ cls: "gw-fc-lib-cards" });
		for (const card of cards) {
			const row = list.createDiv({ cls: "gw-fc-lib-card" });
			const qa = row.createDiv({ cls: "gw-fc-card-qa" });
			qa.createEl("b", { text: card.concept });
			qa.createEl("span", { text: card.front.split("\n")[0] });
			qa.createEl("em", { text: card.back.split("\n")[0] });
			const rowTools = row.createDiv({ cls: "gw-fc-card-row-tools" });
			const edit = rowTools.createEl("button", { cls: "gw-fcard-tool", text: "Edit", attr: { type: "button" } });
			edit.addEventListener("click", () => drawComposer(main, host, card.deckId, deck?.title ?? "", redraw, card));
			const del = rowTools.createEl("button", { cls: "gw-fcard-tool gw-fcard-del", text: "Delete", attr: { type: "button" } });
			del.addEventListener("click", () => void removeCard(host, card.id, () => redraw()));
		}
	};

	const redraw = async () => {
		lib = await loadFlashcardLibrary(host.store.io);
		goals = await host.goals();
		drawDecks();
		drawCards();
	};

	drawDecks();
	drawCards();
}

async function exportDeck(host: FlashcardsLibraryHost, _lib: FlashcardLibrary): Promise<void> {
	const folders = host.writeFolders();
	if (!folders.length) {
		new Notice("Pick a folder the tutor can write, then export again.");
		return;
	}
	try {
		const written = await exportFlashcards(host.store, folders);
		new Notice(written.length ? `Wrote cards into ${written.join(", ")}.` : "No cards to export yet.");
	} catch (err) {
		new Notice(err instanceof Error ? err.message : String(err));
	}
}

async function removeCard(host: FlashcardsLibraryHost, id: string, onDone: () => void): Promise<void> {
	try {
		await deleteFlashcard(host.store, id);
		onDone();
	} catch (err) {
		new Notice(err instanceof Error ? err.message : String(err));
	}
}

function drawComposer(
	parent: HTMLElement,
	host: FlashcardsLibraryHost,
	deckId: string,
	deckTitle: string,
	redraw: () => Promise<void>,
	existing?: Flashcard,
): void {
	const prior = parent.querySelector(".gw-fc-lib-form");
	prior?.remove();
	const form = parent.createDiv({ cls: "gw-fc-lib-form gw-fcard" });
	form.createEl("p", { cls: "gw-fc-k", text: existing ? "Edit card" : "New card" });
	const concept = form.createEl("input", { cls: "gw-fc-input", attr: { placeholder: "Concept", "aria-label": "Concept" } });
	concept.value = existing?.concept ?? "";
	const front = form.createEl("textarea", { cls: "gw-fc-input", attr: { rows: "3", placeholder: "Front", "aria-label": "Front" } });
	front.value = existing?.front ?? "";
	const back = form.createEl("textarea", { cls: "gw-fc-input", attr: { rows: "2", placeholder: "Back", "aria-label": "Back" } });
	back.value = existing?.back ?? "";
	const row = form.createDiv({ cls: "gw-fc-form-row" });
	const cancel = row.createEl("button", { cls: "gw-lib-btn", text: "Cancel", attr: { type: "button" } });
	cancel.addEventListener("click", () => form.remove());
	const save = row.createEl("button", { cls: "gw-lib-btn mod-cta", text: "Save", attr: { type: "button" } });
	save.addEventListener("click", () => {
		void (async () => {
			try {
				if (existing) await deleteFlashcard(host.store, existing.id);
				await createFlashcard(host.store, {
					concept: concept.value,
					front: front.value,
					back: back.value,
					deckId,
					deckTitle,
				});
				await redraw();
			} catch (err) {
				new Notice(err instanceof Error ? err.message : String(err));
			}
		})();
	});
}
