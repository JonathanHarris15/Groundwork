import { Notice, setIcon, type App } from "obsidian";
import {
	buildStudyQueue,
	cardsInDeck,
	createFlashcard,
	deleteFlashcard,
	dueByConcept,
	exportFlashcards,
	emptyFlashcardLibrary,
	flashcardCounts,
	flashcardsDir,
	loadFlashcardLibrary,
	previewIntervals,
	rateFlashcard,
	setAddFromTeachingNotes,
	syncFlashcards,
	type CardRating,
	type Concept,
	type Flashcard,
	type FlashcardLibrary,
	type Goal,
	type KnowledgeStore,
	slugify,
} from "@groundwork/core";

export interface FlashcardsHost {
	app: App;
	store: KnowledgeStore;
	writeFolders: () => string[];
	goalId: () => string;
	selection: () => string;
	renderMarkdown(el: HTMLElement, markdown: string): Promise<void>;
	onQuiz(prompt: string): void;
	onClose(): void;
}

const RATINGS: Array<{ rating: CardRating; label: string; key: string }> = [
	{ rating: "again", label: "Again", key: "1" },
	{ rating: "hard", label: "Hard", key: "2" },
	{ rating: "good", label: "Good", key: "3" },
	{ rating: "easy", label: "Easy", key: "4" },
];

