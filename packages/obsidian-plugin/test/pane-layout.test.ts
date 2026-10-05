import { describe, expect, it } from "vitest";
import { INITIAL_PANE, PRIMARY_TABS, paneRootClasses, setScreen, toggleUtility } from "../src/pane-layout";

describe("center tabs", () => {
	it("lists Learn, Map, Goals, Flashcards in header order", () => {
		expect(PRIMARY_TABS.map((tab) => tab.label)).toEqual(["Learn", "Map", "Goals", "Flashcards"]);
	});
});

describe("paneRootClasses", () => {
	it("shows the learn body only on the learn tab", () => {
		expect(paneRootClasses(INITIAL_PANE)).toEqual({
			isMap: false,
			isGoals: false,
			isFlashcards: false,
			isLibrary: false,
			isSettings: false,
		});
	});

	it("shows one screen at a time, Library included", () => {
		const library = paneRootClasses(setScreen(setScreen(INITIAL_PANE, "map"), "library"));
		expect(library.isLibrary).toBe(true);
		expect(library.isMap).toBe(false);
		expect(Object.values(library).filter(Boolean)).toHaveLength(1);
	});
});

describe("utility screens", () => {
	it("Library replaces Settings rather than stacking on it", () => {
		const settings = setScreen(INITIAL_PANE, "settings");
		const library = toggleUtility(settings, "library");
		expect(library.screen).toBe("library");
		expect(paneRootClasses(library).isSettings).toBe(false);
	});

	it("pressing the Library button again returns to the tab it came from", () => {
		const fromGoals = toggleUtility(setScreen(INITIAL_PANE, "goals"), "library");
		expect(toggleUtility(fromGoals, "library").screen).toBe("goals");
	});

	it("a center tab leaves a utility screen", () => {
		const library = toggleUtility(setScreen(INITIAL_PANE, "flashcards"), "library");
		const learn = setScreen(library, "learn");
		expect(learn.screen).toBe("learn");
		expect(learn.lastPrimary).toBe("learn");
	});

	it("moving between utilities keeps the center tab to return to", () => {
		const library = toggleUtility(setScreen(INITIAL_PANE, "map"), "library");
		const settings = toggleUtility(library, "settings");
		expect(toggleUtility(settings, "settings").screen).toBe("map");
	});
});
