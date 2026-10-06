import { type App } from "obsidian";
import {
	buildStudyQueue,
	cardsInDeck,
	emptyFlashcardLibrary,
	flashcardsDir,
	masteryTone,
	syncFlashcards,
	type Concept,
	type Flashcard,
	type FlashcardLibrary,
	type KnowledgeStore,
	type MasteryTone,
	slugify,
} from "@groundwork/core";
import { paintMarkdown, type RenderMarkdown } from "./markdown-face";
import { masteryDot } from "./mastery-ui";

export interface FlashcardsHost {
	app: App;
	store: KnowledgeStore;
	writeFolders: () => string[];
	renderMarkdown: RenderMarkdown;
	onManageCards: () => void;
}

export class FlashcardsPane {
	private active = false;
	private lib: FlashcardLibrary = emptyFlashcardLibrary();
	private concepts = new Map<string, Concept>();
	private deckId = "";
	private requestedDeckId = "";
	private cards: Flashcard[] = [];
	private index = 0;
	private revealed = false;
	private renderGen = 0;

	constructor(
		private readonly root: HTMLElement,
		private readonly host: FlashcardsHost,
	) {
		this.root.tabIndex = 0;
		this.root.addEventListener("keydown", (e) => this.onKey(e));
	}

	async show(): Promise<void> {
		this.active = true;
		this.root.empty();
		this.root.createDiv({ cls: "gw-fc-loading", text: "Loading flashcards…" });
		try {
			this.lib = await syncFlashcards(this.host.store, this.host.writeFolders());
			await this.loadContext();
			this.applyRequestedDeck();
			this.startSession();
			this.draw();
			this.root.focus();
		} catch (err) {
			this.root.empty();
			this.root.createDiv({ cls: "gw-error", text: err instanceof Error ? err.message : String(err) });
		}
	}

	hide(): void {
		this.active = false;
		this.renderGen++;
	}

	/** Reload cards and keep the session on the deck already open. */
	refresh(): void {
		if (!this.active) return;
		const gen = ++this.renderGen;
		void this.reload(gen);
	}

	/** Open this deck the next time the pane is shown. If it is already showing, switch now. */
	study(deckId: string): void {
		const id = deckId.trim();
		if (!id) return;
		this.requestedDeckId = id;
		if (this.active) this.refresh();
	}

	private async reload(gen: number): Promise<void> {
		try {
			this.lib = await syncFlashcards(this.host.store, this.host.writeFolders());
			await this.loadContext();
		} catch {
			return;
		}
		if (!this.active || gen !== this.renderGen) return;
		const before = this.deckId;
		const currentId = this.cards[this.index]?.id;
		this.applyRequestedDeck();
		if (this.deckId !== before) this.startSession();
		else {
			this.cards = this.makeQueue();
			const next = currentId ? this.cards.findIndex((card) => card.id === currentId) : -1;
			this.index = next >= 0 ? next : Math.min(this.index, this.cards.length);
			if (this.index >= this.cards.length) this.revealed = false;
		}
		this.draw();
	}

	private async loadContext(): Promise<void> {
		this.concepts = await this.host.store.concepts();
	}

	private startSession(): void {
		this.revealed = false;
		this.index = 0;
		this.cards = this.makeQueue();
	}

	private makeQueue(): Flashcard[] {
		return buildStudyQueue(this.scopedCards());
	}

	private scopedCards(): Flashcard[] {
		return cardsInDeck(this.lib, this.deckId);
	}

	private onKey(e: KeyboardEvent): void {
		if (!this.active) return;
		const target = e.target as HTMLElement | null;
		if (target && (target.closest("input, textarea, select, button") || target.isContentEditable)) return;
		if (e.key !== " " && e.key !== "Enter" && e.key !== "ArrowRight") return;
		if (!this.cards.length || this.index >= this.cards.length) return;
		if (!this.revealed) {
			if (e.key === "ArrowRight") return;
			this.reveal();
			e.preventDefault();
			return;
		}
		this.advance();
		e.preventDefault();
	}

	private reveal(): void {
		this.revealed = true;
		this.root.addClass("is-revealed");
	}

	private advance(): void {
		if (!this.revealed || this.index >= this.cards.length) return;
		this.index += 1;
		this.revealed = false;
		this.draw();
	}

	private sortedDecks() {
		return [...this.lib.decks].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
	}

