import { setIcon } from "obsidian";
import { MathField } from "./math-field";
import {
	FAMILIARITY_LABELS,
	familiarityLabel,
	gradeQuiz,
	letter,
	MAX_FAMILIARITY,
	type AskInput,
	type AskResponse,
	type ConceptStats,
	type PreparedQuiz,
	type PreparedTest,
	type QuizGrade,
	type QuizResponse,
	type TestReport,
	type TestResponse,
} from "@groundwork/core";

export type RenderMd = (el: HTMLElement, markdown: string) => Promise<void>;

export interface AnsweredQuiz {
	response: QuizResponse;
	grade: QuizGrade;
	before?: ConceptStats;
	after?: ConceptStats;
}

const KIND_LABEL = { probe: "Probe", check: "Check", review: "Review", explain: "Explain", test: "Test" } as const;
const DEFAULT_FAMILIARITY = 1;

interface QuizCardOptions {
	/** Inside a practice test: numbered, no per-question submit or feedback until the whole test is graded. */
	testNumber?: number;
	onChange?: () => void;
}

export class QuizCard {
	readonly el: HTMLElement;
	private selected = new Set<string>();
	private dontKnow = false;
	private familiarity = DEFAULT_FAMILIARITY;
	private optionEls = new Map<string, HTMLElement>();
	private dontKnowEl!: HTMLButtonElement;
	private dontKnowLabelEl!: HTMLElement;
	private familiarityEl!: HTMLElement;
	private sliderEl!: HTMLInputElement;
	private familiarityTextEl!: HTMLElement;
	private freeEl?: HTMLElement;
	private field?: MathField;
	private answerEl?: HTMLElement;
	private noteEl!: HTMLTextAreaElement;
	private submitEl?: HTMLButtonElement;
	private feedbackEl!: HTMLElement;
	private mastery?: HTMLElement;
	private done = false;
	private readonly inTest: boolean;