const STATUS_COLOR: Record<string, string> = {
	solid: "#3CC56F",
	shaky: "#F7A93E",
	learning: "#45A9F0",
	rusty: "#F7A93E",
	unassessed: "#8b8e94",
};

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
	private composing = false;
	private draft = { concept: "", front: "", back: "" };
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
			if (!this.deckId) this.deckId = this.host.goalId();
			if (!this.deckOptions().some((o) => o.id === this.deckId)) this.deckId = "";
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

	private async loadContext(): Promise<void> {
		const [goals, concepts] = await Promise.all([this.host.store.goals(), this.host.store.concepts()]);
		this.goals = goals;
		this.concepts = concepts;
	}

	private startSession(): void {
		this.history = [];
		this.misses = [];
		this.revealed = false;
		this.composing = false;
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
		if (!this.active || this.composing || this.busy) return;
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

	private draw(): void {
		const gen = ++this.renderGen;
		const now = new Date();
		this.root.empty();
		this.root.toggleClass("is-revealed", this.revealed);
		const body = this.root.createDiv({ cls: "gw-fc-body" });
		const main = body.createDiv({ cls: "gw-fc-main" });
		this.drawTop(main);
		this.drawProgress(main);
		if (this.composing) this.drawComposer(main);
		else this.drawStage(main, now);
		this.drawSide(body, now);
		if (gen !== this.renderGen) return;
	}

	private deckOptions(): Array<{ id: string; title: string }> {
		const options = [{ id: "", title: "All cards" }];
		for (const goal of this.goals) {
			if (goal.status === "done") continue;
			options.push({ id: goal.id, title: goal.title });
		}
		for (const deck of this.lib.decks) {
			if (options.some((o) => o.id === deck.id)) continue;
			if (!this.lib.cards.some((c) => c.deckId === deck.id)) continue;
			options.push({ id: deck.id, title: deck.title });
		}
		return options;
	}

	private deckTitle(): string {
		if (!this.deckId) return "All cards";
		return this.deckOptions().find((o) => o.id === this.deckId)?.title ?? "Deck";
	}

	private drawTop(parent: HTMLElement): void {
		const top = parent.createDiv({ cls: "gw-fc-top" });
		const deck = top.createDiv({ cls: "gw-deck" });
		deck.createSpan({ cls: "gw-deck-k", text: "Flashcards · due today" });
		const titleRow = deck.createDiv({ cls: "gw-deck-title-row" });
		const select = titleRow.createEl("select", { cls: "gw-deck-select", attr: { "aria-label": "Flashcard deck" } });
		for (const option of this.deckOptions()) {
			select.createEl("option", { text: option.id ? `${option.title} deck` : option.title, attr: { value: option.id } });
		}
		select.value = this.deckOptions().some((o) => o.id === this.deckId) ? this.deckId : "";
		select.addEventListener("change", () => {
			this.deckId = select.value;
			this.startSession();
			this.draw();
		});
		const meta = top.createDiv({ cls: "gw-fc-meta" });
		if (this.deckId && this.goals.some((g) => g.id === this.deckId)) {
			meta.createSpan({ cls: "gw-fc-chip", text: `Goal deck · ${this.deckTitle()}` });
		}
		const close = top.createEl("button", {
			cls: "clickable-icon gw-icon-btn gw-fc-close",
			attr: { "aria-label": "Close flashcards", title: "Close flashcards", type: "button" },
		});
		setIcon(close, "x");
		close.addEventListener("click", () => this.host.onClose());
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
		const minutes = Math.max(1, Math.round((this.queue.length * 20) / 60));
		labels.createSpan({ text: this.queue.length ? `About ${minutes} min left` : "Caught up" });
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
				text: next ? `Next card ${formatWhen(next.due, now)}.` : "New cards from teaching notes show up here. You can also add one.",
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
		const dot = concept.createSpan({ cls: "gw-dot" });
		dot.style.background = this.conceptColor(card.concept);
		concept.createSpan({ text: card.concept });
		head.createSpan({ cls: "gw-fcard-seen", text: seenLabel(card, now) });
		const del = head.createEl("button", { cls: "gw-fcard-del", text: "Delete", attr: { type: "button" } });
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			if (del.dataset.armed !== "1") {
				del.dataset.armed = "1";
				del.setText("Delete?");
				window.setTimeout(() => {
					if (del.dataset.armed !== "1") return;
					del.dataset.armed = "";
					del.setText("Delete");
				}, 3000);
				return;
			}
			void this.remove(card);
		});
		const front = face.createDiv({ cls: "gw-fcard-front" });
		void this.host.renderMarkdown(front, card.front);
		const show = face.createEl("button", { cls: "gw-fc-show", attr: { type: "button" } });
		show.createSpan({ text: "Show answer" });
		show.createEl("kbd", { text: "Space" });
		show.addEventListener("click", (e) => {
			e.stopPropagation();
			this.reveal();
		});
		face.createDiv({ cls: "gw-flipline", text: "Answer" });
		const back = face.createDiv({ cls: "gw-fcard-back" });
		void this.host.renderMarkdown(back, card.back);
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
		if (this.concepts.has(slugify(card.concept))) {
			const feeds = src.createSpan({ cls: "gw-fcard-feeds" });
			const mark = feeds.createSpan({ cls: "gw-dot" });
			mark.style.background = this.conceptColor(card.concept);
			feeds.createSpan({ text: `Updates ${card.concept} on the map` });
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

	private drawComposer(parent: HTMLElement): void {
		const stage = parent.createDiv({ cls: "gw-fc-stage" });
		const form = stage.createDiv({ cls: "gw-fcard gw-fc-form" });
		form.createDiv({ cls: "gw-fcard-head" }).createSpan({ text: "New card" });
		const concept = form.createEl("input", { cls: "gw-fc-input", attr: { placeholder: "Concept", "aria-label": "Concept" } });
		concept.value = this.draft.concept;
		const front = form.createEl("textarea", { cls: "gw-fc-input", attr: { rows: "3", placeholder: "Front — the question", "aria-label": "Front" } });
		front.value = this.draft.front;
		const back = form.createEl("textarea", { cls: "gw-fc-input", attr: { rows: "4", placeholder: "Back — the answer", "aria-label": "Back" } });
		back.value = this.draft.back;
		const remember = () => {
			this.draft = { concept: concept.value, front: front.value, back: back.value };
		};
		for (const el of [concept, front, back]) el.addEventListener("input", remember);
		const row = form.createDiv({ cls: "gw-fc-form-row" });
		const cancel = row.createEl("button", { cls: "gw-lib-btn", text: "Cancel", attr: { type: "button" } });
		cancel.addEventListener("click", () => {
			this.composing = false;
			this.draw();
		});
		const save = row.createEl("button", { cls: "gw-lib-btn mod-cta", text: "Save card", attr: { type: "button" } });
		save.addEventListener("click", () => {
			remember();
			void this.saveDraft();
		});
	}

	private drawSide(parent: HTMLElement, now: Date): void {
		const side = parent.createDiv({ cls: "gw-fc-side" });
		const head = side.createDiv({ cls: "gw-fc-side-head" });
		head.createSpan({ text: "Today's deck" });
		const cards = this.scopedCards();
		const counts = flashcardCounts(cards, now);
		const grid = side.createDiv({ cls: "gw-fc-counts" });
		for (const [n, label] of [
			[counts.fresh, "New"],
			[counts.learning, "Learning"],
			[counts.review, "Review"],
		] as const) {
			const cell = grid.createDiv({ cls: "gw-fc-count" });
			cell.createEl("b", { text: String(n) });
			cell.createSpan({ text: label });
		}
		const block = side.createDiv({ cls: "gw-fc-block" });
		block.createEl("p", { cls: "gw-fc-k", text: "Cards due by concept" });
		const rows = dueByConcept(cards, now).slice(0, 8);
		const max = rows[0]?.count ?? 1;
		if (!rows.length) block.createDiv({ cls: "gw-fc-muted", text: "None due." });
		for (const row of rows) {
			const line = block.createDiv({ cls: "gw-fc-concept" });
			const name = line.createSpan({ cls: "gw-fc-concept-name" });
			const dot = name.createSpan({ cls: "gw-dot" });
			dot.style.background = this.conceptColor(row.concept);
			name.createSpan({ text: row.concept });
			const bar = line.createSpan({ cls: "gw-fc-bar" });
			const fill = bar.createSpan();
			fill.style.width = `${Math.round((row.count / max) * 100)}%`;
			fill.style.background = this.conceptColor(row.concept);
			line.createEl("em", { text: String(row.count) });
		}
		const made = side.createDiv({ cls: "gw-fc-made" });
		made.createEl("b", { text: "Made from your notes" });
		made.createSpan({ text: "Groundwork writes cards from its teaching notes. They stay on your account. Write them into the vault only when you want the notes on this computer." });
		const toggle = made.createDiv({ cls: "gw-fc-toggle" });
		toggle.createSpan({ text: "Add cards from new teaching notes" });
		const sw = toggle.createEl("label", { cls: "gw-switch" });
		const input = sw.createEl("input", { type: "checkbox", attr: { "aria-label": "Add cards from new teaching notes" } });
		input.checked = this.lib.addFromTeachingNotes;
		sw.createSpan({ cls: "gw-switch-ui" });
		input.addEventListener("change", () => void this.toggleNotes(input.checked));
		const actions = side.createDiv({ cls: "gw-fc-actions" });
		this.sideButton(actions, "plus", "New card from selection", () => this.startFromSelection());
		this.sideButton(actions, "check", "Turn misses into a quiz", () => this.quizMisses());
		this.sideButton(actions, "download", "Write cards into the vault", () => void this.exportCards());
		const file = this.primaryDeckFile();
		this.sideButton(actions, "file-text", file ? `Open ${file.split("/").pop()}` : "Open deck note", () => {
			if (!file) {
				new Notice(this.host.writeFolders().length ? "Write the cards into the vault first." : "Cards stay on your account until you pick a folder and write them into the vault.");
				return;
			}
			void this.openPath(file);
		});
	}

	private sideButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl("button", { cls: "gw-fc-action", attr: { type: "button" } });
		setIcon(button.createSpan({ cls: "gw-fc-action-icon" }), icon);
		button.createSpan({ text: label });
		button.addEventListener("click", onClick);
	}

	private startFromSelection(): void {
		const quote = this.host.selection().trim();
		this.draft = { concept: "", front: quote, back: "" };
		this.composing = true;
		if (!quote) new Notice("Select text in the chat or a note, or type the front yourself.");
		this.draw();
	}

	private async saveDraft(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const deckId = this.deckId || "library";
			const deckTitle = deckId === "library" ? "Library" : this.deckTitle();
			const card = await createFlashcard(this.host.store, { ...this.draft, deckId, deckTitle });
			this.lib = await loadFlashcardLibrary(this.host.store.io);
			this.queue.unshift(card);
			this.composing = false;
			this.revealed = false;
			this.draft = { concept: "", front: "", back: "" };
			this.draw();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		} finally {
			this.busy = false;
		}
	}

	private async remove(card: Flashcard): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await deleteFlashcard(this.host.store, card.id);
			this.lib.cards = this.lib.cards.filter((c) => c.id !== card.id);
			this.queue = this.queue.filter((c) => c.id !== card.id);
			this.revealed = false;
			this.draw();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		} finally {
			this.busy = false;
		}
	}

	private async toggleNotes(on: boolean): Promise<void> {
		try {
			this.lib = await setAddFromTeachingNotes(this.host.store, on);
			await this.loadContext();
			this.startSession();
			this.draw();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		}
	}

	private quizMisses(): void {
		const rows = this.misses.length
			? this.misses
			: this.scopedCards()
					.filter((c) => c.lastRating === "again" || c.lapses > 0)
					.slice(0, 8)
					.map((c) => ({ concept: c.concept, front: c.front }));
		if (!rows.length) {
			new Notice("No missed cards yet. Rate a card Again or Hard first.");
			return;
		}
		const lines = [...new Map(rows.map((r) => [r.concept + r.front, r])).values()].map((r) => `- ${r.concept}: ${r.front.split("\n")[0]}`);
		this.host.onQuiz(`Quiz me on the flashcards I missed:\n${lines.join("\n")}`);
	}

	private conceptColor(concept: string): string {
		const status = this.concepts.get(slugify(concept))?.stats.status ?? "unassessed";
		return STATUS_COLOR[status] ?? STATUS_COLOR.unassessed;
	}

	private async exportCards(): Promise<void> {
		const folders = this.host.writeFolders();
		if (!folders.length) {
			new Notice("Cards stay on your account. Pick a folder the tutor can write, then ask again to copy them into the vault.");
			return;
		}
		try {
			const written = await exportFlashcards(this.host.store, folders);
			this.lib = await loadFlashcardLibrary(this.host.store.io);
			new Notice(written.length ? `Groundwork wrote the cards into ${written.join(", ")}.` : "No cards to write yet. They stay on your account.");
			this.draw();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		}
	}

	private deckPath(card: Flashcard): string {
		const folder = this.host.writeFolders()[0];
		if (!folder) return "";
		const deck = this.lib.decks.find((d) => d.id === card.deckId);
		const name = deck?.fileName || card.fileName;
		return name ? `${flashcardsDir(folder)}/${name}` : "";
	}

	private primaryDeckFile(): string {
		const folder = this.host.writeFolders()[0];
		if (!folder) return "";
		const deck = this.lib.decks.find((d) => d.id === this.deckId && d.fileName) ?? this.lib.decks.find((d) => d.fileName);
		if (deck?.fileName) return `${flashcardsDir(folder)}/${deck.fileName}`;
		const card = this.scopedCards().find((c) => c.fileName);
		return card?.fileName ? `${flashcardsDir(folder)}/${card.fileName}` : "";
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
