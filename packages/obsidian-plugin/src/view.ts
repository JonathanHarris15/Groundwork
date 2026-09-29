import { Component, ItemView, Keymap, MarkdownRenderer, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import {
	AgentSession,
	buildSystemPrompt,
	demoteHeadings,
	letter,
	parseNote,
	PATHS,
	serializeNote,
	setSection,
	TOOLS,
	type AgentEvent,
	type AskInput,
	type AskResponse,
	type ChatMessage,
	type ConceptStats,
	type PreparedQuiz,
	type QuizGrade,
	type QuizOutcome,
	type QuizResponse,
	type SessionInfo,
	type ToolUI,
} from "@groundwork/core";
import { AskCard, QuizCard } from "./cards";
import type GroundworkPlugin from "./main";

export const VIEW_TYPE = "groundwork-chat";

type DisplayItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "tool"; name: string; summary: string; isError?: boolean }
	| { kind: "quiz"; quiz: PreparedQuiz; response: QuizResponse; grade: QuizGrade; before?: ConceptStats; after?: ConceptStats }
	| { kind: "ask"; input: AskInput; answer: AskResponse }
	| { kind: "error"; text: string };

interface ChatRecord {
	id: string;
	title: string;
	created: string;
	updated: string;
	notePath?: string;
	messages: ChatMessage[];
	items: DisplayItem[];
}

const TOOL_VERBS: Record<string, string> = {
	get_learner_overview: "Reading your knowledge vault",
	search_knowledge: "Searching what you already know",
	get_concepts: "Reading concept notes",
	upsert_concept: "Updating a concept note",
	set_goal: "Mapping the goal's dependencies",
	get_goal: "Checking goal progress",
	set_goal_status: "Updating goal status",
	record_evidence: "Recording evidence",
	get_due_reviews: "Checking due reviews",
	update_learner_profile: "Updating your learner profile",
	save_session_summary: "Saving the session summary",
};

export class ChatView extends ItemView implements ToolUI {
	private record!: ChatRecord;
	private session!: SessionInfo;
	private agent: AgentSession | null = null;
	private abort: AbortController | null = null;
	private pending = new Set<(v: null) => void>();
	private liveQuizCards = new Map<string, QuizCard>();

	private uiTitleEl!: HTMLElement;
	private uiBadgeEl!: HTMLElement;
	private uiSyncBtn!: HTMLElement;
	private uiMessagesEl!: HTMLElement;
	private uiInputEl!: HTMLTextAreaElement;
	private uiSendBtn!: HTMLButtonElement;

