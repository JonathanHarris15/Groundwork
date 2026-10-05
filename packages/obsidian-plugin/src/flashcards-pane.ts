import { Notice, type App } from "obsidian";
import {
	buildStudyQueue,
	cardsInDeck,
	emptyFlashcardLibrary,
	flashcardCounts,
	flashcardsDir,
	masteryTone,
	previewIntervals,
	rateFlashcard,
	syncFlashcards,
	type CardRating,
	type Concept,
	type Flashcard,
	type FlashcardLibrary,
	type Goal,
	type KnowledgeStore,
	type MasteryTone,
	slugify,
} from "@groundwork/core";
import { masteryDot } from "./mastery-ui";

export interface FlashcardsHost {
	app: App;
	store: KnowledgeStore;
	writeFolders: () => string[];
	goalId: () => string;
	renderMarkdown(el: HTMLElement, markdown: string): Promise<void>;
	onManageCards: () => void;
	onFocusWorkingGoal?: () => void;
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
	private goals: Goal[] = [];
	private concepts = new Map<string, Concept>();
	private deckId = "";
	private queue: Flashcard[] = [];
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
			this.syncDeckToWorkingGoal();
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

	/** Follows Working on. A new deck starts a new session; the same deck keeps the one in progress. */
	refresh(): void {
		if (!this.active || this.pinnedGoalId() === this.deckId) return;
		this.syncDeckToWorkingGoal();
		this.startSession();
		this.draw();
	}

	private async loadContext(): Promise<void> {
		const [goals, concepts] = await Promise.all([this.host.store.goals(), this.host.store.concepts()]);
		this.goals = goals;
		this.concepts = concepts;
	}

	private startSession(): void {
		this.history = [];
		this.misses = [];
		this.revealed = false;
		this.queue = this.makeQueue();
	}

	private makeQueue(): Flashcard[] {
		const goal = this.goals.find((g) => g.id === this.deckId);
		const rank = new Map<string, number>();
		if (goal) {
			const targets = [...goal.targets].sort((a, b) => (this.concepts.get(a)?.stats.current ?? 1) - (this.concepts.get(b)?.stats.current ?? 1));
			targets.forEach((id, i) => rank.set(id, i));
			let n = rank.size;
			for (const id of [...goal.nodes, ...goal.built]) if (!rank.has(id)) rank.set(id, n++);
		}
		return buildStudyQueue(cardsInDeck(this.lib, this.deckId, this.goals), new Date(), {
			rank: (concept) => rank.get(slugify(concept)) ?? 1000,
		});
	}