	private applyRequestedDeck(): void {
		const decks = this.sortedDecks();
		const requested = this.requestedDeckId;
		this.requestedDeckId = "";
		if (requested && decks.some((deck) => deck.id === requested)) this.deckId = requested;
		else if (!decks.some((deck) => deck.id === this.deckId)) this.deckId = decks[0]?.id ?? "";
	}

	private draw(): void {
		const gen = ++this.renderGen;
		this.root.empty();
		this.root.toggleClass("is-revealed", this.revealed && this.index < this.cards.length);
		if (!this.deckId || !this.lib.decks.some((deck) => deck.id === this.deckId)) {
			this.drawNoDeck();
			return;
		}
		const body = this.root.createDiv({ cls: "gw-fc-body" });
		const main = body.createDiv({ cls: "gw-fc-main" });
		this.drawTop(main);
		this.drawProgress(main);
		this.drawStage(main);
		if (gen !== this.renderGen) return;
	}

	private drawNoDeck(): void {
		const body = this.root.createDiv({ cls: "gw-fc-body gw-fc-unpinned" });
		const main = body.createDiv({ cls: "gw-fc-main" });
		const top = main.createDiv({ cls: "gw-fc-top" });
		const deck = top.createDiv({ cls: "gw-deck" });
		deck.createSpan({ cls: "gw-deck-k", text: "Flashcards" });
		const empty = main.createDiv({ cls: "gw-fc-empty gw-fc-unpinned-empty" });
		empty.createEl("h2", { cls: "gw-goals-unpinned-title", text: "No decks yet" });
		const hint = empty.createEl("p", { cls: "gw-goals-unpinned-hint" });
		hint.textContent = "Make a deck in Library. Add cards yourself, or ask the tutor to make them.";
		const manage = empty.createEl("button", { cls: "gw-next-btn", text: "Manage cards", attr: { type: "button", title: "Edit decks and cards in Library" } });
		manage.addEventListener("click", () => this.host.onManageCards());
	}

	private deckTitle(): string {
		return this.lib.decks.find((d) => d.id === this.deckId)?.title ?? "Deck";
	}

	private drawTop(parent: HTMLElement): void {
		const top = parent.createDiv({ cls: "gw-fc-top" });
		const deck = top.createDiv({ cls: "gw-deck" });
		deck.createSpan({ cls: "gw-deck-k", text: "Flashcards" });
		const titleRow = deck.createDiv({ cls: "gw-deck-title-row" });
		const select = titleRow.createEl("select", { cls: "gw-deck-select", attr: { "aria-label": "Flashcard deck" } });
		for (const item of this.sortedDecks()) {
			const option = select.createEl("option", { text: item.title, attr: { value: item.id } });
			if (item.id === this.deckId) option.selected = true;
		}
		select.addEventListener("change", () => {
			if (select.value === this.deckId) return;
			this.deckId = select.value;
			this.startSession();
			this.draw();
		});
		const meta = top.createDiv({ cls: "gw-fc-meta" });
		const count = this.scopedCards().length;
		const chip = meta.createSpan({ cls: "gw-fc-chip" });
		chip.createEl("b", { text: String(count) });
		chip.append(count === 1 ? " card" : " cards");
		const manage = top.createEl("button", {
			cls: "gw-lib-btn gw-fc-manage",
			text: "Manage cards",
			attr: { type: "button", title: "Edit decks and cards in Library" },
		});
		manage.addEventListener("click", () => this.host.onManageCards());
	}