	private segment: { el: HTMLElement; text: string; comp: Component | null; timer: number | null; version: number } | null = null;
	private toolChips = new Map<string, HTMLElement>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: GroundworkPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Groundwork";
	}
	getIcon(): string {
		return "graduation-cap";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("gw-root");

		const header = root.createDiv({ cls: "gw-header" });
		const titles = header.createDiv({ cls: "gw-titles" });
		this.uiTitleEl = titles.createDiv({ cls: "gw-title" });
		this.uiBadgeEl = titles.createDiv({ cls: "gw-subtitle" });
		const actions = header.createDiv({ cls: "gw-actions" });
		this.iconButton(actions, "square-pen", "New session", () => this.newSession());
		this.iconButton(actions, "history", "Past sessions", (e) => this.showHistory(e));
		this.iconButton(actions, "target", "Goals", (e) => this.showGoals(e));
		this.uiSyncBtn = this.iconButton(actions, "refresh-cw", "Sync with GitHub", () => this.plugin.syncNow("manual"));

		this.uiMessagesEl = root.createDiv({ cls: "gw-messages" });
		this.registerDomEvent(this.uiMessagesEl, "click", (evt) => {
			const a = (evt.target as HTMLElement).closest("a.internal-link") as HTMLAnchorElement | null;
			if (!a) return;
			evt.preventDefault();
			const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
			void this.app.workspace.openLinkText(href, this.record?.notePath ?? "", Keymap.isModEvent(evt));
		});

		const composer = root.createDiv({ cls: "gw-composer" });
		this.uiInputEl = composer.createEl("textarea", {
			cls: "gw-input",
			attr: { rows: "1", placeholder: "What do you want to understand?", title: "Enter to send · Shift+Enter for a new line" },
		});
		this.uiSendBtn = composer.createEl("button", { cls: "gw-send mod-cta", attr: { "aria-label": "Send" } });
		setIcon(this.uiSendBtn, "arrow-up");
		this.registerDomEvent(this.uiInputEl, "keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.submit();
			}
		});
		this.registerDomEvent(this.uiInputEl, "input", () => this.autoGrow());
		this.registerDomEvent(this.uiSendBtn, "click", () => (this.agent?.busy ? this.stop() : void this.submit()));

		const last = await this.latestChat();
		if (last) this.openChat(last);
		else this.newSession();
		this.refreshSyncIndicator();
	}

	async onClose(): Promise<void> {
		this.stop();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void): HTMLElement {
		const b = parent.createEl("button", { cls: "clickable-icon gw-icon-btn", attr: { "aria-label": label } });
		setIcon(b, icon);
		this.registerDomEvent(b, "click", onClick);
		return b;
	}

	// ── session lifecycle ───────────────────────────────────────────────

	newSession(): void {
		if (this.agent?.busy) this.stop();
		const now = new Date().toISOString();
		this.record = { id: `chat-${Date.now().toString(36)}`, title: "New session", created: now, updated: now, messages: [], items: [] };
		this.session = { id: this.record.id };
		this.agent = null;
		this.renderAll();
		this.uiInputEl?.focus();
	}

	private openChat(record: ChatRecord): void {
		this.record = record;
		this.session = { id: record.id, title: record.title, notePath: record.notePath };
		this.agent = null;
		this.renderAll();
	}

	resetAgent(): void {
		this.agent = null;
		this.renderHeader();
		if (!this.record.items.length) this.renderAll();
	}

	private ensureAgent(): AgentSession | null {
		if (this.agent) return this.agent;
		const provider = this.plugin.makeProvider();
		if (!provider) return null;
		const today = new Date().toISOString().slice(0, 10);
		this.agent = new AgentSession({
			provider,
			store: this.plugin.store,
			tools: TOOLS,
			system: buildSystemPrompt("obsidian", `# Context\nToday is ${today}. Device: ${this.plugin.deviceName()}.`),
			ui: this,
			session: this.session,
			messages: this.record.messages,
		});
		return this.agent;
	}

	private async submit(prefill?: string): Promise<void> {
		const text = (prefill ?? this.uiInputEl.value).trim();
		if (!text || this.agent?.busy) return;
		const agent = this.ensureAgent();
		if (!agent) {
			new Notice("Add an Anthropic API key in Settings → Groundwork, or switch the provider to Demo.");
			this.plugin.openSettings();
			return;
		}
		this.uiInputEl.value = "";
		this.autoGrow();
		if (!this.record.items.length) {
			this.uiMessagesEl.empty();
			this.record.title = text.replace(/\s+/g, " ").slice(0, 60);
			this.session.title = this.record.title;
			this.session.notePath = await this.plugin.store.sessionNotePath(this.record.title.split(" ").slice(0, 8).join(" "));
			this.record.notePath = this.session.notePath;
		}
		this.pushItem({ kind: "user", text });
		this.setBusy(true);
		this.abort = new AbortController();
		try {
			await agent.send(text, (e) => this.onEvent(e), this.abort.signal);
		} finally {
			this.finishSegment();
			this.abort = null;
			this.record.messages = agent.messages;
			this.setBusy(false);
			await this.persist();
		}
	}

	stop(): void {
		this.abort?.abort();
		for (const resolve of this.pending) resolve(null);
		this.pending.clear();
	}

	private setBusy(busy: boolean): void {
		this.contentEl.toggleClass("is-busy", busy);
		this.uiSendBtn.empty();
		setIcon(this.uiSendBtn, busy ? "square" : "arrow-up");
		this.uiSendBtn.setAttr("aria-label", busy ? "Stop" : "Send");
		if (busy) this.showThinking();
		else this.hideThinking();
	}

	private uiThinkingEl: HTMLElement | null = null;
	private showThinking(): void {
		this.hideThinking();
		this.uiThinkingEl = this.uiMessagesEl.createDiv({ cls: "gw-thinking" });
		for (let i = 0; i < 3; i++) this.uiThinkingEl.createSpan({ cls: "gw-dot" });
		this.scrollToBottom(true);
	}
	private hideThinking(): void {
		this.uiThinkingEl?.remove();
		this.uiThinkingEl = null;
	}
	private keepThinkingLast(): void {
		if (this.uiThinkingEl) this.uiMessagesEl.appendChild(this.uiThinkingEl);
	}

	// ── agent events ────────────────────────────────────────────────────

	private onEvent(e: AgentEvent): void {
		switch (e.type) {
			case "text_delta": {
				if (!this.segment) {
					const el = this.uiMessagesEl.createDiv({ cls: "gw-msg gw-assistant markdown-rendered" });
					this.segment = { el, text: "", comp: null, timer: null, version: 0 };
				}
				this.segment.text += e.text;
				if (this.segment.timer === null) {
					const seg = this.segment;
					seg.timer = window.setTimeout(() => {
						seg.timer = null;
						if (this.segment === seg) void this.renderSegment(seg);
					}, 70);
				}
				break;
			}
			case "tool_start": {
				this.finishSegment();
				if (e.name === "quiz" || e.name === "ask_user") break;
				const chip = this.uiMessagesEl.createDiv({ cls: "gw-tool is-running" });
				setIcon(chip.createSpan({ cls: "gw-tool-icon" }), "loader");
				chip.createSpan({ text: TOOL_VERBS[e.name] ?? e.name });
				this.toolChips.set(e.id, chip);
				this.keepThinkingLast();
				this.scrollToBottom();
				break;
			}
			case "tool_end": {
				const chip = this.toolChips.get(e.id);
				if (chip) {
					chip.removeClass("is-running");
					chip.toggleClass("is-error", !!e.isError);
					chip.empty();
					setIcon(chip.createSpan({ cls: "gw-tool-icon" }), e.isError ? "alert-triangle" : iconFor(e.name));
					const summary = e.isError ? `${TOOL_VERBS[e.name] ?? e.name} failed: ${e.text.replace(/^Error:\s*/, "").slice(0, 160)}` : (e.summary ?? e.name);
					chip.createSpan({ text: summary });
					this.record.items.push({ kind: "tool", name: e.name, summary, isError: e.isError });
					this.toolChips.delete(e.id);
				}
				break;
			}
			case "error":
				this.finishSegment();
				this.pushItem({ kind: "error", text: e.message });
				break;
			case "turn_end":
				this.finishSegment();
				break;
		}
	}

	private async renderSegment(seg: NonNullable<ChatView["segment"]>): Promise<void> {
		const version = ++seg.version;
		const next = createDiv();
		const comp = new Component();
		this.addChild(comp);
		await MarkdownRenderer.render(this.app, seg.text, next, this.record.notePath ?? "", comp);
		// A newer render started while this one was in flight; drop the stale output.
		if (version !== seg.version) {
			this.removeChild(comp);
			return;
		}
		if (seg.comp) this.removeChild(seg.comp);
		seg.comp = comp;
		seg.el.empty();
		while (next.firstChild) seg.el.appendChild(next.firstChild);
		this.keepThinkingLast();
		this.scrollToBottom();
	}

	private finishSegment(): void {
		const seg = this.segment;
		if (!seg) return;
		this.segment = null;
		if (seg.timer !== null) window.clearTimeout(seg.timer);
		seg.timer = null;
		const text = seg.text.trim();
		if (!text) {
			seg.el.remove();
			return;
		}
		this.record.items.push({ kind: "assistant", text });
		void this.renderSegment(seg);
	}

	// ── ToolUI ──────────────────────────────────────────────────────────

	quiz(quiz: PreparedQuiz): Promise<QuizResponse | null> {
		this.finishSegment();
		return new Promise((resolve) => {
			const settle = (v: QuizResponse | null) => {
				this.pending.delete(settle as (v: null) => void);
				resolve(v);
			};
			this.pending.add(settle as (v: null) => void);
			const card = new QuizCard(this.uiMessagesEl, quiz, (el, md) => this.renderMd(el, md), (r) => settle(r));
			this.liveQuizCards.set(quiz.id, card);
			this.keepThinkingLast();
			this.scrollToBottom(true);
			card.focus();
		});
	}

	quizRecorded(o: QuizOutcome): void {
		this.liveQuizCards.get(o.quiz.id)?.showRecorded(o.before, o.after);
		this.liveQuizCards.delete(o.quiz.id);
		this.record.items.push({ kind: "quiz", quiz: o.quiz, response: o.response, grade: o.grade, before: o.before, after: o.after });
		this.plugin.onKnowledgeChanged();
	}

	ask(input: AskInput): Promise<AskResponse | null> {
		this.finishSegment();
		return new Promise((resolve) => {
			const settle = (v: AskResponse | null) => {
				this.pending.delete(settle as (v: null) => void);
				if (v) this.record.items.push({ kind: "ask", input, answer: v });
				resolve(v);
			};
			this.pending.add(settle as (v: null) => void);
			new AskCard(this.uiMessagesEl, input, (el, md) => this.renderMd(el, md), (r) => settle(r));
			this.keepThinkingLast();
			this.scrollToBottom(true);
		});
	}

	// ── rendering ───────────────────────────────────────────────────────

	private async renderMd(el: HTMLElement, markdown: string): Promise<void> {
		await MarkdownRenderer.render(this.app, markdown, el, this.record?.notePath ?? "", this);
		// Rendered options sit inside buttons; a lone paragraph adds unwanted margins.
		const only = el.children.length === 1 ? el.firstElementChild : null;
		if (only?.tagName === "P") only.addClass("gw-tight");
	}

	private renderHeader(): void {
		this.uiTitleEl.setText(this.record.items.length ? this.record.title : "Groundwork");
		this.uiBadgeEl.empty();
		const p = this.plugin.providerLabel();
		this.uiBadgeEl.createSpan({ cls: `gw-badge ${p.demo ? "is-demo" : ""}`, text: p.label });
		if (this.record.notePath) {
			const link = this.uiBadgeEl.createEl("a", { cls: "gw-note-link", text: "session note" });
			link.addEventListener("click", () => void this.app.workspace.openLinkText(this.record.notePath!, "", true));
		}
	}

	private renderAll(): void {
		this.renderHeader();
		this.uiMessagesEl.empty();
		this.toolChips.clear();
		if (!this.record.items.length) {
			void this.renderEmpty();
			return;
		}
		for (const item of this.record.items) this.renderItem(item);
		this.scrollToBottom(true);
	}

	private renderItem(item: DisplayItem): void {
		switch (item.kind) {
			case "user": {
				const el = this.uiMessagesEl.createDiv({ cls: "gw-msg gw-user" });
				el.setText(item.text);
				break;
			}
			case "assistant": {
				const el = this.uiMessagesEl.createDiv({ cls: "gw-msg gw-assistant markdown-rendered" });
				void this.renderMd(el, item.text);
				break;
			}
			case "tool": {
				const chip = this.uiMessagesEl.createDiv({ cls: `gw-tool ${item.isError ? "is-error" : ""}` });
				setIcon(chip.createSpan({ cls: "gw-tool-icon" }), item.isError ? "alert-triangle" : iconFor(item.name));
				chip.createSpan({ text: item.summary });
				break;
			}
			case "quiz": {
				const card = new QuizCard(this.uiMessagesEl, item.quiz, (el, md) => this.renderMd(el, md));
				card.showAnswer({ response: item.response, grade: item.grade, before: item.before, after: item.after });
				break;
			}
			case "ask":
				new AskCard(this.uiMessagesEl, item.input, (el, md) => this.renderMd(el, md), undefined, item.answer);
				break;
			case "error": {
				const el = this.uiMessagesEl.createDiv({ cls: "gw-error" });
				setIcon(el.createSpan({ cls: "gw-tool-icon" }), "alert-triangle");
				el.createSpan({ text: item.text });
				break;
			}
		}
	}

	private pushItem(item: DisplayItem): void {
		this.record.items.push(item);
		this.renderItem(item);
		this.renderHeader();
		this.keepThinkingLast();
		this.scrollToBottom(true);
	}

	private async renderEmpty(): Promise<void> {
		const el = this.uiMessagesEl.createDiv({ cls: "gw-empty" });
		const hero = el.createDiv({ cls: "gw-hero" });
		setIcon(hero.createDiv({ cls: "gw-hero-icon" }), "graduation-cap");
		hero.createEl("h2", { text: "What do you want to understand?" });
		hero.createEl("p", {
			text: "Name a goal. The tutor checks what your vault already knows, maps the prerequisites down to truths you can accept without caveats, quizzes to find the edge of your understanding, and teaches up from there.",
		});

		const provider = this.plugin.providerLabel();
		if (provider.missingKey) {
			const warn = el.createDiv({ cls: "gw-setup" });
			warn.createEl("strong", { text: "Connect a model to start." });
			warn.createEl("p", { text: "Add your Anthropic API key (kept on this device only), or try the scripted demo first." });
			const row = warn.createDiv({ cls: "gw-row" });
			row.createEl("button", { cls: "mod-cta", text: "Add API key" }).addEventListener("click", () => this.plugin.openSettings());
			row.createEl("button", { text: "Try the demo" }).addEventListener("click", async () => {
				await this.plugin.useDemo();
				this.renderAll();
			});
		}

		const store = this.plugin.store;
		let overview: Awaited<ReturnType<typeof store.overview>> | null = null;
		try {
			overview = await store.overview();
		} catch {
			overview = null;
		}
		const suggestions = el.createDiv({ cls: "gw-suggestions" });
		const suggest = (icon: string, label: string, detail: string, run: () => void) => {
			const b = suggestions.createEl("button", { cls: "gw-suggestion" });
			setIcon(b.createSpan({ cls: "gw-suggestion-icon" }), icon);
			const t = b.createDiv();
			t.createDiv({ cls: "gw-suggestion-title", text: label });
			t.createDiv({ cls: "gw-suggestion-detail", text: detail });
			b.addEventListener("click", run);
		};
		if (provider.demo) {
			suggest("play", "Run the demo lesson", "A scripted lesson on the derivative: recall, plan, quizzes, memory updates.", () => void this.submit("Teach me what a derivative really is."));
		}
		for (const g of overview?.activeGoals.slice(0, 3) ?? []) {
			suggest("target", `Continue: ${g.title}`, `${g.progress}${g.next.length ? ` · next: ${g.next.slice(0, 2).join(", ")}` : ""}`, () =>
				void this.submit(`Let's continue with my goal "${g.title}".`),
			);
		}
		if (overview?.dueReviews.length) {
			suggest("rotate-ccw", `Review ${overview.dueReviews.length} fading concept${overview.dueReviews.length === 1 ? "" : "s"}`, overview.dueReviews.slice(0, 3).map((d) => d.title).join(", "), () =>
				void this.submit("Let's do my due reviews."),
			);
		}
		suggest("sparkles", "Start a new goal", "Tell the tutor what you want to be able to do.", () => {
			this.uiInputEl.value = "I want to understand ";
			this.uiInputEl.focus();
			this.autoGrow();
		});

		if (overview && overview.conceptCount) {
			const c = overview.counts;
			const stats = el.createDiv({ cls: "gw-vault-stats" });
			stats.createSpan({ text: `Your vault: ${overview.conceptCount} concepts` });
			for (const k of ["solid", "shaky", "learning", "rusty"] as const) {
				if (c[k]) stats.createSpan({ cls: `gw-status gw-status-${k}`, text: `${c[k]} ${k}` });
			}
		}
	}

	private autoGrow(): void {
		this.uiInputEl.style.height = "auto";
		this.uiInputEl.style.height = `${Math.min(this.uiInputEl.scrollHeight, 220)}px`;
	}

	private scrollToBottom(force = false): void {
		const el = this.uiMessagesEl;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
		if (force || nearBottom) el.scrollTop = el.scrollHeight;
	}

	refreshSyncIndicator(): void {
		if (!this.uiSyncBtn) return;
		const s = this.plugin.syncStatus;
		this.uiSyncBtn.toggleClass("is-syncing", s.state === "syncing");
		this.uiSyncBtn.toggleClass("is-warning", s.state === "error" || s.state === "offline");
		this.uiSyncBtn.setAttr("aria-label", `Sync with GitHub — ${s.text}`);
	}

	// ── menus ───────────────────────────────────────────────────────────

	private async showHistory(evt: MouseEvent): Promise<void> {
		const menu = new Menu();
		const chats = await this.listChats();
		if (!chats.length) menu.addItem((i) => i.setTitle("No past sessions yet").setDisabled(true));
		for (const c of chats.slice(0, 20)) {
			menu.addItem((i) =>
				i
					.setTitle(`${c.title}  ·  ${c.updated.slice(0, 10)}`)
					.setIcon(c.id === this.record.id ? "check" : "message-square")
					.onClick(() => {
						if (this.agent?.busy) this.stop();
						this.openChat(c);
					}),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private async showGoals(evt: MouseEvent): Promise<void> {
		const menu = new Menu();
		const goals = await this.plugin.store.goals();
		if (!goals.length) menu.addItem((i) => i.setTitle("No goals yet — tell the tutor what you want to learn").setDisabled(true));
		for (const g of goals) {
			menu.addItem((i) =>
				i
					.setTitle(`${g.title}${g.status === "active" ? "" : ` (${g.status})`}`)
					.setIcon(g.status === "done" ? "check-circle" : "target")
					.onClick(() => void this.app.workspace.openLinkText(g.path, "", "tab")),
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Open knowledge graph")
				.setIcon("git-fork")
				.onClick(() => (this.app as any).commands?.executeCommandById("graph:open")),
		);
		menu.showAtMouseEvent(evt);
	}

	// ── persistence ─────────────────────────────────────────────────────

	private async persist(): Promise<void> {
		this.record.updated = new Date().toISOString();
		const store = this.plugin.store;
		await store.writeFile(`${PATHS.chats}/${this.record.id}.json`, JSON.stringify(this.record));
		if (this.record.notePath) {
			const path = this.record.notePath;
			const existing = (await store.io.exists(path)) ? await store.io.read(path) : "";
			const { frontmatter, body } = parseNote(existing);
			const fm = { ...frontmatter, type: "session", date: this.record.created.slice(0, 10), chat: this.record.id, tags: ["groundwork/session"] };
			const base = body.trim() ? body : `# ${this.record.title}\n`;
			await store.writeFile(path, serializeNote(fm, setSection(base, "Transcript", transcript(this.record.items))));
		}
		this.renderHeader();
	}

	private async listChats(): Promise<ChatRecord[]> {
		const io = this.plugin.store.io;
		if (!(await io.exists(PATHS.chats))) return [];
		const out: ChatRecord[] = [];
		for (const f of (await io.list(PATHS.chats)).files) {
			if (!f.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(await io.read(f)));
			} catch {
				// ignore unreadable chat files
			}
		}
		return out.sort((a, b) => b.updated.localeCompare(a.updated));
	}

	private async latestChat(): Promise<ChatRecord | null> {
		const [last] = await this.listChats();
		if (!last) return null;
		const ageHours = (Date.now() - Date.parse(last.updated)) / 3_600_000;
		return ageHours < 12 ? last : null;
	}
}

function iconFor(name: string): string {
	switch (name) {
		case "get_learner_overview":
		case "search_knowledge":
		case "get_concepts":
			return "brain";
		case "set_goal":
		case "get_goal":
		case "set_goal_status":
			return "git-fork";
		case "save_session_summary":
			return "notebook-pen";
		case "update_learner_profile":
			return "user";
		default:
			return "check";
	}
}

function transcript(items: DisplayItem[]): string {
	const out: string[] = [];
	const quote = (s: string) => s.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
	for (const item of items) {
		switch (item.kind) {
			case "user":
				out.push(`> [!quote] You\n${quote(item.text)}`, "");
				break;
			case "assistant":
				out.push(demoteHeadings(item.text), "");
				break;
			case "quiz": {
				const { quiz, grade, response, after } = item;
				const verdict = grade.outcome === "correct" ? "✅ Correct" : grade.outcome === "dont_know" ? "❔ I don't know" : "❌ Incorrect";
				const lines = [
					`> [!question]- ${verdict} · ${quiz.kind} quiz on [[${quiz.concept}]] (level ${quiz.difficulty})`,
					quote(quiz.question),
					">",
					...quiz.options.map((o, i) => {
						const mark = quiz.correct.includes(o.value) ? " ✓" : response.selected.includes(o.value) ? " ✗" : "";
						return `> ${letter(i)}. ${o.label}${mark}`;
					}),
				];
				if (response.note) lines.push(">", `> *Note:* ${response.note}`);
				if (quiz.explanation) lines.push(">", quote(quiz.explanation));
				if (after) lines.push(">", `> Now **${Math.round(after.current * 100)}%** (${after.status})`);
				out.push(lines.join("\n"), "");
				break;
			}
			case "ask":
				out.push(
					`> [!question] ${item.input.question.split("\n")[0]}\n> **Answer:** ${[...item.answer.selected, item.answer.text].filter(Boolean).join(" — ")}`,
					"",
				);
				break;
			case "error":
				out.push(`> [!warning] ${item.text}`, "");
				break;
		}
	}
	return out.join("\n");
}
