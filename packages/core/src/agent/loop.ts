import { collapseAnthropicTranscript, invalidAnthropicRequest, messagesForAnthropic, normalizeAnthropicMessages } from "../account/anthropic-messages";
import { compactTutorHistory } from "../account/history-budget";
import { holdsFixturePrefix, isGarbageReply, isInternalToolReport, LOST_REPLY, sanitizeTutorOutput, scrubLearnerText, TutorTextFilter } from "../learner-text";
import type { FolderAccess } from "../access";
import { dialogueFromMessages, quizDeclined, studyToolBlock, visibleAsk, withLearnerDue } from "../intent";
import { goalAsked, isQuestionTool, learnerFacingCorrection, repairNote, setGoalSucceeded } from "../turn-repair";
import { fileBlocks, userContent, type VaultFile } from "../files";
import type { KnowledgeStore } from "../store";
import type { SessionInfo, ToolContext, ToolDef, ToolUI } from "../tools";
import { ResearchTurn, WEB_RESEARCH_TOOLS, forcingAnswer, researchClosedNote, stepsClosedNote, unfinishedTurn } from "./research";
import type { AgentEvent, ChatMessage, ContentBlock, Provider, ProviderResponse, ProviderTool, TutorSession, TutorTurnContext } from "./types";

export interface AgentOptions {
	provider: Provider;
	store: KnowledgeStore;
	tools: ToolDef[];
	system: string;
	ui?: ToolUI;
	session: SessionInfo;
	messages?: ChatMessage[];
	maxSteps?: number;
	/** Read and write folders for vault file tools. Omitted uses the defaults. */
	access?: FolderAccess;
	grader?: ToolContext["grader"];
	keyVerifier?: ToolContext["keyVerifier"];
	/** Free accounts cannot save new cards. Omit to allow. */
	flashcardsWritable?: boolean;
}

export class AgentSession implements TutorSession {
	readonly messages: ChatMessage[];
	private running = false;
	private turnContext: TutorTurnContext | null = null;

	constructor(private readonly opts: AgentOptions) {
		this.messages = normalizeAnthropicMessages(opts.messages ? [...opts.messages] : []);
	}

	setTurnContext(ctx: TutorTurnContext | null): void {
		this.turnContext = ctx;
	}

	get session(): SessionInfo {
		return this.opts.session;
	}

	get busy(): boolean {
		return this.running;
	}

	async send(text: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal, files?: VaultFile[]): Promise<void> {
		if (this.running) throw new Error("The tutor is still responding.");
		this.running = true;
		this.messages.push({ role: "user", content: userContent(text, files) });
		try {
			await this.run(onEvent, signal);
		} catch (err) {
			if (signal?.aborted) {
				this.repairAfterAbort();
			} else {
				this.repairAfterAbort();
				onEvent({ type: "error", message: errorMessage(err), code: errorCode(err) });
			}
		} finally {
			this.healStored();
			this.running = false;
			onEvent({ type: "turn_end" });
		}
	}

