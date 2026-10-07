import { Menu, Modal, Notice, type App } from "obsidian";
import {
	cardsInDeck,
	createDeck,
	createFlashcard,
	DEFAULT_DECK_ID,
	deleteDeck,
	deleteFlashcard,
	exportFlashcards,
	loadFlashcardLibrary,
	renameDeck,
	syncFlashcards,
	updateFlashcard,
	type Flashcard,
	type FlashcardLibrary,
	type KnowledgeStore,
} from "@groundwork/core";
import { paintMarkdown, type RenderMarkdown } from "./markdown-face";

export interface FlashcardsLibraryHost {
	app: App;
	store: KnowledgeStore;
	writeFolders: () => string[];
	/** Open this deck in the Flashcards tab. */
	onStudy: (deckId: string) => void;
	renderMarkdown?: RenderMarkdown;
	/** The Library tab badge. Called after the account deck changes. */
	onCardsChanged?: (count: number) => void;
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
	const publishCount = () => host.onCardsChanged?.(lib.cards.length);
	publishCount();

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
			row.addEventListener("contextmenu", (event) => {
				event.preventDefault();
				event.stopPropagation();
				selectedDeckId = deck.id;
				drawDecks();
				drawCards();
				const menu = new Menu();
				menu.addItem((item) => item.setTitle("Rename").onClick(() => startRename(deck.id)));
				if (deck.id !== DEFAULT_DECK_ID) menu.addItem((item) => item.setTitle("Delete").onClick(() => askDeleteDeck(deck.id)));
				menu.showAtMouseEvent(event);
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
		const titleWrap = head.createDiv({ cls: "gw-fc-lib-title" });
		titleWrap.createEl("h3", { text: deck.title });
		if (deck.id === DEFAULT_DECK_ID) {
			titleWrap.createEl("p", { cls: "gw-fc-lib-note", text: "Cards that aren't put in a deck go here." });
		}
		const headTools = head.createDiv({ cls: "gw-fc-lib-tools" });
		const study = headTools.createEl("button", { cls: "gw-lib-btn", text: "Study this deck", attr: { type: "button" } });
		study.addEventListener("click", () => host.onStudy(deck.id));
		const addBtn = headTools.createEl("button", { cls: "gw-lib-btn mod-cta", text: "Add card", attr: { type: "button" } });
		const rename = headTools.createEl("button", {
			cls: "gw-lib-btn",
			text: "Rename",
			attr: { type: "button", "aria-label": `Rename ${deck.title}` },
		});
		rename.addEventListener("click", () => startRename(deck.id));
		if (deck.id !== DEFAULT_DECK_ID) {
			const remove = headTools.createEl("button", {
				cls: "gw-lib-btn is-danger",
				text: "Delete",
				attr: { type: "button", "aria-label": `Delete ${deck.title}` },
			});
			remove.addEventListener("click", () => askDeleteDeck(deck.id));
		}
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
		const del = rowTools.createEl("button", { cls: "gw-lib-btn is-danger", text: "Delete", attr: { type: "button", "aria-label": `Delete card: ${card.front.slice(0, 60)}` } });
		del.addEventListener("click", () => {
			openConfirm(cardDeleteCopy(), async () => {
				await deleteFlashcard(host.store, card.id);
				await redraw();
			});
		});
	};

	const startRename = (deckId: string) => {
		const deck = libraryDecks(lib).find((item) => item.id === deckId);
		if (!deck) return;
		selectedDeckId = deckId;
		drawDecks();
		drawCards();
		const title = main.querySelector(".gw-fc-lib-title");
		const head = main.querySelector(".gw-fc-lib-head");
		if (!title || !head) return;
		head.classList.add("is-renaming");
		const form = renameField(
			main,
			deck.title,
			async (next) => {
				await renameDeck(host.store, deck.id, next);
				await redraw();
			},
			() => drawCards(),
		);
		title.replaceWith(form);
	};

	const askDeleteDeck = (deckId: string) => {
		if (deckId === DEFAULT_DECK_ID) return;
		const deck = lib.decks.find((item) => item.id === deckId);
		if (!deck) {
			new Notice("That deck is already gone.");
			return;
		}
		openConfirm(deckDeleteCopy(deck.title, cardsInDeck(lib, deckId).length), async () => {
			await deleteDeck(host.store, deckId);
			await redraw();
		});
	};

	const openConfirm = (copy: ConfirmCopy, run: () => Promise<void>) => {
		try {
			const modal = new ConfirmModal(host.app, copy, () => {
				void run().catch((err: unknown) => new Notice(err instanceof Error ? err.message : String(err)));
			});
			modal.open();
			// Obsidian puts the modal on the focused window. If that is not this one, show it here.
			if (!document.body.contains(modal.containerEl)) document.body.appendChild(modal.containerEl);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		}
	};

	const redraw = async () => {
		section.querySelector(".gw-fc-lib-form.is-deck")?.remove();
		lib = await loadFlashcardLibrary(host.store.io);
		const next = libraryDecks(lib);
		if (!next.some((deck) => deck.id === selectedDeckId)) selectedDeckId = next[0]?.id ?? "";
		publishCount();
		drawDecks();
		drawCards();
	};

	drawDecks();
	drawCards();
}

async function exportDecks(host: FlashcardsLibraryHost): Promise<void> {
	const folders = host.writeFolders();
	if (!folders.length) {
		new Notice("Pick a folder the tutor can write in settings, then export again.");
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
	const form = owner.ownerDocument.win.createDiv();
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
	const form = owner.ownerDocument.win.createDiv();
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

interface ConfirmCopy {
	heading: string;
	body: string;
	confirmLabel: string;
}

function deckDeleteCopy(title: string, count: number): ConfirmCopy {
	const cards = count === 1 ? "1 card" : `${count} cards`;
	const lead =
		count === 0
			? `Delete "${title}"? It has no cards. This removes the deck from your account.`
			: `Delete "${title}" and its ${cards}? This removes them from your account.`;
	return {
		heading: "Delete this deck?",
		body: `${lead} Notes already in the vault stay there, and they will not come back.`,
		confirmLabel: "Delete deck",
	};
}

function cardDeleteCopy(): ConfirmCopy {
	return {
		heading: "Delete this card?",
		body: "This removes it from your account. If you already exported it, the note stays in your vault and will not come back.",
		confirmLabel: "Delete card",
	};
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly copy: ConfirmCopy,
		private readonly onYes: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.copy.heading);
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: this.copy.body });
		const row = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = row.createEl("button", { text: "Cancel", attr: { type: "button" } });
		const ok = row.createEl("button", { cls: "mod-warning", text: this.copy.confirmLabel, attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
		ok.addEventListener("click", () => {
			this.close();
			this.onYes();
		});
		window.setTimeout(() => cancel.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function renameField(owner: HTMLElement, current: string, save: (title: string) => Promise<void>, onCancel: () => void): HTMLElement {
	const form = owner.ownerDocument.win.createDiv();
	form.className = "gw-fc-lib-rename";
	const row = form.createDiv({ cls: "gw-fc-lib-rename-row" });
	const name = row.createEl("input", {
		cls: "gw-fc-input",
		attr: { name: "deck-name", "aria-label": "Deck name", autocomplete: "off", spellcheck: "false" },
	});
	name.value = current;
	name.setAttribute("value", current);
	const saveBtn = row.createEl("button", { cls: "gw-lib-btn mod-cta", text: "Save", attr: { type: "button" } });
	const cancel = row.createEl("button", { cls: "gw-lib-btn", text: "Cancel", attr: { type: "button" } });
	const error = form.createDiv({ cls: "gw-fc-form-error", attr: { role: "alert" } });
	cancel.addEventListener("click", onCancel);
	const commit = () => {
		if (saveBtn.disabled) return;
		saveBtn.disabled = true;
		error.setText("");
		void save(name.value)
			.catch((err: unknown) => {
				error.setText(err instanceof Error ? err.message : String(err));
				name.focus();
			})
			.finally(() => {
				saveBtn.disabled = false;
			});
	};
	saveBtn.addEventListener("click", commit);
	name.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		commit();
	});
	window.setTimeout(() => {
		name.focus();
		name.select();
	}, 0);
	return form;
}
