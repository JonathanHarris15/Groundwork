import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	buildSystemPrompt,
	describeQuizOutcome,
	KnowledgeStore,
	latexToPlain,
	letter,
	mcpContent,
	parseChatAnswer,
	prepareQuiz,
	quizInputSchema,
	recordQuizAnswer,
	TOOLS,
	type PreparedQuiz,
	type QuizInput,
	type QuizResponse,
	type ToolDef,
	type ToolResult,
} from "@groundwork/core";
import { GitSync, NodeVaultIO } from "@groundwork/core/node";
import * as os from "node:os";

const INSTRUCTIONS = `Groundwork is the learner's persistent, calibrated knowledge vault (a git-synced Obsidian vault shared across all their computers).
Whenever the learner wants to learn, understand, review, or be quizzed on something:
1. Call get_learner_overview first. On the first call it also returns the teaching method; follow it for the whole conversation.
2. Build on what the vault already knows (search_knowledge, get_concepts) instead of re-probing from scratch.
3. Use quiz for every gradable question so the vault stays calibrated, and save goals, concepts, and a session summary as you go.
4. If they attach or mention homeworks, lecture slides, a study guide, or a practice exam, call ingest_exam_materials, then teach to the required levels — that is exam prep.`;

const DONT_KNOW = /^(e|\?|i\s*don'?t\s*know|idk|not\s*sure|no\s*idea|dont\s*know)$/i;

export async function runMcpServer(vaultDir: string, opts: { autoSync: boolean }): Promise<void> {
	const device = os.hostname();
	const git = new GitSync(vaultDir, { device });
	let timer: NodeJS.Timeout | null = null;
	const scheduleSync = () => {
		if (!opts.autoSync) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void git.sync(undefined, () => store.recomputeAll()).catch(() => undefined);
		}, 20_000);
	};
	const store = new KnowledgeStore(new NodeVaultIO(vaultDir), { device, onChange: scheduleSync });
	await store.ensureLayout();
	if (opts.autoSync) {
		const r = await git.sync(undefined, () => store.recomputeAll()).catch(() => null);
		if (r?.incoming) store.invalidate();
	}

	const pending = new Map<string, PreparedQuiz>();
	let methodDelivered = false;
	const session = { id: `mcp-${Date.now().toString(36)}` };

	const server = new Server(
		{ name: "groundwork", version: "0.1.0" },
		{ capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
	);

	const canElicit = () => !!server.getClientCapabilities()?.elicitation;

	const quizTool: ToolDef<QuizInput> = {
		name: "quiz",
		description:
			"Ask the learner ONE graded multiple-choice question; the answer is recorded as calibrated evidence on the concept. If the client supports forms, the learner answers inline and you get the graded result. Otherwise you get the question to present verbatim; then pass the learner's reply to submit_quiz_answer. Never add an 'I don't know' option (always offered) and never grade it yourself.",
		inputSchema: quizInputSchema,
		async run(input) {
			const concept = await store.resolve(input.concept);
			if (!concept) return { text: `Unknown concept "${input.concept}". Create it with upsert_concept or set_goal first.`, isError: true };
			const quiz = prepareQuiz({ ...input, concept: concept.title });
			pending.set(quiz.id, quiz);

			if (canElicit()) {
				const res = await elicitQuiz(server, quiz).catch(() => null);
				if (res && res.action === "accept" && res.content) {
					pending.delete(quiz.id);
					const outcome = await recordQuizAnswer(store, quiz, res.content, session);
					return {
						text: `${describeQuizOutcome(outcome)}\n\nShow the learner whether they were right and this explanation (render the math):\n${quiz.explanation}`,
					};
				}
				if (res && (res.action === "decline" || res.action === "cancel")) {
					pending.delete(quiz.id);
					return { text: "The learner dismissed the quiz. Nothing was recorded." };
				}
			}
			return { text: presentQuiz(quiz) };
		},
	};

	const submitTool: ToolDef<{ quiz_id: string; answer: string; note?: string }> = {
		name: "submit_quiz_answer",
		description: "Grade and record the learner's reply to a quiz you presented in chat. Pass their answer verbatim (a letter like 'B', several letters for multi-select, or 'I don't know').",
		inputSchema: {
			type: "object",
			properties: {
				quiz_id: { type: "string" },
				answer: { type: "string", description: "The learner's reply, verbatim." },
				note: { type: "string", description: "Anything else the learner said about their thinking." },
			},
			required: ["quiz_id", "answer"],
		},
		async run({ quiz_id, answer, note }) {
			const quiz = pending.get(quiz_id);
			if (!quiz) return { text: `No pending quiz with id ${quiz_id}. It may already be graded.`, isError: true };
			const idkLetter = letter(quiz.options.length);
			const trimmed = answer.trim().replace(/[.)]$/, "");
			const dontKnow = DONT_KNOW.test(trimmed) || trimmed.toUpperCase() === idkLetter;
			const selected = dontKnow ? [] : parseChatAnswer(quiz, answer);
			if (!dontKnow && !selected.length) {
				return { text: `Couldn't match "${answer}" to an option. Ask the learner to reply with a letter (A–${idkLetter}).`, isError: true };
			}
			pending.delete(quiz_id);
			const response: QuizResponse = { dontKnow, selected, note };
			const outcome = await recordQuizAnswer(store, quiz, response, session);
			return {
				text: `${describeQuizOutcome(outcome)}\n\nNow tell the learner the result and give this explanation (render the math):\n${quiz.explanation}`,
			};
		},
	};

	const methodTool: ToolDef = {
		name: "get_teaching_method",
		description: "The full teaching method to follow in learning conversations. get_learner_overview includes it on first call.",
		inputSchema: { type: "object", properties: {} },
		async run() {
			methodDelivered = true;
			return { text: buildSystemPrompt("chat") };
		},
	};

	const syncTool: ToolDef = {
		name: "sync_vault",
		description: "Commit and sync the knowledge vault with GitHub now (it also syncs automatically).",
		inputSchema: { type: "object", properties: {} },
		async run() {
			const r = await git.sync(undefined, () => store.recomputeAll());
			if (r.incoming) store.invalidate();
			return { text: `${r.state}: ${r.message}` };
		},
	};

	const tools: ToolDef[] = [
		...TOOLS.filter((t) => !t.interactive),
		quizTool,
		submitTool,
		methodTool,
		syncTool,
	];

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as any })),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = tools.find((t) => t.name === req.params.name);
		if (!tool) return { content: [{ type: "text", text: `Unknown tool ${req.params.name}` }], isError: true };
		let result: ToolResult;
		try {
			result = await tool.run(req.params.arguments ?? {}, { store, session });
		} catch (e) {
			result = { text: `Error: ${(e as Error).message}`, isError: true };
		}
		let text = result.text;
		if (tool.name === "get_learner_overview" && !methodDelivered) {
			methodDelivered = true;
			text = `${buildSystemPrompt("chat")}\n\n---\n\n# Learner state\n${text}`;
		}
		return { content: mcpContent(text, result.files), isError: result.isError };
	});

	server.setRequestHandler(ListPromptsRequestSchema, async () => ({
		prompts: [
			{
				name: "teach",
				description: "Start a Groundwork tutoring session (loads the teaching method and your vault).",
				arguments: [{ name: "topic", description: "What you want to understand (optional).", required: false }],
			},
			{ name: "review", description: "Spaced review of concepts that are fading." },
			{
				name: "exam",
				description: "Prepare for an exam from attached or vault files (homeworks, slides, study guide, practice exam).",
				arguments: [{ name: "files", description: "Vault paths or file names, comma-separated (optional if already attached in chat).", required: false }],
			},
		],
	}));

	server.setRequestHandler(GetPromptRequestSchema, async (req) => {
		const method = buildSystemPrompt("chat");
		methodDelivered = true;
		if (req.params.name === "exam") {
			const files = typeof req.params.arguments?.files === "string" ? req.params.arguments.files : "";
			return {
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: `${method}\n\n---\n\nI want to prepare for an exam from my course files. Call get_learner_overview, then ingest_exam_materials${files ? ` with files: ${files}` : " (list_vault_files / read_vault_file first if you need paths)"}. Parse the homeworks, slides, study guide, and/or practice exam into topics and required levels, set_goal, and start teaching to that depth.`,
						},
					},
				],
			};
		}
		if (req.params.name === "review") {
			return {
				messages: [
					{
						role: "user",
						content: { type: "text", text: `${method}\n\n---\n\nRun a spaced review session: call get_due_reviews, then quiz me (kind "review") on each due concept, adapting difficulty to my recorded edge.` },
					},
				],
			};
		}
		const topic = req.params.arguments?.topic;
		return {
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `${method}\n\n---\n\n${topic ? `I want to understand: ${topic}` : "Let's start a learning session. Check my vault and ask what I want to work on."}`,
					},
				},
			],
		};
	});

	const flush = async () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
			await git.sync().catch(() => undefined);
		}
	};
	process.on("SIGINT", () => void flush().then(() => process.exit(0)));
	process.on("SIGTERM", () => void flush().then(() => process.exit(0)));
	process.stdin.on("end", () => void flush());

	await server.connect(new StdioServerTransport());
}