	private async run(onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
		const maxSteps = this.opts.maxSteps ?? 40;
		const catalog = this.opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
		const research = new ResearchTurn();
		const turnAt = this.messages.length;
		let repaired = false;
		let garbageRetries = 0;
		let calledQuestion = false;
		let calledGoal = false;
		let calledFigure = false;
		let toolsRan = false;
		const toolErrors: string[] = [];
		for (let step = 0; step < maxSteps; step++) {
			if (signal?.aborted) return;
			const force = forcingAnswer(step, maxSteps);
			const tools = toolsForStep(catalog, research, force);
			const note = force ? stepsClosedNote() : research.exhausted ? researchClosedNote() : "";
			const system = this.turnContext?.system ?? this.opts.system;
			const speech = new HeldSpeech((text) => onEvent({ type: "text_delta", text }));
			const res = await this.complete(note ? `${system}\n\n${note}` : system, tools, signal, (delta) => speech.push(delta));
			const uses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
			if (res.stopReason === "pause_turn") {
				speech.flush();
				this.messages.push({ role: "assistant", content: presentAssistant(res.content) });
				continue;
			}
			if (!uses.length && isGarbageReply(assistantPlain(res.content))) {
				speech.discard();
				if (garbageRetries < 2) {
					garbageRetries += 1;
					this.messages.push({ role: "user", content: [{ type: "text", text: BLANK_REPLY }] });
					continue;
				}
				speech.emit(LOST_REPLY);
				this.messages.push({ role: "assistant", content: [{ type: "text", text: LOST_REPLY }] });
				return;
			}
			speech.flush();
			this.messages.push({ role: "assistant", content: presentAssistant(res.content) });

			if (!uses.length) {
				if (!repaired && this.repairTurn(turnAt, calledQuestion, calledGoal, calledFigure, toolErrors)) {
					repaired = true;
					continue;
				}
				this.correctUnsavedGoal(onEvent, turnAt, calledGoal, toolsRan, toolErrors);
				return;
			}

			const results: ContentBlock[] = [];
			const dialogue = dialogueFromMessages(this.messages);
			for (const use of uses) {
				if (signal?.aborted) {
					results.push({ type: "tool_result", tool_use_id: use.id, content: "Cancelled by the learner.", is_error: true });
					continue;
				}
				onEvent({ type: "tool_start", id: use.id, name: use.name, input: use.input });
				const tool = this.opts.tools.find((t) => t.name === use.name);
				let text: string;
				let isError = false;
				let summary: string | undefined;
				let files: VaultFile[] | undefined;
				const gate = force
					? { text: "Tools are closed for this reply. Tell the learner where this stands, in text. Do not ask another question.", isError: true, summary: "Wrapping up" }
					: research.intercept(use.name, use.input);
				const blocked = gate ? null : studyToolBlock(use.name, dialogue);
				if (gate) {
					text = gate.text;
					isError = gate.isError;
					summary = gate.summary;
				} else if (blocked) {
					text = blocked.text;
					isError = true;
					summary = blocked.summary;
				} else {
					try {
						if (!tool) throw new Error(`Unknown tool ${use.name}`);
						const r = await tool.run(withLearnerDue(use.name, toolArguments(use.input), dialogue), {
							store: this.opts.store,
							ui: this.opts.ui,
							session: this.opts.session,
							signal,
							access: this.opts.access,
							grader: this.opts.grader,
							keyVerifier: this.opts.keyVerifier,
							profile: this.turnContext?.profile,
							tutorContext: this.turnContext?.tutorContext,
							flashcardsWritable: this.opts.flashcardsWritable,
						});
						text = r.text;
						isError = !!r.isError;
						summary = r.summary;
						files = r.files;
					} catch (err) {
						text = `Error: ${errorMessage(err)}`;
						isError = true;
					}
				}
				if (!gate && WEB_RESEARCH_TOOLS.has(use.name)) {
					research.record(use.name, use.input, text, !isError);
					const warning = research.warning(use.name, use.input);
					if (warning && !isError) text += `\n\n${warning}`;
				}
				toolsRan = true;
				if (isError && !isInternalToolReport(summary, text)) toolErrors.push(reportedToolError(use.name, summary, text));
				if (!isError && isQuestionTool(use.name)) calledQuestion = true;
				if (!isError && use.name === "set_goal") calledGoal = true;
				if (!isError && use.name === "show_figure") calledFigure = true;
				onEvent({ type: "tool_end", id: use.id, name: use.name, summary, isError, text });
				const content = files?.length ? [{ type: "text", text }, ...files.flatMap(fileBlocks)] : text;
				results.push({ type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) });
			}
			this.messages.push({ role: "user", content: results });
		}
		this.finishUnfinished(onEvent, turnAt);
	}

	/** Repair the saved thread, then send it. If the provider still rejects the history, drop it to text and retry once. */
	private async complete(system: string, tools: ProviderTool[], signal: AbortSignal | undefined, onText: (delta: string) => void): Promise<ProviderResponse> {
		this.healStored();
		const call = (messages: ChatMessage[]) =>
			this.opts.provider.complete({
				system,
				messages,
				tools,
				signal,
				onText,
			});
		try {
			return await call(messagesForAnthropic(this.messages));
		} catch (err) {
			if (signal?.aborted || !invalidAnthropicRequest(errorMessage(err))) throw err;
			this.messages.splice(0, this.messages.length, ...collapseAnthropicTranscript(this.messages));
			return await call(messagesForAnthropic(this.messages));
		}
	}

	private healStored(): void {
		const healed = compactTutorHistory(normalizeAnthropicMessages(this.messages));
		this.messages.splice(0, this.messages.length, ...healed);
	}

	/** The step cap still hit. Leave a partial answer and a way to continue, never a bare error. */
	private finishUnfinished(onEvent: (e: AgentEvent) => void, turnAt: number): void {
		this.closeDanglingTools();
		const unfinished = unfinishedTurn(this.messages, turnAt);
		if (unfinished.answer) onEvent({ type: "text_delta", text: unfinished.answer });
		const last = this.messages[this.messages.length - 1];
		const blocks = last && Array.isArray(last.content) ? last.content : null;
		if (unfinished.answer && last?.role === "assistant" && blocks && !blocks.some((block) => block.type === "tool_use")) {
			blocks.push({ type: "text", text: unfinished.answer });
		} else if (last?.role !== "assistant") {
			this.messages.push({ role: "assistant", content: [{ type: "text", text: unfinished.answer || unfinished.note }] });
		}
		onEvent({ type: "continue_offer", text: unfinished.note });
	}

	/** A claim that the goal was saved, with no successful set_goal, is replaced with the truth. An invented tool failure is replaced with the tool's error, or with the fact that no tool ran. */
	private correctUnsavedGoal(onEvent: (e: AgentEvent) => void, turnAt: number, calledGoal: boolean, toolsRan: boolean, toolErrors: string[]): void {
		const user = this.messages[turnAt - 1];
		const history = this.messages.slice(0, turnAt);
		const assistantText = assistantTextSince(this.messages, turnAt);
		const correction = learnerFacingCorrection({
			userText: user ? messageText(user) : "",
			assistantText,
			calledGoal,
			goalPending: goalAsked(history) && !setGoalSucceeded(history),
			toolErrors,
			toolsRan,
		});
		const clean = correction ? sanitizeTutorOutput(correction).trim() : "";
		if (!clean) return;
		const line = `\n\n${clean}`;
		onEvent({ type: "text_delta", text: line });
		const last = this.messages[this.messages.length - 1];
		if (last?.role === "assistant" && Array.isArray(last.content)) last.content.push({ type: "text", text: line });
		else this.messages.push({ role: "assistant", content: [{ type: "text", text: clean }] });
	}

	/** One follow-up when the model announced a question, skipped a stated objective, or drew ASCII. */
	private repairTurn(turnAt: number, calledQuestion: boolean, calledGoal: boolean, calledFigure: boolean, toolErrors: string[]): boolean {
		const user = this.messages[turnAt - 1];
		const history = this.messages.slice(0, turnAt);
		const note = repairNote({
			userText: user ? messageText(user) : "",
			assistantText: assistantTextSince(this.messages, turnAt),
			calledQuestion,
			calledGoal,
			calledFigure,
			goalPending: goalAsked(history) && !setGoalSucceeded(history),
			quizOff: quizDeclined(dialogueFromMessages(history)),
			toolErrors,
		});
		if (!note) return false;
		this.messages.push({ role: "user", content: [{ type: "text", text: note }] });
		return true;
	}

	/** A paused turn can stop on a tool call that never received a result. */
	private closeDanglingTools(): void {
		const last = this.messages[this.messages.length - 1];
		if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
		const uses = last.content.filter((block) => block.type === "tool_use") as Array<{ id: string }>;
		if (!uses.length) return;
		this.messages.push({
			role: "user",
			content: uses.map((use) => ({ type: "tool_result", tool_use_id: use.id, content: "Stopped before this tool ran.", is_error: true })),
		});
	}

	/** Keep history valid for the API: every tool_use needs a tool_result, and turns must alternate. */
	private repairAfterAbort(): void {
		const last = this.messages[this.messages.length - 1];
		if (last?.role === "assistant" && Array.isArray(last.content)) {
			const uses = last.content.filter((b) => b.type === "tool_use") as Array<{ id: string }>;
			if (uses.length) {
				this.messages.push({
					role: "user",
					content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "Cancelled by the learner.", is_error: true })),
				});
			}
		}
		const tail = this.messages[this.messages.length - 1];
		if (tail?.role === "user") {
			this.messages.push({ role: "assistant", content: [{ type: "text", text: "(stopped)" }] });
		}
	}
}

