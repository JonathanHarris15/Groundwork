/** The four center tabs, in header order. */
export type PrimaryScreen = "learn" | "map" | "goals" | "flashcards";

/** Opened from the header utility buttons. They replace the tab body like any tab; there is nothing to close. */
export type UtilityScreen = "library" | "settings";

export type GroundworkScreen = PrimaryScreen | UtilityScreen;

export const PRIMARY_TABS: readonly { id: PrimaryScreen; label: string; title: string }[] = [
	{ id: "learn", label: "Learn", title: "Learn" },
	{ id: "map", label: "Map", title: "Concept map" },
	{ id: "goals", label: "Goals", title: "Goals" },
	{ id: "flashcards", label: "Flashcards", title: "Flashcards" },
];

export interface PaneLayoutState {
	screen: GroundworkScreen;
	/** The center tab a utility screen returns to when its button is pressed again. */
	lastPrimary: PrimaryScreen;
}

export interface PaneRootClasses {
	isMap: boolean;
	isGoals: boolean;
	isFlashcards: boolean;
	isLibrary: boolean;
	isSettings: boolean;
}

export const INITIAL_PANE: PaneLayoutState = { screen: "learn", lastPrimary: "learn" };

export function isPrimary(screen: GroundworkScreen): screen is PrimaryScreen {
	return PRIMARY_TABS.some((tab) => tab.id === screen);
}

/** Exactly one screen shows; Learn is the one with no class. */
export function paneRootClasses(state: PaneLayoutState): PaneRootClasses {
	return {
		isMap: state.screen === "map",
		isGoals: state.screen === "goals",
		isFlashcards: state.screen === "flashcards",
		isLibrary: state.screen === "library",
		isSettings: state.screen === "settings",
	};
}

export function setScreen(state: PaneLayoutState, screen: GroundworkScreen): PaneLayoutState {
	return { screen, lastPrimary: isPrimary(screen) ? screen : state.lastPrimary };
}

/** A utility button opens its screen, or goes back to the last center tab when that screen is already showing. */
export function toggleUtility(state: PaneLayoutState, utility: UtilityScreen): PaneLayoutState {
	return state.screen === utility ? setScreen(state, state.lastPrimary) : setScreen(state, utility);
}