	constructor(
		parent: HTMLElement,
		private readonly quiz: PreparedQuiz,
		private readonly renderMd: RenderMd,
		private readonly onSubmit?: (r: QuizResponse) => void,
		private readonly opts: QuizCardOptions = {},
	) {
		this.inTest = opts.testNumber !== undefined;
		const free = quiz.format === "free";
		this.el = parent.createDiv({ cls: `gw-card gw-quiz${this.inTest ? " gw-test-question" : ""}${free ? " gw-quiz-free" : ""}` });
		this.el.tabIndex = 0;
		const head = this.el.createDiv({ cls: "gw-card-head" });
		if (this.inTest) {
			head.createSpan({ cls: "gw-card-kind", text: `Question ${opts.testNumber}` });
		} else {
			setIcon(head.createSpan({ cls: "gw-card-icon" }), free ? "pencil-line" : "circle-help");
			head.createSpan({ cls: "gw-card-kind", text: `${KIND_LABEL[quiz.kind] ?? "Check"} quiz` });
		}
		head.createSpan({ cls: "gw-pill", text: quiz.concept });
		head.createSpan({ cls: "gw-pill gw-pill-muted", text: `level ${quiz.difficulty}/5` });
		if (free) head.createSpan({ cls: "gw-pill gw-pill-muted", text: "written answer" });
		else if (quiz.multiSelect) head.createSpan({ cls: "gw-pill gw-pill-muted", text: "select all that apply" });

		if (quiz.purpose) {
			const why = this.el.createDiv({ cls: "gw-purpose" });
			setIcon(why.createSpan({ cls: "gw-purpose-icon" }), "compass");
			void this.renderMd(why.createDiv({ cls: "gw-purpose-text" }), quiz.purpose);
		}
		void this.renderMd(this.el.createDiv({ cls: "gw-quiz-question" }), quiz.question);
		if (quiz.details) void this.renderMd(this.el.createDiv({ cls: "gw-quiz-details" }), quiz.details);

		const list = this.el.createDiv({ cls: "gw-options" });
		if (free) this.buildFreeInput(list);
		else {
			quiz.options.forEach((o, i) => {
				const btn = list.createEl("button", { cls: "gw-option" });
				btn.createSpan({ cls: "gw-option-key", text: letter(i) });
				void this.renderMd(btn.createDiv({ cls: "gw-option-label" }), o.label);
				btn.addEventListener("click", () => this.toggle(o.value));
				this.optionEls.set(o.value, btn);
			});
		}
		this.dontKnowEl = list.createEl("button", { cls: "gw-option gw-option-dontknow" });
		this.dontKnowEl.createSpan({ cls: "gw-option-key", text: "?" });
		this.dontKnowLabelEl = this.dontKnowEl.createDiv({ cls: "gw-option-label", text: "I don't know" });
		this.dontKnowEl.addEventListener("click", () => this.toggleDontKnow());
		this.buildFamiliarity(list);

		const footer = this.el.createDiv({ cls: "gw-card-footer" });
		this.noteEl = footer.createEl("textarea", {
			cls: "gw-note",
			attr: { rows: "1", placeholder: "Optional note: what you were thinking or unsure about" },
		});
		if (!this.inTest) {
			this.submitEl = footer.createEl("button", { cls: "mod-cta gw-submit", text: free ? "Submit answer" : "Check answer" });
			this.submitEl.disabled = true;
			this.submitEl.addEventListener("click", () => this.submit());
		}
		this.feedbackEl = this.el.createDiv({ cls: "gw-feedback" });

		this.el.addEventListener("keydown", (e) => {
			if (this.done || e.target === this.noteEl) return;
			if (e.target instanceof Node && this.answerEl?.contains(e.target)) {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !this.inTest) {
					this.submit();
					e.preventDefault();
				}
				return;
			}
			if (e.target instanceof Node && this.freeEl?.contains(e.target)) return;
			if (e.target === this.sliderEl) return;
			const n = e.key.toLowerCase();
			const idx = /^[1-9]$/.test(n) ? Number(n) - 1 : /^[a-i]$/.test(n) ? n.charCodeAt(0) - 97 : -1;
			if (!free && idx >= 0 && idx < quiz.options.length) {
				this.toggle(quiz.options[idx].value);
				e.preventDefault();
			} else if (n === "?" || n === "0") {
				this.toggleDontKnow();
				e.preventDefault();
			} else if (e.key === "Enter" && !this.inTest) {
				this.submit();
				e.preventDefault();
			}
		});