const BLANK_REPLY = "<tutor_repair>\nThat reply was empty. Continue this turn: answer the learner, or call the tool that does the next step. Do not stop yet.\n</tutor_repair>";

/** Holds a reply that is still only a test id, and strips gate text from the stream. */
class HeldSpeech {
	private held = "";
	private live = false;
	private readonly filter = new TutorTextFilter();

	constructor(private readonly emit: (text: string) => void) {}

	push(delta: string): void {
		if (!delta) return;
		if (this.live) {
			const text = this.filter.push(delta);
			if (text) this.emit(text);
			return;
		}
		this.held += delta;
		if (holdsFixturePrefix(this.held)) return;
		this.live = true;
		const text = this.filter.push(this.held);
		this.held = "";
		if (text) this.emit(text);
	}

	discard(): void {
		this.held = "";
		this.live = false;
		this.filter.flush();
	}

	flush(): void {
		if (!this.live) {
			const text = scrubLearnerText(this.held);
			this.held = "";
			if (!text || isGarbageReply(text)) return;
			const cleaned = this.filter.push(text) + this.filter.flush();
			if (cleaned) this.emit(cleaned);
			return;
		}
		const tail = this.filter.flush();
		if (tail) this.emit(tail);
	}
}

function assistantPlain(content: ContentBlock[]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("");
}

