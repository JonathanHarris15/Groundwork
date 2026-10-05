import { describe, expect, it } from "vitest";
import { appearanceFrom } from "../src/appearance";

describe("appearanceFrom", () => {
	it("defaults to Groundwork dark when no palette was chosen", () => {
		expect(appearanceFrom({})).toBe("dark");
		expect(appearanceFrom({ appearance: "obsidian" })).toBe("obsidian");
		expect(appearanceFrom({ appearance: "dark" })).toBe("dark");
		expect(appearanceFrom({ appearance: "light" })).toBe("light");
	});

	it("keeps an older website theme as Dark", () => {
		expect(appearanceFrom({ siteTheme: true })).toBe("dark");
		expect(appearanceFrom({ siteTheme: true, appearance: "light" })).toBe("light");
	});
});