		if (!onSubmit && !this.inTest) this.lock();
	}

	private buildFreeInput(list: HTMLElement): void {
		this.freeEl = list.createDiv({ cls: "gw-free" });
		this.field = new MathField(this.freeEl, this.renderMd, {
			placeholder: "Write your answer. $x^2$ renders inline, a $$ line displays a formula.",
			hint: this.inTest ? "Formulas render as you type. Click one to edit it." : "Formulas render as you type. Click one to edit it · Ctrl/Cmd+Enter to submit",
			onChange: () => {
				if (this.dontKnow && this.field!.value.trim()) this.dontKnow = false;
				this.refresh();
			},
		});
		this.answerEl = this.field.editor;
	}

	private buildFamiliarity(list: HTMLElement): void {
		this.familiarityEl = list.createDiv({ cls: "gw-familiarity" });
		const top = this.familiarityEl.createDiv({ cls: "gw-familiarity-top" });
		top.createSpan({ cls: "gw-familiarity-q", text: "How familiar does it feel?" });
		this.familiarityTextEl = top.createSpan({ cls: "gw-familiarity-value" });
		this.sliderEl = this.familiarityEl.createEl("input", {
			cls: "gw-familiarity-slider",
			attr: { type: "range", min: "0", max: String(MAX_FAMILIARITY), step: "1", "aria-label": "How familiar the question feels" },
		});
		this.sliderEl.value = String(this.familiarity);
		this.sliderEl.addEventListener("input", () => this.setFamiliarity(Number(this.sliderEl.value)));
		const ticks = this.familiarityEl.createDiv({ cls: "gw-familiarity-ticks" });
		FAMILIARITY_LABELS.forEach((label, i) => {
			const t = ticks.createEl("button", { cls: "gw-familiarity-tick", text: label });
			t.addEventListener("click", () => this.setFamiliarity(i));
		});
		this.setFamiliarity(this.familiarity);
	}

	private setFamiliarity(n: number): void {
		if (this.done) return;
		this.familiarity = Math.min(MAX_FAMILIARITY, Math.max(0, Math.round(n)));
		this.sliderEl.value = String(this.familiarity);
		this.familiarityTextEl.setText(familiarityLabel(this.familiarity));
		this.familiarityEl.querySelectorAll(".gw-familiarity-tick").forEach((el, i) => el.toggleClass("is-active", i === this.familiarity));
		this.opts.onChange?.();
	}

	focus(): void {
		if (this.field) this.field.focus();
		else this.el.focus({ preventScroll: true });
	}

	private toggle(value: string): void {
		if (this.done) return;
		this.dontKnow = false;
		if (this.quiz.multiSelect) {
			if (this.selected.has(value)) this.selected.delete(value);
			else this.selected.add(value);
		} else {
			this.selected = new Set([value]);
		}
		this.refresh();
		if (!this.quiz.multiSelect) this.submitEl?.focus();
	}

	private toggleDontKnow(): void {
		if (this.done) return;
		this.dontKnow = !this.dontKnow;
		if (this.dontKnow) this.selected.clear();
		this.refresh();
		if (this.dontKnow) this.sliderEl.focus();
	}

	private hasAnswer(): boolean {
		if (this.dontKnow) return true;
		return this.quiz.format === "free" ? !!this.field?.value.trim() : this.selected.size > 0;
	}

	private refresh(): void {
		for (const [v, el] of this.optionEls) el.toggleClass("is-selected", this.selected.has(v));
		this.dontKnowEl.toggleClass("is-selected", this.dontKnow);
		this.familiarityEl.toggleClass("is-open", this.dontKnow);
		this.freeEl?.toggleClass("is-muted", this.dontKnow);
		if (this.submitEl) this.submitEl.disabled = !this.hasAnswer();
		this.el.toggleClass("is-answered", this.hasAnswer());
		this.opts.onChange?.();
	}

	/** The current answer, or null if the learner hasn't answered. */
	getResponse(): QuizResponse | null {
		if (!this.hasAnswer()) return null;
		const note = this.noteEl.value.trim() || undefined;
		if (this.dontKnow) return { dontKnow: true, selected: [], familiarity: this.familiarity, note };
		if (this.quiz.format === "free") return { dontKnow: false, selected: [], text: this.field!.value.trim(), note };
		return { dontKnow: false, selected: [...this.selected], note };
	}

	private submit(): void {
		if (this.done) return;
		const response = this.getResponse();
		if (!response) return;
		if (this.quiz.format === "free" && !response.dontKnow) this.showPending(response);
		else this.showAnswer({ response, grade: gradeQuiz(this.quiz, response) });
		this.onSubmit?.(response);
	}

	lock(): void {
		this.done = true;
		this.el.addClass("is-done");
		for (const el of this.optionEls.values()) (el as HTMLButtonElement).disabled = true;
		this.dontKnowEl.disabled = true;
		this.sliderEl.disabled = true;
		this.familiarityEl.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
		this.noteEl.disabled = true;
		this.submitEl?.remove();
		if (!this.noteEl.value) this.noteEl.remove();
		this.field?.disable();
	}

	/** Restore a response into the controls (history, or a test being graded). */
	private restore(response: QuizResponse): void {
		this.selected = new Set(response.selected);
		this.dontKnow = response.dontKnow;
		if (response.familiarity !== undefined) this.familiarity = response.familiarity;
		this.sliderEl.value = String(this.familiarity);
		this.familiarityTextEl.setText(familiarityLabel(this.familiarity));
		this.familiarityEl.querySelectorAll(".gw-familiarity-tick").forEach((el, i) => el.toggleClass("is-active", i === this.familiarity));
		if (response.note) this.noteEl.value = response.note;
		if (this.field) this.field.value = response.text ?? "";
		this.refresh();
		if (response.dontKnow) this.dontKnowLabelEl.setText(`I don't know · ${familiarityLabel(this.familiarity)}`);
	}

	/** Swap the editor for the rendered answer once it is submitted. */
	private freezeFreeAnswer(response: QuizResponse): void {
		if (!this.freeEl) return;
		this.freeEl.empty();
		if (response.dontKnow) {
			this.freeEl.remove();
			this.freeEl = undefined;
			return;
		}
		this.freeEl.addClass("is-submitted");
		this.freeEl.createDiv({ cls: "gw-free-label", text: "Your answer" });
		void this.renderMd(this.freeEl.createDiv({ cls: "gw-free-answer markdown-rendered" }), response.text ?? "");
		this.field?.destroy();
		this.field = undefined;
		this.answerEl = undefined;
	}

	/** A free-response answer waiting for the tutor's grade. */
	showPending(response: QuizResponse, message = "Submitted. Your tutor is grading it…"): void {
		this.restore(response);
		this.lock();
		this.freezeFreeAnswer(response);
		this.feedbackEl.empty();
		if (message) this.feedbackEl.createDiv({ cls: "gw-verdict is-pending", text: message });
	}

	/** Show graded feedback. Also used to re-render answered quizzes from history. */
	showAnswer(a: AnsweredQuiz): void {
		this.restore(a.response);
		this.lock();
		this.freezeFreeAnswer(a.response);
		for (const [v, el] of this.optionEls) {
			const isKey = this.quiz.correct.includes(v);
			const picked = a.response.selected.includes(v);
			el.toggleClass("is-correct", isKey);
			el.toggleClass("is-wrong", picked && !isKey);
			const key = el.querySelector(".gw-option-key");
			if (key && (isKey || picked)) key.textContent = isKey ? "✓" : "✗";
		}
		this.feedbackEl.empty();
		const verdict = this.feedbackEl.createDiv({ cls: "gw-verdict" });
		const outcome = a.grade.outcome;
		verdict.addClass(outcome === "correct" ? "is-correct" : outcome === "partial" ? "is-partial" : outcome === "dont_know" ? "is-unknown" : "is-wrong");
		verdict.setText(
			outcome === "correct" ? "Correct" : outcome === "partial" ? "Partly right" : outcome === "dont_know" ? "Honest gap — that's useful" : "Not quite",
		);
		if (a.grade.feedback) void this.renderMd(this.feedbackEl.createDiv({ cls: "gw-grade-feedback" }), a.grade.feedback);
		if (a.grade.misconception) {
			this.feedbackEl.createDiv({ cls: "gw-misconception", text: `Likely belief: ${a.grade.misconception}` });
		}
		if (this.quiz.format === "free" && this.quiz.reference) {
			const ref = this.feedbackEl.createDiv({ cls: "gw-reference" });
			ref.createDiv({ cls: "gw-free-label", text: "Model answer" });
			void this.renderMd(ref.createDiv({ cls: "markdown-rendered" }), this.quiz.reference);
		}
		if (this.quiz.explanation) void this.renderMd(this.feedbackEl.createDiv({ cls: "gw-explanation" }), this.quiz.explanation);
		if (this.inTest) return;
		this.mastery = this.feedbackEl.createDiv({ cls: "gw-mastery" });
		if (a.after) this.showRecorded(a.before, a.after);
	}

	showRecorded(before: ConceptStats | undefined, after: ConceptStats): void {
		if (!this.mastery) return;
		this.mastery.empty();
		const from = before && before.attempts ? Math.round(before.current * 100) : null;
		const to = Math.round(after.current * 100);
		const label = this.mastery.createDiv({ cls: "gw-mastery-label" });
		label.createSpan({ text: this.quiz.concept });
		label.createSpan({ cls: `gw-status gw-status-${after.status}`, text: after.status });
		label.createSpan({ cls: "gw-mastery-delta", text: from === null ? `${to}%` : `${from}% → ${to}%` });
		const bar = this.mastery.createDiv({ cls: "gw-bar" });
		const fill = bar.createDiv({ cls: `gw-bar-fill gw-status-${after.status}` });
		fill.style.width = `${Math.max(3, to)}%`;
	}
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtPoints = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