/** Drop internal fixture ids before they are stored or sent back to the model. */
function presentAssistant(content: ContentBlock[]): ContentBlock[] {
	return content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		const text = scrubLearnerText(block.text);
		return text === block.text ? block : { type: "text", text };
	});
}

/** A tool failure in one line, named, without the note meant for the model. */
function reportedToolError(name: string, summary: string | undefined, text: string): string {
	const detail = (summary || text).replace(/\s+/g, " ").trim();
	const clip = detail.length > 180 ? `${detail.slice(0, 180)}…` : detail;
	return `${name}: ${clip}`;
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export function errorCode(err: unknown): string | undefined {
	if (!err || typeof err !== "object" || !("code" in err)) return undefined;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" && code ? code : undefined;
}

function messageText(message: ChatMessage): string {
	if (typeof message.content === "string") return visibleAsk(message.content);
	return visibleAsk(
		message.content
			.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n"),
	);
}

function assistantTextSince(messages: ChatMessage[], turnAt: number): string {
	return messages
		.slice(turnAt)
		.filter((message) => message.role === "assistant")
		.map((message) => (typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => (block as { text?: string }).text ?? "").join("")))
		.join("\n");
}

function toolArguments(input: unknown): unknown {
	if (typeof input === "string") {
		try {
			const parsed: unknown = JSON.parse(input);
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			return {};
		}
	}
	return input ?? {};
}

function toolsForStep(catalog: ProviderTool[], research: ResearchTurn, force: boolean): ProviderTool[] {
	if (force) return [];
	if (!research.exhausted) return catalog;
	return catalog.filter((tool) => !WEB_RESEARCH_TOOLS.has(tool.name));
}
