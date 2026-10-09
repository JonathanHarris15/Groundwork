import { Component, FuzzySuggestModal, ItemView, Keymap, MarkdownRenderer, Menu, Notice, setIcon, TFile, type App, type WorkspaceLeaf } from "obsidian";
import {
	AgentSession,
	ASIDE_PROMPT,
	ASIDE_TOOL_NAMES,
	HINT_PROMPT,
	asideOpening,
	FIGURE_PROMPT,
	figureFile,
	figureForChat,
	figureFromModelText,
	figureOpening,
	hintNotes,
	hintOpening,
	basename,
	DemoAsideProvider,
	DemoFigureProvider,
	DemoProvider,
	marginNotes,
	buildSystemPrompt,
	prepareTutorTurn,
	buildConceptMap,
	buildFromGroundwork,
	layoutGroundworkGraph,
	daysLeftPhrase,
	describeQuizOutcome,
	fileAccessGuidance,
	formatDue,
	goalChoiceLabel,
	workingGoalNote,
	demoteHeadings,
	examPrepInstruction,
	familiarityLabel,
	fileKind,
	letter,
	loadVaultFile,
	normalizeTutorMarkdown,
	normalizeVaultPath,
	parseNote,
	practiceTestRequest,
	shouldStartExamPrep,
	pathInsideAny,
	removeFlashcardMirrors,
	PATHS,
	saveFigure,
	serializeNote,
	settleQuizAnswer,
	setSection,
	sourceBoundConceptReason,
	TOOLS,
	toolByName,
	withoutFileData,
	type AgentEvent,
	type AsideThread,
	type HintBrief,
	type SessionFigure,
	type AskInput,
	type AskResponse,
	type ChatMessage,
	type ConceptStats,
	type PreparedQuiz,
	type PreparedTest,
	type QuizGrade,
	type QuizOutcome,
	type QuizResponse,
	type SessionInfo,
	type StudyMove,
	type TestReport,
	type TestResponse,
	type ToolUI,
	type TutorSession,
	CLAUDE_SETUP,
	loadFlashcardLibrary,
} from "@groundwork/core";
import { ClaudeCodeSession } from "@groundwork/core/claude-code";
import { AsideCard, findQuoteRange } from "./aside";
import { downloadFigure, FigureCard, type FigureCardModel } from "./figure-card";
import { gutterFlags, menuPosition, sideRoom } from "./gutter";
import { clampSelection, passageOf } from "./passage";
import { toBoard, type GoalBoardView } from "./goal-board";
import { renderGoalsPane } from "./goals-pane";
import { renderMapPane, renderStartedVaultMap } from "./map-pane";
import { mountMark } from "./mark";
import { expandToMath, mathIn, mathOf, rangeText, tagMath } from "./math-source";
import { AskCard, QuizCard, TestCard } from "./cards";
import { pendingQuiz } from "./open-quiz";
import { ReaderFollow } from "./reader-follow";
import { FlashcardsPane, type FlashcardsHost } from "./flashcards-pane";
import { renderFlashcardsLibrary } from "./flashcards-library-pane";
import { enhanceGraphs } from "./graph-pane";
import { appendSvgFragment } from "./svg-fragment";
import type GroundworkPlugin from "./main";
import type { GroundworkAppearance } from "./appearance";
import {
	INITIAL_PANE,
	PRIMARY_TABS,
	paneRootClasses,
	setScreen as setPaneScreen,
	toggleUtility,
	type GroundworkScreen,
	type PaneLayoutState,
	type PrimaryScreen,
	type UtilityScreen,
} from "./pane-layout";
import { masteryPill, statusPill } from "./mastery-ui";
import { COMPOSER_INPUT_MIN_HEIGHT_PX } from "./ui-invariants";
import { MISSING_READ_FOLDER_DETAIL, MISSING_READ_FOLDER_TITLE, MissingReadFolderError, missingReadFolderNotice } from "./attach-warning";
import { accountOrigin, accountSignInUrl, folderAccessFrom, loadAccountToken, VaultFolderModal } from "./settings";
import { filesUnderFolderRoots } from "./vault-scope";

export const VIEW_TYPE = "groundwork-chat";

type DisplayItem =
	| { kind: "user"; text: string; attachments?: string[] }
	| { kind: "assistant"; text: string }
	| { kind: "tool"; name: string; summary: string; isError?: boolean }
	| { kind: "quiz"; quiz: PreparedQuiz; response: QuizResponse; grade: QuizGrade; before?: ConceptStats; after?: ConceptStats }
	| { kind: "test"; test: PreparedTest; response: TestResponse; report?: TestReport }
	| { kind: "ask"; input: AskInput; answer: AskResponse }
	| { kind: "error"; text: string }
	| { kind: "continue"; text: string; used?: boolean };

interface ChatRecord {
	id: string;
	title: string;
	created: string;
	updated: string;
	notePath?: string;
	/** API-provider history, and how many display items it covers. */
	messages: ChatMessage[];
	messagesAt?: number;
	/** Claude Code keeps sessions on the machine that ran them, so resume only there and only if nothing happened since. */
	claude?: { device: string; sessionId: string; at: number };
	items: DisplayItem[];
	/** Shown and not yet answered. Survives closing Obsidian so the question is still there. */
	openQuiz?: PreparedQuiz;
	/** Margin threads on highlighted passages. */
	asides?: AsideThread[];
	/** Figures in the left margin, also saved on the account. */
	figures?: SessionFigure[];
}

/** What a study button sends to the tutor on the learner's behalf. */
const STUDY_REQUEST: Record<StudyMove, (title: string) => string> = {
	start: (title) => `Let's build ${title}.`,
	quiz: (title) => `Quiz me on ${title}.`,
	learn: (title) => `Teach me ${title}.`,
	review: (title) => `Review ${title} with me.`,
};

const TAB_ICONS: Record<PrimaryScreen, string> = {
	learn: `<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"></path><path d="M4 19V5"></path>`,
	map: `<circle cx="6" cy="6" r="2.5"></circle><circle cx="18" cy="8" r="2.5"></circle><circle cx="10" cy="18" r="2.5"></circle><path d="M8 7l7.5 1M7 8l2.3 7.6M16.5 10l-5 6"></path>`,
	goals: `<path d="M5 21V4M5 4h11l-2 4 2 4H5"></path>`,
	flashcards: `<rect x="3" y="3" width="7" height="9" rx="1"></rect><rect x="14" y="3" width="7" height="5" rx="1"></rect><rect x="14" y="11" width="7" height="10" rx="1"></rect><rect x="3" y="15" width="7" height="6" rx="1"></rect>`,
};

const PAPERCLIP_PATH = `<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.57 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>`;