export class TestCard {
	readonly el: HTMLElement;
	private cards: QuizCard[] = [];
	private progressEl!: HTMLElement;
	private clockEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private reportEl!: HTMLElement;
	private submitEl?: HTMLButtonElement;
	private started = Date.now();
	private timer: number | null = null;
	private confirming = false;
	private done = false;

	constructor(
		parent: HTMLElement,
		private readonly test: PreparedTest,
		private readonly renderMd: RenderMd,
		private readonly onSubmit?: (r: TestResponse) => void,
		private readonly openNote?: (path: string) => void,
	) {
		this.el = parent.createDiv({ cls: "gw-card gw-test" });
		const head = this.el.createDiv({ cls: "gw-card-head" });
		setIcon(head.createSpan({ cls: "gw-card-icon" }), "clipboard-check");
		head.createSpan({ cls: "gw-card-kind", text: "Practice test" });
		head.createSpan({ cls: "gw-pill gw-pill-muted", text: `${test.questions.length} question${test.questions.length === 1 ? "" : "s"}` });
		if (test.timeLimitMinutes) head.createSpan({ cls: "gw-pill gw-pill-muted", text: `${test.timeLimitMinutes} min` });
		this.el.createEl("h3", { cls: "gw-test-title", text: test.title });
		if (test.objective) {
			const why = this.el.createDiv({ cls: "gw-purpose" });
			setIcon(why.createSpan({ cls: "gw-purpose-icon" }), "compass");
			void this.renderMd(why.createDiv({ cls: "gw-purpose-text" }), test.objective);
		}
		if (test.instructions) void this.renderMd(this.el.createDiv({ cls: "gw-quiz-details" }), test.instructions);

		const bar = this.el.createDiv({ cls: "gw-test-bar" });
		this.progressEl = bar.createSpan({ cls: "gw-test-progress" });
		this.clockEl = bar.createSpan({ cls: "gw-test-clock" });
		this.reportEl = this.el.createDiv({ cls: "gw-test-report" });

		const list = this.el.createDiv({ cls: "gw-test-questions" });
		test.questions.forEach((q, i) => {
			this.cards.push(new QuizCard(list, q, renderMd, undefined, { testNumber: i + 1, onChange: () => this.refresh() }));
		});

		const footer = this.el.createDiv({ cls: "gw-card-footer gw-test-footer" });
		this.statusEl = footer.createDiv({ cls: "gw-test-status" });
		if (onSubmit) {
			this.submitEl = footer.createEl("button", { cls: "mod-cta gw-submit", text: "Submit test" });
			this.submitEl.addEventListener("click", () => this.submit());
			this.timer = window.setInterval(() => this.tick(), 1000);
			this.tick();
		} else {
			this.lock();
		}
		this.refresh();
	}