	private scopedCards(): Flashcard[] {
		return cardsInDeck(this.lib, this.deckId, this.goals);
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
			this.queue.shift();
			if (updated.intervalMinutes <= 10) this.queue.push(updated);
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

	private pinnedGoalId(): string {
		return this.host.goalId()?.trim() ?? "";
	}

	private syncDeckToWorkingGoal(): void {
		this.deckId = this.pinnedGoalId();
	}

	private activeGoal(): Goal | undefined {
		return this.goals.find((g) => g.id === this.deckId);
	}

	private draw(): void {
		const gen = ++this.renderGen;
		const now = new Date();
		this.root.empty();
		this.root.toggleClass("is-revealed", this.revealed);
		if (!this.deckId) {
			this.drawUnpinned();
			return;
		}
		const body = this.root.createDiv({ cls: "gw-fc-body" });
		const main = body.createDiv({ cls: "gw-fc-main" });
		this.drawTop(main, now);
		this.drawProgress(main);
		this.drawStage(main, now);
		if (gen !== this.renderGen) return;
	}

	private drawUnpinned(): void {
		const body = this.root.createDiv({ cls: "gw-fc-body gw-fc-unpinned" });
		const main = body.createDiv({ cls: "gw-fc-main" });
		const top = main.createDiv({ cls: "gw-fc-top" });
		const deck = top.createDiv({ cls: "gw-deck" });
		deck.createSpan({ cls: "gw-deck-k", text: "Flashcards" });
		const empty = main.createDiv({ cls: "gw-fc-empty gw-fc-unpinned-empty" });
		empty.createEl("h2", { cls: "gw-goals-unpinned-title", text: "Select a goal to review its cards" });
		const hint = empty.createEl("p", { cls: "gw-goals-unpinned-hint" });
		hint.textContent = "Flashcards live on the goal you pin in Working on. Each goal has its own deck.";
		const focus = empty.createEl("button", { cls: "gw-next-btn", text: "Choose in Working on", attr: { type: "button" } });
		focus.addEventListener("click", () => this.host.onFocusWorkingGoal?.());
		const manage = empty.createEl("button", { cls: "gw-text-btn", text: "Manage cards", attr: { type: "button", title: "Edit decks and cards in Library" } });
		manage.addEventListener("click", () => this.host.onManageCards());
	}

	private deckTitle(): string {
		return this.activeGoal()?.title ?? this.lib.decks.find((d) => d.id === this.deckId)?.title ?? "Goal deck";
	}

	private drawTop(parent: HTMLElement, now: Date): void {
		const top = parent.createDiv({ cls: "gw-fc-top" });
		const deck = top.createDiv({ cls: "gw-deck" });
		deck.createSpan({ cls: "gw-deck-k", text: "Flashcards · goal deck" });
		const titleRow = deck.createDiv({ cls: "gw-deck-title-row" });
		titleRow.createEl("span", { cls: "gw-deck-t", text: this.deckTitle() });
		const meta = top.createDiv({ cls: "gw-fc-meta" });
		const counts = flashcardCounts(this.scopedCards(), now);
		for (const [n, label] of [
			[counts.fresh, "New"],
			[counts.learning, "Learning"],
			[counts.review, "Review"],
		] as const) {
			const chip = meta.createSpan({ cls: "gw-fc-chip" });
			chip.createEl("b", { text: String(n) });
			chip.append(` ${label}`);
		}
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
		const left = this.queue.length ? this.history.length + 1 : this.history.length;
		const total = this.history.length + this.queue.length;
		labels.createSpan({ text: total ? `Card ${Math.min(left, total)} of ${total}` : "Nothing due" });
		labels.createSpan({ text: this.queue.length ? `${this.queue.length} to go` : "Caught up" });
	}

	private drawStage(parent: HTMLElement, now: Date): void {
		const card = this.queue[0];
		const stage = parent.createDiv({ cls: "gw-fc-stage" });
		if (!card) {
			const empty = stage.createDiv({ cls: "gw-fc-empty" });
			empty.createDiv({ cls: "gw-deck-t", text: "Nothing due" });
			const next = this.scopedCards()
				.filter((c) => c.state !== "new" && Date.parse(c.due) > now.getTime())
				.sort((a, b) => a.due.localeCompare(b.due))[0];
			empty.createDiv({
				cls: "gw-fc-empty-sub",
				text: next ? `Next card ${formatWhen(next.due, now)}.` : "New cards from teaching notes show up here. Manage cards in Library when you want to edit the deck.",
			});
			return;
		}
		const stack = stage.createDiv({ cls: "gw-fc-stack" });
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
		if (this.concepts.get(slugify(card.concept))?.stats.attempts) {
			const feeds = src.createSpan({ cls: "gw-fcard-feeds", attr: { title: "Ratings add a small, capped amount. A quiz is what makes a concept solid." } });
			masteryDot(feeds, this.conceptTone(card.concept));
			feeds.createSpan({ text: `Counts a little toward ${card.concept}` });
		}
		const rate = parent.createDiv({ cls: "gw-fc-rate" });
		for (const item of RATINGS) {
			const preview = previewIntervals(card).find((p) => p.rating === item.rating)!;
			const button = rate.createEl("button", { cls: `gw-rb gw-rb-${item.rating}`, attr: { type: "button" } });
			const label = button.createEl("b");
			label.createSpan({ text: item.label });
			label.createEl("kbd", { text: item.key });
			button.createSpan({ text: preview.label });
			button.addEventListener("click", () => void this.rate(item.rating));
		}
	}

	private paintCardFace(el: HTMLElement, markdown: string): void {
		const text = markdown.trim();
		if (!text) {
			el.createDiv({ cls: "gw-fcard-placeholder", text: "No text on this card yet." });
			return;
		}
		const inner = el.createDiv({ cls: "gw-fcard-md" });
		inner.setText(text);
		void this.host.renderMarkdown(inner, text).catch(() => {
			if (!inner.textContent?.trim()) inner.setText(text);
		});
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
	const state = card.state === "new" ? "New" : card.state === "learning" ? "Learning" : "Review";
	if (!card.lastReviewed) return state;
	const days = Math.floor((now.getTime() - Date.parse(card.lastReviewed)) / 86_400_000);
	const when = days <= 0 ? "last seen today" : days === 1 ? "last seen yesterday" : `last seen ${days} days ago`;
	return `${state} · ${when}`;
}

function formatWhen(iso: string, now: Date): string {
	const ms = Date.parse(iso) - now.getTime();
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `in ${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
	const days = Math.round(hours / 24);
	return days === 1 ? "tomorrow" : `in ${days} days`;
}
