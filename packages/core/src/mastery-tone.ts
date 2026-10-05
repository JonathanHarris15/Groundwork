import type { ConceptStatus } from "./model";

/**
 * One mastery vocabulary for every surface that draws a concept's state:
 * map nodes, the path panel, legends, goal tables, and status pills.
 * Stylesheets carry the same names as `--gw-tone-<tone>` tokens.
 */
export type MasteryTone = "solid" | "learning" | "shaky" | "rusty" | "unstarted";

/** Strongest to weakest, the order legends list them in. */
export const MASTERY_TONES: readonly MasteryTone[] = ["solid", "shaky", "learning", "rusty", "unstarted"];

export const MASTERY_LABEL: Record<MasteryTone, string> = {
	solid: "Solid",
	shaky: "Shaky",
	learning: "Learning",
	rusty: "Rusty",
	unstarted: "Not started",
};

/** What each tone means, for legends and tooltips. */
export const MASTERY_HINT: Record<MasteryTone, string> = {
	solid: "You have this groundwork",
	shaky: "Nearly there, a quiz will confirm it",
	learning: "Started, still building",
	rusty: "Was solid, due for a review",
	unstarted: "Not studied yet",
};

/** A concept built on a goal reads as solid there even if its stats have since faded. */
export function masteryTone(status: ConceptStatus, built = false): MasteryTone {
	if (built || status === "solid") return "solid";
	if (status === "unassessed") return "unstarted";
	return status;
}

export function masteryLabel(status: ConceptStatus, built = false): string {
	return MASTERY_LABEL[masteryTone(status, built)];
}