	focus(): void {
		this.cards[0]?.focus();
	}

	private answeredCount(): number {
		return this.cards.filter((c) => c.getResponse()).length;
	}

	private refresh(): void {
		if (this.done) return;
		const n = this.answeredCount();
		this.progressEl.setText(`${n}/${this.cards.length} answered`);
		if (this.confirming && n === this.cards.length) this.resetConfirm();
	}

	private tick(): void {
		if (!this.el.isConnected && this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
			return;
		}
		const elapsed = (Date.now() - this.started) / 1000;
		const limit = this.test.timeLimitMinutes ? this.test.timeLimitMinutes * 60 : undefined;
		if (limit === undefined) {
			this.clockEl.setText(`${fmtClock(elapsed)} elapsed`);
			return;
		}
		const left = limit - elapsed;
		this.clockEl.toggleClass("is-over", left < 0);
		this.clockEl.toggleClass("is-low", left >= 0 && left < 120);
		this.clockEl.setText(left >= 0 ? `${fmtClock(left)} left` : `${fmtClock(-left)} over time`);
	}

	private resetConfirm(): void {
		this.confirming = false;
		if (this.submitEl) this.submitEl.setText("Submit test");
		this.statusEl.setText("");
	}

	private submit(): void {
		if (this.done) return;
		const blank = this.cards.length - this.answeredCount();
		if (blank && !this.confirming) {
			this.confirming = true;
			this.submitEl?.setText(`Submit with ${blank} blank`);
			this.statusEl.setText(`${blank} question${blank === 1 ? " is" : "s are"} unanswered and will count as "I don't know".`);
			return;
		}
		const answers: TestResponse["answers"] = {};
		this.test.questions.forEach((q, i) => {
			const r = this.cards[i].getResponse();
			if (r) answers[q.id] = r;
		});
		const response: TestResponse = { answers, elapsedSeconds: Math.round((Date.now() - this.started) / 1000) };
		this.showSubmitted(response);
		this.onSubmit?.(response);
	}

