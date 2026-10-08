import { describe, expect, it } from "vitest";
import { MemoryVaultIO } from "../src/io";
import { SURVEY_PER_FILE_CHARS, SURVEY_TOTAL_CHARS, surveyDocuments } from "../src/survey";
import { KnowledgeStore } from "../src/store";
import { toolByName } from "../src/tools";

const LIMITS = "The squeeze theorem is not in these notes.";
const DERIV = "The power rule is stated here without a proof.";
const CHAIN = "The chain-rule proof is in a handout that is not in this folder.";

function vault() {
	const io = new MemoryVaultIO();
	io.files.set("resources/limits.md", `# Limits\n\nA limit describes the value a function approaches. ${LIMITS}\n`);
	io.files.set("resources/derivative.md", `# Derivative\n\nThe derivative is a limit of difference quotients. ${DERIV}\n`);
	io.files.set("resources/chain-rule.md", `# Chain rule\n\nRates multiply along a composition. ${CHAIN}\n`);
	io.writeBinary("resources/sketch.png", new Uint8Array([1, 2, 3, 4]));
	io.files.set("courses/secret.md", "This file is outside the read folders.");
	return io;
}

describe("surveyDocuments", () => {
	it("reads each context document and skips files outside the read folders", async () => {
		const read = await surveyDocuments(vault(), ["resources"]);
		const texts = read.hits.filter((hit) => hit.text).map((hit) => hit.text ?? "");
		expect(texts.join("\n")).toContain(LIMITS);
		expect(texts.join("\n")).toContain(DERIV);
		expect(texts.join("\n")).toContain(CHAIN);
		expect(texts.join("\n")).not.toContain("outside the read folders");
		const image = read.hits.find((hit) => hit.path.endsWith("sketch.png"));
		expect(image?.text).toBeUndefined();
		expect(image?.note).toMatch(/Image/);
		expect(read.unread).toEqual([]);
	});

	it("stops reading once the size budget is used and names what was left", async () => {
		const io = vault();
		io.files.set("resources/long-a.md", "A".repeat(SURVEY_PER_FILE_CHARS));
		io.files.set("resources/long-b.md", "B".repeat(SURVEY_PER_FILE_CHARS));
		io.files.set("resources/long-c.md", "C".repeat(SURVEY_PER_FILE_CHARS));
		io.files.set("resources/zzz-left-out.md", "This later note was not opened.");
		const read = await surveyDocuments(io, ["resources"], { maxFiles: 12, perFileChars: SURVEY_PER_FILE_CHARS, totalChars: SURVEY_TOTAL_CHARS });
		const opened = read.hits.filter((hit) => hit.text);
		const chars = opened.reduce((sum, hit) => sum + (hit.text?.length ?? 0), 0);
		expect(chars).toBeLessThanOrEqual(SURVEY_TOTAL_CHARS);
		expect(opened.some((hit) => hit.truncated)).toBe(true);
		expect(read.unread.join(" ")).toContain("zzz-left-out.md");
	});

	it("returns the excerpts from the survey tool", async () => {
		const store = new KnowledgeStore(vault());
		const result = await toolByName("survey_documents")!.run({}, { store });
		expect(result.isError).toBeFalsy();
		expect(result.text).toContain(LIMITS);
		expect(result.text).toContain(DERIV);
		expect(result.text).toContain(CHAIN);
		expect(result.text).toContain("sketch.png");
		expect(result.text).not.toContain("outside the read folders");
		expect(result.summary).toBe("Read 3 documents");
	});
});
