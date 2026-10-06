import { describe, expect, it } from "vitest";
import { gutterFlags } from "../src/gutter";

describe("tutor gutters", () => {
	it("puts figures on the left only when the pane can hold them", () => {
		expect(gutterFlags(1280, 1, 1)).toEqual({ figures: true, margin: true });
		expect(gutterFlags(1000, 1, 0)).toEqual({ figures: true, margin: false });
		expect(gutterFlags(1000, 1, 1)).toEqual({ figures: false, margin: false });
		expect(gutterFlags(700, 1, 0)).toEqual({ figures: false, margin: false });
		expect(gutterFlags(1280, 0, 2)).toEqual({ figures: false, margin: true });
	});
});
