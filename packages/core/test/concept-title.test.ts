import { describe, expect, it } from "vitest";
import { directSourceReference, sourceBoundConceptReason } from "../src/concept-title";

describe("concept titles stay abstract", () => {
	it("rejects document names and tasks tied to them", () => {
		const rejected = [
			"Lecture Note 1 fluency",
			"Lecture 1 note fluency",
			"Lecture Note 1",
			"Practice Exam 1",
			"Practice Exam 1 mastery",
			"Practice Exam 1 Solutions",
			"Practice Exam 2 unaided",
			"Prepare for HV 25H exam",
			"Prepare for JJ 00 exam",
			"Prepare for ROY97G exam",
			"HW2 Solutions",
			"Chapter 3",
			"resources/Lecture Note 1.pdf",
			"Lecture Note 1.pdf",
		];
		for (const title of rejected) expect(sourceBoundConceptReason(title), title).toBeTruthy();
	});

	it("accepts ideas that carry to another class", () => {
		const accepted = [
			"Linear functions",
			"Affine compositions",
			"Final value theorem",
			"Series solutions",
			"Positive semidefinite matrices",
			"Chain rule",
			"Slope of a line",
			"The assignment problem",
			"Unit circle",
			"Whole note",
		];
		for (const title of accepted) expect(sourceBoundConceptReason(title), title).toBeNull();
	});

	it("finds a file referenced inside concept text", () => {
		expect(directSourceReference("A map that preserves addition.")).toBeNull();
		expect(directSourceReference("See [[resources/Lecture Note 1.pdf]].")).toBe("resources/Lecture Note 1.pdf");
		expect(directSourceReference("Opened lecture3.pdf yesterday.")).toBe("lecture3.pdf");
		expect(directSourceReference("Builds on [[Linear functions]].")).toBeNull();
		expect(directSourceReference("Same idea as [[Practice Exam 1]].")).toBe("Practice Exam 1");
	});
});
