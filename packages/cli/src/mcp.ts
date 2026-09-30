import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	awaitJudgment,
	buildSystemPrompt,
	clampFamiliarity,
	describeQuizOutcome,
	describeTestForGrading,
	describeTestReport,
	FAMILIARITY_LABELS,
	finishTest,
	KnowledgeStore,
	latexToPlain,
	letter,
	mcpContent,
	needsJudgment,
	parseChatAnswer,
	parseFamiliarity,
	practiceTestInputSchema,
	practiceTestRequest,
	prepareQuiz,
	prepareTest,
	quizInputSchema,
	recordQuizAnswer,
	startTestGrading,
	TOOLS,
	ungraded,
	type PracticeTestInput,
	type PreparedQuiz,
	type PreparedTest,
	type QuizInput,
	type QuizResponse,
	type TestResponse,
	type ToolDef,
	type ToolResult,
} from "@groundwork/core";
import { GitSync, NodeVaultIO } from "@groundwork/core/node";
import * as os from "node:os";

const INSTRUCTIONS = `Groundwork is the learner's persistent, calibrated knowledge vault (a git-synced Obsidian vault shared across all their computers).
Whenever the learner wants to learn, understand, review, or be quizzed on something:
1. Call get_learner_overview first. On the first call it also returns the teaching method; follow it for the whole conversation.
2. Teach the topic or file they brought. Call suggest_what_to_study only when they ask what to study and named nothing. Build on what the vault already knows (search_knowledge, get_concepts) instead of re-probing from scratch.
3. Use quiz for every gradable question (multiple choice or free response) so the vault stays calibrated, and save goals, concepts, and a session summary as you go.
4. After a miss or "I don't know", follow the result's Next move: diagnose down to what they hold before teaching.
5. If they attach or mention homeworks, lecture slides, a study guide, or a practice exam, call ingest_exam_materials, then teach to the required levels — that is exam prep. Use practice_test for a full mock exam.`;

