import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/prompt";

describe("teaching method", () => {
	const method = buildSystemPrompt();

	it("introduces a node by one difference, then a small check on a new case", () => {
		expect(method).toContain("Unconditional truths first");
		expect(method).toContain("show one difference");
		expect(method).toContain("Two cases where it holds");
		expect(method).toContain("One minimal pair");
		expect(method).toContain("One fully worked example");
		expect(method).toContain("Use none of the labeled examples as the question");
		expect(method).toContain("one more question at the required level");
	});

	it("re-teaches a miss in the other representation", () => {
		expect(method).toContain("Re-teach in the other representation");
		expect(method).toContain("wrong kind of thing");
	});

	it("names the default read and write folders, including a file to submit", () => {
		expect(method).toContain("`resources/`");
		expect(method).toContain("`submissions/`");
		expect(method).toContain("write_submission_file");
	});
});
