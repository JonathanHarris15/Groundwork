/**
 * Jev (TypeSafe System One) client.
 *
 * The model returns a typed judgment. Code decides what to do with it.
 * Mastery numbers and the goal graph are never computed here.
 */

import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";

export interface JevAnswer {
	score?: number;
	confidence?: number;
	noul?: number;
	choice?: string;
}

export interface JevClient {
	ask(state: unknown, questions: Questions): Promise<Record<string, JevAnswer>>;
}

/** Same concept only when the score lands on that level and the call is concentrated. */
export const SAME_CONFIDENCE = 0.6;
/** A tutor-written edge is removed only when Jev is confident it is not direct. */
export const TUTOR_DROP_BELOW = 0.35;
/** An edge guessed from course files is kept only when Jev affirms it. */
export const PROPOSED_KEEP_AT = 0.65;
/** An edge the tutor did not write is added only when Jev is sure. */
export const ADD_EDGE_AT = 0.75;
/** Free-response outcome replaces the tutor's grade only above this. */
export const GRADE_CONFIDENCE = 0.6;
/** A next-step pick is ignored when the options split the probability. */
export const PICK_CONFIDENCE = 0.45;

export interface CandidateScore {
	id: string;
	title: string;
	score: number;
	confidence: number;
}

export type Alignment =
	| { action: "same"; id: string; title: string; score: number; confidence: number }
	| { action: "related"; id: string; title: string; score: number; confidence: number }
	| { action: "new" };

/** Nearest rubric level. Two strong "same" answers stay unmerged. */
export function decideAlignment(scores: CandidateScore[]): Alignment {
	const ranked = [...scores].sort((a, b) => b.score - a.score || b.confidence - a.confidence);
	const same = ranked.filter((s) => Math.round(s.score) >= 2 && s.confidence >= SAME_CONFIDENCE);
	if (same.length === 1) return { action: "same", ...same[0] };
	const top = same[0] ?? ranked.find((s) => Math.round(s.score) === 1);
	if (top) return { action: "related", id: top.id, title: top.title, score: top.score, confidence: top.confidence };
	return { action: "new" };
}

export interface GradedUnderstanding {
	outcome: "correct" | "partial" | "incorrect";
	slip: boolean;
}

/** 0 incorrect, 1 partial, 2 slip, 3 correct. Uncertain scores are left for the tutor's grade. */
export function decideGrade(score: number, confidence: number): GradedUnderstanding | null {
	if (!(confidence >= GRADE_CONFIDENCE)) return null;
	const level = Math.min(3, Math.max(0, Math.round(score)));
	if (level >= 3) return { outcome: "correct", slip: false };
	if (level === 2) return { outcome: "correct", slip: true };
	if (level === 1) return { outcome: "partial", slip: false };
	return { outcome: "incorrect", slip: false };
}

export interface EdgeVote {
	child: string;
	parent: string;
	source: "stated" | "candidate";
	yes: number;
}

export function keepEdge(edge: EdgeVote, mode: "tutor" | "proposed"): boolean {
	if (edge.source === "candidate") return edge.yes >= ADD_EDGE_AT;
	if (mode === "tutor") return edge.yes >= TUTOR_DROP_BELOW;
	return edge.yes >= PROPOSED_KEEP_AT;
}

function readAnswer(answer: SystemOneResult<Questions>["answers"][string]): JevAnswer {
	if (answer.type === "noul") return { noul: answer.noul };
	if (answer.type === "score") return { score: answer.score, confidence: answer.confidence };
	return { choice: answer.choice, confidence: answer.confidence };
}

/** A client for this device. Empty key returns nothing, and callers keep today's behavior. */
export function jevClient(apiKey: string): JevClient | undefined {
	const key = apiKey.trim();
	if (!key) return undefined;
	const client = new TypeSafeClient({
		apiKey: key,
		// The Obsidian panel is a local window, not a public page. The key stays in this device's storage.
		dangerouslyAllowBrowser: true,
		timeout: 20_000,
		logLevel: "warn",
		defaultModel: "jev-latest",
	});
	return {
		async ask(state, questions) {
			const result = await client.systemOne({ state: state as EntryType, questions });
			const out: Record<string, JevAnswer> = {};
			for (const [id, answer] of Object.entries(result.answers)) out[id] = readAnswer(answer);
			return out;
		},
	};
}

export function jevFromEnv(env: NodeJS.ProcessEnv = process.env): JevClient | undefined {
	const key = env.TYPESAFE_API_KEY?.trim();
	return key ? jevClient(key) : undefined;
}
