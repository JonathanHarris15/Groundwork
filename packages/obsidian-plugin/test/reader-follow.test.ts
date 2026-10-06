import { describe, expect, it } from "vitest";
import { ReaderFollow } from "../src/reader-follow";

describe("reader follow", () => {
	it("keeps the viewport on the passage when a quiz is inserted below it", () => {
		const el = { scrollTop: 420, scrollHeight: 2000, clientHeight: 600 };
		const reader = new ReaderFollow();
		reader.keepPlace(el, () => {
			el.scrollHeight += 480;
			el.scrollTop = el.scrollHeight;
		});
		expect(el.scrollTop).toBe(420);
		expect(reader.held).toBe(true);
		expect(reader.follow(el, true)).toBe(false);
		expect(el.scrollTop).toBe(420);
	});

	it("follows again once the learner scrolls back to the bottom", () => {
		const el = { scrollTop: 420, scrollHeight: 2000, clientHeight: 600 };
		const reader = new ReaderFollow();
		reader.keepPlace(el, () => {
			el.scrollHeight += 480;
		});
		expect(reader.follow(el, true)).toBe(false);
		el.scrollTop = el.scrollHeight - el.clientHeight;
		reader.noteUserScroll(el);
		expect(reader.held).toBe(false);
		el.scrollHeight += 200;
		expect(reader.follow(el, true)).toBe(true);
		expect(el.scrollTop).toBe(el.scrollHeight);
	});

	it("follows a forced scroll after the learner answers and the hold is released", () => {
		const el = { scrollTop: 420, scrollHeight: 2480, clientHeight: 600 };
		const reader = new ReaderFollow();
		reader.hold();
		reader.release();
		expect(reader.follow(el, true)).toBe(true);
		expect(el.scrollTop).toBe(el.scrollHeight);
	});

	it("holds again when the learner scrolls up into the explanation", () => {
		const el = { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 };
		const reader = new ReaderFollow();
		el.scrollTop = 420;
		reader.noteUserScroll(el);
		expect(reader.held).toBe(true);
		el.scrollHeight += 480;
		expect(reader.follow(el, true)).toBe(false);
		expect(el.scrollTop).toBe(420);
	});

	it("ignores the scroll event caused by putting the viewport back", () => {
		const el = { scrollTop: 420, scrollHeight: 2000, clientHeight: 600 };
		const reader = new ReaderFollow();
		const top = reader.keepPlace(el, () => {
			el.scrollHeight += 480;
		});
		reader.restore(el, top);
		expect(reader.held).toBe(true);
		expect(el.scrollTop).toBe(420);
	});
});
