import { Notice } from "obsidian";
import {
	cardsInDeck,
	createDeck,
	createFlashcard,
	deleteFlashcard,
	exportFlashcards,
	loadFlashcardLibrary,
	syncFlashcards,
	updateFlashcard,
	type Flashcard,
	type FlashcardLibrary,
	type KnowledgeStore,
} from "@groundwork/core";
import { paintMarkdown, type RenderMarkdown } from "./markdown-face";

export interface FlashcardsLibraryHost {
	store: KnowledgeStore;
	writeFolders: () => string[];
	/** Open this deck in the Flashcards tab. */
	onStudy: (deckId: string) => void;
	renderMarkdown?: RenderMarkdown;
}

interface DeckEntry {
	id: string;
	title: string;
}

/** Every deck on the account, including an empty one the learner just made. */
export function libraryDecks(lib: FlashcardLibrary): DeckEntry[] {
	return [...lib.decks]
		.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
		.map((deck) => ({ id: deck.id, title: deck.title }));
}

export async function renderFlashcardsLibrary(parent: HTMLElement, host: FlashcardsLibraryHost): Promise<void> {
	parent.empty();
	const section = parent.createDiv({ cls: "gw-lib-section gw-lib-flashcards" });
	section.createDiv({
		cls: "gw-lib-help",
		text: "Make a deck and add cards, or ask the tutor to make them. A deck is not tied to a goal.",
	});

	let lib: FlashcardLibrary;
	try {
		lib = await syncFlashcards(host.store, host.writeFolders());
	} catch (err) {
		section.createDiv({ cls: "gw-error", text: err instanceof Error ? err.message : String(err) });
		return;
	}

	const tools = section.createDiv({ cls: "gw-fc-lib-bar" });
	const newDeckBtn = tools.createEl("button", { cls: "gw-lib-btn", text: "New deck", attr: { type: "button" } });
	const exportBtn = tools.createEl("button", {
		cls: "gw-lib-btn",
		text: "Export to vault",
		attr: { type: "button", title: "Write every deck as notes under flashcards/ in your write folders" },
	});
	exportBtn.addEventListener("click", () => void exportDecks(host));

	const layout = section.createDiv({ cls: "gw-fc-lib-layout" });
	const deckList = layout.createDiv({ cls: "gw-fc-lib-decks", attr: { role: "list", "aria-label": "Decks" } });
	const main = layout.createDiv({ cls: "gw-fc-lib-main" });

	let decks = libraryDecks(lib);
	let selectedDeckId = decks[0]?.id ?? "";

	newDeckBtn.addEventListener("click", () => {
		section.querySelector(".gw-fc-lib-form.is-deck")?.remove();
		const form = deckNameForm(section, async (title) => {
			const deck = await createDeck(host.store, title);
			selectedDeckId = deck.id;
			await redraw();
		});
		layout.before(form);
	});

	const drawDecks = () => {
		decks = libraryDecks(lib);
		deckList.empty();
		deckList.createEl("p", { cls: "gw-fc-k", text: "Decks" });
		if (!decks.length) {
			deckList.createDiv({ cls: "gw-lib-empty", text: "No decks yet." });
			return;
		}
		for (const deck of decks) {
			const row = deckList.createEl("button", {
				cls: `gw-fc-lib-deck${deck.id === selectedDeckId ? " is-on" : ""}`,
				attr: { type: "button", "aria-pressed": deck.id === selectedDeckId ? "true" : "false" },
			});
			row.createSpan({ cls: "gw-fc-lib-deck-name", text: deck.title });
			row.createSpan({ cls: "gw-fc-lib-deck-n", text: String(cardsInDeck(lib, deck.id).length) });
			row.addEventListener("click", () => {
				selectedDeckId = deck.id;
				drawDecks();
				drawCards();
			});
		}
	};

	const drawCards = () => {
		main.empty();
		const deck = decks.find((d) => d.id === selectedDeckId);
		if (!deck) {
			main.createDiv({ cls: "gw-lib-empty", text: "Make a deck, then add cards to it." });
			return;
		}
		const head = main.createDiv({ cls: "gw-fc-lib-head" });
		head.createEl("h3", { text: deck.title });
		const headTools = head.createDiv({ cls: "gw-fc-lib-tools" });
		const study = headTools.createEl("button", { cls: "gw-lib-btn", text: "Study this deck", attr: { type: "button" } });
		study.addEventListener("click", () => host.onStudy(deck.id));
		const addBtn = headTools.createEl("button", { cls: "gw-lib-btn mod-cta", text: "Add card", attr: { type: "button" } });
		const list = main.createDiv({ cls: "gw-fc-lib-cards" });
		addBtn.addEventListener("click", () => {
			const form = cardForm(
				main,
				null,
				async (input) => {
					await createFlashcard(host.store, { ...input, deckId: deck.id, deckTitle: deck.title });
					await redraw();
				},
				() => form.remove(),
			);
			list.before(form);
		});

		const cards = [...cardsInDeck(lib, deck.id)].sort((a, b) => a.concept.localeCompare(b.concept) || a.front.localeCompare(b.front));
		if (!cards.length) {
			list.createDiv({ cls: "gw-lib-empty", text: "No cards in this deck yet. Add one, or ask the tutor to make some." });
			return;
		}
		for (const card of cards) drawCard(list, card);
	};

	const drawCard = (list: HTMLElement, card: Flashcard) => {
		const row = list.createDiv({ cls: "gw-fc-lib-card" });
		const qa = row.createDiv({ cls: "gw-fc-card-qa" });
		qa.createEl("b", { text: card.concept });
		paintMarkdown(qa, "span", "", card.front.split("\n")[0], host.renderMarkdown);
		paintMarkdown(qa, "span", "gw-fc-card-back", card.back.split("\n")[0], host.renderMarkdown);
		if (card.qualityIssue) qa.createEl("em", { text: `Left out of study until edited: ${card.qualityIssue}` });
		const rowTools = row.createDiv({ cls: "gw-fc-card-row-tools" });
		const edit = rowTools.createEl("button", { cls: "gw-lib-btn", text: "Edit", attr: { type: "button", "aria-label": `Edit card: ${card.front.slice(0, 60)}` } });
		edit.addEventListener("click", () => {
			const form = cardForm(
				main,
				card,
				async (input) => {
					await updateFlashcard(host.store, card.id, input);
					await redraw();
				},
				() => drawCards(),
			);
			row.replaceWith(form);
		});
		const del = rowTools.createEl("button", { cls: "gw-lib-btn", text: "Delete", attr: { type: "button", "aria-label": `Delete card: ${card.front.slice(0, 60)}` } });
		del.addEventListener("click", () => {
			if (del.dataset.armed !== "1") {
				del.dataset.armed = "1";
				del.setText("Delete?");
				del.addClass("is-danger");
				window.setTimeout(() => {
					if (del.dataset.armed !== "1") return;
					del.dataset.armed = "";
					del.setText("Delete");
					del.removeClass("is-danger");
				}, 3000);
				return;
			}
			del.dataset.armed = "";
			void deleteFlashcard(host.store, card.id).then(redraw, (err: unknown) => new Notice(err instanceof Error ? err.message : String(err)));
		});
	};

	const redraw = async () => {
		section.querySelector(".gw-fc-lib-form.is-deck")?.remove();
		lib = await loadFlashcardLibrary(host.store.io);
		const next = libraryDecks(lib);
		if (!next.some((deck) => deck.id === selectedDeckId)) selectedDeckId = next[0]?.id ?? "";
		drawDecks();
		drawCards();
	};

	drawDecks();
	drawCards();
}

