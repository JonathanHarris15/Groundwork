/**
 * Diagnose down, then build up.
 *
 * A miss or an "I don't know" says the question was above the learner's
 * frontier, not where the frontier is. Re-explaining from one step back
 * teaches into mid-air. Instead, each session keeps a ladder: the missed
 * rungs, top (the original question) to bottom. The tutor keeps asking
 * smaller, easier questions until one is answered correctly (the floor),
 * then teaches the rung directly above it and climbs back, one checked rung
 * at a time, until the original question is answered.
 */

import type { ConceptStatus, EvidenceKind, Outcome } from "./model";
import { familiarityLabel } from "./quiz";

export interface Rung {
	concept: string;
	difficulty: number;
	question: string;
	outcome: Outcome;
	familiarity?: number;
	misconception?: string;
}

export interface PrerequisiteState {
	title: string;
	status: ConceptStatus;
	floor?: number;
}

export interface Ladder {
	/** Missed rungs still to climb, in the order they were missed: [0] is the original question. */
	missed: Rung[];
	/** The highest rung answered correctly since the descent started. */
	floor?: Rung;
}

const ladders = new Map<string, Ladder>();

export function ladderFor(sessionKey: string): Ladder | undefined {
	return ladders.get(sessionKey);
}

export function clearLadder(sessionKey: string): void {
	ladders.delete(sessionKey);
}

/** Start (or extend) a descent from a miss found elsewhere, e.g. a practice test. */
export function seedLadder(sessionKey: string, rung: Rung): void {
	const l = ladders.get(sessionKey) ?? { missed: [] };
	if (!l.missed.some((r) => sameRung(r, rung))) l.missed.push(rung);
	ladders.set(sessionKey, l);
}

const MAX_DESCENT_BEFORE_TEACHING = 4;

const rungName = (r: Pick<Rung, "concept" | "difficulty">) => `${r.concept} at d${r.difficulty}`;
const sameRung = (a: Rung, b: Rung) => a.concept === b.concept && a.difficulty === b.difficulty;
const quoteQ = (q: string) => `"${q.length > 140 ? `${q.slice(0, 137)}…` : q}"`;

const WEAK: Record<ConceptStatus, number> = { unassessed: 0, learning: 1, rusty: 2, shaky: 3, solid: 4 };

/** Record one answer on the session's ladder and say what to ask or teach next. */
export function nextMove(
	sessionKey: string,
	step: Rung & { kind: EvidenceKind },
	ctx: { prerequisites: PrerequisiteState[]; floor?: number; ceiling?: number },
): string {
	if (step.kind === "test") return "";
	const ladder = ladders.get(sessionKey);
	return step.outcome === "correct" ? afterCorrect(sessionKey, step, ladder, ctx) : afterMiss(sessionKey, step, ladder, ctx);
}