/** "I don't know", optionally followed by how familiar it feels ("idk — rings a bell"). */
const DONT_KNOW = /^(\?|i\s*don'?t\s*know|idk|not\s*sure|no\s*idea|dont\s*know)(\s*[,.;:!—–-].*)?$/is;

const familiarityHelp = `If you don't know, say how familiar it feels: ${FAMILIARITY_LABELS.map((l, i) => `${i} = ${l.toLowerCase()}`).join(", ")}.`;

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
			"Ask the learner ONE graded question; the answer is recorded as calibrated evidence on the concept. format choice = multiple choice, graded by the server. format free = a typed answer (LaTeX allowed) that you grade with grade_answer. If the client supports forms, the learner answers inline. Otherwise you get the question to present verbatim; then pass the learner's reply to submit_quiz_answer. Never add an 'I don't know' option (always offered) and never grade multiple choice yourself.",
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
					return { text: await answered(quiz, res.content) };
				}
				if (res && (res.action === "decline" || res.action === "cancel")) {
					pending.delete(quiz.id);
					return { text: "The learner dismissed the quiz. Nothing was recorded." };
				}
			}
			return { text: presentQuiz(quiz) };
		},
	};

	/** Record a response, or hand a free-response answer back to the tutor to grade. */
	const answered = async (quiz: PreparedQuiz, response: QuizResponse): Promise<string> => {
		if (needsJudgment(quiz, response)) {
			return `${awaitJudgment(quiz, response)}\n\nAfter grade_answer, tell the learner the result, your feedback, and the reference answer (render the math).`;
		}
		const outcome = await recordQuizAnswer(store, quiz, response, session);
		return `${describeQuizOutcome(outcome)}\n\nNow tell the learner the result and give this explanation (render the math):\n${quiz.explanation}`;
	};

	const submitTool: ToolDef<{ quiz_id: string; answer: string; familiarity?: number; note?: string }> = {
		name: "submit_quiz_answer",
		description:
			"Record the learner's reply to a quiz you presented in chat. Pass their answer verbatim: a letter like 'B', several letters for multi-select, the text they wrote for a free-response question, or 'I don't know'. For 'I don't know', also pass familiarity (0 never seen this … 3 very familiar, almost have it) if they said.",
		inputSchema: {
			type: "object",
			properties: {
				quiz_id: { type: "string" },
				answer: { type: "string", description: "The learner's reply, verbatim." },
				familiarity: { type: "integer", minimum: 0, maximum: 3, description: "Only for 'I don't know': 0 never seen this, 1 seen it but can't place it, 2 rings a bell, 3 almost have it." },
				note: { type: "string", description: "Anything else the learner said about their thinking." },
			},
			required: ["quiz_id", "answer"],
		},
		async run({ quiz_id, answer, familiarity, note }) {
			const quiz = pending.get(quiz_id);
			if (!quiz) return { text: `No pending quiz with id ${quiz_id}. It may already be graded.`, isError: true };
			const response = parseReply(quiz, answer, familiarity, note);
			if (!response) {
				return { text: `Couldn't match "${answer}" to an option. Ask the learner to reply with a letter (A–${letter(quiz.options.length)}).`, isError: true };
			}
			pending.delete(quiz_id);
			return { text: await answered(quiz, response) };
		},
	};

	const pendingTests = new Map<string, PreparedTest>();

	const practiceTool: ToolDef<PracticeTestInput> = {
		name: "practice_test",
		description:
			"Give the learner a full practice test (exam prep): many questions, multiple choice and free response mixed, no feedback until submitted. If the client supports forms, the learner answers inline. Otherwise you get the test to present verbatim; collect all their answers, then call submit_practice_test. Grade free responses with grade_practice_test. Every answer is recorded, and an evaluation is saved to tests/.",
		inputSchema: practiceTestInputSchema,
		async run(input) {
			const unknown: string[] = [];
			const questions: QuizInput[] = [];
			for (const q of input.questions ?? []) {
				const c = await store.resolve(q.concept);
				if (!c) unknown.push(q.concept);
				else questions.push({ ...q, concept: c.title });
			}
			if (unknown.length) return { text: `Unknown concepts: ${[...new Set(unknown)].join(", ")}. Create them with upsert_concept or set_goal first.`, isError: true };
			const test = prepareTest({ ...input, questions });
			if (canElicit()) {
				const res = await elicitTest(server, test).catch(() => null);
				if (res && res.action === "accept" && res.content) return { text: await testSubmitted(test, res.content) };
				if (res && (res.action === "decline" || res.action === "cancel")) return { text: "The learner closed the practice test. Nothing was recorded." };
			}
			pendingTests.set(test.id, test);
			return { text: presentTest(test) };
		},
	};

	const testSubmitted = async (test: PreparedTest, response: TestResponse): Promise<string> => {
		const state = await startTestGrading(store, test, response, session);
		if (ungraded(state).length) return describeTestForGrading(state);
		return `${describeTestReport(await finishTest(store, state))}\n\nShow the learner their score and the per-concept breakdown.`;
	};

	const submitTestTool: ToolDef<{ test_id: string; answers: Array<{ question: number; answer: string; familiarity?: number; note?: string }> }> = {
		name: "submit_practice_test",
		description: "Record the learner's answers to a practice test you presented in chat, one entry per question, verbatim. Unanswered questions count as left blank.",
		inputSchema: {
			type: "object",
			properties: {
				test_id: { type: "string" },
				answers: {
					type: "array",
					items: {
						type: "object",
						properties: {
							question: { type: "integer", description: "Question number (1-based)." },
							answer: { type: "string", description: "Their reply verbatim: a letter, the text they wrote, or 'I don't know'." },
							familiarity: { type: "integer", minimum: 0, maximum: 3 },
							note: { type: "string" },
						},
						required: ["question", "answer"],
					},
				},
			},
			required: ["test_id", "answers"],
		},
		async run({ test_id, answers }) {
			const test = pendingTests.get(test_id);
			if (!test) return { text: `No practice test waiting for answers with id ${test_id}.`, isError: true };
			const response: TestResponse = { answers: {} };
			const problems: string[] = [];
			for (const a of answers ?? []) {
				const q = test.questions[Number(a.question) - 1];
				if (!q) {
					problems.push(`There is no question ${a.question}.`);
					continue;
				}
				const r = parseReply(q, a.answer, a.familiarity, a.note);
				if (r) response.answers[q.id] = r;
				else problems.push(`Question ${a.question}: couldn't match "${a.answer}" to an option.`);
			}
			if (problems.length) return { text: `${problems.join("\n")}\nAsk the learner to clarify, then call submit_practice_test again with every answer.`, isError: true };
			pendingTests.delete(test_id);
			return { text: await testSubmitted(test, response) };
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
		practiceTool,
		submitTestTool,
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
			{
				name: "practice-test",
				description: "Take a practice test (mock exam) on a goal, exam plan, or topic, get an evaluation, and learn from it.",
				arguments: [{ name: "topic", description: "Goal, exam plan, or topic to test (optional).", required: false }],
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
							text: `${method}\n\n---\n\nI want to prepare for an exam from my course files. Call get_learner_overview, then ingest_exam_materials${files ? ` with files: ${files}` : " (list_vault_files / read_vault_file first if you need paths)"}. Parse the homeworks, slides, study guide, and/or practice exam into topics and required levels, set_goal with those must-know concepts as the targets (not a concept named after the exam), and start teaching to that depth.`,
						},
					},
				],
			};
		}
		if (req.params.name === "practice-test") {
			const topic = typeof req.params.arguments?.topic === "string" ? req.params.arguments.topic.trim() : "";
			return {
				messages: [
					{
						role: "user",
						content: { type: "text", text: `${method}\n\n---\n\n${practiceTestRequest(topic)}` },
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

/** Turn a chat reply into a response; null when a multiple-choice reply matches no option. */
function parseReply(quiz: PreparedQuiz, answer: string, familiarity?: number, note?: string): QuizResponse | null {
	const trimmed = String(answer ?? "").trim().replace(/[.)]$/, "");
	const idkLetter = letter(quiz.options.length);
	const dontKnow = DONT_KNOW.test(trimmed) || (quiz.format !== "free" && trimmed.toUpperCase() === idkLetter);
	if (dontKnow) return { dontKnow, selected: [], familiarity: clampFamiliarity(familiarity) ?? parseFamiliarity(trimmed) ?? 0, note };
	if (quiz.format === "free") return trimmed ? { dontKnow: false, selected: [], text: String(answer).trim(), note } : null;
	const selected = parseChatAnswer(quiz, answer);
	return selected.length ? { dontKnow: false, selected, note } : null;
}

function questionLines(quiz: PreparedQuiz, heading: string): string[] {
	const lines = [heading, quiz.purpose ? `*Why: ${quiz.purpose}*` : "", "", quiz.question, quiz.details ? `\n*${quiz.details}*` : "", ""];
	if (quiz.format === "free") lines.push("*Write your answer (use $...$ for math), or say \"I don't know\".*");
	else lines.push(...quiz.options.map((o, i) => `**${letter(i)}.** ${o.label}`), `**${letter(quiz.options.length)}.** I don't know`);
	return lines;
}

function presentQuiz(quiz: PreparedQuiz): string {
	const free = quiz.format === "free";
	return [
		`Present this quiz to the learner exactly as written (render the math), then STOP and wait for their reply. Do not hint at or reveal the answer. When they reply, call submit_quiz_answer with quiz_id "${quiz.id}" and their reply verbatim.`,
		"",
		"---",
		...questionLines(quiz, `**Quiz · ${quiz.concept} · level ${quiz.difficulty}/5${free ? " · written answer" : quiz.multiSelect ? " · select all that apply" : ""}**`),
		"",
		`*${free ? "Reply with your answer" : `Reply with ${quiz.multiSelect ? "letters" : "a letter"}`}; add a note about your thinking if you like. ${familiarityHelp}*`,
	].join("\n");
}

function presentTest(test: PreparedTest): string {
	const lines = [
		`Present this practice test to the learner exactly as written (render the math), then STOP. Give no hints and no feedback until they have answered everything. When they reply, call submit_practice_test with test_id "${test.id}" and one entry per question, verbatim.`,
		"",
		"---",
		`## ${test.title}`,
		`*${test.questions.length} questions${test.timeLimitMinutes ? ` · ${test.timeLimitMinutes} minutes` : ""}*`,
		test.objective ? `\n**What this measures:** ${test.objective}` : "",
		test.instructions ? `\n${test.instructions}` : "",
	];
	test.questions.forEach((q, i) => lines.push("", ...questionLines(q, `**${i + 1}.** *(${q.concept} · level ${q.difficulty}/5${q.format === "free" ? " · written" : ""})*`)));
	lines.push("", `*Reply with your answers numbered 1–${test.questions.length}. ${familiarityHelp}*`);
	return lines.join("\n");
}

const DK = "__dont_know__";
const familiaritySchema = {
	type: "string",
	title: "If you don't know: how familiar does it feel?",
	oneOf: FAMILIARITY_LABELS.map((l, i) => ({ const: String(i), title: l })),
};

function answerSchema(quiz: PreparedQuiz, title: string) {
	if (quiz.format === "free") return { type: "string", title, description: "Use $...$ for math. Leave empty if you don't know." };
	const choices = quiz.options.map((o, i) => ({ const: o.value, title: `${letter(i)}. ${latexToPlain(o.label)}` }));
	return quiz.multiSelect
		? { type: "array", title: `${title} (select all that apply)`, items: { anyOf: choices } }
		: { type: "string", title, oneOf: [...choices, { const: DK, title: "I don't know" }] };
}

function readAnswer(quiz: PreparedQuiz, raw: unknown, familiarity: unknown, note?: string): QuizResponse {
	const fam = clampFamiliarity(familiarity);
	if (quiz.format === "free") {
		const text = typeof raw === "string" ? raw.trim() : "";
		return text ? { dontKnow: false, selected: [], text, note } : { dontKnow: true, selected: [], familiarity: fam ?? 0, note };
	}
	const selected = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
	const dontKnow = selected.includes(DK) || selected.length === 0;
	return dontKnow ? { dontKnow, selected: [], familiarity: fam ?? 0, note } : { dontKnow, selected, note };
}

const noteOf = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function elicitQuiz(server: Server, quiz: PreparedQuiz) {
	const res = await server.elicitInput({
		message: `Quiz · ${quiz.concept} · level ${quiz.difficulty}/5${quiz.purpose ? `\nWhy: ${latexToPlain(quiz.purpose)}` : ""}\n\n${latexToPlain(quiz.question)}${quiz.details ? `\n\n${latexToPlain(quiz.details)}` : ""}`,
		requestedSchema: {
			type: "object",
			properties: {
				answer: answerSchema(quiz, "Your answer") as any,
				familiarity: familiaritySchema as any,
				note: { type: "string", title: "Note (optional)", description: "What you were thinking or unsure about" },
			},
			required: quiz.format === "free" ? [] : ["answer"],
		},
	});
	if (res.action !== "accept" || !res.content) return { action: res.action, content: null };
	return { action: "accept" as const, content: readAnswer(quiz, res.content.answer, res.content.familiarity, noteOf(res.content.note)) };
}

async function elicitTest(server: Server, test: PreparedTest) {
	const properties: Record<string, any> = {};
	test.questions.forEach((q, i) => {
		properties[`q${i + 1}`] = { ...answerSchema(q, `${i + 1}. ${latexToPlain(q.question)}`) };
		properties[`q${i + 1}_familiarity`] = { ...familiaritySchema, title: `${i + 1}. If you don't know: how familiar?` };
	});
	const started = Date.now();
	const res = await server.elicitInput({
		message: `${test.title} · ${test.questions.length} questions${test.timeLimitMinutes ? ` · ${test.timeLimitMinutes} min` : ""}${test.objective ? `\n\n${latexToPlain(test.objective)}` : ""}${test.instructions ? `\n\n${latexToPlain(test.instructions)}` : ""}`,
		requestedSchema: { type: "object", properties },
	});
	if (res.action !== "accept" || !res.content) return { action: res.action, content: null };
	const answers: TestResponse["answers"] = {};
	test.questions.forEach((q, i) => {
		answers[q.id] = readAnswer(q, res.content![`q${i + 1}`], res.content![`q${i + 1}_familiarity`]);
	});
	return { action: "accept" as const, content: { answers, elapsedSeconds: Math.round((Date.now() - started) / 1000) } satisfies TestResponse };
}

