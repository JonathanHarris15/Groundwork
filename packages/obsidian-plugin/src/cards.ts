import { setIcon } from "obsidian";
import { gradeQuiz, letter, type AskInput, type AskResponse, type ConceptStats, type PreparedQuiz, type QuizGrade, type QuizResponse } from "@groundwork/core";

export type RenderMd = (el: HTMLElement, markdown: string) => Promise<void>;

export interface AnsweredQuiz {
	response: QuizResponse;
	grade: QuizGrade;
	before?: ConceptStats;
	after?: ConceptStats;
}

const KIND_LABEL = { probe: "Probe", check: "Check", review: "Review", explain: "Explain" } as const;

export class QuizCard {
	readonly el: HTMLElement;
	private selected = new Set<string>();
	private dontKnow = false;
	private optionEls = new Map<string, HTMLElement>();
	private dontKnowEl!: HTMLElement;
	private noteEl!: HTMLTextAreaElement;
	private submitEl!: HTMLButtonElement;
	private feedbackEl!: HTMLElement;
	private mastery?: HTMLElement;
	private done = false;

	constructor(
		parent: HTMLElement,
		private readonly quiz: PreparedQuiz,
		private readonly renderMd: RenderMd,
		private readonly onSubmit?: (r: QuizResponse) => void,
	) {
		this.el = parent.createDiv({ cls: "gw-card gw-quiz" });
		this.el.tabIndex = 0;
		const head = this.el.createDiv({ cls: "gw-card-head" });
		const icon = head.createSpan({ cls: "gw-card-icon" });
		setIcon(icon, "circle-help");
		head.createSpan({ cls: "gw-card-kind", text: `${KIND_LABEL[quiz.kind]} quiz` });
		head.createSpan({ cls: "gw-pill", text: quiz.concept });
		head.createSpan({ cls: "gw-pill gw-pill-muted", text: `level ${quiz.difficulty}/5` });
		if (quiz.multiSelect) head.createSpan({ cls: "gw-pill gw-pill-muted", text: "select all that apply" });

		void this.renderMd(this.el.createDiv({ cls: "gw-quiz-question" }), quiz.question);
		if (quiz.details) void this.renderMd(this.el.createDiv({ cls: "gw-quiz-details" }), quiz.details);

		const list = this.el.createDiv({ cls: "gw-options" });
		quiz.options.forEach((o, i) => {
			const btn = list.createEl("button", { cls: "gw-option" });
			btn.createSpan({ cls: "gw-option-key", text: letter(i) });
			void this.renderMd(btn.createDiv({ cls: "gw-option-label" }), o.label);
			btn.addEventListener("click", () => this.toggle(o.value));
			this.optionEls.set(o.value, btn);
		});
		this.dontKnowEl = list.createEl("button", { cls: "gw-option gw-option-dontknow" });
		this.dontKnowEl.createSpan({ cls: "gw-option-key", text: "?" });
		this.dontKnowEl.createDiv({ cls: "gw-option-label", text: "I don't know" });
		this.dontKnowEl.addEventListener("click", () => this.toggleDontKnow());

		const footer = this.el.createDiv({ cls: "gw-card-footer" });
		this.noteEl = footer.createEl("textarea", {
			cls: "gw-note",
			attr: { rows: "1", placeholder: "Optional note: what you were thinking or unsure about" },
		});
		this.submitEl = footer.createEl("button", { cls: "mod-cta gw-submit", text: "Check answer" });
		this.submitEl.disabled = true;
		this.submitEl.addEventListener("click", () => this.submit());
		this.feedbackEl = this.el.createDiv({ cls: "gw-feedback" });

		this.el.addEventListener("keydown", (e) => {
			if (this.done || e.target === this.noteEl) return;
			const n = e.key.toLowerCase();
			const idx = /^[1-9]$/.test(n) ? Number(n) - 1 : /^[a-i]$/.test(n) ? n.charCodeAt(0) - 97 : -1;
			if (idx >= 0 && idx < quiz.options.length) {
				this.toggle(quiz.options[idx].value);
				e.preventDefault();
			} else if (n === "?" || n === "0") {
				this.toggleDontKnow();
				e.preventDefault();
			} else if (e.key === "Enter") {
				this.submit();
				e.preventDefault();
			}
		});

		if (!onSubmit) this.lock();
	}

	focus(): void {
		this.el.focus({ preventScroll: true });
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
		if (!this.quiz.multiSelect) this.submitEl.focus();
	}

	private toggleDontKnow(): void {
		if (this.done) return;
		this.dontKnow = !this.dontKnow;
		if (this.dontKnow) this.selected.clear();
		this.refresh();
	}

	private refresh(): void {
		for (const [v, el] of this.optionEls) el.toggleClass("is-selected", this.selected.has(v));
		this.dontKnowEl.toggleClass("is-selected", this.dontKnow);
		this.submitEl.disabled = !this.dontKnow && this.selected.size === 0;
	}

	private submit(): void {
		if (this.done || (!this.dontKnow && this.selected.size === 0)) return;
		const note = this.noteEl.value.trim() || undefined;
		const response: QuizResponse = { dontKnow: this.dontKnow, selected: [...this.selected], note };
		this.showAnswer({ response, grade: gradeQuiz(this.quiz, response) });
		this.onSubmit?.(response);
	}

	private lock(): void {
		this.done = true;
		this.el.addClass("is-done");
		for (const el of this.optionEls.values()) (el as HTMLButtonElement).disabled = true;
		(this.dontKnowEl as HTMLButtonElement).disabled = true;
		this.noteEl.disabled = true;
		this.submitEl.remove();
		if (!this.noteEl.value) this.noteEl.remove();
	}

	/** Show graded feedback. Also used to re-render answered quizzes from history. */
	showAnswer(a: AnsweredQuiz): void {
		this.selected = new Set(a.response.selected);
		this.dontKnow = a.response.dontKnow;
		if (a.response.note) this.noteEl.value = a.response.note;
		this.refresh();
		this.lock();
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
		verdict.addClass(outcome === "correct" ? "is-correct" : outcome === "dont_know" ? "is-unknown" : "is-wrong");
		verdict.setText(outcome === "correct" ? "Correct" : outcome === "dont_know" ? "Honest gap — that's useful" : "Not quite");
		if (a.grade.misconception) {
			this.feedbackEl.createDiv({ cls: "gw-misconception", text: `Likely belief: ${a.grade.misconception}` });
		}
		if (this.quiz.explanation) void this.renderMd(this.feedbackEl.createDiv({ cls: "gw-explanation" }), this.quiz.explanation);
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
