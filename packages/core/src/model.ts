/**
 * Calibrated knowledge model.
 *
 * Every graded interaction is stored as an immutable `Evidence` event. A
 * concept's state is a pure function of its evidence (event sourcing), so two
 * machines that recorded quizzes offline converge once their append-only logs
 * are merged: replay the union and you get the same numbers everywhere.
 *
 * Two quantities are tracked per concept:
 *
 * - ability θ (logits): a Rasch/Elo-style estimate. A question of difficulty d
 *   (1–5) has location b = d − 3, and P(correct) = σ(θ − b). Each answer moves
 *   θ by K·(outcome − P), with K shrinking as evidence accumulates, so early
 *   answers move the estimate a lot and later ones refine it.
 * - memory half-life h (days): how long until recall odds halve. Spaced
 *   successes grow it, crammed successes barely do, misses shrink it.
 *
 * `current` combines both: ability discounted by forgetting since the last
 * evidence. That is the number used to decide what is solid, what is rusty,
 * and what to review.
 */

export type Outcome = "correct" | "partial" | "incorrect" | "dont_know";
export type EvidenceKind = "probe" | "check" | "review" | "explain" | "test";

/** "I don't know" is a spectrum: 0 = never seen this … 3 = very familiar, almost have it. */
export const MAX_FAMILIARITY = 3;

export interface Evidence {
	ts: string;
	concept: string;
	outcome: Outcome;
	/** 1 = recall a definition … 5 = transfer to a novel problem. */
	difficulty: number;
	kind: EvidenceKind;
	question?: string;
	chosen?: string;
	correctAnswer?: string;
	/** What the chosen distractor reveals about the learner's model. */
	misconception?: string;
	/** For "dont_know": how familiar the question felt, 0 (never seen) … MAX_FAMILIARITY (almost have it). */
	familiarity?: number;
	/** Right method, non-conceptual error (arithmetic, sign, copying, typo). Stored with outcome "correct". */
	slip?: boolean;
	/** Free-response questions: what the learner wrote. */
	response?: string;
	note?: string;
	session?: string;
	device?: string;
}

export type ConceptStatus = "unassessed" | "learning" | "shaky" | "solid" | "rusty";

export interface ConceptStats {
	ability: number;
	attempts: number;
	correct: number;
	halfLifeDays: number;
	lastEvidence?: string;
	/** P(correct) on a medium (d=3) question if asked right after the last evidence. */
	mastery: number;
	/** 2^(−Δt/h): fraction of memory strength left since the last evidence. */
	retention: number;
	/** mastery discounted by forgetting — what we believe right now. */
	current: number;
	status: ConceptStatus;
	nextReview?: string;
	/** Highest difficulty answered correctly (floor of the bracketed edge). */
	floor?: number;
	/** Lowest difficulty missed after the last floor raise (ceiling of the edge). */
	ceiling?: number;
	openMisconceptions: string[];
}

const DAY_MS = 86_400_000;
const REVIEW_AT_RETENTION = 0.7;
const SOLID = 0.8;
const SHAKY = 0.6;
/** A slip is noted, not held against them: nearly full credit, and it still counts as a success for memory and the edge. */
export const SLIP_CREDIT = 0.9;

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function difficultyLocation(difficulty: number): number {
	return clamp(Math.round(difficulty), 1, 5) - 3;
}

export function emptyStats(): ConceptStats {
	return {
		ability: 0,
		attempts: 0,
		correct: 0,
		halfLifeDays: 1,
		mastery: sigmoid(0),
		retention: 1,
		current: sigmoid(0),
		status: "unassessed",
		openMisconceptions: [],
	};
}