	private lock(): void {
		this.done = true;
		this.el.addClass("is-done");
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.submitEl?.remove();
		this.submitEl = undefined;
		for (const c of this.cards) c.lock();
	}

	/** Submitted and waiting for the tutor to grade the written answers. */
	showSubmitted(response: TestResponse): void {
		this.lock();
		this.test.questions.forEach((q, i) => {
			const r = response.answers[q.id] ?? { dontKnow: true, selected: [], familiarity: 0, note: "Left blank" };
			this.cards[i].showPending(r, "");
		});
		const n = Object.keys(response.answers).length;
		this.progressEl.setText(`${n}/${this.cards.length} answered`);
		if (response.elapsedSeconds !== undefined) this.clockEl.setText(`${fmtClock(response.elapsedSeconds)} taken`);
		this.clockEl.removeClass("is-low", "is-over");
		this.statusEl.setText("Submitted. Your tutor is grading the written answers…");
	}

	showReport(report: TestReport): void {
		this.lock();
		this.statusEl.setText("");
		for (const r of report.results) this.cards[r.number - 1]?.showAnswer({ response: r.response, grade: r.grade });
		if (report.elapsedSeconds !== undefined) this.clockEl.setText(`${fmtClock(report.elapsedSeconds)} taken`);
		this.progressEl.setText(`${report.results.filter((r) => r.outcome !== "dont_know").length}/${report.results.length} answered`);

		this.reportEl.empty();
		this.reportEl.addClass("is-ready");
		const top = this.reportEl.createDiv({ cls: "gw-test-score" });
		const pct = Math.round(report.percent * 100);
		top.createDiv({ cls: `gw-test-score-big ${pct >= 80 ? "is-good" : pct >= 60 ? "is-ok" : "is-low"}`, text: `${pct}%` });
		const meta = top.createDiv({ cls: "gw-test-score-meta" });
		meta.createDiv({ text: `${fmtPoints(report.earned)} of ${report.possible} points` });
		const counts = { correct: 0, partial: 0, incorrect: 0, dont_know: 0 };
		for (const r of report.results) counts[r.outcome]++;
		meta.createDiv({
			cls: "gw-test-score-counts",
			text: [
				`${counts.correct} correct`,
				counts.partial ? `${counts.partial} partial` : "",
				counts.incorrect ? `${counts.incorrect} wrong` : "",
				counts.dont_know ? `${counts.dont_know} don't know` : "",
			]
				.filter(Boolean)
				.join(" · "),
		});
		if (report.notePath && this.openNote) {
			const link = meta.createEl("a", { cls: "gw-note-link", text: "Open evaluation note" });
			link.addEventListener("click", () => this.openNote!(report.notePath!));
		}

		const concepts = this.reportEl.createDiv({ cls: "gw-test-concepts" });
		concepts.createDiv({ cls: "gw-free-label", text: "By concept, weakest first" });
		for (const c of report.byConcept) {
			const row = concepts.createDiv({ cls: "gw-test-concept" });
			const label = row.createDiv({ cls: "gw-mastery-label" });
			label.createSpan({ text: c.concept });
			label.createSpan({ cls: `gw-status gw-status-${c.status}`, text: c.status });
			label.createSpan({ cls: "gw-mastery-delta", text: `${fmtPoints(c.earned)}/${c.possible} · Q${c.questions.join(", Q")}` });
			const bar = row.createDiv({ cls: "gw-bar" });
			const p = Math.round(c.percent * 100);
			bar.createDiv({ cls: `gw-bar-fill ${p >= 80 ? "gw-status-solid" : p >= 50 ? "gw-status-shaky" : "gw-status-learning"}` }).style.width = `${Math.max(3, p)}%`;
		}
		if (report.misconceptions.length) {
			const m = this.reportEl.createDiv({ cls: "gw-test-misconceptions" });
			m.createDiv({ cls: "gw-free-label", text: "Beliefs to fix" });
			for (const x of report.misconceptions) m.createDiv({ cls: "gw-misconception", text: `${x.concept}: ${x.misconception}` });
		}
	}
}

