/**
 * What to do after an answer.
 *
 * Teaching moves forward: ground in what they hold, teach the next step,
 * check it, and that step becomes the ground for the one after. A miss on a
 * check is answered by teaching that step again from a different angle, not
 * by a string of easier quizzes. Only a repeated miss on the same step, or a
 * miss while probing (or on a practice test), starts a short descent: a few
 * smaller questions to find the piece that is actually missing (the floor),
 * then teaching back up to where it broke.
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
/** Per session: concepts whose teaching check was missed and re-taught, not yet passed. */
const retaught = new Map<string, Set<string>>();

export function ladderFor(sessionKey: string): Ladder | undefined {
	return ladders.get(sessionKey);
}

export function clearLadder(sessionKey: string): void {
	ladders.delete(sessionKey);
	retaught.delete(sessionKey);
}

/** Start (or extend) a descent from a miss found elsewhere, e.g. a practice test. */
export function seedLadder(sessionKey: string, rung: Rung): void {
	const l = ladders.get(sessionKey) ?? { missed: [] };
	if (!l.missed.some((r) => sameRung(r, rung))) l.missed.push(rung);
	ladders.set(sessionKey, l);
}

const MAX_DESCENT_BEFORE_TEACHING = 3;

const rungName = (r: Pick<Rung, "concept" | "difficulty">) => `${r.concept} at d${r.difficulty}`;
const sameRung = (a: Rung, b: Rung) => a.concept === b.concept && a.difficulty === b.difficulty;
const quoteQ = (q: string) => `"${q.length > 140 ? `${q.slice(0, 137)}…` : q}"`;
const isTeaching = (kind: EvidenceKind) => kind === "check" || kind === "review";

const WEAK: Record<ConceptStatus, number> = { unassessed: 0, learning: 1, rusty: 2, shaky: 3, solid: 4 };

const OFF_PATH =
	"Only chase a piece the goal actually needs. If it is off the path to the goal, name it in a line and keep going toward the goal.";

/** Record one answer on the session's ladder and say what to ask or teach next. */
export function nextMove(
	sessionKey: string,
	step: Rung & { kind: EvidenceKind; slip?: boolean },
	ctx: { prerequisites: PrerequisiteState[]; floor?: number; ceiling?: number },
): string {
	if (step.kind === "test") return "";
	const ladder = ladders.get(sessionKey);
	if (step.outcome === "correct") return afterCorrect(sessionKey, step, ladder, ctx);
	if (isTeaching(step.kind) && !ladder?.missed.length) return afterTeachingMiss(sessionKey, step, ctx);
	return afterMiss(sessionKey, step, ladder, ctx);
}

function weakPrerequisites(prerequisites: PrerequisiteState[]): PrerequisiteState[] {
	return [...prerequisites].sort((a, b) => WEAK[a.status] - WEAK[b.status]).filter((p) => p.status !== "solid");
}

function solidPrerequisites(prerequisites: PrerequisiteState[]): string {
	const solid = prerequisites.filter((p) => p.status === "solid").map((p) => p.title);
	return solid.length ? ` They already hold ${solid.join(", ")}: build on that.` : "";
}

