import type { TutorStatus } from "@groundwork/core";

export const LEARN_EMPTY_HERO_TITLE = "What do you want to understand?";

export type SyncUiState = "idle" | "syncing" | "ok" | "offline" | "error" | "disabled";

/** Red sync glyph only for syncing, error, or not linked — not for Linked/ok. */
export function syncStatusShowsGlyph(state: SyncUiState): boolean {
	return state === "syncing" || state === "error" || state === "offline";
}

export function learnEmptyHubCounts(root: ParentNode): { emptyBlocks: number; heroTitles: number } {
	const emptyBlocks = root.querySelectorAll(".gw-messages > .gw-empty").length;
	let heroTitles = 0;
	root.querySelectorAll(".gw-messages > .gw-empty .gw-hero h2").forEach((el) => {
		if (el.textContent?.trim() === LEARN_EMPTY_HERO_TITLE) heroTitles += 1;
	});
	return { emptyBlocks, heroTitles };
}

export function isSingleLearnEmptyHub(root: ParentNode): boolean {
	const { emptyBlocks, heroTitles } = learnEmptyHubCounts(root);
	return emptyBlocks === 1 && heroTitles === 1;
}

/** Composer provider chip: show when the learner must act; hide for hosted Groundwork tutor. */
export function showComposerProviderChip(input: {
	label: string;
	hasSetup: boolean;
	route: TutorStatus | null;
	runtime: "demo" | "claude" | "proxy" | "setup";
}): boolean {
	if (!input.label.trim()) return false;
	if (input.hasSetup) return true;
	const route = input.route;
	if (route && !route.ownModel && (route.action === "hosted" || route.via === "hosted")) return false;
	if (input.runtime === "proxy" && route && !route.ownModel) return false;
	return true;
}
