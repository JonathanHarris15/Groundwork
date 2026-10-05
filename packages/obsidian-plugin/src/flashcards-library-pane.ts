import { Notice } from "obsidian";
import {
	cardsInDeck,
	createFlashcard,
	deleteFlashcard,
	exportFlashcards,
	loadFlashcardLibrary,
	setAddFromTeachingNotes,
	syncFlashcards,
	updateFlashcard,
	type Flashcard,
	type FlashcardLibrary,
	type Goal,
	type KnowledgeStore,
} from "@groundwork/core";

export interface FlashcardsLibraryHost {
	store: KnowledgeStore;
	writeFolders: () => string[];
	goals: () => Promise<Goal[]>;
	/** The goal pinned in Working on. Its deck opens first. */
	pinnedGoalId: () => string;
	/** Pin the goal and study its deck in the Flashcards tab. */
	onStudy: (goalId: string) => void;
}

interface DeckEntry {
	id: string;
	title: string;
	note?: string;
	/** Set on a goal deck the learner can still pin. */
	studyGoalId?: string;
}

/** Every goal has a deck, even an empty one. Other decks show only while they hold cards. */
export function libraryDecks(lib: FlashcardLibrary, goals: Goal[]): DeckEntry[] {
	const order = { active: 0, paused: 1, done: 2 } as const;
	const goalDecks: DeckEntry[] = [...goals]
		.sort((a, b) => order[a.status] - order[b.status] || a.title.localeCompare(b.title))
		.map((goal) => ({
			id: goal.id,
			title: goal.title,
			note: goal.status === "active" ? undefined : goal.status === "paused" ? "Paused" : "Done",
			studyGoalId: goal.status === "done" ? undefined : goal.id,
		}));
	const goalIds = new Set(goals.map((goal) => goal.id));
	const others = lib.decks
		.filter((deck) => !goalIds.has(deck.id) && !(deck.goalId && goalIds.has(deck.goalId)) && lib.cards.some((card) => card.deckId === deck.id))
		.sort((a, b) => a.title.localeCompare(b.title))
		.map((deck) => ({ id: deck.id, title: deck.title }));
	return [...goalDecks, ...others];
}

export async function renderFlashcardsLibrary(parent: HTMLElement, host: FlashcardsLibraryHost): Promise<void> {
	parent.empty();
	const section = parent.createDiv({ cls: "gw-lib-section gw-lib-flashcards" });
	section.createDiv({
		cls: "gw-lib-help",
		text: "One deck per goal. Edit, add, or delete cards here, then study them in the Flashcards tab.",
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

	const tools = section.createDiv({ cls: "gw-fc-lib-bar" });
	const teaching = tools.createEl("label", { cls: "gw-fc-lib-switch", attr: { title: "Add a card for each concept the tutor writes a summary for" } });
	const toggle = teaching.createSpan({ cls: "gw-switch" });
	const teachingInput = toggle.createEl("input", { type: "checkbox" });
	teachingInput.checked = lib.addFromTeachingNotes;
	toggle.createSpan({ cls: "gw-switch-ui" });
	teaching.createSpan({ text: "Make cards from teaching notes" });
	teachingInput.addEventListener("change", () => {
		void setAddFromTeachingNotes(host.store, teachingInput.checked).then(
			(next) => {
				lib = next;
				drawDecks();
				drawCards();
			},
			(err: unknown) => new Notice(err instanceof Error ? err.message : String(err)),
		);
	});
	const exportBtn = tools.createEl("button", {
		cls: "gw-lib-btn",
		text: "Export to vault",
		attr: { type: "button", title: "Write every deck as notes under flashcards/ in your write folders" },
	});
	exportBtn.addEventListener("click", () => void exportDecks(host));

	const layout = section.createDiv({ cls: "gw-fc-lib-layout" });
	const deckList = layout.createDiv({ cls: "gw-fc-lib-decks", attr: { role: "list", "aria-label": "Decks" } });
	const main = layout.createDiv({ cls: "gw-fc-lib-main" });

	let decks = libraryDecks(lib, goals);
	const pinned = host.pinnedGoalId();
	let selectedDeckId = decks.some((deck) => deck.id === pinned) ? pinned : (decks[0]?.id ?? "");

	const drawDecks = () => {
		decks = libraryDecks(lib, goals);
		deckList.empty();
		deckList.createEl("p", { cls: "gw-fc-k", text: "Decks" });
		if (!decks.length) {
			deckList.createDiv({ cls: "gw-lib-empty", text: "A deck appears for each goal you set." });
			return;
		}
		for (const deck of decks) {
			const row = deckList.createEl("button", {
				cls: `gw-fc-lib-deck${deck.id === selectedDeckId ? " is-on" : ""}`,
				attr: { type: "button", "aria-pressed": deck.id === selectedDeckId ? "true" : "false" },
			});
			const name = row.createSpan({ cls: "gw-fc-lib-deck-name", text: deck.title });
			if (deck.note) name.createSpan({ cls: "gw-fc-lib-deck-note", text: deck.note });
			row.createSpan({ cls: "gw-fc-lib-deck-n", text: String(cardsInDeck(lib, deck.id, goals).length) });
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
			main.createDiv({ cls: "gw-lib-empty", text: "Set a goal and its deck shows up here." });
			return;
		}
		const head = main.createDiv({ cls: "gw-fc-lib-head" });
		head.createEl("h3", { text: deck.title });
		const headTools = head.createDiv({ cls: "gw-fc-lib-tools" });
		const studyGoalId = deck.studyGoalId;
		if (studyGoalId) {
			const study = headTools.createEl("button", { cls: "gw-lib-btn", text: "Study this deck", attr: { type: "button" } });
			study.addEventListener("click", () => host.onStudy(studyGoalId));
		}
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

		const cards = [...cardsInDeck(lib, deck.id, goals)].sort((a, b) => a.concept.localeCompare(b.concept) || a.front.localeCompare(b.front));
		if (!cards.length) {
			list.createDiv({ cls: "gw-lib-empty", text: "No cards in this deck yet. Add one, or let the tutor make them from teaching notes." });
			return;
		}
		for (const card of cards) drawCard(list, card);
	};

	const drawCard = (list: HTMLElement, card: Flashcard) => {
		const row = list.createDiv({ cls: "gw-fc-lib-card" });
		const qa = row.createDiv({ cls: "gw-fc-card-qa" });
		qa.createEl("b", { text: card.concept });
		qa.createEl("span", { text: card.front.split("\n")[0] });
		qa.createEl("span", { cls: "gw-fc-card-back", text: card.back.split("\n")[0] });
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
		lib = await loadFlashcardLibrary(host.store.io);
		goals = await host.goals();
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