function afterTeachingMiss(sessionKey: string, step: Rung, ctx: { prerequisites: PrerequisiteState[] }): string {
	const seen = retaught.get(sessionKey) ?? new Set<string>();
	retaught.set(sessionKey, seen);
	const lines: string[] = [];

	if (!seen.has(step.concept)) {
		seen.add(step.concept);
		lines.push(
			`Next move — keep teaching forward; do not start a string of easier quizzes. Say in a line what went wrong, then teach this step again from a different angle: the other representation of the same fact (a picture or a concrete case if you used symbols, symbols if you used a picture), and say it is the same fact. A new set of numbers in the same template is the same angle. Ground it in what they already know.${solidPrerequisites(ctx.prerequisites)} Then check it once with a fresh question at the same level, on a new case.`,
		);
		if (step.outcome === "dont_know") {
			const f = step.familiarity ?? 0;
			lines.push(
				f >= 3
					? `They said "I don't know" but it felt very familiar (${familiarityLabel(f)}): give a short cue or the first move, then let them finish the faded step.`
					: `They said "I don't know" (${familiarityLabel(f)}): skip another attempt. Teach it directly, concrete case first, then the same fact in symbols, before asking again.`,
			);
		} else if (step.outcome === "partial") {
			lines.push("Partly right: name the one piece that broke and fix it in the explanation. If the core idea of this node is there, move on instead of re-checking.");
		} else if (step.misconception) {
			lines.push(
				`Their answer points to a belief: "${step.misconception}". If that belief is a wrong claim inside the right idea, show one case where it gives the wrong answer. If it files the idea under the wrong kind (a process treated as a thing, a limit treated as plugging in), name the kind it is and the kind it is not.`,
			);
		}
		lines.push("If it was really a slip (they plainly understand, only the arithmetic or a click went wrong), say so and continue with the plan instead.");
		return lines.join("\n");
	}

	const l: Ladder = { missed: [step] };
	ladders.set(sessionKey, l);
	const weakest = weakPrerequisites(ctx.prerequisites);
	lines.push(
		`Next move — second miss on ${step.concept} after re-teaching, so a piece underneath is probably missing. Ask one quick question on the single piece this step most depends on${
			weakest.length ? ` (weakest prerequisite: ${weakest[0].title}, ${weakest[0].status})` : ""
		}, easier than this one. Right → teach from there back up to this step. Wrong → teach that piece directly. ${OFF_PATH}`,
	);
	return lines.join("\n");
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
	if (depth >= MAX_DESCENT_BEFORE_TEACHING) {
		lines.push(
			`Next move — ${depth} rungs down without a correct answer. Stop asking: teach the most basic piece directly (as an unconditional truth or a short derivation), confirm it reads as obviously true, then teach forward from it toward ${rungName(l.missed[0])}. ${OFF_PATH}`,
		);
		return lines.join("\n");
	}

	lines.push(
		depth === 1
			? "Next move — this question sat above their frontier. Find where it starts with one or two smaller questions, not a long descent, then teach up from the first one they get right."
			: `Next move — still above their frontier (${depth} rungs down from ${rungName(l.missed[0])}). One more smaller question at most, then teach.`,
	);

	const weakest = weakPrerequisites(ctx.prerequisites);
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
				`Something is there. Ask about the one piece it most needs, easier: this concept at d${Math.max(1, step.difficulty - 2)}, or a prerequisite. ${prereqText}`,
			);
		}
	} else if (step.outcome === "partial") {
		lines.push(`Partly right: part of the method is there. Ask a question on only the step that went wrong, one level easier (d${Math.max(1, step.difficulty - 1)}).`);
	} else {
		if (step.misconception) {
			lines.push(`Their answer points to a belief: "${step.misconception}". Dislodge it explicitly when you teach.`);
		}
		lines.push(`Step down: the same idea at d${Math.max(1, step.difficulty - 1)} or one piece of it. ${prereqText}`);
	}
	lines.push(OFF_PATH);
	return lines.join("\n");
}

function afterCorrect(
	sessionKey: string,
	step: Rung & { kind: EvidenceKind; slip?: boolean },
	ladder: Ladder | undefined,
	ctx: { floor?: number; ceiling?: number },
): string {
	const recovered = retaught.get(sessionKey)?.delete(step.concept) ?? false;
	const slipNote = step.slip ? "It was a slip, not a gap: mention it in a line and move on. " : "";
	if (!ladder || !ladder.missed.length) {
		ladders.delete(sessionKey);
		if (recovered) return `Next move — ${slipNote}${step.concept} landed after re-teaching. Continue forward to the next step of the plan; do not re-check it.`;
		if (step.kind !== "probe") return slipNote ? `Next move — ${slipNote}Continue with the plan.` : "";
		if (ctx.ceiling !== undefined && ctx.ceiling <= step.difficulty + 1 && ctx.ceiling > step.difficulty) {
			return `Next move — ${slipNote}edge bracketed on ${step.concept}: holds d${step.difficulty}, misses d${ctx.ceiling}. Teaching on this strand starts at d${ctx.ceiling}.`;
		}
		if (ctx.ceiling === undefined && step.difficulty < 5) {
			return `Next move — ${slipNote}no ceiling found yet on ${step.concept}. Jump to d${Math.min(5, step.difficulty + 2)} rather than inching up, or stop probing this strand if you know enough to plan.`;
		}
		return slipNote ? `Next move — ${slipNote}` : "";
	}

	ladder.floor = step;
	const climbed = ladder.missed.filter((r) => r.concept === step.concept && r.difficulty <= step.difficulty);
	ladder.missed = ladder.missed.filter((r) => !climbed.includes(r));
	const next = ladder.missed[ladder.missed.length - 1];
	if (!next) {
		const origin = climbed[0] ?? step;
		ladders.delete(sessionKey);
		return `Next move — ${slipNote}gap closed: they now answer ${rungName(origin)}, the level they originally missed. Continue the plan toward the goal.`;
	}
	const origin = ladder.missed[0];
	return [
		climbed.length
			? `Next move — ${slipNote}rung climbed (${rungName(step)}).`
			: `Next move — ${slipNote}floor found: they hold ${rungName(step)}. Teach forward from here; no more descending.`,
		`Next rung up: ${rungName(next)} — ${quoteQ(next.question)}. Teach just the step from what they showed to that rung: one contrast, then the statement that names it, then a check on a new case at that level.`,
		ladder.missed.length > 1 ? `Rungs left to the original question (${rungName(origin)}): ${ladder.missed.length}.` : "",
	]
		.filter(Boolean)
		.join("\n");
}
