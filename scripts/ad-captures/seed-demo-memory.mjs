#!/usr/bin/env node
/**
 * Seed a local demo account for Groundwork ad captures.
 *
 * Writes a tutor-memory file and an accounts file. No production data.
 * Usage: npx tsx scripts/ad-captures/seed-demo-memory.mjs [memory.json] [accounts.json]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryVaultIO, KnowledgeStore, knowledgeSnapshot, tutorMemoryFiles, buildExamBlueprint, flashcardQualityIssue } from "@groundwork/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const examPath = path.join(root, "scripts/ad-captures/fixtures/MATH-151-practice-exam.md");

const memoryOut = process.argv[2] || path.join(root, "tmp/ad-captures/tutor-memory.json");
const accountsOut = process.argv[3] || path.join(root, "tmp/ad-captures/accounts.json");

const now = new Date();
let clock = new Date(now);

function isoDaysAgo(days, hour = 16) {
	const d = new Date(now.getTime() - days * 86_400_000);
	d.setUTCHours(hour, 0, 0, 0);
	return d.toISOString();
}

function utcDate(offsetDays) {
	const d = new Date(now.getTime() + offsetDays * 86_400_000);
	return d.toISOString().slice(0, 10);
}

const GOAL_TITLE = "Derivatives for Calc I";
const GOAL_DUE = utcDate(21);

const nodes = [
	{ title: "Functions", summary: "A rule that assigns one output to each input." },
	{ title: "Slope of a line", prerequisites: ["Functions"], summary: "Rise over run, the same number for any two points on a straight line." },
	{ title: "Average rate of change", prerequisites: ["Slope of a line"], summary: "The slope of the secant through two points on a curve." },
	{ title: "Limits", prerequisites: ["Functions"], summary: "The value a function approaches as the input approaches a point." },
	{ title: "Difference quotient", prerequisites: ["Average rate of change", "Limits"], summary: "The secant slope $\\frac{f(x+h)-f(x)}{h}$." },
	{ title: "Derivative definition", prerequisites: ["Difference quotient"], summary: "The derivative is the limit of the difference quotient as $h$ approaches 0." },
	{ title: "Power rule", prerequisites: ["Derivative definition"], summary: "$\\frac{d}{dx} x^n = n x^{n-1}$." },
	{ title: "Product rule", prerequisites: ["Power rule"], summary: "$(uv)' = u'v + uv'$." },
	{ title: "Chain rule", prerequisites: ["Product rule"], summary: "Differentiate the outside, then multiply by the derivative of the inside." },
	{ title: "Quotient rule", prerequisites: ["Derivative definition"], summary: "The derivative of a quotient, from the product rule and the chain rule on $1/v$." },
	{ title: "Derivative of sine", prerequisites: ["Derivative definition"], summary: "$\\frac{d}{dx}\\sin x = \\cos x$." },
	{ title: "Derivative of cosine", prerequisites: ["Derivative definition"], summary: "$\\frac{d}{dx}\\cos x = -\\sin x$." },
	{ title: "Continuity", prerequisites: ["Limits"], summary: "The limit equals the function value." },
	{ title: "Tangent line", prerequisites: ["Derivative definition"], summary: "The line through a point whose slope is the derivative there." },
];

const targets = [
	"Functions",
	"Slope of a line",
	"Average rate of change",
	"Limits",
	"Difference quotient",
	"Derivative definition",
	"Power rule",
	"Product rule",
	"Chain rule",
	"Quotient rule",
	"Derivative of sine",
	"Derivative of cosine",
];

export const EXAM_GOAL_TITLE = "Prepare for MATH 151 practice";

export function examGoalInput(sourcePath) {
	return {
		title: EXAM_GOAL_TITLE,
		objective: "Be able to differentiate the functions on the MATH 151 practice exam: powers, products, quotients, sine, cosine, and compositions.",
		why: "The practice exam is the checklist for the Calc I exam.",
		due: utcDate(22),
		targets: [
			"Derivative definition",
			"Power rule",
			"Product rule",
			"Chain rule",
			"Quotient rule",
			"Derivative of sine",
			"Derivative of cosine",
		],
		nodes: nodes
			.filter((n) =>
				[
					"Functions",
					"Slope of a line",
					"Average rate of change",
					"Limits",
					"Difference quotient",
					"Derivative definition",
					"Power rule",
					"Product rule",
					"Chain rule",
					"Quotient rule",
					"Derivative of sine",
					"Derivative of cosine",
					"Continuity",
					"Tangent line",
				].includes(n.title),
			)
			.map((n) => ({ ...n, requiredLevel: 2 })),
		weights: [
			{ title: "Derivative of sine", weight: 28 },
			{ title: "Derivative of cosine", weight: 16 },
			{ title: "Chain rule", weight: 16 },
			{ title: "Quotient rule", weight: 12 },
			{ title: "Product rule", weight: 8 },
		],
		sources: sourcePath ? [sourcePath] : [],
	};
}

async function quiz(store, title, outcome, difficulty, ts) {
	return store.recordEvidence(title, {
		outcome,
		difficulty,
		kind: "check",
		ts,
		question: title,
		device: "Demo",
	});
}

async function solid(store, title) {
	for (const day of [14, 11, 8, 5, 2]) {
		await quiz(store, title, "correct", 4, isoDaysAgo(day, 15));
	}
}

async function seedStore() {
	const io = new MemoryVaultIO();
	const store = new KnowledgeStore(io, { now: () => new Date(clock), device: "Demo" });
	await store.ensureLayout();

	// A few days in, so the goals board is on pace instead of a long row of missed days.
	clock = new Date(now.getTime() - 3 * 86_400_000);
	const report = await store.setGoal({
		title: GOAL_TITLE,
		objective: "Differentiate from the definition, then use the power, product, quotient, and chain rules, including sine and cosine.",
		why: "Calc I exam in three weeks.",
		due: GOAL_DUE,
		targets,
		nodes,
		weights: [
			{ title: "Chain rule", weight: 22 },
			{ title: "Quotient rule", weight: 12 },
			{ title: "Derivative of sine", weight: 12 },
			{ title: "Derivative of cosine", weight: 12 },
			{ title: "Product rule", weight: 10 },
		],
	});
	await store.setWorkingGoal(report.goal.title);
	clock = new Date(now);

	await solid(store, "Functions");
	await solid(store, "Slope of a line");
	await solid(store, "Average rate of change");
	await solid(store, "Tangent line");

	for (const hour of [10, 11, 12, 14]) {
		await quiz(store, "Limits", "correct", 5, isoDaysAgo(18, hour));
	}

	await quiz(store, "Difference quotient", "incorrect", 3, isoDaysAgo(3, 15));
	await quiz(store, "Difference quotient", "partial", 3, isoDaysAgo(1, 15));

	await quiz(store, "Derivative definition", "correct", 3, isoDaysAgo(2, 15));
	await quiz(store, "Derivative definition", "correct", 3, isoDaysAgo(1, 11));

	await quiz(store, "Power rule", "correct", 2, isoDaysAgo(4, 15));
	await quiz(store, "Power rule", "partial", 3, isoDaysAgo(2, 15));
	const power = await quiz(store, "Power rule", "incorrect", 3, isoDaysAgo(0, 15));

	await quiz(store, "Continuity", "incorrect", 3, isoDaysAgo(2, 15));
	await quiz(store, "Continuity", "correct", 2, isoDaysAgo(1, 15));

	await store.recomputeAll();

	const concepts = await store.concepts();
	const statuses = Object.fromEntries([...concepts.values()].map((c) => [c.title, c.stats.status]));
	const expected = {
		Functions: "solid",
		"Slope of a line": "solid",
		"Average rate of change": "solid",
		"Tangent line": "solid",
		Limits: "rusty",
		"Difference quotient": "learning",
		"Derivative definition": "shaky",
		"Power rule": "learning",
		Continuity: "learning",
		"Product rule": "unassessed",
		"Chain rule": "unassessed",
		"Quotient rule": "unassessed",
		"Derivative of sine": "unassessed",
		"Derivative of cosine": "unassessed",
	};
	const mismatches = Object.entries(expected).filter(([title, status]) => statuses[title] !== status);
	if (mismatches.length) {
		const detail = mismatches.map(([title, status]) => `${title}: wanted ${status}, got ${statuses[title]}`).join("\n");
		throw new Error(`Mastery mix is off.\n${detail}\n${JSON.stringify(statuses, null, 2)}`);
	}

	const goalReport = await store.goalReport(GOAL_TITLE);
	const libUpdated = now.toISOString();
	const deckId = "deck-derivatives";
	const card = (id, concept, front, back, state, extra = {}) => ({
		id,
		deckId,
		concept,
		front,
		back,
		createdAt: isoDaysAgo(6),
		updatedAt: libUpdated,
		state,
		due: isoDaysAgo(0, 8),
		intervalMinutes: state === "review" ? 3 * 24 * 60 : 0,
		ease: 2.5,
		reps: state === "review" ? 3 : 0,
		lapses: 0,
		lastReviewed: state === "review" ? isoDaysAgo(4) : undefined,
		...extra,
	});
	const cards = [
		card("card-power", "Power rule", "What is $\\frac{d}{dx} x^n$?", "$nx^{n-1}$", "review", { due: isoDaysAgo(2, 9) }),
		card("card-sine", "Derivative of sine", "What is $\\frac{d}{dx}\\sin x$?", "$\\cos x$", "review"),
		card("card-cosine", "Derivative of cosine", "What is $\\frac{d}{dx}\\cos x$?", "$-\\sin x$", "review"),
		card("card-product", "Product rule", "What is $(uv)'$?", "$u'v+uv'$", "review"),
		card("card-chain", "Chain rule", "What is $\\frac{d}{dx} f(g(x))$?", "$f'(g(x))g'(x)$", "review"),
		card("card-const", "Derivative definition", "What is $\\frac{d}{dx}(5)$?", "$0$", "new", { intervalMinutes: 0, reps: 0, lastReviewed: undefined }),
		card("card-linear", "Power rule", "What is $\\frac{d}{dx}(3x)$?", "$3$", "review"),
		card("card-secant", "Average rate of change", "A secant slope is the change in $y$ over what?", "the change in $x$", "review"),
	];
	for (const c of cards) {
		const issue = flashcardQualityIssue(c.front, c.back);
		if (issue) throw new Error(`Card ${c.id} is not atomic: ${issue}`);
	}
	await io.write(
		".groundwork/flashcards.json",
		JSON.stringify(
			{
				updatedAt: libUpdated,
				addFromTeachingNotes: false,
				decks: [{ id: deckId, title: "Derivatives", goalId: report.goal.id, fileName: "Derivatives.md" }],
				cards,
			},
			null,
			2,
		),
	);

	const chatId = "chat-power-rule";
	const chat = {
		id: chatId,
		title: "Power rule",
		created: isoDaysAgo(0, 14),
		updated: now.toISOString(),
		messages: [],
		items: [
			{
				kind: "quiz",
				quiz: {
					id: "q-power-rule",
					concept: "Power rule",
					question: "What is $\\frac{d}{dx}(x^3)$?",
					purpose: "Whether the power rule matches the derivative you get from the definition.",
					format: "choice",
					options: [
						{ label: "$3x^2$", value: "three-x-squared" },
						{ label: "$3x$", value: "three-x", misconception: "Drops the exponent by two instead of one" },
						{ label: "$x^2$", value: "x-squared", misconception: "Forgets to multiply by the old exponent" },
					],
					correct: ["three-x-squared"],
					explanation: "The exponent comes down as a coefficient, then drops by one: $3x^{2}$.",
					difficulty: 3,
					kind: "check",
					multiSelect: false,
				},
				response: { dontKnow: false, selected: ["three-x"] },
				grade: {
					outcome: "incorrect",
					correct: false,
					selectedLabels: ["$3x$"],
					correctLabels: ["$3x^2$"],
					misconception: "Drops the exponent by two instead of one",
				},
				before: power.before,
				after: power.after,
			},
			{
				kind: "assistant",
				text: [
					"That answer keeps the 3 and drops the power all the way to $x$. That is one step too far.",
					"",
					"Take $f(x) = x^3$ at $x = 2$, so $f(2) = 8$. Step forward by $h = 0.1$: $f(2.1) = 9.261$. The rise is $1.261$ and the run is $0.1$, so the secant slope is $12.61$.",
					"",
					"The power rule says $f'(2) = 3 \\cdot 2^2 = 12$. The secant is already close to 12, and it gets closer as $h$ shrinks. $3x$ at the same point is 6. The exponent comes down, then drops by one: $x^3$ becomes $3x^2$.",
				].join("\n"),
			},
		],
	};
	await io.write(`.groundwork/chats/${chatId}.json`, JSON.stringify(chat, null, 2));

	const conceptsList = [...concepts.values()];
	const goals = await store.goals();
	const updatedAt = now.toISOString();
	return {
		statuses,
		goal: goalReport.goal.title,
		due: goalReport.goal.due,
		memory: { updatedAt, files: tutorMemoryFiles(io.files) },
		knowledge: knowledgeSnapshot(
			conceptsList.map((c) => ({ id: c.id, title: c.title, prerequisites: c.prerequisites, stats: c.stats })),
			goals.map((g) => ({ title: g.title, status: g.status, targets: g.targets, built: g.built })),
			updatedAt,
		),
	};
}

async function main() {
	const examText = await readFile(examPath, "utf8");
	const blueprint = buildExamBlueprint(
		[{ name: "MATH-151-practice-exam.md", path: "resources/MATH-151-practice-exam.md", kind: "practice_exam", text: examText }],
		{ userText: "Prep me for this practice exam." },
	);
	if (blueprint.title !== EXAM_GOAL_TITLE) {
		throw new Error(`Exam blueprint title is "${blueprint.title}", expected "${EXAM_GOAL_TITLE}". Topics: ${blueprint.topics.map((t) => t.title).join(", ")}`);
	}
	const record = await seedStore();
	await mkdir(path.dirname(memoryOut), { recursive: true });
	await mkdir(path.dirname(accountsOut), { recursive: true });
	await writeFile(
		memoryOut,
		JSON.stringify({ users: { local: { memory: record.memory, knowledge: record.knowledge } } }, null, 2),
	);
	await writeFile(
		accountsOut,
		JSON.stringify(
			{
				users: {
					local: {
						plan: "included",
						period: now.toISOString().slice(0, 7),
						spentUsd: 0,
						displayName: "Demo",
					},
				},
			},
			null,
			2,
		),
	);
	console.log(
		JSON.stringify(
			{
				memory: memoryOut,
				accounts: accountsOut,
				goal: record.goal,
				due: record.due,
				statuses: record.statuses,
				examTopics: blueprint.topics.map((t) => t.title),
				examTitle: blueprint.title,
			},
			null,
			2,
		),
	);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
