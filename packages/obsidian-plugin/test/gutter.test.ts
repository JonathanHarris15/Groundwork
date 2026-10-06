import { describe, expect, it } from "vitest";
import { gutterFlags, menuPosition, sideRoom } from "../src/gutter";

describe("tutor gutters", () => {
	it("opens a side gutter only when the margin already has room", () => {
		expect(sideRoom(1280)).toBe(220);
		expect(sideRoom(1000)).toBe(80);
		expect(sideRoom(700)).toBe(0);
		expect(gutterFlags(1280, 1, 1)).toEqual({ figures: true, margin: true });
		expect(gutterFlags(1120, 1, 0)).toEqual({ figures: true, margin: false });
		expect(gutterFlags(1000, 1, 0)).toEqual({ figures: false, margin: false });
		expect(gutterFlags(1000, 1, 1)).toEqual({ figures: false, margin: false });
		expect(gutterFlags(700, 1, 0)).toEqual({ figures: false, margin: false });
		expect(gutterFlags(1280, 0, 2)).toEqual({ figures: false, margin: true });
	});

	it("places the highlight menu on the selected line", () => {
		const host = { left: 0, top: 0, width: 900, height: 700 };
		const lower = menuPosition(host, { left: 220, top: 480, width: 160, bottom: 504 }, 280, 36);
		expect(lower.top).toBe(510);
		const nearBottom = menuPosition(host, { left: 220, top: 640, width: 160, bottom: 668 }, 280, 36);
		expect(nearBottom.top).toBe(598);
		expect(nearBottom.top).toBeGreaterThan(500);
	});
});