function presentQuiz(quiz: PreparedQuiz): string {
	const opts = quiz.options.map((o, i) => `**${letter(i)}.** ${o.label}`);
	opts.push(`**${letter(quiz.options.length)}.** I don't know`);
	return [
		`Present this quiz to the learner exactly as written (render the math), then STOP and wait for their reply. Do not hint at or reveal the answer. When they reply, call submit_quiz_answer with quiz_id "${quiz.id}" and their reply verbatim.`,
		"",
		"---",
		`**Quiz · ${quiz.concept} · level ${quiz.difficulty}/5${quiz.multiSelect ? " · select all that apply" : ""}**`,
		"",
		quiz.question,
		quiz.details ? `\n*${quiz.details}*` : "",
		"",
		...opts,
		"",
		`*Reply with ${quiz.multiSelect ? "letters" : "a letter"}; add a note about your thinking if you like.*`,
	].join("\n");
}

async function elicitQuiz(server: Server, quiz: PreparedQuiz) {
	const choices = quiz.options.map((o, i) => ({ const: o.value, title: `${letter(i)}. ${latexToPlain(o.label)}` }));
	const DK = "__dont_know__";
	const answer = quiz.multiSelect
		? { type: "array", title: "Your answer (select all that apply)", items: { anyOf: choices } }
		: { type: "string", title: "Your answer", oneOf: [...choices, { const: DK, title: "I don't know" }] };
	const res = await server.elicitInput({
		message: `Quiz · ${quiz.concept} · level ${quiz.difficulty}/5\n\n${latexToPlain(quiz.question)}${quiz.details ? `\n\n${latexToPlain(quiz.details)}` : ""}`,
		requestedSchema: {
			type: "object",
			properties: {
				answer: answer as any,
				note: { type: "string", title: "Note (optional)", description: "What you were thinking or unsure about" },
			},
			required: ["answer"],
		},
	});
	if (res.action !== "accept" || !res.content) return { action: res.action, content: null };
	const raw = res.content.answer;
	const selected = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
	const dontKnow = selected.includes(DK) || selected.length === 0;
	const note = typeof res.content.note === "string" && res.content.note.trim() ? res.content.note.trim() : undefined;
	return { action: "accept" as const, content: { dontKnow, selected: dontKnow ? [] : selected, note } satisfies QuizResponse };
}