export class AskCard {
	readonly el: HTMLElement;
	private selected = new Set<string>();

	constructor(
		parent: HTMLElement,
		input: AskInput,
		renderMd: RenderMd,
		onSubmit?: (r: AskResponse) => void,
		answered?: AskResponse,
	) {
		this.el = parent.createDiv({ cls: "gw-card gw-ask" });
		const head = this.el.createDiv({ cls: "gw-card-head" });
		setIcon(head.createSpan({ cls: "gw-card-icon" }), "message-circle-question");
		head.createSpan({ cls: "gw-card-kind", text: "Question for you" });
		void renderMd(this.el.createDiv({ cls: "gw-quiz-question" }), input.question);
		if (input.details) void renderMd(this.el.createDiv({ cls: "gw-quiz-details" }), input.details);

		const optionEls = new Map<string, HTMLButtonElement>();
		if (input.options?.length) {
			const list = this.el.createDiv({ cls: "gw-options gw-options-inline" });
			for (const o of input.options) {
				const btn = list.createEl("button", { cls: "gw-chip" });
				void renderMd(btn.createDiv({ cls: "gw-option-label" }), o);
				optionEls.set(o, btn);
				btn.addEventListener("click", () => {
					if (!onSubmit) return;
					if (input.multiSelect) {
						if (this.selected.has(o)) this.selected.delete(o);
						else this.selected.add(o);
						btn.toggleClass("is-selected", this.selected.has(o));
						return;
					}
					this.selected = new Set([o]);
					finish();
				});
			}
		}

		const footer = this.el.createDiv({ cls: "gw-card-footer" });
		const allowText = input.allowFreeText !== false;
		const text = allowText
			? footer.createEl("textarea", { cls: "gw-note", attr: { rows: "1", placeholder: input.options?.length ? "Or write your own answer…" : "Your answer…" } })
			: null;
		const send = footer.createEl("button", { cls: "mod-cta gw-submit", text: "Send" });

		const finish = () => {
			const r: AskResponse = { selected: [...this.selected], text: text?.value.trim() || undefined };
			if (!r.selected.length && !r.text) return;
			lock(r);
			onSubmit?.(r);
		};
		const lock = (r: AskResponse) => {
			this.el.addClass("is-done");
			for (const [o, b] of optionEls) {
				b.disabled = true;
				b.toggleClass("is-selected", r.selected.includes(o));
			}
			send.remove();
			if (text) {
				if (r.text) {
					text.remove();
					this.el.createDiv({ cls: "gw-ask-answer", text: r.text });
				} else text.remove();
			}
		};
		send.addEventListener("click", finish);
		text?.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				finish();
			}
		});
		if (answered) lock(answered);
		else if (!onSubmit) lock({ selected: [] });
		else setTimeout(() => (text ?? send).focus(), 0);
	}
}