function paperclipIcon(doc: Document): SVGElement {
	const svg = doc.win.createSvg("svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.classList.add("svg-icon");
	appendSvgFragment(svg, PAPERCLIP_PATH);
	return svg;
}

const TOOL_VERBS: Record<string, string> = {
	get_learner_overview: "Reading your knowledge vault",
	suggest_what_to_study: "Checking what you could study",
	search_knowledge: "Searching what you already know",
	get_concepts: "Reading concept notes",
	upsert_concept: "Updating a concept note",
	set_goal: "Mapping the goal's dependencies",
	get_goal: "Checking goal progress",
	set_goal_status: "Updating goal status",
	set_working_goal: "Setting the goal you're working on",
	merge_goals: "Merging duplicate goals",
	record_evidence: "Recording evidence",
	get_due_reviews: "Checking due reviews",
	update_learner_profile: "Updating your learner profile",
	save_session_summary: "Saving the session summary",
	save_flashcard: "Saving a flashcard",
	list_flashcards: "Checking flashcards",
	list_vault_files: "Looking through your files",
	read_vault_file: "Opening a file",
	write_submission_file: "Writing a file to submit",
	ingest_exam_materials: "Breaking the files into exam topics",
	get_exam_plan: "Reading the exam plan",
	grade_answer: "Grading your answer",
	grade_practice_test: "Grading your practice test",
	show_figure: "Drawing a figure",
	fetch_public: "Reading a public page",
	Read: "Opening a file",
	WebSearch: "Searching the web",
	WebFetch: "Reading a web page",
};

/** Git hosts reject very large files, and the vault is a git repo. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type PendingFile = { name: string; file?: File; path?: string };

export class ChatView extends ItemView implements ToolUI {
	private record!: ChatRecord;
	private session!: SessionInfo;
	private agent: TutorSession | null = null;
	private abort: AbortController | null = null;
	private pending = new Set<(v: null) => void>();
	private liveQuizCards = new Map<string, QuizCard>();
	private liveTestCards = new Map<string, TestCard>();
	/** Live quiz() promises, so a re-render can reattach the same answer. */
	private quizSettle = new Map<string, (v: QuizResponse | null) => void>();
	/** Restored quiz waiting in the pending set. Replaced when the chat is redrawn. */
	private restoredQuizSettle: ((v: null) => void) | null = null;
	private resumedQuizIds = new Set<string>();
	private reader = new ReaderFollow();
	/** Closing the view must keep an unanswered quiz. Stop and New session must not. */
	private closing = false;
	private persistQueue: Promise<void> = Promise.resolve();

	private uiSessionEl!: HTMLElement;
	private uiProviderEl!: HTMLElement;
	private uiWeightEl!: HTMLElement;
	private uiContextEl!: HTMLElement;
	private uiGoalDaysEl!: HTMLElement;
	private uiTabs = new Map<PrimaryScreen, HTMLElement>();
	private uiMapEl!: HTMLElement;
	private uiGoalsEl!: HTMLElement;
	private pane: PaneLayoutState = INITIAL_PANE;
	private selectedGoalId: string | null = null;
	private uiMessagesEl!: HTMLElement;
	private uiInputEl!: HTMLTextAreaElement;
	private uiGoalEl!: HTMLSelectElement;
	private refreshingGoalSelect = false;
	private uiLibraryEl!: HTMLElement;
	private uiLibraryBtn!: HTMLElement;
	private uiFlashEl!: HTMLElement;
	private flashPane!: FlashcardsPane;
	private libraryTab: "goals" | "concepts" | "chats" | "flashcards" = "goals";
	private conceptQuery = "";
	private uiSettingsEl!: HTMLElement;
	private uiSettingsBtn!: HTMLElement;
	/** Unsaved learner file. Null means show what is saved in the vault. */
	private learnerDraft: string | null = null;
	private uiSendBtn!: HTMLButtonElement;
	private uiPendingEl!: HTMLElement;
	private uiAttachWarn!: HTMLElement;
	private uiAttachBtn!: HTMLButtonElement;
	private uiFileInput!: HTMLInputElement;
	private pendingFiles: PendingFile[] = [];

	private segment: { wrap: HTMLElement; el: HTMLElement; text: string; comp: Component | null; timer: number | null; version: number } | null = null;
	private toolChips = new Map<string, HTMLElement>();

	private waitingQuiz: PreparedQuiz | null = null;
	private waitingTest: PreparedTest | null = null;
	private asideCards = new Map<string, AsideCard>();
	private asideAgents = new Map<string, TutorSession>();
	private agentKey = "";
	/** Answer keys for open hint chats. Never written onto the saved thread. */
	private hintKeys = new Map<string, HintBrief>();
	private hintInflight = new Map<string, Promise<void>>();
	private asideRanges = new Map<string, Range>();
	private highlightFrame = 0;
	private uiAskBtn!: HTMLElement;
	private uiVizBtn!: HTMLElement;
	private uiSelectMenu!: HTMLElement;
	private selection: { anchor: string; quote: string } | null = null;
	private figureCards = new Map<string, FigureCard>();
	private figureRanges = new Map<string, Range>();
	private figureAgents = new Map<string, TutorSession>();
	/** Figures from show_figure, attached to the next assistant turn. */
	private pendingFigures: SessionFigure[] = [];
	private pickedMath: HTMLElement[] = [];

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
		const title = this.record?.title?.trim();
		if (title && title !== "New session" && (this.record?.items?.length ?? 0) > 0) {
			return title.length > 28 ? `${title.slice(0, 26)}…` : title;
		}
		return "Groundwork";
	}
	getIcon(): string {
		return "graduation-cap";
	}

	applyAppearance(mode: GroundworkAppearance): void {
		this.contentEl.removeClass("gw-theme-obsidian", "gw-theme-dark", "gw-theme-light", "gw-site-theme");
		this.contentEl.addClass("gw-root", `gw-theme-${mode}`);
	}


	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.removeAttribute("data-gw-ready");
		root.addClass("gw-root");
		this.applyAppearance(this.plugin.settings.appearance);

		const header = root.createDiv({ cls: "gw-header" });
		const brand = header.createDiv({ cls: "gw-brand" });
		mountMark(brand);
		brand.createSpan({ cls: "gw-brand-name", text: "GROUNDWORK" });
		const views = header.createDiv({ cls: "gw-views", attr: { role: "tablist", "aria-label": "Groundwork" } });
		this.uiTabs.clear();
		for (const tab of PRIMARY_TABS) this.uiTabs.set(tab.id, this.viewTab(views, tab.id, tab.title, TAB_ICONS[tab.id], tab.label));
		const actions = header.createDiv({ cls: "gw-actions" });
		this.uiSessionEl = actions.createDiv({ cls: "gw-session-title is-empty", attr: { "aria-hidden": "true" } });
		const headerTools = actions.createDiv({ cls: "gw-actions-tools" });
		this.iconButton(headerTools, "square-pen", "New session", () => this.newSession());
		this.uiLibraryBtn = this.iconButton(headerTools, "library", "Library", () => this.toggleUtilityScreen("library"));
		this.uiLibraryBtn.setAttr("data-testid", "gw-library-btn");
		this.uiSettingsBtn = this.iconButton(headerTools, "settings", "Settings", () => this.toggleUtilityScreen("settings"));
		this.uiSettingsBtn.setAttr("data-testid", "gw-settings-btn");
		this.iconButton(headerTools, "more-horizontal", "More actions", (e) => void this.showMoreMenu(e));
		const goalBar = root.createDiv({ cls: "gw-goalbar" });
		goalBar.createSpan({ cls: "gw-goalbar-label", text: "Working on:" });
		this.uiGoalEl = goalBar.createEl("select", {
			cls: "gw-goal-select",
			attr: {
				"aria-label": "Working goal — pin a goal for this session, or leave unset and study whatever you bring",
				title: "Pin a goal for this session. Leave unset to follow the topic or files you open in chat.",
			},
		});
		this.uiGoalDaysEl = goalBar.createSpan({ cls: "gw-goalbar-days" });
		this.registerDomEvent(this.uiGoalEl, "change", () => {
			if (this.refreshingGoalSelect) return;
			const id = this.uiGoalEl.value;
			this.selectedGoalId = id || null;
			void this.plugin.store.setWorkingGoal(id || null).then(() => {
				void this.refreshGoalSelect();
				if (this.pane.screen === "map") void this.renderMap();
				else if (this.pane.screen === "goals") void this.renderGoals();
				if (this.pane.screen === "flashcards") this.flashPane?.refresh();
			});
		});

		this.uiMessagesEl = root.createDiv({ cls: "gw-messages" });
		this.registerDomEvent(this.uiMessagesEl, "scroll", () => this.reader.noteUserScroll(this.uiMessagesEl));
		this.uiMapEl = root.createDiv({ cls: "gw-screen gw-map" });
		this.uiGoalsEl = root.createDiv({ cls: "gw-screen gw-goals" });
		this.uiLibraryEl = root.createDiv({ cls: "gw-library" });
		this.uiFlashEl = root.createDiv({ cls: "gw-flash" });
		this.flashPane = new FlashcardsPane(this.uiFlashEl, this.flashcardsHost());
		this.uiSettingsEl = root.createDiv({ cls: "gw-settings" });
		this.registerDomEvent(this.uiMessagesEl, "click", (evt) => {
			const a = (evt.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
			if (!a) return;
			evt.preventDefault();
			const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
			void this.app.workspace.openLinkText(href, this.record?.notePath ?? "", Keymap.isModEvent(evt));
		});

		const composer = root.createDiv({ cls: "gw-composer" });
		const box = composer.createDiv({ cls: "gw-box" });
		this.uiPendingEl = box.createDiv({ cls: "gw-pending" });
		this.uiAttachWarn = box.createDiv({ cls: "gw-attach-warn", attr: { hidden: "", role: "status" } });
		this.uiAttachWarn.createDiv({ cls: "gw-attach-warn-title", text: MISSING_READ_FOLDER_TITLE });
		this.uiAttachWarn.createEl("p", { cls: "gw-attach-warn-detail", text: MISSING_READ_FOLDER_DETAIL });
		const openReadFolders = this.uiAttachWarn.createEl("button", {
			cls: "gw-lib-btn",
			text: "Open vault folders",
			attr: { type: "button" },
		});
		this.registerDomEvent(openReadFolders, "click", () => void this.openReadFolderSettings());
		this.uiInputEl = box.createEl("textarea", {
			cls: "gw-input",
			attr: { rows: "1", placeholder: "Answer, ask a question, or say what you want to learn", title: "Enter to send · Shift+Enter for a new line · paste or drop files to attach" },
		});
		const row = box.createDiv({ cls: "gw-box-row" });
		const tools = row.createDiv({ cls: "gw-box-tools" });
		this.uiAttachBtn = tools.createEl("button", {
			cls: "clickable-icon gw-icon-btn gw-attach",
			attr: { "aria-label": "Attach files", title: "Attach files", type: "button" },
		});
		this.uiAttachBtn.append(paperclipIcon(tools.ownerDocument));
		this.registerDomEvent(this.uiAttachBtn, "click", (e) => {
			if (this.blockedWithoutReadFolder()) return;
			this.showAttachMenu(e);
		});
		this.uiFileInput = tools.createEl("input", { type: "file", attr: { multiple: "", hidden: "" } });
		this.registerDomEvent(this.uiFileInput, "change", () => {
			this.addFiles([...(this.uiFileInput.files ?? [])]);
			this.uiFileInput.value = "";
		});

		this.uiWeightEl = tools.createDiv({ cls: "gw-seg gw-tutor-weight", attr: { hidden: "", role: "group", "aria-label": "Tutor model" } });
		this.uiProviderEl = tools.createSpan({ cls: "gw-chip gw-chip-provider", attr: { hidden: "" } });
		this.uiContextEl = tools.createSpan({ cls: "gw-chip gw-chip-context", attr: { hidden: "" } });
		const openProviderSetup = () => {
			const setup = this.plugin.providerLabel().setup;
			if (!setup) return;
			if (setup.website) window.open(this.plugin.signedIn() ? accountOrigin() : accountSignInUrl());
			else void this.openSettings();
		};
		this.registerDomEvent(this.uiProviderEl, "click", () => openProviderSetup());
		this.registerDomEvent(this.uiProviderEl, "keydown", (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			openProviderSetup();
		});
		this.uiSendBtn = row.createEl("button", { cls: "gw-send mod-cta", attr: { "aria-label": "Send" } });
		setIcon(this.uiSendBtn, "arrow-up");
		this.registerDomEvent(this.uiInputEl, "keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.submit();
			}
		});
		this.registerDomEvent(this.uiInputEl, "input", () => this.autoGrow());
		this.registerDomEvent(this.uiInputEl, "paste", (e) => {
			const files = [...(e.clipboardData?.files ?? [])];
			if (!files.length) return;
			e.preventDefault();
			this.addFiles(files);
		});
		this.registerFileDrop(root);
		this.trackStatusBar();
		this.registerDomEvent(this.uiSendBtn, "click", () => (this.agent?.busy ? this.stop() : void this.submit()));

		root.setAttr("data-gw-ready", "true");
		void this.finishBootstrapOpen();
		this.setupMargin(root);
		return;
	}

	/** Account sync + seeded chat after the shell is painted (E2E waits on `data-gw-bootstrapped`). */
	private async finishBootstrapOpen(): Promise<void> {
		try {
			await this.plugin.bootstrapForE2e();
			const last = await this.latestChat();
			if (last) this.openChat(last);
			else this.newSession();
			await this.refreshGoalSelect();
			this.renderHeader();
			this.refreshSyncIndicator();
			this.syncPaneLayout();
			this.contentEl.setAttr("data-gw-bootstrapped", "true");
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.error("Groundwork bootstrap failed", e);
			this.contentEl.setAttr("data-gw-bootstrapped", "error");
			this.contentEl.setAttr("data-gw-bootstrap-error", message.slice(0, 240));
		}
	}

	async onClose(): Promise<void> {
		this.closing = true;
		if (this.record) await this.persist().catch(() => undefined);
		if (this.pane.screen === "flashcards") this.flashPane?.hide();
		this.stop();
		this.dropAgent();
		this.dropAsides();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void): HTMLElement {
		const b = parent.createEl("button", {
			cls: "clickable-icon gw-icon-btn",
			attr: { "aria-label": label, title: label, type: "button" },
		});
		setIcon(b, icon);
		b.createSpan({ cls: "gw-icon-label", text: label });
		this.registerDomEvent(b, "click", onClick);
		return b;
	}

	// ── session lifecycle ───────────────────────────────────────────────

	newSession(): void {
		this.enterScreen("learn");
		const leaving = this.record;
		if (this.agent?.busy) this.stop();
		else if (leaving) leaving.openQuiz = undefined;
		this.dropRestoredQuiz();
		this.reader.release();
		const now = new Date().toISOString();
		this.record = { id: `chat-${Date.now().toString(36)}`, title: "New session", created: now, updated: now, messages: [], items: [] };
		if (leaving && leaving.id !== this.record.id && (leaving.items.length || leaving.messages.length)) void this.persist(leaving);
		this.session = { id: this.record.id };
		this.dropAgent();
		this.dropAsides();
		this.renderAll();
		window.requestAnimationFrame(() => this.uiInputEl?.focus());
	}

	startPracticeTest(): void {
		if (this.agent?.busy) {
			new Notice("Groundwork: wait for the tutor to finish, then ask for a practice test.");
			return;
		}
		void this.submit(practiceTestRequest());
	}

	private openChat(record: ChatRecord): void {
		this.enterScreen("learn");
		const leaving = this.record;
		if (this.agent?.busy && leaving && leaving.id !== record.id) this.stop({ keepQuiz: true });
		this.dropRestoredQuiz();
		this.reader.release();
		this.record = {
			...record,
			messages: record.messages ?? [],
			items: record.items ?? [],
		};
		if (leaving && leaving.id !== this.record.id && (leaving.items.length || leaving.openQuiz || leaving.messages.length)) void this.persist(leaving);
		this.session = { id: record.id, title: record.title, notePath: record.notePath };
		this.dropAgent();
		this.dropAsides();
		this.renderAll();
	}

	resetAgent(): void {
		this.dropAgent();
		this.renderHeader();
		if (!this.record.items.length) this.renderAll();
	}

	private dropAgent(): void {
		this.agent?.close?.();
		this.agent = null;
	}

	private async ensureAgent(): Promise<TutorSession | null> {
		if (this.agent?.busy) return this.agent;
		await this.plugin.refreshTutorRoute();
		if (!this.plugin.signedIn()) {
			this.dropAgent();
			this.agentKey = "";
			return null;
		}
		const key = this.plugin.tutorRouteKey();
		if (this.agent && this.agentKey === key) return this.agent;
		this.dropAgent();
		this.dropAsides();
		this.agentKey = key;

		const today = new Date().toISOString().slice(0, 10);
		const access = folderAccessFrom(this.plugin.settings);
		const system = buildSystemPrompt(`# Context\nToday is ${today}. Device: ${this.plugin.deviceName()}.`, access);
		const record = this.record;
		const history = record.items.length ? transcript(record.items, record.asides) : undefined;
		const runtime = this.plugin.runtime();
		if (runtime.runtime === "setup") return null;

		if (runtime.runtime === "claude") {
			const cfg = this.plugin.claudeCodeConfig();
			if (!cfg) return null;
			const device = this.plugin.deviceName();
			const c = record.claude;
			const resumable = c && c.device === device && c.at === record.items.length;
			this.agent = new ClaudeCodeSession({
				...cfg,
				store: this.plugin.store,
				tools: TOOLS,
				system,
				ui: this,
				session: this.session,
				resume: resumable ? c.sessionId : undefined,
				history,
				access,
				grader: this.plugin.answerGrader(),
			});
			return this.agent;
		}

		const provider = runtime.runtime === "proxy" ? this.plugin.makeGroundworkProvider() : new DemoProvider();
		const current = record.messages.length > 0 && (record.messagesAt === undefined || record.messagesAt === record.items.length);
		const messages: ChatMessage[] = current
			? record.messages
			: history
				? [
						{ role: "user", content: `Here is our conversation so far, from an earlier session:\n\n<previous_conversation>\n${history.slice(-40_000)}\n</previous_conversation>` },
						{ role: "assistant", content: "Got it. I'll continue from there." },
					]
				: [];
		this.agent = new AgentSession({ provider, store: this.plugin.store, tools: TOOLS, system, ui: this, session: this.session, messages, access, grader: this.plugin.answerGrader() });
		return this.agent;
	}

	private async submit(prefill?: string, opts?: { quiet?: boolean }): Promise<void> {
		const quiet = opts?.quiet === true;
		const chatId = this.record.id;
		const text = (prefill ?? this.uiInputEl.value).trim();
		const pending = prefill === undefined ? this.pendingFiles : [];
		if (!text && !pending.length) return;
		if (this.agent?.busy) {
			if (this.pending.size) {
				new Notice("Groundwork: answer or close the card above first. Your message is kept.");
				const open = this.uiMessagesEl.querySelectorAll(".gw-test:not(.is-done), .gw-quiz:not(.is-done):not(.gw-test-question), .gw-ask:not(.is-done)");
				open[open.length - 1]?.scrollIntoView({ block: "center", behavior: "smooth" });
			} else {
				new Notice("Groundwork: the tutor is still replying. Press stop to interrupt.");
			}
			return;
		}
		const agent = await this.ensureAgent();
		if (!agent) {
			const runtime = this.plugin.runtime();
			new Notice(runtime.detail ?? this.plugin.providerLabel().setup?.detail ?? "Sign in on the Groundwork website, then choose Open Obsidian.");
			if (runtime.website) window.open(this.plugin.signedIn() ? accountOrigin() : accountSignInUrl());
			else this.plugin.openSettings();
			return;
		}
		let attachments: string[];
		try {
			attachments = [...new Set([...(await this.saveAttachments(pending)), ...this.linkedFiles(text)])];
		} catch (err) {
			if (err instanceof MissingReadFolderError) {
				this.showMissingReadFolderWarning(true);
				return;
			}
			new Notice(`Couldn't save the attachment: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (!quiet && prefill === undefined) {
			this.pendingFiles = [];
			this.renderPending();
		}
		if (!quiet) {
			this.uiInputEl.value = "";
			this.autoGrow();
		}
		if (!quiet && !this.record.items.length) {
			this.uiMessagesEl.empty();
			this.record.title = (text || `About ${attachments.map(basename).join(", ")}`).replace(/\s+/g, " ").slice(0, 60);
			this.session.title = this.record.title;
			this.session.notePath = await this.plugin.store.sessionNotePath(this.record.title.split(" ").slice(0, 8).join(" "));
			this.record.notePath = this.session.notePath;
		}
		if (!quiet) this.pushItem({ kind: "user", text, ...(attachments.length ? { attachments } : {}) });
		this.setBusy(true);
		this.abort = new AbortController();
		try {
			const files = await Promise.all(attachments.map((p) => loadVaultFile(this.plugin.store.context, p)));
			let toSend = text;
			if (attachments.length && shouldStartExamPrep(attachments.map(basename), text)) {
				const ingested = await this.plugin.store.ingestExamMaterials({
					files: attachments,
					userText: text,
					why: text || undefined,
					createGoal: true,
				});
				if (ingested.goal && !(await this.plugin.store.workingGoal())) {
					await this.plugin.store.setWorkingGoal(ingested.goal.goal.title);
					await this.refreshGoalSelect();
				}
				toSend = [examPrepInstruction(ingested.blueprint), text].filter(Boolean).join("\n\n");
			}
			toSend = [workingGoalNote(await this.plugin.store.workingGoal()), toSend].filter(Boolean).join("\n\n");
			const notes = this.marginNotes();
			if (notes) toSend = [toSend, notes].filter(Boolean).join("\n\n");
			const today = new Date().toISOString().slice(0, 10);
			const access = folderAccessFrom(this.plugin.settings);
			const prepared = await prepareTutorTurn({
				selector: this.plugin.runtime().runtime === "demo" ? undefined : this.plugin.contextSelector(),
				message: toSend,
				extra: `# Context\nToday is ${today}. Device: ${this.plugin.deviceName()}.`,
				access,
				profile: await this.plugin.store.profile(),
				tutorContext: await this.plugin.store.tutorContext(),
				attached: files,
				io: this.plugin.store.context,
				signal: this.abort.signal,
			});
			agent.setTurnContext?.(prepared.selected ? { system: prepared.system, profile: prepared.profile, tutorContext: prepared.tutorContext } : null);
			if (prepared.note) toSend = [toSend, prepared.note].join("\n\n");
			await agent.send(toSend, (e) => this.onEvent(e), this.abort.signal, prepared.files);
		} finally {
			this.abort = null;
			if (!this.record || this.record.id !== chatId) {
				this.setBusy(false);
			} else {
				this.finishSegment();
				// A close resolves the open quiz as dismissed. Do not store that half-turn, or the question is gone on return.
				if (!this.closing) {
					if (agent instanceof AgentSession) {
						this.record.messages = agent.messages;
						this.record.messagesAt = this.record.items.length;
					} else if (agent instanceof ClaudeCodeSession && agent.sessionId) {
						this.record.claude = { device: this.plugin.deviceName(), sessionId: agent.sessionId, at: this.record.items.length };
					}
				}
				this.setBusy(false);
				await this.persist();
			}
		}
	}

	/** Continue after a restored answer without putting that handoff in the transcript. */
	private continueTutor(text: string): Promise<void> {
		return this.submit(text, { quiet: true });
	}

	stop(opts?: { keepQuiz?: boolean }): void {
		this.abort?.abort();
		this.reader.release();
		if (!this.closing && !opts?.keepQuiz && this.record) this.record.openQuiz = undefined;
		for (const resolve of this.pending) resolve(null);
		this.pending.clear();
		this.quizSettle.clear();
		this.restoredQuizSettle = null;
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
					const wrap = this.turn();
					const el = this.assistantSlot(wrap);
					this.segment = { wrap, el, text: "", comp: null, timer: null, version: 0 };
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
				if (e.name === "quiz" || e.name === "ask_user" || e.name === "practice_test") break;
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
				if (!chip) break;
				this.toolChips.delete(e.id);
				// A failed call is feedback for the tutor, which retries or explains in its reply.
				if (e.isError) {
					chip.remove();
					break;
				}
				chip.removeClass("is-running");
				chip.empty();
				setIcon(chip.createSpan({ cls: "gw-tool-icon" }), iconFor(e.name));
				const summary = e.summary ?? e.name;
				chip.createSpan({ text: summary });
				this.record.items.push({ kind: "tool", name: e.name, summary });
				if (["set_goal", "set_goal_status", "set_working_goal", "merge_goals", "ingest_exam_materials"].includes(e.name)) {
					void this.refreshGoalSelect();
				}
				break;
			}
			case "error":
				this.finishSegment();
				this.pushItem({ kind: "error", text: e.message });
				break;
			case "continue_offer":
				this.finishSegment();
				this.pushItem({ kind: "continue", text: e.text });
				break;
			case "turn_end":
				this.finishSegment();
				this.flushOrphanFigures();
				break;
		}
	}

	private async renderSegment(seg: NonNullable<ChatView["segment"]>): Promise<void> {
		const version = ++seg.version;
		const next = createDiv();
		const comp = new Component();
		this.addChild(comp);
		const md = normalizeTutorMarkdown(seg.text);
		await MarkdownRenderer.render(this.app, md, next, this.record.notePath ?? "", comp);
		tagMath(next, md);
		// A newer render started while this one was in flight; drop the stale output.
		if (version !== seg.version) {
			this.removeChild(comp);
			return;
		}
		if (seg.comp) this.removeChild(seg.comp);
		seg.comp = comp;
		seg.el.empty();
		while (next.firstChild) seg.el.appendChild(next.firstChild);
		enhanceGraphs(seg.el, { onConcept: (title) => void this.studyConcept(title, "start") });
		this.scheduleHighlights();
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
			seg.wrap.remove();
			return;
		}
		this.record.items.push({ kind: "assistant", text });
		seg.wrap.dataset.anchor = `item:${this.record.items.length - 1}`;
		this.attachPendingFigures(seg.wrap);
		void this.renderSegment(seg);
	}

	// ── ToolUI ──────────────────────────────────────────────────────────

	quiz(quiz: PreparedQuiz): Promise<QuizResponse | null> {
		// Hold before the last prose render finishes, so that render cannot jump to the new card.
		this.reader.hold();
		this.finishSegment();
		this.record.openQuiz = quiz;
		void this.persist();
		return new Promise((resolve) => {
			const settle = (v: QuizResponse | null) => {
				this.pending.delete(settle);
				this.quizSettle.delete(quiz.id);
				if (v) this.reader.release();
				void this.releaseQuiz(quiz, v, resolve);
			};
			this.quizSettle.set(quiz.id, settle);
			this.pending.add(settle);
			this.waitingQuiz = quiz;
			const top = this.reader.keepPlace(this.uiMessagesEl, () => {
				this.mountOpenQuiz(quiz, (r) => settle(r));
				this.keepThinkingLast();
			});
			window.requestAnimationFrame(() => {
				this.reader.restore(this.uiMessagesEl, top);
				window.requestAnimationFrame(() => this.reader.restore(this.uiMessagesEl, top));
			});
		});
	}

	/** Let an in-flight hint finish so the tutor reads the nudge they actually got. */
	private async releaseQuiz(quiz: PreparedQuiz, v: QuizResponse | null, resolve: (v: QuizResponse | null) => void): Promise<void> {
		if (v) await this.hintsSettled([quiz.id]);
		if (this.waitingQuiz === quiz) this.waitingQuiz = null;
		resolve(v);
	}

	focusGoal(_title: string | null): void {
		void this.refreshGoalSelect();
	}

	refreshAfterAccountLink(): void {
		if (this.pane.screen === "settings") void this.renderSettings();
		if (!this.record) {
			this.renderHeader();
			return;
		}
		if (this.pane.screen === "learn" && !this.record.items.length) {
			this.renderAll();
			return;
		}
		this.renderHeader();
	}

	refreshAfterBootstrap(): void {
		this.refreshAfterAccountLink();
		if (!this.record) return;
		void this.refreshGoalSelect();
		if (this.pane.screen === "library") void this.renderLibrary();
	}

	private async refreshGoalSelect(): Promise<void> {
		if (!this.uiGoalEl) return;
		const choices = await this.plugin.store.goalChoices();
		const current = await this.plugin.store.workingGoal();
		this.refreshingGoalSelect = true;
		this.uiGoalEl.empty();
		this.uiGoalEl.createEl("option", {
			text: "No goal pinned",
			attr: { value: "", title: "The tutor follows what you bring in chat until you pick a goal" },
		});
		const seen = new Set<string>();
		for (const choice of choices) {
			if (seen.has(choice.id)) continue;
			seen.add(choice.id);
			this.uiGoalEl.createEl("option", { text: choice.title, attr: { value: choice.id } });
		}
		this.uiGoalEl.value = current && choices.some((c) => c.id === current.id) ? current.id : "";
		this.refreshingGoalSelect = false;
		this.selectedGoalId = this.uiGoalEl.value || null;
		this.uiGoalDaysEl?.setText(current?.daysLeft == null ? "" : daysLeftPhrase(current.daysLeft));
		this.uiGoalDaysEl?.toggle(current?.daysLeft != null);
		this.refreshOpenScreen();
	}

	quizRecorded(o: QuizOutcome): void {
		const card = this.liveQuizCards.get(o.quiz.id);
		if (o.quiz.format === "free") card?.showAnswer({ response: o.response, grade: o.grade, before: o.before, after: o.after });
		else card?.showRecorded(o.before, o.after);
		this.liveQuizCards.delete(o.quiz.id);
		if (this.record.openQuiz?.id === o.quiz.id) this.record.openQuiz = undefined;
		this.record.items.push({ kind: "quiz", quiz: o.quiz, response: o.response, grade: o.grade, before: o.before, after: o.after });
		this.plugin.onKnowledgeChanged();
	}

	private mountOpenQuiz(quiz: PreparedQuiz, onSubmit: (r: QuizResponse) => void): void {
		this.waitingQuiz = quiz;
		const card = new QuizCard(this.turn(`quiz:${quiz.id}`), quiz, (el, md) => this.renderMd(el, md), onSubmit, {
			onHint: () => this.openHint(`quiz:${quiz.id}`, quiz),
		});
		this.liveQuizCards.set(quiz.id, card);
		card.focus();
	}

	/** Draw a quiz that was saved unanswered. Answering it grades and continues the tutor. */
	private mountRestoredQuiz(quiz: PreparedQuiz): void {
		this.dropRestoredQuiz();
		const live = this.quizSettle.get(quiz.id);
		if (live) {
			this.mountOpenQuiz(quiz, (r) => live(r));
			return;
		}
		const settle = (v: QuizResponse | null) => {
			this.pending.delete(settle);
			if (this.restoredQuizSettle === settle) this.restoredQuizSettle = null;
			if (v) void this.answerRestoredQuiz(quiz, v);
		};
		this.restoredQuizSettle = settle;
		this.pending.add(settle);
		this.mountOpenQuiz(quiz, (r) => settle(r));
	}

	private dropRestoredQuiz(): void {
		if (!this.restoredQuizSettle) return;
		this.pending.delete(this.restoredQuizSettle);
		this.restoredQuizSettle = null;
	}

	private async answerRestoredQuiz(quiz: PreparedQuiz, response: QuizResponse): Promise<void> {
		if (this.resumedQuizIds.has(quiz.id)) return;
		this.resumedQuizIds.add(quiz.id);
		this.reader.release();
		if (this.waitingQuiz?.id === quiz.id) this.waitingQuiz = null;
		try {
			const settled = await settleQuizAnswer(this.plugin.store, quiz, response, this.session, this.plugin.answerGrader());
			if (this.record.openQuiz?.id === quiz.id) this.record.openQuiz = undefined;
			if ("outcome" in settled) {
				this.quizRecorded(settled.outcome);
				await this.persist();
				await this.continueTutor(
					[
						"The learner answered a quiz that was still open when they came back.",
						describeQuizOutcome(settled.outcome),
						"Already graded. Teach from this result.",
					].join("\n\n"),
				);
			} else {
				await this.persist();
				await this.continueTutor(settled.pending);
			}
		} catch (err) {
			this.resumedQuizIds.delete(quiz.id);
			new Notice(`Couldn't record that answer: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	test(test: PreparedTest): Promise<TestResponse | null> {
		this.finishSegment();
		return new Promise((resolve) => {
			const settle = (v: TestResponse | null) => {
				this.pending.delete(settle);
				void this.releaseTest(test, v, resolve);
			};
			this.pending.add(settle);
			this.waitingTest = test;
			const card = new TestCard(
				this.turn(`test:${test.id}`),
				test,
				(el, md) => this.renderMd(el, md),
				(r) => settle(r),
				(p) => this.openVaultNote(p),
				(q) => this.openHint(`test:${test.id}`, q),
			);
			this.liveTestCards.set(test.id, card);
			this.keepThinkingLast();
			this.scrollToBottom(true);
			card.focus();
		});
	}

	private async releaseTest(test: PreparedTest, v: TestResponse | null, resolve: (v: TestResponse | null) => void): Promise<void> {
		if (v) {
			this.record.items.push({ kind: "test", test, response: v });
			await this.hintsSettled(test.questions.map((q) => q.id));
		}
		if (this.waitingTest === test) this.waitingTest = null;
		resolve(v);
	}

	testGraded(report: TestReport): void {
		this.liveTestCards.get(report.testId)?.showReport(report);
		this.liveTestCards.delete(report.testId);
		const item = this.record.items.find((i): i is Extract<DisplayItem, { kind: "test" }> => i.kind === "test" && i.test.id === report.testId);
		if (item) item.report = report;
		this.plugin.onKnowledgeChanged();
	}

	private openVaultNote(path: string): void {
		void this.app.workspace.openLinkText(path, "", true);
	}

	ask(input: AskInput): Promise<AskResponse | null> {
		this.finishSegment();
		return new Promise((resolve) => {
			const settle = (v: AskResponse | null) => {
				this.pending.delete(settle);
				if (v) this.record.items.push({ kind: "ask", input, answer: v });
				resolve(v);
			};
			this.pending.add(settle);
			new AskCard(this.uiMessagesEl, input, (el, md) => this.renderMd(el, md), (r) => settle(r));
			this.keepThinkingLast();
			this.scrollToBottom(true);
		});
	}

	// ── rendering ───────────────────────────────────────────────────────

	private async renderMd(el: HTMLElement, markdown: string): Promise<void> {
		const md = normalizeTutorMarkdown(markdown);
		await MarkdownRenderer.render(this.app, md, el, this.record?.notePath ?? "", this);
		tagMath(el, md);
		enhanceGraphs(el, { onConcept: (title) => void this.studyConcept(title, "start") });
		this.scheduleHighlights();
		// Rendered options sit inside buttons; a lone paragraph adds unwanted margins.
		const only = el.children.length === 1 ? el.firstElementChild : null;
		if (only?.tagName === "P") only.addClass("gw-tight");
	}

	private paintTutorWeight(): void {
		const el = this.uiWeightEl;
		if (!el) return;
		const show = this.plugin.tutorRoute?.action === "hosted";
		el.toggleAttribute("hidden", !show);
		if (!show) {
			el.empty();
			return;
		}
		this.paintWeightButtons(el);
	}

	private paintWeightButtons(parent: HTMLElement): void {
		const weight = this.plugin.tutorRoute?.weight === "heavy" ? "heavy" : "light";
		parent.empty();
		for (const [id, label] of [
			["light", "Light"],
			["heavy", "Heavy"],
		] as const) {
			const on = weight === id;
			const button = parent.createEl("button", {
				text: label,
				attr: { type: "button", "aria-pressed": on ? "true" : "false" },
			});
			if (on) button.addClass("is-on");
			button.addEventListener("click", () => {
				if (this.plugin.tutorRoute?.weight === id || (!this.plugin.tutorRoute?.weight && id === "light")) return;
				void this.plugin.setTutorWeight(id);
			});
		}
	}

	private renderHeader(): void {
		if (!this.record) return;
		const title = this.record.items.length ? this.record.title : "New session";
		const showTitle = this.pane.screen === "learn" && this.record.items.length > 0;
		this.uiSessionEl?.toggleClass("is-empty", !showTitle);
		this.uiSessionEl?.setAttr("aria-hidden", showTitle ? "false" : "true");
		this.uiSessionEl?.setText(showTitle ? title : "");
		const provider = this.plugin.providerLabel();
		this.paintTutorWeight();
		this.uiProviderEl?.setText(provider.label);
		this.uiProviderEl?.toggleAttribute("hidden", !this.plugin.showProviderChip());
		this.uiProviderEl?.toggleClass("is-attention", !!provider.setup);
		this.uiProviderEl?.toggleClass("is-clickable", !!provider.setup);
		if (provider.setup) {
			this.uiProviderEl.setAttr("role", "button");
			this.uiProviderEl.setAttr("tabindex", "0");
			this.uiProviderEl.setAttr("title", `${provider.label} — ${provider.setup.title}`);
		} else {
			this.uiProviderEl.removeAttribute("role");
			this.uiProviderEl.removeAttribute("tabindex");
			this.uiProviderEl.setAttr("title", provider.label);
		}
		const folders = this.plugin.settings.readFolders;
		this.uiAttachBtn?.setAttr("title", folders.length ? "Attach files" : `${MISSING_READ_FOLDER_TITLE}. Settings → Vault folders.`);
		if (folders.length) {
			this.uiAttachWarn?.setAttr("hidden", "");
			this.uiContextEl.show();
			this.uiContextEl.setText(folders[0]);
			this.uiContextEl.setAttr("title", `Vault folder the tutor can read: ${folders[0]}`);
		} else {
			this.uiContextEl.hide();
		}
	}

	private renderAll(): void {
		if (!this.record) return;
		this.renderHeader();
		this.uiMessagesEl.empty();
		this.toolChips.clear();
		this.asideCards.clear();
		this.asideRanges.clear();
		this.figureCards.clear();
		this.figureRanges.clear();
		this.pendingFigures = [];
		this.updateMarginMode();
		const open = pendingQuiz(this.record);
		if (!this.record.items.length && !open) {
			void this.renderEmpty();
			return;
		}
		this.record.items.forEach((item, i) => this.renderItem(item, i));
		for (const t of this.record.asides ?? []) this.mountAside(t);
		for (const figure of this.record.figures ?? []) this.mountSavedFigure(figure);
		if (open) this.mountRestoredQuiz(open);
		this.scrollToBottom(true);
	}

	private renderItem(item: DisplayItem, index: number): void {
		switch (item.kind) {
			case "user": {
				const row = this.uiMessagesEl.createDiv({ cls: "gw-msg-row is-me" });
				row.createDiv({ cls: "gw-avatar is-me", text: this.learnerInitial() });
				const body = row.createDiv({ cls: "gw-msg-body" });
				const bubble = body.createDiv({ cls: "gw-msg gw-user" });
				if (item.attachments?.length) this.renderFiles(bubble.createDiv({ cls: "gw-user-files" }), item.attachments);
				if (item.text) bubble.createDiv({ cls: "gw-user-text", text: item.text });
				break;
			}
			case "assistant": {
				const el = this.assistantSlot(this.turn(`item:${index}`));
				void this.renderMd(el, item.text);
				break;
			}
			case "tool": {
				if (item.isError) break;
				const chip = this.uiMessagesEl.createDiv({ cls: "gw-tool" });
				setIcon(chip.createSpan({ cls: "gw-tool-icon" }), iconFor(item.name));
				chip.createSpan({ text: item.summary });
				break;
			}
			case "quiz": {
				const card = new QuizCard(this.turn(`quiz:${item.quiz.id}`), item.quiz, (el, md) => this.renderMd(el, md));
				card.showAnswer({ response: item.response, grade: item.grade, before: item.before, after: item.after });
				break;
			}
			case "test": {
				const card = new TestCard(this.turn(`test:${item.test.id}`), item.test, (el, md) => this.renderMd(el, md), undefined, (p) => this.openVaultNote(p));
				if (item.report) card.showReport(item.report);
				else card.showSubmitted(item.response);
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
			case "continue":
				this.renderContinue(item);
				break;
		}
	}

	private renderContinue(item: Extract<DisplayItem, { kind: "continue" }>): void {
		const row = this.uiMessagesEl.createDiv({ cls: "gw-continue" });
		row.createSpan({ text: item.text });
		const button = row.createEl("button", {
			text: item.used ? "Continued" : "Continue",
			attr: { type: "button" },
		});
		if (item.used) button.disabled = true;
		button.addEventListener("click", () => {
			if (item.used || this.agent?.busy) return;
			item.used = true;
			button.disabled = true;
			button.setText("Continued");
			void this.continueTutor("Continue from where you stopped and finish the answer.");
		});
	}

	private pushItem(item: DisplayItem): void {
		this.record.items.push(item);
		this.renderItem(item, this.record.items.length - 1);
		this.renderHeader();
		this.keepThinkingLast();
		this.scrollToBottom(true);
	}

	private emptyPaintGen = 0;

	private async renderEmpty(): Promise<void> {
		const gen = ++this.emptyPaintGen;
		if (!this.record || this.record.items.length) return;
		this.uiMessagesEl.empty();
		const el = this.uiMessagesEl.createDiv({ cls: "gw-empty" });
		const provider = this.plugin.providerLabel();
		const needsSetup = !!provider.setup;

		if (needsSetup) {
			const start = el.createDiv({ cls: "gw-start" });
			start.createEl("h2", { cls: "gw-start-title", text: provider.setup!.title });
			void MarkdownRenderer.render(this.app, provider.setup!.detail, start.createDiv({ cls: "gw-start-detail" }), "", this);
			const actions = start.createDiv({ cls: "gw-start-actions" });
			const primary = actions.createEl("button", {
				cls: "mod-cta gw-start-primary",
				text: provider.setup!.action,
				attr: { type: "button" },
			});
			primary.addEventListener("click", () => {
				if (provider.setup?.website) window.open(this.plugin.signedIn() ? accountOrigin() : accountSignInUrl());
				else void this.openSettings();
			});
			if (this.plugin.signedIn()) {
				const demo = actions.createEl("button", {
					cls: "gw-text-btn gw-start-demo",
					text: "Preview with the demo tutor",
					attr: { type: "button" },
				});
				demo.addEventListener("click", () => {
					void (async () => {
						await this.plugin.useDemo();
						this.renderAll();
					})();
				});
			}
		} else {
			const hero = el.createDiv({ cls: "gw-hero" });
			setIcon(hero.createDiv({ cls: "gw-hero-icon" }), "graduation-cap");
			hero.createEl("h2", { text: "What do you want to understand?" });
			hero.createEl("p", {
				text: "Say what you want to learn, or drop in a lecture, homework, or notes. The tutor checks what you already hold and teaches that.",
			});
		}

		const store = this.plugin.store;
		let overview: Awaited<ReturnType<typeof store.overview>> | null = null;
		try {
			overview = await store.overview();
		} catch {
			overview = null;
		}
		if (gen !== this.emptyPaintGen || !this.record || this.record.items.length) return;
		const suggestions = el.createDiv({ cls: `gw-suggestions${needsSetup ? " is-deferred" : ""}` });
		if (needsSetup) {
			suggestions.createEl("h3", { cls: "gw-suggestions-kicker", text: "After you are connected" });
		}
		const suggest = (icon: string, label: string, detail: string, run: () => void) => {
			const b = suggestions.createEl("button", { cls: "gw-suggestion" });
			setIcon(b.createSpan({ cls: "gw-suggestion-icon" }), icon);
			const t = b.createDiv();
			t.createDiv({ cls: "gw-suggestion-title", text: label });
			t.createDiv({ cls: "gw-suggestion-detail", text: detail });
			b.addEventListener("click", run);
		};
		if (provider.demo && !needsSetup) {
			suggest("play", "Run the demo lesson", "A scripted lesson on the derivative: recall, plan, quizzes, memory updates.", () => void this.submit("Teach me what a derivative really is."));
		}
		for (const g of overview?.activeGoals.slice(0, 3) ?? []) {
			const waiting = g.targets.slice(0, 2).join(", ");
			suggest("target", `Continue: ${g.title}`, `${g.progress}${waiting ? ` · ${waiting}` : ""}`, () =>
				void this.submit(`Let's continue with my goal "${g.title}".`),
			);
		}
		if (overview?.dueReviews.length) {
			suggest("rotate-ccw", `Review ${overview.dueReviews.length} fading concept${overview.dueReviews.length === 1 ? "" : "s"}`, overview.dueReviews.slice(0, 3).map((d) => d.title).join(", "), () =>
				void this.submit("Let's do my due reviews."),
			);
		}
		suggest("clipboard-check", "Take a practice test", "A mock exam with no feedback until you submit, then an evaluation to learn from.", () =>
			void this.submit(practiceTestRequest(overview?.activeGoals[0]?.title)),
		);
		suggest("sparkles", "Start a new goal", "Tell the tutor what you want to be able to do.", () => {
			this.uiInputEl.value = "I want to understand ";
			this.uiInputEl.focus();
			this.autoGrow();
		});
		if (overview?.nextUp) {
			suggest("help-circle", "What should I study?", overview.nextUp.why, () => void this.submit("What should I study?"));
		}

		if (overview && overview.conceptCount) {
			const c = overview.counts;
			const stats = el.createDiv({ cls: "gw-vault-stats" });
			stats.createSpan({ text: `Your vault: ${overview.conceptCount} concepts` });
			for (const k of ["solid", "shaky", "learning", "rusty"] as const) {
				if (c[k]) masteryPill(stats, k, `${c[k]} ${k}`);
			}
		}
	}

	private autoGrow(): void {
		this.uiInputEl.setCssStyles({ height: "auto" });
		const min = COMPOSER_INPUT_MIN_HEIGHT_PX;
		this.uiInputEl.setCssStyles({ height: `${Math.min(Math.max(this.uiInputEl.scrollHeight, min), 220)}px` });
	}

	private scrollToBottom(force = false): void {
		this.reader.follow(this.uiMessagesEl, force);
	}

	refreshSyncIndicator(): void {
		// Tutor memory sync lives on the Obsidian status bar (see GroundworkPlugin.renderStatus).
	}

	// ── attachments ─────────────────────────────────────────────────────

	private showAttachMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((i) =>
			i.setTitle("Upload from this computer…").setIcon("upload").onClick(() => {
				if (this.blockedWithoutReadFolder()) return;
				this.uiFileInput.click();
			}),
		);
		menu.addItem((i) =>
			i
				.setTitle("Choose from the vault…")
				.setIcon("folder-open")
				.onClick(() => {
					if (this.blockedWithoutReadFolder()) return;
					new VaultFileModal(this.app, folderAccessFrom(this.plugin.settings).readFolders, (f) => this.addVaultFile(f.path)).open();
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	/** True when attaching is refused because no read folder is set. The composer explains where to add one. */
	private blockedWithoutReadFolder(): boolean {
		if (folderAccessFrom(this.plugin.settings).readFolders.length) return false;
		this.showMissingReadFolderWarning();
		return true;
	}

	private showMissingReadFolderWarning(forceAnnounce = false): void {
		const warn = this.uiAttachWarn;
		const fresh = warn.hasAttribute("hidden");
		warn.removeAttribute("hidden");
		if (fresh || forceAnnounce) new Notice(missingReadFolderNotice(), 12_000);
		if (fresh) warn.querySelector("button")?.focus();
	}

	/** Settings opens on the read-folder field, which is where an upload is saved. */
	private openReadFolderSettings(): void {
		void this.openSettings().then(() => {
			this.uiSettingsEl?.querySelector("#gw-read-folders")?.scrollIntoView({ block: "start" });
		});
	}

	private addFiles(files: File[]): void {
		if (!files.length) return;
		if (this.blockedWithoutReadFolder()) return;
		for (const file of files) {
			if (file.size > MAX_UPLOAD_BYTES) {
				new Notice(`${file.name} is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB, too large to attach.`);
				continue;
			}
			const name = /^image\.\w+$/.test(file.name) ? `Pasted image ${timestamp()}.${file.name.split(".").pop()}` : file.name;
			this.pendingFiles.push({ name, file });
		}
		this.renderPending();
		this.uiInputEl.focus();
	}

	private addVaultFile(path: string): void {
		if (this.blockedWithoutReadFolder()) return;
		if (!this.pendingFiles.some((p) => p.path === path)) this.pendingFiles.push({ name: basename(path), path });
		this.renderPending();
		this.uiInputEl.focus();
	}

	private renderPending(): void {
		const el = this.uiPendingEl;
		el.empty();
		el.toggleClass("is-empty", !this.pendingFiles.length);
		for (const p of this.pendingFiles) {
			const chip = el.createDiv({ cls: "gw-file-chip" });
			setIcon(chip.createSpan({ cls: "gw-file-icon" }), iconForFile(p.name));
			const readFolder = folderAccessFrom(this.plugin.settings).readFolders[0];
			chip.createSpan({
				cls: "gw-file-name",
				text: p.name,
				attr: { title: p.path ?? (readFolder ? `Will be saved to ${readFolder}/` : missingReadFolderNotice()) },
			});
			const x = chip.createEl("button", { cls: "clickable-icon gw-file-remove", attr: { "aria-label": `Remove ${p.name}` } });
			setIcon(x, "x");
			x.addEventListener("click", () => {
				this.pendingFiles = this.pendingFiles.filter((q) => q !== p);
				this.renderPending();
			});
		}
	}

	/** Uploads go into the first folder the tutor is allowed to read, so it can open them again later. */
	private async saveAttachments(pending: PendingFile[]): Promise<string[]> {
		const access = folderAccessFrom(this.plugin.settings);
		if (!access.readFolders.length && pending.length) throw new MissingReadFolderError();
		const out: string[] = [];
		for (const p of pending) {
			if (p.path) {
				if (!pathInsideAny(p.path, access.readFolders)) {
					throw new Error(`${p.path} is outside the folders the tutor can read. Add that folder in Settings → Vault folders, under “Folders the tutor can read”.`);
				}
				out.push(p.path);
				continue;
			}
			const dir = access.readFolders[0];
			if (!dir) throw new MissingReadFolderError();
			await this.ensureVaultFolder(dir);
			const path = this.availablePath(`${dir}/${safeName(p.name)}`);
			await this.app.vault.createBinary(path, await p.file!.arrayBuffer());
			out.push(path);
		}
		return out;
	}

	private async ensureVaultFolder(folder: string): Promise<void> {
		let acc = "";
		for (const part of folder.split("/")) {
			acc = acc ? `${acc}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(acc)) await this.app.vault.createFolder(acc);
		}
	}

	private availablePath(path: string): string {
		const dot = path.lastIndexOf(".");
		const [stem, ext] = dot > path.lastIndexOf("/") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
		let candidate = path;
		for (let n = 1; this.app.vault.getAbstractFileByPath(candidate); n++) candidate = `${stem} ${n}${ext}`;
		return candidate;
	}

	/** Files the learner linked in their message, like [[Lecture 3.pdf]] or ![[diagram.png]], are attached too. */
	private linkedFiles(text: string): string[] {
		const access = folderAccessFrom(this.plugin.settings);
		const out: string[] = [];
		let missingFolder = false;
		for (const m of text.matchAll(/!?\[\[([^\]|#^]+)[^\]]*\]\]/g)) {
			const file = this.app.metadataCache.getFirstLinkpathDest(m[1].trim(), this.record.notePath ?? "");
			if (!file || file.extension === "md" || fileKind(file.path).kind === "other") continue;
			if (!access.readFolders.length) {
				missingFolder = true;
				continue;
			}
			if (!pathInsideAny(file.path, access.readFolders)) {
				new Notice(`${file.name} is outside the folders the tutor can read. Add its folder in Settings → Vault folders, under “Folders the tutor can read”.`);
				continue;
			}
			out.push(file.path);
		}
		if (missingFolder) this.showMissingReadFolderWarning();
		return out;
	}

	private renderFiles(el: HTMLElement, paths: string[]): void {
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			const open = () => {
				if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
				else new Notice(`${path} is no longer in the vault.`);
			};
			if (file instanceof TFile && fileKind(path).kind === "image") {
				const img = el.createEl("img", { cls: "gw-file-thumb", attr: { src: this.app.vault.getResourcePath(file), alt: file.name, title: path } });
				img.addEventListener("click", open);
				continue;
			}
			const chip = el.createDiv({ cls: `gw-file-chip is-link ${file ? "" : "is-missing"}`, attr: { title: path } });
			setIcon(chip.createSpan({ cls: "gw-file-icon" }), iconForFile(path));
			chip.createSpan({ cls: "gw-file-name", text: basename(path) });
			chip.addEventListener("click", open);
		}
	}

	private registerFileDrop(root: HTMLElement): void {
		const draggedVaultFiles = (): TFile[] => {
			const d = (this.app as App & { dragManager?: { draggable?: { type?: string; file?: unknown; files?: unknown } } }).dragManager?.draggable;
			if (d?.type === "file" && d.file instanceof TFile) return [d.file];
			if (d?.type === "files" && Array.isArray(d.files)) return d.files.filter((f: unknown): f is TFile => f instanceof TFile);
			return [];
		};
		const accepts = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files") || draggedVaultFiles().length > 0;
		let depth = 0;
		this.registerDomEvent(root, "dragenter", (e) => {
			if (!accepts(e)) return;
			depth++;
			root.addClass("is-dragover");
		});
		this.registerDomEvent(root, "dragleave", () => {
			if (depth && --depth === 0) root.removeClass("is-dragover");
		});
		this.registerDomEvent(root, "dragover", (e) => {
			if (!accepts(e)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		});
		this.registerDomEvent(root, "drop", (e) => {
			depth = 0;
			root.removeClass("is-dragover");
			const vaultFiles = draggedVaultFiles();
			const files = [...(e.dataTransfer?.files ?? [])];
			if (!vaultFiles.length && !files.length) return;
			e.preventDefault();
			e.stopPropagation();
			for (const f of vaultFiles) this.addVaultFile(f.path);
			if (!vaultFiles.length) this.addFiles(files);
		});
	}

	/** Obsidian's status bar floats over the bottom-right of the workspace; keep the composer clear of it. */
	private trackStatusBar(): void {
		let frame = 0;
		const update = () => {
			frame = 0;
			const bar = this.contentEl.doc.querySelector<HTMLElement>(".status-bar");
			let inset = 0;
			if (bar && getComputedStyle(bar).display !== "none") {
				const a = this.contentEl.getBoundingClientRect();
				const b = bar.getBoundingClientRect();
				if (b.width && b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top) inset = Math.ceil(a.bottom - b.top);
			}
			this.contentEl.style.setProperty("--gw-bottom-inset", `${inset}px`);
		};
		const schedule = () => {
			if (!frame) frame = window.requestAnimationFrame(update);
		};
		const observer = new ResizeObserver(schedule);
		observer.observe(this.contentEl);
		const bar = this.contentEl.doc.querySelector<HTMLElement>(".status-bar");
		if (bar) observer.observe(bar);
		this.register(() => {
			observer.disconnect();
			if (frame) window.cancelAnimationFrame(frame);
		});
		this.registerEvent(this.app.workspace.on("layout-change", schedule));
		this.registerEvent(this.app.workspace.on("resize", schedule));
		this.registerEvent(this.app.workspace.on("css-change", schedule));
		schedule();
	}

	// ── menus ───────────────────────────────────────────────────────────

	private showMoreMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((i) =>
			i.setTitle("Past sessions").setIcon("history").onClick(() => void this.showHistory(evt)),
		);
		const s = this.plugin.syncStatus;
		menu.addItem((i) =>
			i
				.setTitle(`Save tutor memory — ${s.text}`)
				.setIcon("refresh-cw")
				.onClick(() => void this.plugin.saveMemory(true)),
		);
		menu.showAtMouseEvent(evt);
	}

	private async showHistory(evt?: MouseEvent): Promise<void> {
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
		if (evt) menu.showAtMouseEvent(evt);
	}

	showFlashcards(): Promise<void> {
		return this.showScreen("flashcards");
	}

	private async ensureFlashcardsVisible(): Promise<void> {
		if (!this.uiFlashEl?.isConnected) {
			this.uiFlashEl =
				(this.contentEl.querySelector<HTMLElement>(".gw-flash")) ??
				this.contentEl.createDiv({ cls: "gw-flash" });
			this.flashPane = new FlashcardsPane(this.uiFlashEl, this.flashcardsHost());
		}
		this.uiInputEl?.blur();
		await this.flashPane.show();
	}

	private flashcardsHost(): FlashcardsHost {
		return {
			app: this.app,
			store: this.plugin.store,
			writeFolders: () => this.plugin.settings.writeFolders,
			renderMarkdown: (el, md) => this.renderMd(el, md),
			onManageCards: () => void this.openLibraryFlashcards(),
		};
	}

	openLibraryFlashcards(): Promise<void> {
		this.libraryTab = "flashcards";
		return this.showScreen("library");
	}

	private selectedQuote(): string {
		const chat = this.selection?.quote?.trim();
		if (chat) return chat;
		const editor = this.app.workspace.activeEditor?.editor;
		const fromNote = editor?.getSelection()?.trim();
		return fromNote || "";
	}

	openLibraryPanel(): Promise<void> {
		return this.showScreen("library");
	}

	/** Library chrome first, so the screen is never an empty bar while data loads. */
	private paintLibraryShell(): void {
		if (!this.uiLibraryEl?.isConnected) {
			this.uiLibraryEl =
				(this.contentEl.querySelector<HTMLElement>(".gw-library")) ??
				this.contentEl.createDiv({ cls: "gw-library" });
		}
		this.uiLibraryEl.empty();
		const top = this.uiLibraryEl.createDiv({ cls: "gw-library-top" });
		this.panelHead(top, "Library", "Goals, concepts, flashcards, and past chats.");
		const tabs = top.createDiv({ cls: "gw-lib-tabs", attr: { role: "tablist", "aria-label": "Library" } });
		this.uiLibraryEl.createDiv({ cls: "gw-library-scroll", attr: { "data-gw-library-scroll": "1" } });
		const tab = (id: "goals" | "concepts" | "chats" | "flashcards", label: string) => {
			const button = tabs.createEl("button", {
				cls: `gw-lib-tab${this.libraryTab === id ? " is-active" : ""}`,
				attr: { type: "button", role: "tab", "aria-selected": this.libraryTab === id ? "true" : "false", title: label },
			});
			button.createSpan({ text: label });
			button.createSpan({ cls: "gw-lib-count", text: "…" });
			button.addEventListener("click", () => {
				if (this.libraryTab === id) return;
				this.libraryTab = id;
				void this.renderLibrary();
			});
		};
		tab("goals", "Goals");
		tab("concepts", "Concepts");
		tab("chats", "Chats");
		tab("flashcards", "Flashcards");
	}

	showSettings(): Promise<void> {
		return this.showScreen("settings");
	}

	private openSettings(): Promise<void> {
		return this.showScreen("settings");
	}

	private async renderSettingsScreen(): Promise<void> {
		if (!this.uiSettingsEl?.isConnected) {
			this.uiSettingsEl =
				(this.contentEl.querySelector<HTMLElement>(".gw-settings")) ??
				this.contentEl.createDiv({ cls: "gw-settings" });
		}
		await this.plugin.refreshTutorRoute();
		if (this.pane.screen === "settings") await this.renderSettings();
	}

	/** Goals, concepts, and chats, one tab at a time. Nothing here opens a vault note. */
	private async renderLibrary(): Promise<void> {
		if (!this.uiLibraryEl?.isConnected) {
			this.uiLibraryEl = this.contentEl.querySelector<HTMLElement>(".gw-library") ?? this.uiLibraryEl;
		}
		if (!this.uiLibraryEl.querySelector<HTMLElement>(".gw-library-top")) this.paintLibraryShell();
		try {
			await this.renderLibraryBody();
		} catch (err) {
			const scroll =
				this.uiLibraryEl.querySelector<HTMLElement>(".gw-library-scroll") ??
				this.uiLibraryEl.createDiv({ cls: "gw-library-scroll" });
			scroll.empty();
			scroll.createDiv({
				cls: "gw-error",
				text: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async renderLibraryBody(): Promise<void> {
		const store = this.plugin.store;
		if (!this.uiLibraryEl.querySelector<HTMLElement>(".gw-library-top")) this.paintLibraryShell();
		const top = this.uiLibraryEl.querySelector<HTMLElement>(".gw-library-top");
		if (!top) return;
		const tabs = top.querySelector<HTMLElement>(".gw-lib-tabs");
		if (!tabs) return;
		let scroll = this.uiLibraryEl.querySelector<HTMLElement>(".gw-library-scroll");
		if (!scroll) scroll = this.uiLibraryEl.createDiv({ cls: "gw-library-scroll" });
		scroll.empty();

		const tab = (id: "goals" | "concepts" | "chats" | "flashcards", label: string, count: number | string) => {
			const button = tabs.createEl("button", {
				cls: `gw-lib-tab${this.libraryTab === id ? " is-active" : ""}`,
				attr: { type: "button", role: "tab", "aria-selected": this.libraryTab === id ? "true" : "false", title: label },
			});
			button.createSpan({ text: label });
			button.createSpan({ cls: "gw-lib-count", text: String(count) });
			button.addEventListener("click", () => {
				if (this.libraryTab === id) return;
				this.libraryTab = id;
				void this.renderLibrary();
			});
		};

		let choices: Awaited<ReturnType<typeof store.goalChoices>> = [];
		let goals: Awaited<ReturnType<typeof store.goals>> = [];
		let concepts: Awaited<ReturnType<typeof store.concepts>> = new Map();
		let chats: ChatRecord[] = [];
		try {
			[choices, goals, concepts, chats] = await Promise.all([store.goalChoices(), store.goals(), store.concepts(), this.listChats()]);
		} catch (err) {
			scroll.createDiv({ cls: "gw-error", text: err instanceof Error ? err.message : String(err) });
			return;
		}

		tabs.empty();
		let flashCount = 0;
		try {
			flashCount = (await loadFlashcardLibrary(store.io)).cards.length;
		} catch {
			flashCount = 0;
		}
		tab("goals", "Goals", goals.length);
		tab("concepts", "Concepts", concepts.size);
		tab("chats", "Chats", chats.length);
		tab("flashcards", "Flashcards", flashCount);

		if (this.libraryTab === "flashcards") {
			await renderFlashcardsLibrary(scroll, {
				app: this.app,
				store,
				writeFolders: () => this.plugin.settings.writeFolders,
				onStudy: (deckId) => void this.studyDeck(deckId),
				renderMarkdown: (el, md) => this.renderMd(el, md),
				onCardsChanged: (count) => {
					const badge = this.uiLibraryEl?.querySelector<HTMLElement>('.gw-lib-tab[title="Flashcards"] .gw-lib-count');
					if (badge) badge.textContent = String(count);
				},
			});
			return;
		}

		if (this.libraryTab === "goals") {
			const section = scroll.createDiv({ cls: "gw-lib-section" });
			section.createDiv({
				cls: "gw-lib-help",
				text: "A goal can name a course or a file, like Lecture 1 note fluency. Its concepts stay abstract so they carry to the next goal. Work toward one, quiz it, or delete it. Deleting a goal leaves those concepts in place.",
			});
			const choiceIds = new Set(choices.map((c) => c.id));
			if (!choices.length && !goals.length) {
				this.libraryEmpty(
					section,
					"Goals name what you want built by a date. They stay here after you finish.",
					"Tell the tutor your goal",
					() => this.promptGoal(),
				);
			}
			for (const choice of choices) {
				const row = this.libraryRow(section, choice.title, goalChoiceLabel(choice).replace(`${choice.title} → `, ""));
				this.libraryButton(row, "Work toward", () => void this.workToward(choice.id), true);
				this.libraryButton(row, "Quiz", () => void this.quizGoal(choice.id, choice.title, true));
				this.libraryDelete(row, () => this.deleteListedGoal(choice.id));
			}
			for (const goal of goals) {
				if (choiceIds.has(goal.id)) continue;
				const row = this.libraryRow(section, goal.title, goal.status === "paused" ? "Paused" : "Done");
				this.libraryButton(row, "Quiz", () => void this.quizGoal(goal.id, goal.title, false));
				this.libraryDelete(row, () => this.deleteListedGoal(goal.id));
			}
			return;
		}

		if (this.libraryTab === "concepts") {
			const section = scroll.createDiv({ cls: "gw-lib-section" });
			section.createDiv({
				cls: "gw-lib-help gw-lib-help-concepts",
				text: "Reusable ideas the tutor tracks. Quiz one to check it, or delete it.",
			});
			const filter = section.createEl("input", {
				cls: "gw-lib-filter",
				attr: { type: "search", placeholder: "Filter concepts", "aria-label": "Filter concepts" },
			});
			filter.value = this.conceptQuery;
			const conceptList = section.createDiv({ cls: "gw-lib-list gw-lib-list-concepts" });
			const conceptRows = [...concepts.values()].sort((a, b) => a.title.localeCompare(b.title));
			const drawConcepts = () => {
				conceptList.empty();
				const q = filter.value.trim().toLowerCase();
				const shown = conceptRows.filter((c) => !q || c.title.toLowerCase().includes(q) || c.aliases.some((a) => a.toLowerCase().includes(q)));
				if (!shown.length) {
					if (!conceptRows.length) {
						this.libraryEmpty(section, "Concepts are reusable ideas the tutor quizzes and tracks.", "Ask the tutor to teach one", () => {
							void this.showScreen("learn");
							this.uiInputEl.value = "Teach me ";
							this.autoGrow();
						});
					} else {
						conceptList.createDiv({ cls: "gw-lib-empty", text: "No concepts match your filter." });
					}
					return;
				}
				for (const concept of shown) {
					const row = this.libraryRow(conceptList, concept.title, "");
					const meta = row.querySelector<HTMLElement>(".gw-lib-meta");
					meta?.empty();
					if (meta) statusPill(meta, concept.stats.status);
					if (sourceBoundConceptReason(concept.title) || concept.aliases.some((alias) => sourceBoundConceptReason(alias))) {
						meta?.createSpan({ cls: "gw-lib-bound", text: "Names a document" });
					}
					this.libraryButton(row, "Quiz", () => void this.quizConcept(concept.title));
					this.libraryDelete(row, () => this.deleteListedConcept(concept.title));
				}
			};
			filter.addEventListener("input", () => {
				this.conceptQuery = filter.value;
				drawConcepts();
			});
			drawConcepts();
			return;
		}

		const section = scroll.createDiv({ cls: "gw-lib-section" });
		section.createDiv({ cls: "gw-lib-help", text: "Deleting a chat removes it from the tutor's history, including its session transcript." });
		if (!chats.length) {
			this.libraryEmpty(section, "Past chats stay on your account. Open one to continue where you left off.", "Start a chat", () => void this.showScreen("learn"));
		}
		for (const chat of chats) {
			const when = chat.updated?.slice(0, 10) || chat.created?.slice(0, 10) || "";
			const row = this.libraryRow(section, chat.title || "Untitled", when);
			if (chat.id === this.record?.id) row.addClass("is-current");
			this.libraryButton(row, "Open", () => {
				if (this.agent?.busy) this.stop();
				this.openChat(chat);
			});
			this.libraryDelete(row, () => this.deleteListedChat(chat.id));
		}
	}

	/** Learner file, a few preferences, and a vault reset. */
	private async renderSettings(): Promise<void> {
		const store = this.plugin.store;
		if (!this.uiSettingsEl?.isConnected) {
			this.uiSettingsEl =
				(this.contentEl.querySelector<HTMLElement>(".gw-settings")) ??
				this.contentEl.createDiv({ cls: "gw-settings" });
		}
		this.uiSettingsEl.empty();
		const top = this.uiSettingsEl.createDiv({ cls: "gw-library-top" });
		this.panelHead(top, "Settings", "Vault folders, the tutor, and your account.");
		const scroll = this.uiSettingsEl.createDiv({ cls: "gw-library-scroll" });

		let profile = "";
		try {
			profile = await store.profile();
		} catch (err) {
			scroll.createDiv({ cls: "gw-error", text: err instanceof Error ? err.message : String(err) });
			return;
		}

		const learner = scroll.createDiv({ cls: "gw-lib-section" });
		learner.createEl("h3", { text: "Learner file" });
		learner.createDiv({
			cls: "gw-lib-help",
			text: "Your learner profile lives on your Groundwork account. The tutor reads it every session and may add how you learn. Save writes it there.",
		});
		const learnerArea = learner.createEl("textarea", {
			cls: "gw-lib-context gw-learner",
			attr: { rows: "12", placeholder: "Background, how you learn best, observations…", "aria-label": "Learner file" },
		});
		learnerArea.value = this.learnerDraft ?? profile;
		learnerArea.addEventListener("input", () => {
			this.learnerDraft = learnerArea.value;
		});
		const learnerSave = learner.createDiv({ cls: "gw-lib-save-row" });
		const saveLearner = learnerSave.createEl("button", { cls: "gw-lib-btn mod-cta", text: "Save", attr: { type: "button" } });
		saveLearner.addEventListener("click", () => {
			void store.setProfile(learnerArea.value).then(
				(saved) => {
					this.learnerDraft = null;
					learnerArea.value = saved;
					new Notice("Saved your learner profile.");
				},
				(err: unknown) => new Notice(err instanceof Error ? err.message : String(err)),
			);
		});
		this.renderAccountLink(scroll);
		this.renderVaultFolders(scroll);
		this.renderTutorSettings(scroll);
		this.renderAppearance(scroll);
		this.renderVaultReset(scroll);
	}

	private renderAccountLink(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "gw-lib-section" });
		section.createEl("h3", { text: "Account" });
		section.createDiv({
			cls: "gw-lib-help",
			text: "Sign in, plans, and billing are on the Groundwork website. Tutor memory is stored with that account.",
		});
		const connected = !!loadAccountToken(this.app);
		section.createDiv({
			cls: "gw-lib-help",
			text: connected ? "This device is linked. Choose Open Obsidian on the website again if you switch accounts." : "Sign in on the Groundwork website, then choose Open Obsidian.",
		});
		const row = section.createDiv({ cls: "gw-lib-save-row" });
		const open = row.createEl("button", { cls: "gw-lib-btn mod-cta", text: connected ? "Open website" : "Sign in", attr: { type: "button" } });
		open.addEventListener("click", () => window.open(connected ? accountOrigin() : accountSignInUrl()));
	}

	private renderVaultFolders(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "gw-lib-section" });
		section.createEl("h3", { text: "Vault folders" });
		section.createDiv({
			cls: "gw-lib-help",
			text: "Optional extra context in this vault. The tutor reads only these folders, and writes a file to hand in only inside a write folder. Concepts, notes, dates, and flashcards stay on your account. Cards are written into the vault only when you ask.",
		});
		this.folderEditor(section, "readFolders", "Folders the tutor can read", "Chat uploads are saved in the first one. Leave this empty and the tutor does not read the vault.");
		this.folderEditor(section, "writeFolders", "Folders the tutor can write", "A file to hand in is written here. Flashcards stay on your account until you write them into the vault.");
	}

	private folderEditor(parent: HTMLElement, key: "readFolders" | "writeFolders", name: string, desc: string): void {
		const s = this.plugin.settings;
		const field = this.settingField(parent, name, desc);
		if (key === "readFolders") field.setAttr("id", "gw-read-folders");
		if (!s[key].length) field.createDiv({ cls: "gw-setting-desc", text: "None yet." });
		for (const folder of s[key]) {
			const row = field.createDiv({ cls: "gw-folder-row" });
			row.createSpan({ text: folder });
			const remove = row.createEl("button", { cls: "gw-lib-btn", text: "Remove", attr: { type: "button" } });
			remove.addEventListener("click", () => {
				s[key] = s[key].filter((item) => item !== folder);
				void this.plugin.saveSettings().then(() => this.renderSettings());
			});
		}
		const controls = field.createDiv({ cls: "gw-field-controls" });
		const input = controls.createEl("input", {
			cls: "gw-lib-filter",
			attr: { type: "text", placeholder: key === "readFolders" ? "resources" : "submissions" },
		});
		const add = (path: string) => {
			const folder = normalizeVaultPath(path);
			if (!folder) {
				new Notice("Groundwork: use a vault folder such as resources or submissions/homework.");
				return;
			}
			if (!s[key].includes(folder)) s[key].push(folder);
			void this.plugin.saveSettings().then(() => this.renderSettings());
		};
		const addBtn = controls.createEl("button", { cls: "gw-lib-btn", text: "Add", attr: { type: "button" } });
		addBtn.addEventListener("click", () => add(input.value));
		const choose = controls.createEl("button", { cls: "gw-lib-btn", text: "Choose…", attr: { type: "button" } });
		choose.addEventListener("click", () => {
			new VaultFolderModal(this.app, (picked) => add(picked.path)).open();
		});
	}

	private renderTutorSettings(parent: HTMLElement): void {
		const s = this.plugin.settings;
		const section = parent.createDiv({ cls: "gw-lib-section" });
		section.createEl("h3", { text: "Tutor" });
		section.createDiv({
			cls: "gw-lib-help",
			text: "The tutor looks things up on the web when a fact is uncertain. Written answers are graded on the website.",
		});
		if (!loadAccountToken(this.app)) {
			section.createDiv({
				cls: "gw-lib-help",
				text: "Sign in on the Groundwork website, then choose Open Obsidian. The tutor waits until this device is linked.",
			});
			const signIn = section.createEl("button", { cls: "gw-lib-btn", text: "Sign in", attr: { type: "button" } });
			signIn.addEventListener("click", () => window.open(accountSignInUrl()));
		} else if (this.plugin.tutorRoute?.action === "hosted") {
			const used = Math.round((this.plugin.tutorRoute.budgetUsed || 0) * 100);
			section.createDiv({
				cls: "gw-lib-help",
				text: `Light is Gemini Flash. Heavy is the stronger Gemini Flash, and it uses more of this month's budget. ${used}% of this month's tutor budget is used.`,
			});
			const picker = section.createDiv({ cls: "gw-seg gw-tutor-weight", attr: { role: "group", "aria-label": "Tutor model" } });
			this.paintWeightButtons(picker);
		} else if (this.plugin.tutorRoute?.action === "key") {
			section.createDiv({ cls: "gw-lib-help", text: `The tutor calls ${this.plugin.tutorRoute.label} with the key saved on your account. Change that on the website.` });
		} else if (this.plugin.tutorRoute?.action === "blocked") {
			section.createDiv({ cls: "gw-lib-help", text: this.plugin.tutorRoute.error ?? "Open the website to finish setup." });
			const open = section.createEl("button", { cls: "gw-lib-btn", text: "Open website", attr: { type: "button" } });
			open.addEventListener("click", () => window.open(accountOrigin()));
		} else if (this.plugin.tutorRoute?.action === "claude") {
			this.renderClaudeSettings(section);
		} else {
			section.createDiv({
				cls: "gw-lib-help",
				text: "Your account is signed in here, but Obsidian is not linked yet. On the website, choose Open Obsidian.",
			});
			const open = section.createEl("button", { cls: "gw-lib-btn", text: "Open website", attr: { type: "button" } });
			open.addEventListener("click", () => window.open(accountOrigin()));
		}
		const device = this.settingField(section, "Device name", "Recorded on quiz evidence so you can tell machines apart. Leave empty to use this computer's name.");
		const deviceInput = device.createEl("input", { cls: "gw-lib-filter", attr: { type: "text", placeholder: this.plugin.deviceName() } });
		deviceInput.value = s.deviceName;
		deviceInput.addEventListener("change", () => {
			s.deviceName = deviceInput.value.trim();
			void this.plugin.saveSettings();
		});
	}

	private renderClaudeSettings(parent: HTMLElement): void {
		const s = this.plugin.settings;
		const steps = parent.createEl("ol", { cls: "gw-setup-steps" });
		for (const step of CLAUDE_SETUP) {
			const item = steps.createEl("li");
			item.createEl("strong", { text: `${step.title}. ` });
			item.appendText(step.detail);
		}
		const detected = this.plugin.claudeExecutable();
		const status = this.settingField(
			parent,
			"Connection",
			detected ? "Uses the Claude account Claude Code is signed in with on this computer." : "Claude Code wasn't found. Install it, then run claude in a terminal and type /login.",
		);
		const check = status.createEl("button", { cls: "gw-lib-btn", text: "Check connection", attr: { type: "button" } });
		check.addEventListener("click", () => {
			check.setAttr("disabled", "true");
			check.setText("Checking…");
			void this.plugin.checkClaudeCode().then(
				(r) => {
					if (r.models?.length) this.plugin.claudeModels = r.models;
					new Notice(r.message);
					void this.renderSettings();
				},
				(err: unknown) => {
					check.removeAttribute("disabled");
					check.setText("Check connection");
					new Notice(err instanceof Error ? err.message : String(err));
				},
			);
		});
		const exe = this.settingField(
			parent,
			"Claude Code executable",
			detected && !s.claudePath ? `Found at ${detected}. Leave empty to auto-detect.` : "Leave empty to auto-detect claude.",
		);
		const exeInput = exe.createEl("input", { cls: "gw-lib-filter", attr: { type: "text", placeholder: detected ?? "claude" } });
		exeInput.value = s.claudePath;
		exeInput.addEventListener("change", () => {
			s.claudePath = exeInput.value.trim();
			void this.plugin.saveSettings();
		});
		const models = this.plugin.claudeModels;
		const model = this.settingField(parent, "Model", models.length ? "Models your Claude plan can use." : "Claude Code's default, or an alias like sonnet or opus.");
		if (models.length) {
			const modelSelect = model.createEl("select", { cls: "gw-lib-filter" });
			modelSelect.createEl("option", { text: "Default", attr: { value: "" } });
			for (const item of models) {
				const value = item.value === "default" ? "" : item.value;
				modelSelect.createEl("option", { text: item.displayName || item.value, attr: { value } });
			}
			if (s.claudeModel && !models.some((item) => item.value === s.claudeModel || (item.value === "default" && !s.claudeModel))) {
				modelSelect.createEl("option", { text: s.claudeModel, attr: { value: s.claudeModel } });
			}
			modelSelect.value = s.claudeModel;
			modelSelect.addEventListener("change", () => {
				s.claudeModel = modelSelect.value;
				void this.plugin.saveSettings();
			});
		} else {
			const modelInput = model.createEl("input", { cls: "gw-lib-filter", attr: { type: "text", placeholder: "Default" } });
			modelInput.value = s.claudeModel;
			modelInput.addEventListener("change", () => {
				s.claudeModel = modelInput.value.trim();
				void this.plugin.saveSettings();
			});
		}
	}

	private renderAppearance(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "gw-lib-section" });
		section.createEl("h3", { text: "Appearance" });
		section.createDiv({
			cls: "gw-lib-help",
			text: "Obsidian follows this vault's theme, buttons included. Dark and Light are Groundwork's own palettes.",
		});
		const row = section.createDiv({ cls: "gw-appearance" });
		const choices: [GroundworkAppearance, string][] = [
			["obsidian", "Obsidian"],
			["dark", "Dark"],
			["light", "Light"],
		];
		for (const [id, label] of choices) {
			const button = row.createEl("button", {
				cls: `gw-lib-btn gw-appearance-btn${this.plugin.settings.appearance === id ? " is-on" : ""}`,
				text: label,
				attr: { type: "button" },
			});
			button.addEventListener("click", () => {
				if (this.plugin.settings.appearance === id) return;
				this.plugin.settings.appearance = id;
				this.applyAppearance(id);
				void this.plugin.saveSettings().then(() => this.renderSettings());
			});
		}
	}

	private viewTab(parent: HTMLElement, id: PrimaryScreen, label: string, path: string, shortLabel: string): HTMLElement {
		const on = id === this.pane.screen;
		const button = parent.createEl("button", {
			cls: `gw-view${on ? " is-on" : ""}`,
			attr: {
				type: "button",
				role: "tab",
				"aria-selected": on ? "true" : "false",
				title: label,
				"aria-label": label,
				"data-testid": `gw-${id}-tab`,
			},
		});
		const icon = button.createSpan({ cls: "gw-view-icon" });
		const svg = icon.ownerDocument.win.createSvg("svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		svg.setAttribute("aria-hidden", "true");
		appendSvgFragment(svg, path);
		icon.append(svg);
		button.createSpan({ cls: "gw-view-label", text: shortLabel });
		this.registerDomEvent(button, "click", () => void this.showScreen(id));
		return button;
	}

	private syncPaneLayout(): void {
		const flags = paneRootClasses(this.pane);
		const root = this.contentEl;
		root.toggleClass("is-map", flags.isMap);
		root.toggleClass("is-goals", flags.isGoals);
		root.toggleClass("is-library", flags.isLibrary);
		root.toggleClass("is-settings", flags.isSettings);
		root.toggleClass("is-flashcards", flags.isFlashcards);
		const screen = this.pane.screen;
		for (const [id, button] of this.uiTabs) {
			button.toggleClass("is-on", id === screen);
			button.setAttr("aria-selected", id === screen ? "true" : "false");
		}
		for (const [button, on] of [
			[this.uiLibraryBtn, flags.isLibrary],
			[this.uiSettingsBtn, flags.isSettings],
		] as const) {
			button?.toggleClass("is-active", on);
			button?.setAttr("aria-pressed", on ? "true" : "false");
		}
		this.renderHeader();
	}

	/** Switch the visible screen without drawing it. Leaving a screen drops what it was holding. */
	private enterScreen(screen: GroundworkScreen): void {
		const from = this.pane.screen;
		if (from !== screen) {
			if (from === "flashcards") this.flashPane?.hide();
			else if (from === "library") this.uiLibraryEl?.empty();
			else if (from === "settings") this.uiSettingsEl?.empty();
		}
		this.pane = setPaneScreen(this.pane, screen);
		this.syncPaneLayout();
	}

	private async showScreen(screen: GroundworkScreen): Promise<void> {
		const same = this.pane.screen === screen;
		this.enterScreen(screen);
		if (screen !== "learn") this.uiInputEl?.blur();
		if (screen === "map") await this.renderMap();
		else if (screen === "goals") await this.renderGoals();
		else if (screen === "flashcards") {
			if (!same) await this.ensureFlashcardsVisible();
		} else if (screen === "library") {
			this.paintLibraryShell();
			await this.renderLibrary();
		} else if (screen === "settings") await this.renderSettingsScreen();
		else this.uiInputEl?.focus();
	}

	private toggleUtilityScreen(utility: UtilityScreen): void {
		void this.showScreen(toggleUtility(this.pane, utility).screen);
	}

	/** Redraw what is on screen after the vault or the pinned goal changed. A study session in progress is kept. */
	private refreshOpenScreen(): void {
		if (this.pane.screen === "map") void this.renderMap();
		else if (this.pane.screen === "goals") void this.renderGoals();
		else if (this.pane.screen === "flashcards") this.flashPane?.refresh();
	}

	private learnerInitial(): string {
		const name = this.plugin.deviceName().trim();
		return (name[0] ?? "Y").toUpperCase();
	}

	private assistantSlot(wrap: HTMLElement): HTMLElement {
		const row = wrap.createDiv({ cls: "gw-msg-row" });
		const avatar = row.createDiv({ cls: "gw-avatar" });
		mountMark(avatar, "gw-avatar-mark");
		const body = row.createDiv({ cls: "gw-msg-body" });
		body.createDiv({ cls: "gw-who", text: "Groundwork" });
		return body.createDiv({ cls: "gw-msg gw-assistant markdown-rendered" });
	}

	private vaultConceptStarted(status: string): boolean {
		return status !== "unassessed";
	}

	private async renderMap(): Promise<void> {
		const token = ++this.screenToken;
		const store = this.plugin.store;
		try {
			const goals = await store.goals();
			const pinnedId = this.uiGoalEl?.value?.trim() ?? "";
			if (token !== this.screenToken) return;
			if (!pinnedId) {
				const concepts = await store.concepts();
				if (token !== this.screenToken) return;
				const started = [...concepts.values()].filter((concept) => this.vaultConceptStarted(concept.stats.status));
				const startedIds = new Set(started.map((concept) => concept.id));
				const graphConcepts = started.map((concept) => ({
					id: concept.id,
					title: concept.title,
					prerequisites: concept.prerequisites.filter((prior) => startedIds.has(prior)),
				}));
				const graph = layoutGroundworkGraph(graphConcepts);
				const data = buildFromGroundwork(
					started.map((concept) => ({ id: concept.id, title: concept.title, status: concept.stats.status })),
					graph,
					{ studyHints: true, attentionRings: false },
				);
				renderStartedVaultMap(this.uiMapEl, data, this.mapOptions());
				return;
			}
			const picked = goals.find((goal) => goal.id === pinnedId);
			if (!picked) {
				renderMapPane(this.uiMapEl, null, {
					...this.mapOptions(),
					emptyMessage: "Choose a goal in the Working on menu to see its concept map.",
				});
				return;
			}
			this.selectedGoalId = picked.id;
			const report = await store.goalReport(picked.id);
			const timing = await store.goalTiming(report);
			const next = report.goal.status === "done" ? undefined : ((await store.chooseNext(report)) ?? report.next);
			const concepts = await store.concepts();
			if (token !== this.screenToken) return;
			const inGoal = new Set(report.goal.nodes);
			const outside = [...concepts.values()]
				.filter((concept) => !inGoal.has(concept.id))
				.map((concept) => ({
					id: concept.id,
					title: concept.title,
					prerequisites: concept.prerequisites,
					status: concept.stats.status,
					current: concept.stats.current,
					inGoal: false as const,
				}));
			const nextId = report.nodes.find((node) => node.title === next?.concept)?.id;
			const model = buildConceptMap({
				goalTitle: report.goal.title,
				dueLabel: report.goal.due ? formatDue(report.goal.due) : undefined,
				nodes: [
					...report.nodes.map((node) => ({
						id: node.id,
						title: node.title,
						prerequisites: node.prerequisites,
						status: node.status,
						current: node.current,
						inGoal: true as const,
						role: node.role,
					})),
					...outside,
				],
				weights: timing.weights,
				nextId,
				builtIds: report.goal.built,
			});
			if (token !== this.screenToken) return;
			renderMapPane(this.uiMapEl, model, this.mapOptions(report.goal.title));
		} catch (err) {
			if (token !== this.screenToken) return;
			this.uiMapEl.empty();
			this.uiMapEl.createDiv({ cls: "gw-error", text: err instanceof Error ? err.message : String(err) });
		}
	}

	private mapOptions(goalTitle?: string) {
		return {
			goalTitle,
			onStudy: (title: string, move: StudyMove) => void this.studyConcept(title, move),
			onOpenGoals: () => void this.showScreen("goals"),
		};
	}

	private async renderGoals(): Promise<void> {
		const token = ++this.screenToken;
		const store = this.plugin.store;
		try {
			const goals = await store.goals();
			const boards: GoalBoardView[] = [];
			for (const goal of goals) {
				const report = await store.goalReport(goal.id);
				const timing = await store.goalTiming(report);
				const next = report.goal.status === "done" ? undefined : ((await store.chooseNext(report)) ?? report.next);
				boards.push(toBoard(report, timing, next));
			}
			if (token !== this.screenToken) return;
			boards.sort((a, b) => Number(a.status === "paused") - Number(b.status === "paused") || Number(a.status === "done") - Number(b.status === "done") || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
			const pinnedId = this.uiGoalEl?.value?.trim() ?? "";
			const activeGoalId = pinnedId && boards.some((board) => board.id === pinnedId) ? pinnedId : null;
			renderGoalsPane(this.uiGoalsEl, boards, activeGoalId, {
				onFocusWorkingGoal: () => {
					this.uiGoalEl?.focus();
					this.uiGoalEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
				},
				onSelect: (id) => {
					const board = boards.find((item) => item.id === id);
					const pin = board && board.status !== "done" ? store.setWorkingGoal(id) : Promise.resolve(null);
					void pin.then(() => this.refreshGoalSelect()).catch((err: unknown) => new Notice(err instanceof Error ? err.message : String(err)));
				},
				onCreate: () => this.promptGoal(),
				onDue: (id, due) => {
					void store.setGoalDue(id, due).then(() => this.refreshGoalSelect()).catch((err: unknown) => new Notice(err instanceof Error ? err.message : String(err)));
				},
				onWeight: (id, title, weight) => {
					const board = boards.find((item) => item.id === id);
					if (!board) return;
					const weights = board.concepts.map((concept) => ({ title: concept.title, weight: concept.title === title ? weight : Math.max(1, Math.round(concept.weight)) }));
					void store.setGoalWeights(id, weights).then(() => this.refreshGoalSelect()).catch((err: unknown) => new Notice(err instanceof Error ? err.message : String(err)));
				},
				onOpen: (title, action) => void this.studyConcept(title, action),
				onPractice: () => void this.practiceThisGoal(),
				onMap: () => void this.showScreen("map"),
				onDocs: () => this.askForDocs(),
				onDelete: (id) => void this.deleteListedGoal(id),
			});
		} catch (err) {
			if (token !== this.screenToken) return;
			this.uiGoalsEl.empty();
			this.uiGoalsEl.createDiv({ cls: "gw-error", text: err instanceof Error ? err.message : String(err) });
		}
	}

	/** Open the tutor on a concept title from obsidian://groundwork?concept=… */
	async studyConceptFromDeepLink(title: string): Promise<void> {
		const safe = title.trim();
		if (!safe) return;
		await this.studyConcept(safe, "start");
	}

	private async studyConcept(title: string, action: StudyMove): Promise<void> {
		if (this.agent?.busy) {
			new Notice("Groundwork: wait for the tutor to finish, then ask again.");
			return;
		}
		if (this.selectedGoalId) {
			try {
				await this.plugin.store.setWorkingGoal(this.selectedGoalId);
			} catch {
				// A finished goal stays unpinned.
			}
		}
		await this.refreshGoalSelect();
		await this.showScreen("learn");
		void this.submit(STUDY_REQUEST[action](title));
	}

	private async practiceThisGoal(): Promise<void> {
		if (this.selectedGoalId) {
			try {
				await this.plugin.store.setWorkingGoal(this.selectedGoalId);
			} catch {
				// A finished goal stays unpinned.
			}
		}
		await this.showScreen("learn");
		this.startPracticeTest();
	}

	/** Open a deck in the Flashcards tab. */
	private async studyDeck(deckId: string): Promise<void> {
		this.flashPane?.study(deckId);
		await this.showScreen("flashcards");
	}

	private promptGoal(): void {
		void this.showScreen("learn");
		this.uiInputEl.value = "I want a new goal: ";
		this.autoGrow();
		this.uiInputEl.focus();
	}

	private askForDocs(): void {
		void this.showScreen("learn");
		new Notice("Attach a study guide or syllabus with the paperclip. The tutor can reweight this goal from it.");
		this.uiInputEl?.focus();
	}

	private screenToken = 0;

	private settingField(parent: HTMLElement, name: string, desc: string): HTMLElement {
		const field = parent.createDiv({ cls: "gw-field" });
		field.createDiv({ cls: "gw-setting-name", text: name });
		field.createDiv({ cls: "gw-setting-desc", text: desc });
		return field;
	}

	private settingToggle(parent: HTMLElement, name: string, desc: string, value: boolean, onChange: (on: boolean) => void): void {
		const row = parent.createDiv({ cls: "gw-setting-row" });
		const text = row.createDiv();
		text.createDiv({ cls: "gw-setting-name", text: name });
		text.createDiv({ cls: "gw-setting-desc", text: desc });
		const label = row.createEl("label", { cls: "gw-switch" });
		const input = label.createEl("input", { type: "checkbox", attr: { "aria-label": name } });
		input.checked = value;
		label.createSpan({ cls: "gw-switch-ui" });
		input.addEventListener("change", () => onChange(input.checked));
	}

	private renderVaultReset(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "gw-lib-section gw-danger" });
		section.createEl("h3", { text: "Reset learning vault" });
		section.createDiv({
			cls: "gw-lib-help",
			text: "Deletes every goal, concept, chat, session, exam plan, practice test, quiz record, and flashcard on your account, and restores the learner profile. Flashcard notes in your write folders are removed. Other files in this Obsidian vault stay.",
		});
		const start = section.createEl("button", { cls: "gw-lib-btn is-danger", text: "Reset learning vault", attr: { type: "button" } });
		const box = section.createDiv({ cls: "gw-reset-box" });
		box.hide();
		box.createDiv({ cls: "gw-lib-help", text: "Type reset to confirm. This cannot be undone from here." });
		const row = box.createDiv({ cls: "gw-reset-row" });
		const input = row.createEl("input", {
			cls: "gw-lib-filter",
			attr: { type: "text", placeholder: "Reset", "aria-label": "Type reset to confirm", autocomplete: "off", spellcheck: "false" },
		});
		const go = row.createEl("button", { cls: "gw-lib-btn is-danger", text: "Reset everything", attr: { type: "button" } });
		go.disabled = true;
		const cancel = row.createEl("button", { cls: "gw-lib-btn", text: "Cancel", attr: { type: "button" } });
		start.addEventListener("click", () => {
			start.hide();
			box.show();
			input.focus();
		});
		input.addEventListener("input", () => {
			go.disabled = input.value.trim().toLowerCase() !== "reset";
		});
		cancel.addEventListener("click", () => {
			input.value = "";
			go.disabled = true;
			box.hide();
			start.show();
		});
		go.addEventListener("click", () => {
			if (input.value.trim().toLowerCase() !== "reset" || go.dataset.busy === "1") return;
			go.dataset.busy = "1";
			go.disabled = true;
			void this.resetLearningVault().finally(() => {
				go.dataset.busy = "";
				if (go.isConnected) go.disabled = input.value.trim().toLowerCase() !== "reset";
			});
		});
	}

	private async resetLearningVault(): Promise<void> {
		if (this.agent?.busy || [...this.asideAgents.values()].some((agent) => agent.busy)) {
			new Notice("Groundwork: wait for the tutor to finish, then reset the vault.");
			return;
		}
		this.dropAgent();
		this.dropAsides();
		try {
			await this.plugin.store.resetVault();
			await removeFlashcardMirrors(this.plugin.store.context, this.plugin.settings.writeFolders);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
			return;
		}
		this.learnerDraft = null;
		this.conceptQuery = "";
		const now = new Date().toISOString();
		this.record = { id: `chat-${Date.now().toString(36)}`, title: "New session", created: now, updated: now, messages: [], items: [] };
		this.session = { id: this.record.id };
		this.renderAll();
		await this.refreshGoalSelect();
		if (this.pane.screen === "settings") await this.renderSettings();
		new Notice("Learning vault reset. Files in this Obsidian vault are still there.");
	}

	private libraryEmpty(parent: HTMLElement, detail: string, action: string, run: () => void): void {
		const box = parent.createDiv({ cls: "gw-lib-empty-block" });
		box.createDiv({ cls: "gw-lib-empty", text: detail });
		const btn = box.createEl("button", { cls: "gw-lib-btn mod-cta", text: action, attr: { type: "button" } });
		btn.addEventListener("click", run);
	}

	/** Screen title. Library and Settings are screens like the center tabs, so there is nothing to close. */
	private panelHead(parent: HTMLElement, title: string, subtitle: string): void {
		const head = parent.createDiv({ cls: "gw-library-head" });
		const titles = head.createDiv({ cls: "gw-library-titles" });
		titles.createEl("h2", { cls: "gw-library-title", text: title });
		titles.createDiv({ cls: "gw-library-sub", text: subtitle });
	}

	private libraryRow(parent: HTMLElement, title: string, meta: string): HTMLElement {
		const row = parent.createDiv({ cls: "gw-lib-row" });
		const main = row.createDiv({ cls: "gw-lib-main" });
		main.createDiv({ cls: "gw-lib-name", text: title });
		main.createDiv({ cls: "gw-lib-meta", text: meta });
		row.createDiv({ cls: "gw-lib-actions" });
		return row;
	}

	private libraryButton(row: HTMLElement, label: string, onClick: () => void, primary = false): HTMLElement {
		const actions = row.querySelector<HTMLElement>(".gw-lib-actions") as HTMLElement;
		const button = actions.createEl("button", {
			cls: `gw-lib-btn${primary ? " is-primary" : ""}`,
			text: label,
			attr: { type: "button" },
		});
		button.addEventListener("click", onClick);
		return button;
	}

	private libraryDelete(row: HTMLElement, run: () => Promise<void>): void {
		const button = this.libraryButton(row, "Delete", () => {
			if (button.dataset.armed !== "1") {
				button.dataset.armed = "1";
				button.setText("Delete?");
				button.addClass("is-danger");
				window.setTimeout(() => {
					if (button.dataset.armed !== "1") return;
					button.dataset.armed = "";
					button.setText("Delete");
					button.removeClass("is-danger");
				}, 3000);
				return;
			}
			button.dataset.armed = "";
			void run();
		});
	}

	private async workToward(id: string): Promise<void> {
		try {
			await this.plugin.store.setWorkingGoal(id);
			await this.refreshGoalSelect();
			await this.showScreen("learn");
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		}
	}

	private async quizGoal(id: string, title: string, pin: boolean): Promise<void> {
		if (this.agent?.busy) {
			new Notice("Groundwork: wait for the tutor to finish, then ask for a quiz.");
			return;
		}
		if (pin) {
			try {
				await this.plugin.store.setWorkingGoal(id);
				await this.refreshGoalSelect();
			} catch (err) {
				new Notice(err instanceof Error ? err.message : String(err));
				return;
			}
		}
		await this.showScreen("learn");
		void this.submit(pin ? `Quiz me on ${title}.` : `Quiz me on the concepts in ${title}.`);
	}

	private async quizConcept(title: string): Promise<void> {
		if (this.agent?.busy) {
			new Notice("Groundwork: wait for the tutor to finish, then ask for a quiz.");
			return;
		}
		await this.showScreen("learn");
		void this.submit(STUDY_REQUEST.quiz(title));
	}

	private async deleteListedConcept(title: string): Promise<void> {
		try {
			await this.plugin.store.deleteConcept(title);
			await this.refreshGoalSelect();
			if (this.pane.screen === "library") await this.renderLibrary();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		}
	}

	private async deleteListedGoal(id: string): Promise<void> {
		try {
			await this.plugin.store.deleteGoal(id);
			await this.refreshGoalSelect();
			if (this.pane.screen === "library") await this.renderLibrary();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		}
	}

	private async deleteListedChat(id: string): Promise<void> {
		const current = this.record?.id === id;
		try {
			await this.plugin.store.deleteChat(id);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
			return;
		}
		if (current) {
			this.newSession();
			return;
		}
		if (this.pane.screen === "library") await this.renderLibrary();
	}

	// ── margin threads ──────────────────────────────────────────────────

	/** A lesson element that margin threads can attach to. */
	private turn(anchor?: string): HTMLElement {
		const wrap = this.uiMessagesEl.createDiv({ cls: "gw-turn" });
		if (anchor) wrap.dataset.anchor = anchor;
		return wrap;
	}

	private setupMargin(root: HTMLElement): void {
		this.uiSelectMenu = root.createDiv({ cls: "gw-select-menu" });
		this.uiAskBtn = this.uiSelectMenu.createEl("button", { cls: "gw-ask-btn", attr: { type: "button", "aria-label": "Ask about the highlighted text in the margin" } });
		setIcon(this.uiAskBtn.createSpan({ cls: "gw-ask-btn-icon" }), "message-square-plus");
		this.uiAskBtn.createSpan({ text: "Ask about this" });
		this.uiVizBtn = this.uiSelectMenu.createEl("button", { cls: "gw-viz-btn", attr: { type: "button", "aria-label": "Make me a visualization of the highlighted text" } });
		setIcon(this.uiVizBtn.createSpan({ cls: "gw-viz-btn-icon" }), "image");
		this.uiVizBtn.createSpan({ text: "Make me a visualization" });
		this.uiSelectMenu.hide();
		// Keep the text selection alive while clicking a button.
		this.registerDomEvent(this.uiSelectMenu, "mousedown", (e) => e.preventDefault());
		this.registerDomEvent(this.uiAskBtn, "click", () => {
			const sel = this.selection;
			this.hideAskButton();
			if (sel) this.openAside(sel.anchor, sel.quote);
		});
		this.registerDomEvent(this.uiVizBtn, "click", () => {
			const sel = this.selection;
			this.hideAskButton();
			if (sel) void this.requestFigure(sel.anchor, sel.quote);
		});

		// Drags often end outside the chat, and selections can come from double-clicks or the keyboard,
		// so watch the document rather than mouseup on the messages alone.
		const doc = this.contentEl.doc;
		let dragging = false;
		let settle = 0;
		this.registerDomEvent(this.uiMessagesEl, "mousedown", (e) => {
			dragging = true;
			if (!(e.target instanceof Node) || !this.uiSelectMenu.contains(e.target)) this.hideAskButton();
		});
		const release = () => {
			if (!dragging) return;
			dragging = false;
			window.setTimeout(() => this.onSelectionEnd(), 0);
		};
		// mouseup is not delivered after some drag-selections in Obsidian, and text drag-and-drop ends with dragend.
		this.registerDomEvent(doc, "pointerup", release);
		this.registerDomEvent(doc, "mouseup", release);
		this.registerDomEvent(doc, "dragend", release);
		this.registerDomEvent(doc, "selectionchange", () => {
			if (dragging) return;
			window.clearTimeout(settle);
			settle = window.setTimeout(() => this.onSelectionEnd(), 200);
		});
		this.registerDomEvent(this.uiMessagesEl, "scroll", () => this.hideAskButton());
		// MathJax glyphs can't be text-selected, so a click on a formula selects the whole thing.
		this.registerDomEvent(this.uiMessagesEl, "click", (e) => {
			const math = mathOf(e.target as Node);
			if (!math || (e.target as Element).closest("button, a, .gw-asides, .gw-figures, .gw-free-editor")) return;
			const sel = this.contentEl.win.getSelection();
			if (!sel || (!sel.isCollapsed && !sel.getRangeAt(0).intersectsNode(math))) return;
			const range = this.contentEl.doc.createRange();
			range.selectNode(math);
			sel.removeAllRanges();
			sel.addRange(range);
			this.onSelectionEnd();
		});

		const ro = new ResizeObserver(() => this.updateMarginMode());
		ro.observe(this.uiMessagesEl);
		this.register(() => ro.disconnect());
		this.register(() => this.clearHighlights());
	}

	private onSelectionEnd(): void {
		const sel = this.contentEl.win.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) return this.hideAskButton();
		const range = sel.getRangeAt(0).cloneRange();
		const elOf = (n: Node) => (n.instanceOf(Element) ? n : n.parentElement);
		const start = elOf(range.startContainer);
		const end = elOf(range.endContainer);
		if (start?.closest(".gw-asides, .gw-figures, .gw-select-menu, textarea, input, .gw-free-editor, .gw-symbols-drawer")) return this.hideAskButton();
		const startTurn = start?.closest(".gw-turn[data-anchor]");
		const endTurn = end?.closest(".gw-turn[data-anchor]");
		const turn = startTurn ?? endTurn;
		if (!turn?.instanceOf(HTMLElement) || !this.uiMessagesEl.contains(turn)) return this.hideAskButton();
		// A drag that slips into the margin stays on the paragraph under the pointer.
		clampSelection(range, turn);
		expandToMath(range);
		const quote = rangeText(range).trim();
		if (quote.length < 2) return this.hideAskButton();
		const anchor = turn.getAttribute("data-anchor");
		if (!anchor) return this.hideAskButton();
		this.selection = { anchor, quote: quote.slice(0, 1200) };
		this.markPicked(mathIn(turn, range));

		const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
		const line = rects[rects.length - 1] ?? range.getBoundingClientRect();
		this.uiSelectMenu.show();
		const host = this.uiSelectMenu.offsetParent instanceof HTMLElement ? this.uiSelectMenu.offsetParent : this.contentEl;
		const box = host.getBoundingClientRect();
		const pos = menuPosition(
			{ left: box.left, top: box.top, width: box.width, height: box.height },
			{ left: line.left, top: line.top, width: line.width, bottom: line.bottom },
			this.uiSelectMenu.offsetWidth || 320,
			this.uiSelectMenu.offsetHeight || 36,
		);
		this.uiSelectMenu.style.left = `${pos.left}px`;
		this.uiSelectMenu.style.top = `${pos.top}px`;
	}

	private hideAskButton(): void {
		this.uiSelectMenu?.hide();
		this.selection = null;
		this.markPicked([]);
	}

	/** Selection color doesn't paint MathJax glyphs, so selected formulas get a class instead. */
	private markPicked(els: HTMLElement[]): void {
		for (const el of this.pickedMath) el.removeClass("is-picked");
		for (const el of els) el.addClass("is-picked");
		this.pickedMath = els;
	}

	/** One hint thread per quiz. The first click asks for a nudge; later clicks just focus it. */
	private openHint(anchor: string, quiz: PreparedQuiz): void {
		this.hintKeys.set(quiz.id, hintBrief(quiz));
		const existing = (this.record.asides ?? []).find((t) => t.kind === "hint" && t.hintFor === quiz.id && !t.resolved);
		if (existing) {
			(this.asideCards.get(existing.id) ?? this.mountAside(existing))?.focus();
			return;
		}
		const thread: AsideThread = {
			id: `h_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
			anchor,
			quote: quiz.question,
			created: new Date().toISOString(),
			messages: [],
			shared: 0,
			kind: "hint",
			hintFor: quiz.id,
		};
		(this.record.asides ??= []).push(thread);
		const card = this.mountAside(thread);
		if (!card) {
			this.record.asides = this.record.asides.filter((t) => t !== thread);
			return;
		}
		card.focus();
		if (!this.uiMessagesEl.hasClass("has-margin")) card.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
		void this.askAside(thread, "Give me a hint.");
	}

	private openAside(anchor: string, quote: string): void {
		const thread: AsideThread = {
			id: `m_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
			anchor,
			quote,
			created: new Date().toISOString(),
			messages: [],
			shared: 0,
		};
		(this.record.asides ??= []).push(thread);
		this.contentEl.win.getSelection()?.removeAllRanges();
		const card = this.mountAside(thread);
		card?.focus();
		if (card && !this.uiMessagesEl.hasClass("has-margin")) card.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}

	private mountAside(thread: AsideThread): AsideCard | null {
		if (thread.resolved || this.asideCards.has(thread.id)) return null;
		const wrap = this.uiMessagesEl.querySelector<HTMLElement>(`.gw-turn[data-anchor="${CSS.escape(thread.anchor)}"]`);
		if (!wrap) return null;
		const list = (wrap.querySelector<HTMLElement>(":scope > .gw-asides")) ?? wrap.createDiv({ cls: "gw-asides" });
		const card = new AsideCard(list, thread, (el, md) => this.renderMd(el, md), {
			send: (text) => void this.askAside(thread, text),
			resolve: () => this.resolveAside(thread),
			hover: (on) => this.setActiveHighlight(on ? thread.id : null),
		});
		this.asideCards.set(thread.id, card);
		this.updateMarginMode();
		this.scheduleHighlights();
		return card;
	}

	private resolveAside(thread: AsideThread): void {
		const card = this.asideCards.get(thread.id);
		const list = card?.el.parentElement;
		card?.el.remove();
		if (list && !list.childElementCount) list.remove();
		this.asideCards.delete(thread.id);
		this.asideAgents.get(thread.id)?.close?.();
		this.asideAgents.delete(thread.id);
		if (thread.messages.length) thread.resolved = true;
		else this.record.asides = (this.record.asides ?? []).filter((t) => t !== thread);
		this.updateMarginMode();
		this.scheduleHighlights();
		if (thread.messages.length) void this.persist();
	}

	private async askAside(thread: AsideThread, text: string): Promise<void> {
		const run = this.deliverAside(thread, text);
		if (thread.kind === "hint") this.hintInflight.set(thread.id, run);
		try {
			await run;
		} finally {
			if (this.hintInflight.get(thread.id) === run) this.hintInflight.delete(thread.id);
		}
	}

	private async hintsSettled(quizIds: string[]): Promise<void> {
		const ids = new Set(quizIds);
		const jobs: Promise<void>[] = [];
		for (const t of this.record.asides ?? []) {
			if (t.kind !== "hint" || !t.hintFor || !ids.has(t.hintFor)) continue;
			const job = this.hintInflight.get(t.id);
			if (job) jobs.push(job);
		}
		if (jobs.length) await Promise.all(jobs);
	}

	private async deliverAside(thread: AsideThread, text: string): Promise<void> {
		const card = this.asideCards.get(thread.id);
		if (!card) return;
		const hint = thread.kind === "hint";
		const earlier = thread.messages.slice();
		thread.messages.push({ role: "user", text, at: new Date().toISOString() });
		await card.renderMessage("user", text);
		const reply = card.startReply();

		if (!this.plugin.signedIn()) {
			this.asideAgents.get(thread.id)?.close?.();
			this.asideAgents.delete(thread.id);
		}
		let agent = this.asideAgents.get(thread.id);
		const fresh = !agent;
		agent ??= (await this.makeAsideAgent(hint ? "hint" : "margin", thread.id)) ?? undefined;
		if (!agent) {
			const runtime = this.plugin.runtime();
			const detail = runtime.detail ?? this.plugin.providerLabel().setup?.detail ?? "Sign in on the Groundwork website, then choose Open Obsidian.";
			reply.finish(detail);
			if (!this.plugin.signedIn()) {
				new Notice(detail);
				window.open(accountSignInUrl());
			}
			return;
		}
		this.asideAgents.set(thread.id, agent);

		const others = (this.record.asides ?? []).filter((t) => t !== thread);
		const lesson = transcript(this.record.items, others);
		const prompt = !fresh
			? text
			: hint
				? hintOpening({ lesson, quote: thread.quote, brief: thread.hintFor ? this.hintKeys.get(thread.hintFor) : undefined, earlier }, text)
				: asideOpening({ lesson, quote: thread.quote, pendingQuiz: this.waitingQuiz ?? testAsQuiz(this.waitingTest), earlier }, text);
		let error: string | undefined;
		try {
			await agent.send(prompt, (e) => {
				if (e.type === "text_delta") reply.append(e.text);
				else if (e.type === "error") error = e.message;
			});
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		const answer = reply.finish(error ? `Couldn't answer: ${error}` : undefined);
		if (answer) thread.messages.push({ role: "assistant", text: answer, at: new Date().toISOString() });
		await this.persist();
	}

	private async makeAsideAgent(kind: "margin" | "hint", threadId: string): Promise<TutorSession | null> {
		await this.plugin.refreshTutorRoute();
		if (!this.plugin.signedIn()) return null;
		const tools = TOOLS.filter((t) => ASIDE_TOOL_NAMES.includes(t.name));
		const access = folderAccessFrom(this.plugin.settings);
		const system = [kind === "hint" ? HINT_PROMPT : ASIDE_PROMPT, fileAccessGuidance(access, "read")].join("\n\n");
		const session: SessionInfo = { id: kind === "hint" ? `${this.record.id}-hint-${threadId}` : `${this.record.id}-margin` };
		const store = this.plugin.store;
		const runtime = this.plugin.runtime();
		if (runtime.runtime === "setup") return null;
		if (runtime.runtime === "claude") {
			const cfg = this.plugin.claudeCodeConfig();
			return cfg ? new ClaudeCodeSession({ ...cfg, store, tools, system, session, access, grader: this.plugin.answerGrader() }) : null;
		}
		const p = runtime.runtime === "proxy" ? this.plugin.makeGroundworkProvider() : new DemoAsideProvider();
		return new AgentSession({ provider: p, store, tools, system, session, maxSteps: 8, access, grader: this.plugin.answerGrader() });
	}

	private dropAsides(): void {
		for (const a of this.asideAgents.values()) a.close?.();
		this.asideAgents.clear();
		this.asideCards.clear();
		this.asideRanges.clear();
		this.hintKeys.clear();
		this.hintInflight.clear();
		for (const a of this.figureAgents.values()) a.close?.();
		this.figureAgents.clear();
		this.figureCards.clear();
		this.figureRanges.clear();
		this.pendingFigures = [];
		this.clearHighlights();
	}

	/** ToolUI hook: margin questions and hint chats the main tutor hasn't seen, marked as shared. */
	marginNotes(): string | undefined {
		const threads = this.record?.asides ?? [];
		const margin = marginNotes(threads);
		const hints = hintNotes(threads);
		if (!margin && !hints) return undefined;
		for (const t of threads) {
			const n = margin?.shared.get(t.id) ?? hints?.shared.get(t.id);
			if (n !== undefined) t.shared = n;
		}
		return [margin?.text, hints?.text].filter(Boolean).join("\n\n");
	}

	private updateMarginMode(): void {
		const el = this.uiMessagesEl;
		if (!el) return;
		el.style.setProperty("--gw-side", `${Math.floor(sideRoom(el.clientWidth))}px`);
		const flags = gutterFlags(el.clientWidth, this.figureCards.size, this.asideCards.size);
		el.toggleClass("has-figures", flags.figures);
		el.toggleClass("has-margin", flags.margin);
		this.layoutAsides();
		this.layoutFigures();
	}

	/** In margin mode, start each thread stack level with its highlight. */
	private layoutAsides(): void {
		const margin = this.uiMessagesEl.hasClass("has-margin");
		this.uiMessagesEl.querySelectorAll(".gw-asides").forEach((node) => {
			const list = node as HTMLElement;
			const wrap = list.parentElement!;
			let top = Infinity;
			if (margin) {
				const base = wrap.getBoundingClientRect().top;
				list.querySelectorAll(".gw-aside").forEach((c) => {
					const r = this.asideRanges.get((c as HTMLElement).dataset.thread ?? "");
					if (r) top = Math.min(top, r.getBoundingClientRect().top - base);
				});
			}
			list.style.top = margin && Number.isFinite(top) ? `${Math.max(0, Math.round(top) - 6)}px` : "";
		});
	}

	/** In figure mode, start each stack level with its highlight. */
	private layoutFigures(): void {
		const side = this.uiMessagesEl.hasClass("has-figures");
		this.uiMessagesEl.querySelectorAll(".gw-figures").forEach((node) => {
			const list = node as HTMLElement;
			const wrap = list.parentElement!;
			let top = Infinity;
			if (side) {
				const base = wrap.getBoundingClientRect().top;
				list.querySelectorAll(".gw-figure").forEach((c) => {
					const r = this.figureRanges.get((c as HTMLElement).dataset.figure ?? "");
					if (r) top = Math.min(top, r.getBoundingClientRect().top - base);
				});
			}
			list.style.top = side && Number.isFinite(top) ? `${Math.max(0, Math.round(top) - 6)}px` : "";
		});
	}

	private scheduleHighlights(): void {
		if (!this.asideCards.size && !this.asideRanges.size && !this.figureCards.size && !this.figureRanges.size) return;
		if (this.highlightFrame) return;
		this.highlightFrame = window.requestAnimationFrame(() => {
			this.highlightFrame = 0;
			this.refreshHighlights();
		});
	}

	private refreshHighlights(): void {
		this.asideRanges.clear();
		for (const [id, card] of this.asideCards) {
			const turn = card.el.closest(".gw-turn");
			const msg = turn instanceof HTMLElement ? passageOf(turn) : null;
			const r = msg ? findQuoteRange(msg, card.thread.quote) : null;
			if (r) this.asideRanges.set(id, r);
		}
		const api = highlightApi();
		api?.registry.set("gw-aside", new api.Highlight(...this.asideRanges.values()));
		this.markMath("is-quoted", [...this.asideRanges.values()]);
		this.figureRanges.clear();
		for (const [id, card] of this.figureCards) {
			const quote = card.el.dataset.quote;
			const turn = card.el.closest(".gw-turn");
			const msg = turn instanceof HTMLElement ? passageOf(turn) : null;
			const r = quote && msg ? findQuoteRange(msg, quote) : null;
			if (r) this.figureRanges.set(id, r);
		}
		api?.registry.set("gw-figure", new api.Highlight(...this.figureRanges.values()));
		this.markMath("is-figured", [...this.figureRanges.values()]);
		this.layoutAsides();
		this.layoutFigures();
	}

	private setActiveFigure(id: string | null): void {
		for (const [fid, card] of this.figureCards) card.setActive(fid === id);
		const api = highlightApi();
		const r = id ? this.figureRanges.get(id) : undefined;
		api?.registry.set("gw-figure-active", new api.Highlight(...(r ? [r] : [])));
		this.markMath("is-figured-active", r ? [r] : []);
	}

	private setActiveHighlight(id: string | null): void {
		for (const [tid, card] of this.asideCards) card.setActive(tid === id);
		const api = highlightApi();
		const r = id ? this.asideRanges.get(id) : undefined;
		api?.registry.set("gw-aside-active", new api.Highlight(...(r ? [r] : [])));
		this.markMath("is-quoted-active", r ? [r] : []);
	}

	private clearHighlights(): void {
		const api = highlightApi();
		api?.registry.delete("gw-aside");
		api?.registry.delete("gw-aside-active");
		api?.registry.delete("gw-figure");
		api?.registry.delete("gw-figure-active");
		this.markMath("is-quoted", []);
		this.markMath("is-quoted-active", []);
		this.markMath("is-figured", []);
		this.markMath("is-figured-active", []);
	}

	// ── figures ─────────────────────────────────────────────────────────

	showFigure(figure: SessionFigure): void {
		this.pendingFigures.push(figure);
		(this.record.figures ??= []).push(figureForChat(figure));
	}

	private attachPendingFigures(wrap: HTMLElement): void {
		const anchor = wrap.dataset.anchor;
		if (!anchor || !this.pendingFigures.length) return;
		const batch = this.pendingFigures.splice(0);
		for (const figure of batch) {
			this.rememberAnchor(figure, anchor);
			this.mountFigure(figure, wrap);
			void this.plugin.store.writeFile(figureFile(figure.id), `${JSON.stringify(figure)}\n`);
		}
	}

	private flushOrphanFigures(): void {
		if (!this.pendingFigures.length) return;
		const turns = [...this.uiMessagesEl.querySelectorAll(".gw-turn[data-anchor]")] as HTMLElement[];
		const last = turns[turns.length - 1];
		if (last) {
			this.attachPendingFigures(last);
			return;
		}
		while (this.pendingFigures.length) {
			const figure = this.pendingFigures.shift()!;
			this.rememberAnchor(figure, `figure:${figure.id}`);
			const wrap = this.turn(figure.anchor);
			wrap.createDiv({ cls: "gw-msg gw-assistant", text: figure.caption || figure.title });
			this.mountFigure(figure, wrap);
			void this.plugin.store.writeFile(figureFile(figure.id), `${JSON.stringify(figure)}\n`);
		}
	}

	private mountSavedFigure(figure: SessionFigure): void {
		if (this.figureCards.has(figure.id)) return;
		let wrap = this.uiMessagesEl.querySelector<HTMLElement>(`.gw-turn[data-anchor="${CSS.escape(figure.anchor)}"]`);
		if (!wrap) {
			figure.anchor = figure.anchor || `figure:${figure.id}`;
			wrap = this.turn(figure.anchor);
			wrap.createDiv({ cls: "gw-msg gw-assistant", text: figure.caption || figure.title });
		}
		const card = this.mountFigure(figure, wrap);
		if (figure.hasMedia && !figure.media) void this.hydrateFigure(figure.id, card);
	}

	private mountFigure(figure: FigureCardModel, wrap: HTMLElement): FigureCard {
		const list = (wrap.querySelector<HTMLElement>(":scope > .gw-figures")) ?? wrap.createDiv({ cls: "gw-figures" });
		if (list.parentElement === wrap && wrap.firstElementChild !== list) wrap.prepend(list);
		let card!: FigureCard;
		card = new FigureCard(list, figure, {
			toggle: (collapsed) => {
				const saved = (this.record.figures ?? []).find((item) => item.id === card.el.dataset.figure);
				if (!saved) return;
				saved.collapsed = collapsed;
				void this.writeFigureCollapsed(saved.id, collapsed);
				void this.persist();
			},
			download: (model) => {
				if (model.media) downloadFigure(this.contentEl.doc, model.title, model.svg ?? "", model.media);
				else if (model.svg) downloadFigure(this.contentEl.doc, model.title, model.svg);
			},
			dismiss: () => this.dismissFigure(card.el.dataset.figure ?? figure.id),
			hover: (on) => this.setActiveFigure(on ? (card.el.dataset.figure ?? null) : null),
		});
		this.figureCards.set(figure.id, card);
		this.updateMarginMode();
		this.scheduleHighlights();
		return card;
	}

	private dismissFigure(id: string): void {
		const card = this.figureCards.get(id);
		const list = card?.el.parentElement;
		card?.el.remove();
		if (list && !list.childElementCount) list.remove();
		this.figureCards.delete(id);
		this.figureAgents.get(id)?.close?.();
		this.figureAgents.delete(id);
		this.record.figures = (this.record.figures ?? []).filter((figure) => figure.id !== id);
		this.updateMarginMode();
		this.scheduleHighlights();
	}

	private async requestFigure(anchor: string, quote: string): Promise<void> {
		const wrap = this.uiMessagesEl.querySelector<HTMLElement>(`.gw-turn[data-anchor="${CSS.escape(anchor)}"]`);
		if (!wrap) return;
		const pendingId = `pending_${Date.now().toString(36)}`;
		const card = this.mountFigure({ id: pendingId, title: "Making a visualization", quote, pending: true }, wrap);
		const stateHolder = card;
		this.contentEl.win.getSelection()?.removeAllRanges();
		if (!this.uiMessagesEl.hasClass("has-figures")) card.el.scrollIntoView({ block: "nearest", behavior: "smooth" });

		if (!this.plugin.signedIn()) {
			const detail = this.plugin.runtime().detail ?? "Sign in on the Groundwork website, then choose Open Obsidian.";
			stateHolder.update({ id: pendingId, title: "Couldn't draw that", quote, error: detail });
			window.open(accountSignInUrl());
			return;
		}
		const agent = await this.makeFigureAgent(pendingId);
		if (!agent) {
			const detail = this.plugin.runtime().detail ?? "The tutor isn't ready to draw yet.";
			stateHolder.update({ id: pendingId, title: "Couldn't draw that", quote, error: detail });
			return;
		}
		this.figureAgents.set(pendingId, agent);
		let text = "";
		let error: string | undefined;
		try {
			const lesson = transcript(this.record.items, this.record.asides, this.record.figures);
			await agent.send(figureOpening(lesson, quote), (e) => {
				if (e.type === "text_delta") text += e.text;
				else if (e.type === "error") error = e.message;
			});
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			this.figureAgents.delete(pendingId);
		}
		if (error && !text.trim()) {
			stateHolder.update({ id: pendingId, title: "Couldn't draw that", quote, error: "The tutor couldn't draw a figure for that passage." });
			return;
		}
		try {
			const figure = await saveFigure(this.plugin.store, figureFromModelText(text), {
				quote,
				anchor,
				sessionId: this.record.id,
			});
			(this.record.figures ??= []).push(figureForChat(figure));
			this.figureCards.delete(pendingId);
			this.figureCards.set(figure.id, card);
			card.update(figure);
			this.scheduleHighlights();
			await this.persist();
		} catch (err) {
			const message = err instanceof Error ? err.message : "The tutor couldn't draw a figure for that passage.";
			card.update({ id: pendingId, title: "Couldn't draw that", quote, error: message });
		}
	}

	private async makeFigureAgent(id: string): Promise<TutorSession | null> {
		await this.plugin.refreshTutorRoute();
		if (!this.plugin.signedIn()) return null;
		const access = folderAccessFrom(this.plugin.settings);
		const session: SessionInfo = { id: `${this.record.id}-figure-${id}` };
		const store = this.plugin.store;
		const runtime = this.plugin.runtime();
		if (runtime.runtime === "setup") return null;
		const fetchTool = toolByName("fetch_public");
		const tools = fetchTool ? [fetchTool] : [];
		if (runtime.runtime === "claude") {
			const cfg = this.plugin.claudeCodeConfig();
			return cfg ? new ClaudeCodeSession({ ...cfg, store, tools, system: FIGURE_PROMPT, session, access, grader: this.plugin.answerGrader() }) : null;
		}
		const provider = runtime.runtime === "proxy" ? this.plugin.makeGroundworkProvider() : new DemoFigureProvider();
		return new AgentSession({ provider, store, tools, system: FIGURE_PROMPT, session, maxSteps: 6, access, grader: this.plugin.answerGrader() });
	}

	private rememberAnchor(figure: SessionFigure, anchor: string): void {
		figure.anchor = anchor;
		const saved = (this.record.figures ?? []).find((item) => item.id === figure.id);
		if (saved) saved.anchor = anchor;
	}

	private async hydrateFigure(id: string, card: FigureCard): Promise<void> {
		try {
			const saved = JSON.parse(await this.plugin.store.io.read(figureFile(id))) as SessionFigure;
			if (!saved.media) return;
			const light = (this.record.figures ?? []).find((item) => item.id === id);
			card.update({ ...(light ?? saved), media: saved.media, svg: saved.svg, credit: saved.credit });
		} catch {
			/* the plate still shows the title */
		}
	}

	private async writeFigureCollapsed(id: string, collapsed: boolean): Promise<void> {
		try {
			const saved = JSON.parse(await this.plugin.store.io.read(figureFile(id))) as SessionFigure;
			saved.collapsed = collapsed;
			await this.plugin.store.writeFile(figureFile(id), `${JSON.stringify(saved)}\n`);
		} catch {
			const light = (this.record.figures ?? []).find((item) => item.id === id);
			if (light) await this.plugin.store.writeFile(figureFile(id), `${JSON.stringify({ ...light, collapsed })}\n`);
		}
	}

	private markMath(cls: string, ranges: Range[]): void {
		this.uiMessagesEl?.querySelectorAll(`.math.${cls}`).forEach((el) => el.removeClass(cls));
		for (const r of ranges) {
			const root = r.commonAncestorContainer.instanceOf(HTMLElement) ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
			if (root) for (const el of mathIn(root, r)) el.addClass(cls);
		}
	}

	// ── persistence ─────────────────────────────────────────────────────

	private persist(record = this.record): Promise<void> {
		const job = this.persistQueue.then(() => this.writeChat(record));
		this.persistQueue = job.catch(() => undefined);
		return job;
	}

	private async writeChat(record: ChatRecord | undefined): Promise<void> {
		if (!record) return;
		record.updated = new Date().toISOString();
		const store = this.plugin.store;
		const asides = (record.asides ?? []).filter((t) => t.messages.length);
		await store.writeFile(`${PATHS.chats}/${record.id}.json`, JSON.stringify({ ...record, asides, messages: withoutFileData(record.messages) }));
		if (record.notePath) {
			const path = record.notePath;
			const existing = (await store.io.exists(path)) ? await store.io.read(path) : "";
			const { frontmatter, body } = parseNote(existing);
			const fm = { ...frontmatter, type: "session", date: record.created.slice(0, 10), chat: record.id, tags: ["groundwork/session"] };
			const base = body.trim() ? body : `# ${record.title}\n`;
			await store.writeFile(path, serializeNote(fm, setSection(base, "Transcript", transcript(record.items, record.asides, record.figures))));
		}
		if (this.record?.id === record.id) this.renderHeader();
	}

	private async listChats(): Promise<ChatRecord[]> {
		return (await this.plugin.store.listChats()) as ChatRecord[];
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
		case "suggest_what_to_study":
			return "brain";
		case "set_goal":
		case "get_goal":
		case "set_goal_status":
		case "set_working_goal":
		case "merge_goals":
		case "ingest_exam_materials":
		case "get_exam_plan":
			return "git-fork";
		case "save_session_summary":
			return "notebook-pen";
		case "grade_answer":
		case "grade_practice_test":
			return "clipboard-check";
		case "update_learner_profile":
			return "user";
		case "WebSearch":
		case "WebFetch":
		case "fetch_public":
			return "globe";
		case "show_figure":
			return "image";
		default:
			return "check";
	}
}

/** An open practice test, shaped like a waiting quiz so margin answers don't give answers away. */
function testAsQuiz(test: PreparedTest | null): Pick<PreparedQuiz, "question" | "options" | "concept"> | undefined {
	if (!test) return undefined;
	return {
		concept: `practice test "${test.title}"`,
		question: test.questions.map((q, i) => `${i + 1}. ${q.question}`).join("\n"),
		options: test.questions.flatMap((q) => q.options),
	};
}

function iconForFile(path: string): string {
	switch (fileKind(path).kind) {
		case "image":
			return "image";
		case "pdf":
			return "file-text";
		case "text":
			return "file-code";
		default:
			return "file";
	}
}

function safeName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim() || `Attachment ${timestamp()}`;
}

function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class VaultFileModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly readFolders: string[],
		private readonly onPick: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder("Attach a file from a folder Groundwork can read");
	}
	getItems(): TFile[] {
		const first = this.readFolders[0];
		const inFirst = (f: TFile) => (first && (f.path === first || f.path.startsWith(`${first}/`)) ? 0 : 1);
		return filesUnderFolderRoots(this.app, this.readFolders)
			.filter((f) => f.extension !== "md" && fileKind(f.path).kind !== "other" && pathInsideAny(f.path, this.readFolders))
			.sort((a, b) => inFirst(a) - inFirst(b) || b.stat.mtime - a.stat.mtime);
	}
	getItemText(file: TFile): string {
		return file.path;
	}
	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

/** CSS Custom Highlight API: marks ranges without touching the rendered DOM. */
function highlightApi(): { registry: Map<string, unknown>; Highlight: new (...ranges: Range[]) => unknown } | null {
	const registry = (CSS as { highlights?: Map<string, unknown> }).highlights;
	const Highlight = (window as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
	return registry && Highlight ? { registry, Highlight } : null;
}

const VERDICT = { correct: "✅ Correct", partial: "🟡 Partly right", incorrect: "❌ Incorrect", dont_know: "❔ I don't know" } as const;

const quote = (s: string) => s.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");

/** One question, the learner's answer, and (once graded) the feedback, as blockquote lines. */
function quizLines(quiz: PreparedQuiz, response: QuizResponse, grade?: QuizGrade): string[] {
	const lines = [...(quiz.purpose ? [`> *Why: ${quiz.purpose.replace(/\n/g, " ")}*`, ">"] : []), quote(quiz.question), ">"];
	if (quiz.format === "free") {
		lines.push(response.dontKnow ? "> **Answer:** —" : `> **Answer:**`, ...(response.dontKnow ? [] : [quote(response.text ?? "")]));
		if (grade?.feedback) lines.push(">", `> **Feedback:** ${grade.feedback.replace(/\n/g, " ")}`);
		if (quiz.reference) lines.push(">", "> **Model answer:**", quote(quiz.reference));
	} else {
		lines.push(
			...quiz.options.map((o, i) => {
				const mark = grade && quiz.correct.includes(o.value) ? " ✓" : response.selected.includes(o.value) ? (grade ? " ✗" : " ←") : "";
				return `> ${letter(i)}. ${o.label}${mark}`;
			}),
		);
	}
	if (response.dontKnow) lines.push(">", `> *I don't know — ${familiarityLabel(response.familiarity).toLowerCase()}*`);
	if (response.note) lines.push(">", `> *Note:* ${response.note}`);
	if (grade && quiz.explanation) lines.push(">", quote(quiz.explanation));
	return lines;
}

function hintBrief(quiz: PreparedQuiz): HintBrief {
	return {
		concept: quiz.concept,
		question: quiz.question,
		format: quiz.format,
		details: quiz.details,
		multiSelect: quiz.multiSelect,
		options: quiz.format === "free" ? undefined : quiz.options.map((o) => ({ label: o.label, correct: quiz.correct.includes(o.value) })),
		reference: quiz.reference,
		rubric: quiz.rubric,
		explanation: quiz.explanation,
	};
}

function transcript(items: DisplayItem[], asides: AsideThread[] = [], figures: SessionFigure[] = []): string {
	const out: string[] = [];
	const seen = new Set<string>();
	const figuresAt = (anchor: string) => {
		for (const figure of figures) {
			if (figure.anchor !== anchor) continue;
			seen.add(figure.id);
			const lines = [`> [!example]- Figure: ${figure.title} (${figure.kind})`];
			if (figure.caption) lines.push(">", `> ${figure.caption.replace(/\n/g, " ")}`);
			lines.push(">", `> Saved on the account as \`${figureFile(figure.id)}\`.`);
			out.push(lines.join("\n"), "");
		}
	};
	const margin = (anchor: string) => {
		for (const t of asides) {
			if (t.anchor !== anchor || !t.messages.length) continue;
			const label = t.quote.replace(/\s+/g, " ").trim().slice(0, 160);
			const lines = [t.kind === "hint" ? `> [!tip]- Hint on “${label}”` : `> [!comment]- Margin question on “${label}”`];
			for (const m of t.messages) lines.push(">", m.role === "user" ? `> **You:** ${m.text.replace(/\n/g, " ")}` : quote(m.text));
			out.push(lines.join("\n"), "");
		}
	};
	items.forEach((item, i) => {
		const anchor = item.kind === "quiz" ? `quiz:${item.quiz.id}` : item.kind === "test" ? `test:${item.test.id}` : `item:${i}`;
		render(item);
		figuresAt(anchor);
		margin(anchor);
	});
	for (const figure of figures) {
		if (!seen.has(figure.id)) figuresAt(figure.anchor || figure.id);
	}
	return out.join("\n");

	function render(item: DisplayItem): void {
		switch (item.kind) {
			case "user": {
				const files = (item.attachments ?? []).map((p) => (fileKind(p).kind === "image" ? `![[${p}]]` : `[[${p}]]`));
				out.push(`> [!quote] You\n${quote([...files, item.text].filter(Boolean).join("\n\n"))}`, "");
				break;
			}
			case "assistant":
				out.push(demoteHeadings(item.text), "");
				break;
			case "quiz": {
				const { quiz, grade, response, after } = item;
				const lines = [`> [!question]- ${VERDICT[grade.outcome]} · ${quiz.kind} quiz on [[${quiz.concept}]] (level ${quiz.difficulty})`, ...quizLines(quiz, response, grade)];
				if (after) lines.push(">", `> Now **${Math.round(after.current * 100)}%** (${after.status})`);
				out.push(lines.join("\n"), "");
				break;
			}
			case "test": {
				const { test, response, report } = item;
				const head = report
					? `> [!example]- 📝 Practice test: ${test.title} · ${Math.round(report.percent * 100)}% (${report.earned}/${report.possible})${report.notePath ? ` · [[${report.notePath.replace(/\.md$/, "")}|evaluation]]` : ""}`
					: `> [!example]- 📝 Practice test: ${test.title} · submitted, grading`;
				const lines = [head, ...(test.objective ? [`> **What this measures:** ${test.objective.replace(/\n/g, " ")}`] : [])];
				test.questions.forEach((q, i) => {
					const r = report?.results[i];
					const answer = r?.response ?? response.answers[q.id] ?? { dontKnow: true, selected: [], note: "Left blank" };
					lines.push(">", `> **Q${i + 1}${r ? ` ${VERDICT[r.outcome]}` : ""}** · [[${q.concept}]] (level ${q.difficulty})`, ...quizLines(q, answer, r?.grade));
				});
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
			case "continue":
				out.push(`> [!note] ${item.text}`, "");
				break;
		}
	}
}