async function exportDecks(host: FlashcardsLibraryHost): Promise<void> {
	const folders = host.writeFolders();
	if (!folders.length) {
		new Notice("Pick a folder the tutor can write in Settings, then export again.");
		return;
	}
	try {
		const written = await exportFlashcards(host.store, folders);
		new Notice(written.length ? `Wrote cards into ${written.join(", ")}.` : "No cards to export yet.");
	} catch (err) {
		new Notice(err instanceof Error ? err.message : String(err));
	}
}

type CardInput = { concept: string; front: string; back: string };

function cardForm(owner: HTMLElement, existing: Flashcard | null, save: (input: CardInput) => Promise<void>, onCancel: () => void): HTMLElement {
	owner.querySelector(".gw-fc-lib-form.is-new")?.remove();
	const form = owner.ownerDocument.createElement("div");
	form.className = `gw-fc-lib-form${existing ? "" : " is-new"}`;
	form.createEl("p", { cls: "gw-fc-k", text: existing ? "Edit card" : "New card" });
	const concept = form.createEl("input", { cls: "gw-fc-input", attr: { placeholder: "Concept", "aria-label": "Concept" } });
	concept.value = existing?.concept ?? "";
	const front = form.createEl("textarea", { cls: "gw-fc-input", attr: { rows: "3", placeholder: "Question", "aria-label": "Question" } });
	front.value = existing?.front ?? "";
	const back = form.createEl("textarea", { cls: "gw-fc-input", attr: { rows: "2", placeholder: "Answer, a few words", "aria-label": "Answer" } });
	back.value = existing?.back ?? "";
	const error = form.createDiv({ cls: "gw-fc-form-error", attr: { role: "alert" } });
	const row = form.createDiv({ cls: "gw-fc-form-row" });
	const cancel = row.createEl("button", { cls: "gw-lib-btn", text: "Cancel", attr: { type: "button" } });
	const submit = row.createEl("button", { cls: "gw-lib-btn mod-cta", text: "Save", attr: { type: "button" } });
	cancel.addEventListener("click", onCancel);
	submit.addEventListener("click", () => {
		if (submit.disabled) return;
		submit.disabled = true;
		error.setText("");
		void save({ concept: concept.value, front: front.value, back: back.value })
			.catch((err: unknown) => error.setText(err instanceof Error ? err.message : String(err)))
			.finally(() => {
				submit.disabled = false;
			});
	});
	window.setTimeout(() => (existing ? front : concept).focus(), 0);
	return form;
}

function deckNameForm(owner: HTMLElement, save: (title: string) => Promise<void>): HTMLElement {
	const form = owner.ownerDocument.createElement("div");
	form.className = "gw-fc-lib-form is-deck";
	form.createEl("p", { cls: "gw-fc-k", text: "New deck" });
	const name = form.createEl("input", {
		cls: "gw-fc-input",
		attr: { name: "deck-name", placeholder: "Deck name", "aria-label": "Deck name", autocomplete: "off" },
	});
	const error = form.createDiv({ cls: "gw-fc-form-error", attr: { role: "alert" } });
	const row = form.createDiv({ cls: "gw-fc-form-row" });
	const cancel = row.createEl("button", { cls: "gw-lib-btn", text: "Cancel", attr: { type: "button" } });
	const submit = row.createEl("button", { cls: "gw-lib-btn mod-cta", text: "Create", attr: { type: "button" } });
	cancel.addEventListener("click", () => form.remove());
	const commit = () => {
		if (submit.disabled) return;
		submit.disabled = true;
		error.setText("");
		void save(name.value)
			.catch((err: unknown) => {
				error.setText(err instanceof Error ? err.message : String(err));
				name.focus();
			})
			.finally(() => {
				submit.disabled = false;
			});
	};
	submit.addEventListener("click", commit);
	name.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		commit();
	});
	window.setTimeout(() => name.focus(), 0);
	return form;
}