	private drawProgress(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: "gw-fc-seq-wrap" });
		const seq = wrap.createDiv({ cls: "gw-seq" });
		const total = this.cards.length;
		const done = this.index >= total;
		const cells = Math.max(total, 1);
		const width = Math.min(18, cells);
		for (let i = 0; i < width; i++) {
			const pip = seq.createEl("i", { attr: { "aria-hidden": "true" } });
			const at = total <= 18 ? i : Math.floor((i / width) * total);
			if (done || at < this.index) pip.addClass("seen");
			else if (at === this.index) pip.addClass("cur");
		}
		const labels = wrap.createDiv({ cls: "gw-seq-l" });
		if (!total) labels.createSpan({ text: this.scopedCards().length ? "Nothing to study" : "No cards" });
		else if (done) labels.createSpan({ text: `All ${total} cards` });
		else labels.createSpan({ text: `Card ${this.index + 1} of ${total}` });
		labels.createSpan({ text: this.deckTitle() });
	}

	private drawStage(parent: HTMLElement): void {
		const stage = parent.createDiv({ cls: "gw-fc-stage" });
		const card = this.index < this.cards.length ? this.cards[this.index] : undefined;
		if (!card) {
			const empty = stage.createDiv({ cls: "gw-fc-empty" });
			if (!this.scopedCards().length) {
				empty.createDiv({ cls: "gw-deck-t", text: "No cards yet" });
				empty.createDiv({
					cls: "gw-fc-empty-sub",
					text: "Add cards in Library, or ask the tutor to make some.",
				});
				return;
			}
			if (!this.cards.length) {
				empty.createDiv({ cls: "gw-deck-t", text: "Nothing to study" });
				empty.createDiv({
					cls: "gw-fc-empty-sub",
					text: "Edit the cards in Library. A card needs one short answer.",
				});
				return;
			}
			empty.createDiv({ cls: "gw-deck-t", text: "That's the deck" });
			empty.createDiv({ cls: "gw-fc-empty-sub", text: "Go through it again whenever you want." });
			const again = empty.createEl("button", { cls: "gw-next-btn", text: "Start again", attr: { type: "button" } });
			again.addEventListener("click", () => {
				this.startSession();
				this.draw();
			});
			return;
		}
		const stack = stage.createDiv({ cls: "gw-fc-stack" });
		if (this.cards.length - this.index > 2) stack.createDiv({ cls: "gw-ghostcard gw-gc2" });
		if (this.cards.length - this.index > 1) stack.createDiv({ cls: "gw-ghostcard gw-gc1" });
		const face = stack.createDiv({ cls: "gw-fcard" });
		face.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("a, button")) return;
			if (!this.revealed) this.reveal();
		});
		const head = face.createDiv({ cls: "gw-fcard-head" });
		const concept = head.createSpan({ cls: "gw-fcard-concept" });
		masteryDot(concept, this.conceptTone(card.concept));
		concept.createSpan({ text: card.concept });
		const front = face.createDiv({ cls: "gw-fcard-front" });
		this.paintCardFace(front, card.front);
		const show = face.createEl("button", { cls: "gw-fc-show", attr: { type: "button" } });
		show.createSpan({ text: "Show answer" });
		show.createEl("kbd", { text: "Space" });
		show.addEventListener("click", (e) => {
			e.stopPropagation();
			this.reveal();
		});
		face.createDiv({ cls: "gw-flipline", text: "Answer" });
		const back = face.createDiv({ cls: "gw-fcard-back" });
		this.paintCardFace(back, card.back);
		const src = face.createDiv({ cls: "gw-fcard-src" });
		src.createSpan({ text: "From " });
		src.createEl("span", { cls: "gw-fcard-src-name", text: card.concept });
		const path = this.deckPath(card);
		if (path) {
			src.createSpan({ text: " · " });
			const link = src.createEl("button", { cls: "gw-fcard-src-link", text: path, attr: { type: "button" } });
			link.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.openPath(path);
			});
		}
		const rate = parent.createDiv({ cls: "gw-fc-rate" });
		const next = rate.createEl("button", { cls: "gw-next-btn gw-fc-next", text: "Next card", attr: { type: "button" } });
		next.addEventListener("click", () => this.advance());
	}

	private paintCardFace(el: HTMLElement, markdown: string): void {
		const text = markdown.trim();
		if (!text) {
			el.createDiv({ cls: "gw-fcard-placeholder", text: "No text on this card yet." });
			return;
		}
		paintMarkdown(el, "div", "gw-fcard-md", text, this.host.renderMarkdown);
	}

	private conceptTone(concept: string): MasteryTone {
		return masteryTone(this.concepts.get(slugify(concept))?.stats.status ?? "unassessed");
	}

	private deckPath(card: Flashcard): string {
		const folder = this.host.writeFolders()[0];
		if (!folder) return "";
		const deck = this.lib.decks.find((d) => d.id === card.deckId);
		const name = deck?.fileName || card.fileName;
		return name ? `${flashcardsDir(folder)}/${name}` : "";
	}

	private async openPath(path: string): Promise<void> {
		await this.host.app.workspace.openLinkText(path, "", false);
	}
}
