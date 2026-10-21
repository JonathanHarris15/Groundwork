import type { BulkFile, ExtractedConcept } from "../../src/bulk-import";

export const BULK_ASK = "Help me learn all of these lectures";

interface Deck extends BulkFile {
	concepts: ExtractedConcept[];
}

function deck(path: string, concepts: ExtractedConcept[]): Deck {
	const name = path.split("/").pop() ?? path;
	const text = concepts.map((concept) => `# ${concept.title}\n${concept.summary ?? concept.title}\n`).join("\n");
	return { path, name, text, concepts: concepts.map((concept) => ({ ...concept, sources: concept.sources.map((source) => ({ ...source, path })) })) };
}

const at = (path: string, locator: string) => [{ path, locator }];

export const NINE_DECKS: Deck[] = [
	deck("resources/lecture-1-limits.md", [
		{ title: "Limit", summary: "The value a function approaches.", prerequisites: [], requiredLevel: 2, sources: at("", "slide 2") },
		{ title: "One-sided limit", summary: "A limit from one side only.", prerequisites: ["Limit"], requiredLevel: 2, sources: at("", "slide 4") },
	]),
	deck("resources/lecture-2-derivative.md", [
		{ title: "Difference quotient", summary: "The change in a function over a small step.", prerequisites: ["Limit"], requiredLevel: 2, sources: at("", "slide 1") },
		{ title: "Derivative", summary: "The instantaneous rate of change.", prerequisites: ["Limit"], requiredLevel: 3, sources: at("", "slide 3") },
	]),
	deck("resources/lecture-3-rules.md", [
		{ title: "Lecture 3 slides", summary: "A file of rules.", prerequisites: [], sources: at("", "slide 1") },
		{ title: "Power rule", summary: "Differentiate a power by bringing the exponent down.", prerequisites: ["Derivative", "Eigenvalue"], requiredLevel: 3, sources: at("", "slide 2") },
		{ title: "Product rule", summary: "The derivative of a product of two functions.", prerequisites: ["Derivative"], requiredLevel: 3, sources: at("", "slide 5") },
	]),
	deck("resources/lecture-4-chain.md", [
		{ title: "Chain rule", summary: "The derivative of a composition.", prerequisites: ["Derivative"], requiredLevel: 3, sources: at("", "slide 2") },
		{ title: "The Chain Rule", summary: "Differentiate an outer function and an inner function.", prerequisites: ["Derivative"], requiredLevel: 3, sources: at("", "slide 3") },
		{ title: "Derivative", summary: "The instantaneous rate of change.", prerequisites: ["Chain rule", "Limit"], requiredLevel: 3, sources: at("", "slide 1") },
		{ title: "Implicit differentiation", summary: "Differentiate an equation that mixes x and y.", prerequisites: ["Chain rule"], requiredLevel: 4, sources: at("", "slide 8") },
	]),
	deck("resources/homework-1-limits.md", [
		{ title: "Limits", summary: "The value a function approaches.", prerequisites: [], requiredLevel: 3, sources: at("", "problem 1") },
		{ title: "Squeeze theorem", summary: "A function trapped between two others shares their limit.", prerequisites: ["Limit"], requiredLevel: 3, sources: at("", "problem 2") },
	]),
	deck("resources/homework-2-derivative.md", [
		{ title: "Derivative", prerequisites: ["Limit"], requiredLevel: 3, sources: at("", "problem 1") },
		{ title: "Tangent line", summary: "The line that matches a curve at a point.", prerequisites: ["Derivative"], requiredLevel: 3, sources: at("", "problem 2") },
	]),
	deck("resources/lecture-5-integrals.md", [
		{ title: "Antiderivative", summary: "A function whose derivative is the one you started with.", prerequisites: ["Derivative"], requiredLevel: 3, sources: at("", "slide 2") },
		{ title: "Definite integral", summary: "The signed area under a curve on an interval.", prerequisites: ["Antiderivative"], requiredLevel: 3, sources: at("", "slide 6") },
	]),
	deck("resources/lecture-6-ftc.md", [
		{
			title: "Fundamental theorem",
			summary: "Differentiation and integration undo each other.",
			prerequisites: ["Definite integral", "Derivative"],
			requiredLevel: 4,
			sources: at("", "slide 3"),
		},
	]),
	deck("resources/homework-3-applications.md", [
		{ title: "FTC", summary: "Differentiation and integration undo each other.", prerequisites: ["Definite integral", "Derivative"], requiredLevel: 4, sources: at("", "problem 1") },
		{ title: "Related rates", summary: "How two changing quantities affect each other.", prerequisites: ["Chain rule"], requiredLevel: 4, sources: at("", "problem 2") },
		{ title: "Optimization", summary: "Find a maximum or minimum of a function.", prerequisites: ["Derivative"], requiredLevel: 4, sources: at("", "problem 3") },
	]),
];

export function nineDeckFiles(): BulkFile[] {
	return NINE_DECKS.map(({ path, name, text }) => ({ path, name, text }));
}

/** A stand-in sub-agent. It returns the concepts for the documents named in the prompt. */
export function scriptedBulkReply(system: string, user: string): { text: string; usage: { input: number; output: number } } {
	const usage = { input: 1000, output: 200 };
	if (system.includes("reconcile")) {
		return { text: JSON.stringify({ renames: [{ from: "FTC", to: "Fundamental theorem" }, { from: "Limits", to: "Limit" }] }), usage };
	}
	const concepts = NINE_DECKS.filter((deck) => user.includes(deck.path)).flatMap((deck) => deck.concepts);
	return { text: JSON.stringify({ concepts }), usage };
}
