import { describe, expect, it } from "vitest";
import { parseTutorMemoryFiles } from "../src/account";
import { cleanFolderList, normalizeVaultPath, pathInsideFolder, tutorMayReadPath } from "../src/access";
import { resolveSubmissionPath } from "../src/files";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import { toolByName } from "../src/tools";

describe("folder access", () => {
	it("rejects escaping, hidden, and absolute folders, and does not treat a prefix as a child", () => {
		expect(normalizeVaultPath("resources")).toBe("resources");
		expect(normalizeVaultPath("/submissions/homework/")).toBe("submissions/homework");
		expect(normalizeVaultPath("../etc")).toBeNull();
		expect(normalizeVaultPath(".obsidian")).toBeNull();
		expect(normalizeVaultPath("notes/.secret")).toBeNull();
		expect(normalizeVaultPath("C:/Windows")).toBeNull();
		expect(pathInsideFolder("resources/Lecture 3.pdf", "resources")).toBe(true);
		expect(pathInsideFolder("resources-evil/secret.md", "resources")).toBe(false);
		expect(pathInsideFolder("resources", "resources")).toBe(true);
		expect(cleanFolderList(["resources", "resources/", "../x", ".git"])).toEqual(["resources"]);
	});

	it("lets the tutor read split PDF parts and nothing else outside the read folders", () => {
		const access = { readFolders: ["resources"] };
		expect(tutorMayReadPath("resources/Lecture 3.pdf", access)).toBe(true);
		expect(tutorMayReadPath("courses/calc/notes.md", access)).toBe(false);
		expect(tutorMayReadPath(".groundwork/evidence/a.jsonl", access)).toBe(false);
		expect(tutorMayReadPath(".groundwork/cache/pdf-parts/lecture-1/part.pdf", access)).toBe(true);
		expect(tutorMayReadPath("../resources/Lecture 3.pdf", access)).toBe(false);
	});

	it("puts a bare submission name in the first write folder", () => {
		expect(resolveSubmissionPath("essay", ["submissions"])).toEqual({ path: "submissions/essay.md" });
		expect(resolveSubmissionPath("submissions/week 1/answers.md", ["submissions"])).toEqual({ path: "submissions/week 1/answers.md" });
		expect("error" in resolveSubmissionPath("concepts/note.md", ["submissions"])).toBe(true);
		expect("error" in resolveSubmissionPath("submissions/../../note.md", ["submissions"])).toBe(true);
	});

	it("writes a submission into the vault context and keeps it out of tutor memory", async () => {
		const memory = new MemoryVaultIO();
		const vault = new MemoryVaultIO();
		const store = new KnowledgeStore(memory, { context: vault });
		const wrote = await toolByName("write_submission_file")!.run({ path: "answers.md", content: "The limit is 2." }, { store, access: { readFolders: [], writeFolders: ["submissions"] } });
		expect(wrote.isError).toBeFalsy();
		expect(await vault.read("submissions/answers.md")).toContain("The limit is 2.");
		expect(memory.files.has("submissions/answers.md")).toBe(false);
		expect(parseTutorMemoryFiles({ "concepts/Limit.md": "private" })["concepts/Limit.md"]).toBe("private");
		expect(() => parseTutorMemoryFiles({ "resources/secret.md": "no" })).toThrow(/not tutor memory/);
	});

	it("refuses to ingest a course file outside the read folders", async () => {
		const io = new MemoryVaultIO();
		io.files.set("courses/secret.md", "Practice exam: the secret answer is 7.");
		io.files.set("resources/HW.md", "Homework: differentiate x^2.");
		const store = new KnowledgeStore(io);
		const denied = await toolByName("ingest_exam_materials")!.run({ files: ["courses/secret.md"], createGoal: true }, { store });
		expect(denied.isError).toBe(true);
		expect(await store.examPlans()).toEqual([]);
		const allowed = await toolByName("ingest_exam_materials")!.run({ files: ["HW.md"], userText: "midterm", createGoal: false }, { store });
		expect(allowed.isError).toBeFalsy();
	});
});
