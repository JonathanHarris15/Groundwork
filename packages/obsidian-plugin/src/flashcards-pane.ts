import { Notice, type App } from "obsidian";
import {
	applySessionRating,
	cardsInDeck,
	emptyFlashcardLibrary,
	flashcardsDir,
	masteryTone,
	rateFlashcard,
	sessionRatingHint,
	startStudySession,
	studyableCards,
	syncFlashcards,
	type CardRating,
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

const RATINGS: Array<{ rating: CardRating; label: string; key: string }> = [
	{ rating: "again", label: "Again", key: "1" },
	{ rating: "hard", label: "Hard", key: "2" },
	{ rating: "good", label: "Good", key: "3" },
	{ rating: "easy", label: "Easy", key: "4" },
];

export class FlashcardsPane {
	private active = false;
	private lib: FlashcardLibrary = emptyFlashcardLibrary();
	private concepts = new Map<string, Concept>();
	private deckId = "";
	private requestedDeckId = "";
	private queue: Flashcard[] = [];
	private mastered = 0;
	private history: CardRating[] = [];
	private misses: Array<{ concept: string; front: string }> = [];
	private revealed = false;
	private busy = false;
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
		this.applyRequestedDeck();
		if (this.deckId !== before) this.startSession();
		else {
			const live = new Map(this.scopedCards().map((card) => [card.id, card]));
			this.queue = this.queue.flatMap((card) => {
				const next = live.get(card.id);
				return next ? [next] : [];
			});
		}
		this.draw();
	}

	private async loadContext(): Promise<void> {
		this.concepts = await this.host.store.concepts();
	}

	private startSession(): void {
		this.history = [];
		this.misses = [];
		this.mastered = 0;
		this.revealed = false;
		this.queue = startStudySession(this.scopedCards());
	}

	private scopedCards(): Flashcard[] {
		return cardsInDeck(this.lib, this.deckId);
	}

	private onKey(e: KeyboardEvent): void {
		if (!this.active || this.busy) return;
		const target = e.target as HTMLElement | null;
		if (target && (target.closest("input, textarea, select") || target.isContentEditable)) return;
		if (e.key === " " || e.key === "Enter") {
			if (!this.revealed && this.queue.length) {
				this.reveal();
				e.preventDefault();
			}
			return;
		}
		const rating = RATINGS.find((r) => r.key === e.key)?.rating;
		if (rating && this.revealed) {
			e.preventDefault();
			void this.rate(rating);
		}
	}

	private reveal(): void {
		this.revealed = true;
		this.root.addClass("is-revealed");
	}

	private async rate(rating: CardRating): Promise<void> {
		const card = this.queue[0];
		if (!card || this.busy || !this.revealed) return;
		this.busy = true;
		try {
			const updated = await rateFlashcard(this.host.store, card.id, rating);
			const index = this.lib.cards.findIndex((c) => c.id === updated.id);
			if (index >= 0) this.lib.cards[index] = updated;
			const current = this.queue.map((item) => (item.id === updated.id ? updated : item));
			if (rating === "good" || rating === "easy") this.mastered += 1;
			this.queue = applySessionRating(current, rating);
			this.history.push(rating);
			if (rating === "again" || rating === "hard") this.misses.push({ concept: updated.concept, front: updated.front });
			this.revealed = false;
			this.concepts = await this.host.store.concepts();
			this.draw();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		} finally {
			this.busy = false;
		}
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
		const now = new Date();
		this.root.empty();
		this.root.toggleClass("is-revealed", this.revealed);
		if (!this.deckId || !this.lib.decks.some((deck) => deck.id === this.deckId)) {
			this.drawNoDeck();
			return;
		}
		const body = this.root.createDiv({ cls: "gw-fc-body" });
		const main = body.createDiv({ cls: "gw-fc-main" });
		this.drawTop(main);
		this.drawProgress(main);
		this.drawStage(main, now);
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
		hint.textContent = "Make a deck in library. Add cards yourself, or ask the tutor to make them.";
		const manage = empty.createEl("button", { cls: "gw-next-btn", text: "Manage cards", attr: { type: "button", title: "Edit decks and cards in library" } });
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
		const chip = meta.createSpan({ cls: "gw-fc-chip" });
		const total = studyableCards(this.scopedCards()).length;
		chip.createEl("b", { text: String(total) });
		chip.append(total === 1 ? " card" : " cards");
		const manage = top.createEl("button", {
			cls: "gw-lib-btn gw-fc-manage",
			text: "Manage cards",
			attr: { type: "button", title: "Edit decks and cards in library" },
		});
		manage.addEventListener("click", () => this.host.onManageCards());
	}

	private drawProgress(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: "gw-fc-seq-wrap" });
		const seq = wrap.createDiv({ cls: "gw-seq" });
		const cells: string[] = [...this.history];
		if (this.queue.length) cells.push("cur");
		while (cells.length < 18) cells.push("");
		for (const cell of cells.slice(-18)) {
			const pip = seq.createEl("i");
			if (cell === "cur") pip.addClass("cur");
			else if (cell === "again") pip.addClass("a");
			else if (cell === "hard") pip.addClass("h");
			else if (cell === "good") pip.addClass("g");
			else if (cell === "easy") pip.addClass("e");
		}
		const labels = wrap.createDiv({ cls: "gw-seq-l" });
		labels.createSpan({ text: this.queue.length ? `${this.queue.length} left` : this.mastered ? "Finished" : "No cards" });
		labels.createSpan({ text: this.mastered ? `${this.mastered} down` : "This sitting" });
	}

	private drawStage(parent: HTMLElement, now: Date): void {
		const card = this.queue[0];
		const stage = parent.createDiv({ cls: "gw-fc-stage" });
		if (!card) {
			const empty = stage.createDiv({ cls: "gw-fc-empty" });
			const playable = studyableCards(this.scopedCards());
			if (this.mastered > 0 && playable.length > 0) {
				empty.createDiv({ cls: "gw-deck-t", text: "Deck finished" });
				empty.createDiv({
					cls: "gw-fc-empty-sub",
					text: "Every card in this sitting is down. Study this deck again whenever you want.",
				});
				return;
			}
			const blocked = this.scopedCards().some((item) => item.qualityIssue);
			empty.createDiv({ cls: "gw-deck-t", text: blocked && !playable.length ? "Cards need a shorter answer" : "No cards in this deck" });
			empty.createDiv({
				cls: "gw-fc-empty-sub",
				text: blocked && !playable.length
					? "Fix them in Library, then study this deck again."
					: "Add cards in Library, or ask the tutor to make some.",
			});
			return;
		}
		const study = stage.createDiv({ cls: "gw-fc-study" });
		const unit = study.createDiv({ cls: "gw-fc-unit" });
		const stack = unit.createDiv({ cls: "gw-fc-stack" });
		if (this.queue.length > 2) stack.createDiv({ cls: "gw-ghostcard gw-gc2" });
		if (this.queue.length > 1) stack.createDiv({ cls: "gw-ghostcard gw-gc1" });
		const face = stack.createDiv({ cls: "gw-fcard" });
		face.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("a, button")) return;
			this.reveal();
		});
		const head = face.createDiv({ cls: "gw-fcard-head" });
		const concept = head.createSpan({ cls: "gw-fcard-concept" });
		masteryDot(concept, this.conceptTone(card.concept));
		concept.createSpan({ text: card.concept });
		head.createSpan({ cls: "gw-fcard-seen", text: seenLabel(card, now) });
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
		src.createSpan({ cls: "gw-fcard-src-name", text: card.concept });
		const path = this.deckPath(card);
		if (path) {
			src.createSpan({ text: " · " });
			const link = src.createEl("button", { cls: "gw-fcard-src-link", text: path, attr: { type: "button" } });
			link.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.openPath(path);
			});
		}
		if (this.concepts.get(slugify(card.concept))?.stats.attempts) {
			const feeds = src.createSpan({ cls: "gw-fcard-feeds", attr: { title: "Ratings add a small, capped amount. A quiz is what makes a concept solid." } });
			masteryDot(feeds, this.conceptTone(card.concept));
			feeds.createSpan({ text: `Counts a little toward ${card.concept}` });
		}
		const rate = unit.createDiv({ cls: "gw-fc-rate" });
		for (const item of RATINGS) {
			const button = rate.createEl("button", { cls: `gw-rb gw-rb-${item.rating}`, attr: { type: "button" } });
			const line = button.createSpan({ cls: "gw-rb-line" });
			line.createEl("b", { text: item.label });
			line.createEl("kbd", { text: item.key });
			button.createSpan({ cls: "gw-rb-when", text: sessionRatingHint(item.rating) });
			button.addEventListener("click", () => void this.rate(item.rating));
		}
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

function seenLabel(card: Flashcard, now: Date): string {
	if (!card.lastReviewed) return "New";
	const days = Math.floor((now.getTime() - Date.parse(card.lastReviewed)) / 86_400_000);
	const when = days <= 0 ? "last seen today" : days === 1 ? "last seen yesterday" : `last seen ${days} days ago`;
	return `Seen · ${when}`;
}
