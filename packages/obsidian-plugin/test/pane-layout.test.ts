import { describe, expect, it } from "vitest";
import { closeOverlay, openOverlay, paneRootClasses, setScreen, type PaneLayoutState } from "../src/pane-layout";

const learn: PaneLayoutState = { screen: "learn", overlay: null };

describe("paneRootClasses", () => {
	it("shows learn body only on the learn tab with no overlay", () => {
		expect(paneRootClasses(learn)).toEqual({
			isMap: false,
			isGoals: false,
			isLibrary: false,
			isSettings: false,
			isFlashcards: false,
			isOverlay: false,
		});
	});

	it("keeps map tab class while an overlay is open so closing returns to the map", () => {
		const flags = paneRootClasses({ screen: "map", overlay: "library" });
		expect(flags.isMap).toBe(true);
		expect(flags.isLibrary).toBe(true);
		expect(flags.isOverlay).toBe(true);
		expect(flags.isFlashcards).toBe(false);
	});

	it("treats flashcards as a primary screen, not an overlay", () => {
		const flags = paneRootClasses({ screen: "flashcards", overlay: null });
		expect(flags.isFlashcards).toBe(true);
		expect(flags.isOverlay).toBe(false);
		expect(flags.isLibrary).toBe(false);
	});
});

describe("overlay transitions", () => {
	it("replaces the previous overlay", () => {
		const withLibrary = openOverlay(learn, "library");
		const withSettings = openOverlay(withLibrary, "settings");
		expect(withSettings.overlay).toBe("settings");
		expect(paneRootClasses(withSettings).isLibrary).toBe(false);
		expect(paneRootClasses(withSettings).isSettings).toBe(true);
	});

	it("clears overlay when changing screen", () => {
		const withLibrary = openOverlay({ screen: "flashcards", overlay: "library" }, "library");
		const next = setScreen(withLibrary, "learn");
		expect(next.overlay).toBeNull();
		expect(next.screen).toBe("learn");
	});

	it("closeOverlay is idempotent", () => {
		expect(closeOverlay(learn)).toEqual(learn);
	});
});