function afterMiss(sessionKey: string, step: Rung, ladder: Ladder | undefined, ctx: { prerequisites: PrerequisiteState[] }): string {
	const l = ladder ?? { missed: [] };
	const top = l.missed[l.missed.length - 1];
	if (!top || !sameRung(top, step)) l.missed.push(step);
	ladders.set(sessionKey, l);

	const lines: string[] = [];
	if (l.floor) {
		lines.push(
			`Next move — this rung is where it breaks now. They hold ${rungName(l.floor)}; they miss ${rungName(step)}. Teach only the step between those two, building explicitly on what they just showed, in a smaller increment than before. Then check it with a fresh question at this level.`,
		);
		return lines.join("\n");
	}

	const depth = l.missed.length;
	lines.push(
		depth === 1
			? "Next move — do NOT re-teach yet. A miss shows the question was above their frontier, not where the frontier is. Find the floor first: ask smaller, easier questions until one is answered correctly, then teach up from there."
			: `Next move — still above their frontier (${depth} rungs down from ${rungName(l.missed[0])} without a correct answer). Keep descending.`,
	);

	const weakest = [...ctx.prerequisites].sort((a, b) => WEAK[a.status] - WEAK[b.status]).filter((p) => p.status !== "solid");
	const prereqText = weakest.length
		? `Its prerequisites, weakest first: ${weakest.map((p) => `${p.title} (${p.status}${p.floor ? `, holds d${p.floor}` : ""})`).join(", ")}.`
		: ctx.prerequisites.length
			? `Its recorded prerequisites (${ctx.prerequisites.map((p) => p.title).join(", ")}) are solid, so the gap is inside this concept: split the question into its sub-steps.`
			: "It has no recorded prerequisites yet: name the pieces this question needs (definitions, notation, the sub-steps), add them with upsert_concept, and ask about the most basic one.";

	if (step.outcome === "dont_know") {
		const f = step.familiarity ?? 0;
		lines.push(`They said "I don't know" — familiarity: ${familiarityLabel(f)} (${f}/3).`);
		if (f >= 3) {
			lines.push(
				`Tip of the tongue: the idea is probably there but not retrievable. Give a retrieval cue (a first step, a related fact, the notation), not the answer, and ask the same idea one level easier (d${Math.max(1, step.difficulty - 1)}). A correct answer then is the floor.`,
			);
		} else if (f === 0 || step.difficulty <= 1) {
			lines.push(`Nothing to build on in this concept yet, so drop below it. ${prereqText}`);
		} else {
			lines.push(
				`Something is there. Break the question into the pieces it needs and ask about one piece at a time, easiest plausible first: this concept at d${Math.max(1, step.difficulty - 2)}, or a prerequisite. ${prereqText}`,
			);
		}
	} else if (step.outcome === "partial") {
		lines.push(`Partly right: part of the method is there. Ask a question on only the step that went wrong, one level easier (d${Math.max(1, step.difficulty - 1)}).`);
	} else {
		if (step.misconception) {
			lines.push(`Their answer points to a belief: "${step.misconception}". Next, ask a smaller question that only someone holding that belief would miss, to confirm it before dislodging it.`);
		}
		lines.push(`Step down: the same idea at d${Math.max(1, step.difficulty - 1)} or one piece of it. ${prereqText}`);
	}
	if (depth >= MAX_DESCENT_BEFORE_TEACHING) {
		lines.push(
			`That is ${depth} rungs without a correct answer. Stop descending: state the most basic piece directly as an unconditional truth, confirm it reads as obviously true, and check it. That becomes the floor.`,
		);
	}
	lines.push("One question per rung; change the question, not just the numbers.");
	return lines.join("\n");
}

function afterCorrect(sessionKey: string, step: Rung, ladder: Ladder | undefined, ctx: { floor?: number; ceiling?: number }): string {
	if (!ladder || !ladder.missed.length) {
		ladders.delete(sessionKey);
		if (ctx.ceiling !== undefined && ctx.ceiling <= step.difficulty + 1 && ctx.ceiling > step.difficulty) {
			return `Next move — edge bracketed on ${step.concept}: holds d${step.difficulty}, misses d${ctx.ceiling}. Teaching on this strand starts at d${ctx.ceiling}.`;
		}
		if (ctx.ceiling === undefined && step.difficulty < 5) {
			return `Next move — no ceiling found yet on ${step.concept}. If you are probing, jump to d${Math.min(5, step.difficulty + 2)} rather than inching up.`;
		}
		return "";
	}

	ladder.floor = step;
	const climbed = ladder.missed.filter((r) => r.concept === step.concept && r.difficulty <= step.difficulty);
	ladder.missed = ladder.missed.filter((r) => !climbed.includes(r));
	const next = ladder.missed[ladder.missed.length - 1];
	if (!next) {
		const origin = climbed[0] ?? step;
		ladders.delete(sessionKey);
		return `Next move — gap closed: they now answer ${rungName(origin)}, the level they originally missed. Continue the plan; revisit this concept with a spaced review later.`;
	}
	const origin = ladder.missed[0];
	return [
		climbed.length
			? `Next move — rung climbed (${rungName(step)}).`
			: `Next move — floor found: they hold ${rungName(step)}. This is where teaching starts, not where you left off.`,
		`Next rung up: ${rungName(next)} — ${quoteQ(next.question)}. Teach just the step from what they showed to that rung (motivate → establish → connect), then check it with a new question at that level.`,
		ladder.missed.length > 1 ? `Rungs left to the original question (${rungName(origin)}): ${ladder.missed.length}.` : "",
	]
		.filter(Boolean)
		.join("\n");
}
