/** Which primary tab is selected when no overlay is open. */
export type GroundworkScreen = "learn" | "map" | "goals" | "flashcards";

/** Full-screen panels over the primary tab body. Only one may be open. */
export type GroundworkOverlay = "library" | "settings";

export interface PaneLayoutState {
	screen: GroundworkScreen;
	overlay: GroundworkOverlay | null;
}

export interface PaneRootClasses {
	isMap: boolean;
	isGoals: boolean;
	isLibrary: boolean;
	isSettings: boolean;
	isFlashcards: boolean;
	isOverlay: boolean;
}

/** Maps pane state to root CSS class flags (mutually exclusive overlays). */
export function paneRootClasses(state: PaneLayoutState): PaneRootClasses {
	const overlay = state.overlay;
	return {
		isMap: state.screen === "map",
		isGoals: state.screen === "goals",
		isFlashcards: state.screen === "flashcards",
		isLibrary: overlay === "library",
		isSettings: overlay === "settings",
		isOverlay: overlay !== null,
	};
}

/** Opening an overlay always closes any other overlay. */
export function openOverlay(current: PaneLayoutState, next: GroundworkOverlay): PaneLayoutState {
	return { ...current, overlay: next };
}

export function closeOverlay(state: PaneLayoutState): PaneLayoutState {
	return { ...state, overlay: null };
}

export function setScreen(state: PaneLayoutState, screen: GroundworkScreen): PaneLayoutState {
	return { screen, overlay: null };
}
