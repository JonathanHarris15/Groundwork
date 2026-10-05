import { describe, expect, it } from "vitest";
import { masteryVisual } from "../src/goal-plan";

describe("masteryVisual", () => {
	it("maps solid status to known", () => {
		expect(masteryVisual("solid", false)).toBe("known");
	});
});