export function computeStats(evidence: Evidence[], now: Date = new Date()): ConceptStats {
	const events = [...evidence].sort((a, b) => a.ts.localeCompare(b.ts));
	let ability = 0;
	let halfLife = 1;
	let attempts = 0;
	let correct = 0;
	let last: number | undefined;
	let floor: number | undefined;
	let ceiling: number | undefined;
	const misconceptions = new Map<string, number>();

	for (const ev of events) {
		const t = Date.parse(ev.ts);
		if (Number.isNaN(t)) continue;
		const d = clamp(Math.round(ev.difficulty || 3), 1, 5);
		const b = difficultyLocation(d);
		const p = sigmoid(ability - b);
		const y = outcomeScore(ev);
		const isCorrect = ev.outcome === "correct";
		// "I don't know" is honest signal, so it moves the estimate like a miss —
		// but unlike a wrong guess it never flags a misconception. A familiar
		// "almost have it" is a weaker miss than "never seen this".
		const k = 1.8 / (1 + 0.3 * attempts);
		ability = clamp(ability + Math.max(0.25, k) * (y - p), -4, 4);

		const gapDays = last === undefined ? 0 : (t - last) / DAY_MS;
		if (attempts === 0) {
			halfLife = isCorrect ? 1.5 + 0.5 * d : 0.5 + y;
		} else if (isCorrect) {
			const spacing = clamp(gapDays / halfLife, 0.05, 2);
			halfLife = clamp(halfLife * (1 + 1.4 * spacing * (0.6 + 0.1 * d)), 0.5, 365);
		} else {
			// A partial answer or a tip-of-the-tongue blank means a trace survived, so memory shrinks less.
			halfLife = clamp(halfLife * (0.45 + 0.6 * y), 0.5, 365);
		}

		if (isCorrect) {
			correct++;
			if (floor === undefined || d > floor) {
				floor = d;
				if (ceiling !== undefined && ceiling <= d) ceiling = undefined;
			}
			// A correct answer at or above a misconception's difficulty retires it.
			for (const [m, md] of misconceptions) if (d >= md) misconceptions.delete(m);
		} else {
			if (ceiling === undefined || d < ceiling) ceiling = d;
			if ((ev.outcome === "incorrect" || ev.outcome === "partial") && ev.misconception) misconceptions.set(ev.misconception, d);
		}
		attempts++;
		last = t;
	}

	if (attempts === 0) return emptyStats();

	const mastery = sigmoid(ability);
	const elapsedDays = Math.max(0, (now.getTime() - (last as number)) / DAY_MS);
	const retention = Math.pow(2, -elapsedDays / halfLife);
	const current = sigmoid(ability - 2.5 * (1 - retention));
	const reviewAfterDays = halfLife * Math.log2(1 / REVIEW_AT_RETENTION);

	let status: ConceptStatus;
	if (mastery >= SOLID && attempts >= 2) status = current >= SOLID ? "solid" : "rusty";
	else if (current >= SHAKY) status = "shaky";
	else status = "learning";

	return {
		ability: round(ability, 3),
		attempts,
		correct,
		halfLifeDays: round(halfLife, 2),
		lastEvidence: new Date(last as number).toISOString(),
		mastery: round(mastery, 3),
		retention: round(retention, 3),
		current: round(current, 3),
		status,
		nextReview: new Date((last as number) + reviewAfterDays * DAY_MS).toISOString(),
		floor,
		ceiling,
		openMisconceptions: [...misconceptions.keys()],
	};
}

/** Credit an answer earns in the ability update: 1 correct (0.9 with a slip), ½ partial, a little for a familiar blank, 0 otherwise. */
export function outcomeScore(ev: Pick<Evidence, "outcome" | "familiarity" | "slip">): number {
	switch (ev.outcome) {
		case "correct":
			return ev.slip ? SLIP_CREDIT : 1;
		case "partial":
			return 0.5;
		case "dont_know":
			return 0.1 * clamp(Math.round(ev.familiarity ?? 0), 0, MAX_FAMILIARITY);
		default:
			return 0;
	}
}

/** Probability the learner answers a question of difficulty d correctly right now. */
export function predictCorrect(stats: ConceptStats, difficulty: number): number {
	const forgetting = stats.attempts === 0 ? 0 : 2.5 * (1 - stats.retention);
	return sigmoid(stats.ability - forgetting - difficultyLocation(difficulty));
}

export function isDue(stats: ConceptStats, now: Date = new Date()): boolean {
	return stats.attempts > 0 && !!stats.nextReview && Date.parse(stats.nextReview) <= now.getTime();
}

export function describeEdge(stats: ConceptStats): string {
	if (stats.attempts === 0) return "no evidence yet";
	const parts: string[] = [];
	if (stats.floor !== undefined) parts.push(`answers d${stats.floor} correctly`);
	if (stats.ceiling !== undefined) parts.push(`misses at d${stats.ceiling}`);
	if (stats.ceiling === undefined && stats.floor !== undefined && stats.floor < 5) parts.push("ceiling not found yet");
	if (stats.floor === undefined) parts.push("no correct answers yet");
	return parts.join(", ");
}

function round(x: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
}
