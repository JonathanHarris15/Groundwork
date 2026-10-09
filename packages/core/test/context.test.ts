import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import type { Provider } from "../src/agent/types";
import { loadVaultFile } from "../src/files";
import { MemoryVaultIO } from "../src/io";
import {
	CONTEXT_MAX_FILES,
	contextRequest,
	filesLeftClosedNote,
	includedPieceIds,
	INCLUDE_FILE_AT,
	INCLUDE_INSTRUCTION_AT,
	learnerPieces,
	parseContextRequest,
	prepareTutorTurn,
	remoteContextSelector,
	type ContextPiece,
} from "../src/jev/context";
import { splitMarkdown } from "../src/markdown";
import { buildSystemPrompt, promptParts } from "../src/prompt";
import { KnowledgeStore } from "../src/store";
import { toolByName } from "../src/tools";

const profile = `# Learner profile

## Background

Studied physics. Comfortable with algebra.

## Observations

Rushes the algebra and drops a sign.
`;

function piece(over: Partial<ContextPiece> & Pick<ContextPiece, "id" | "kind">): ContextPiece {
	return { title: over.id, text: over.text ?? "text", ...over };
}

describe("context pieces", () => {
	it("splits headings and leaves a fenced sample inside its section", () => {
		const parts = splitMarkdown("# A\n\n```\n# not a heading\n```\n\n## B\n\nbody");
		expect(parts.map((part) => part.title)).toEqual(["A", "B"]);
		expect(parts[0].text).toContain("# not a heading");
	});

	it("splits the teaching method into optional sections and keeps the gates required", () => {
		const parts = promptParts("# Context\nToday is 2026-10-09.");
		expect(parts.find((part) => part.id === "answer-first")?.required).toBe(true);
		expect(parts.find((part) => part.id === "formatting")?.required).toBe(true);
		expect(parts.find((part) => part.id === "file-access")?.required).toBe(true);
		expect(parts.find((part) => part.id === "today")?.required).toBe(true);
		expect(parts.some((part) => part.id === "method:exam-prep" && !part.required)).toBe(true);
		expect(parts.some((part) => part.id === "method:flashcards" && !part.required)).toBe(true);
		expect(buildSystemPrompt()).toBe(buildSystemPrompt(undefined, undefined));
		expect(buildSystemPrompt().startsWith("# Answer first")).toBe(true);
	});

	it("drops an instruction section without dropping answer-first", () => {
		const keep = new Set(promptParts().filter((part) => part.id !== "method:exam-prep" && part.id !== "method:flashcards").map((part) => part.id));
		const prompt = buildSystemPrompt(undefined, undefined, keep);
		expect(prompt.startsWith("# Answer first")).toBe(true);
		expect(prompt).toContain("Read folders");
		expect(prompt).not.toContain("# Exam prep");
		expect(prompt).not.toContain("# Flashcards");
	});

	it("splits the learner file and the tutor notes", () => {
		const pieces = learnerPieces(profile, "Prefers a formula sheet.");
		expect(pieces.map((item) => item.id)).toEqual(["learner:learner-profile", "learner:background", "learner:observations", "learner:tutor-notes"]);
	});
});

describe("Jev context decision", () => {
	it("asks one noul per piece and does not carry an API key", () => {
		const request = contextRequest("What's the chain rule?", [piece({ id: "method:exam-prep", kind: "instruction", title: "Exam prep" })]);
		expect(request.model).toBe("jev-latest");
		expect(request.questions.i0).toMatchObject({ type: "noul" });
		expect(request.state.message).toContain("chain rule");
		expect(JSON.stringify(request)).not.toMatch(/apiKey|TYPESAFE/);
	});

	it("keeps a needed file, drops a weak one, and fails open on a missing instruction", () => {
		const pieces = [
			piece({ id: "method:exam-prep", kind: "instruction" }),
			piece({ id: "learner:background", kind: "learner" }),
			piece({ id: "file:resources/lecture-3.md", kind: "file", attached: true }),
			piece({ id: "file:resources/syllabus.md", kind: "file" }),
		];
		const included = includedPieceIds(pieces, {
			i0: { type: "noul", noul: INCLUDE_INSTRUCTION_AT },
			i1: { type: "noul", noul: 0.8 },
			i2: { type: "noul", noul: INCLUDE_FILE_AT },
			i3: { type: "noul", noul: INCLUDE_FILE_AT - 0.01 },
		});
		expect(included).toContain("method:exam-prep");
		const dropped = includedPieceIds(pieces, { i0: { type: "noul", noul: INCLUDE_INSTRUCTION_AT - 0.01 } });
		expect(dropped).not.toContain("method:exam-prep");
		expect(included).toContain("learner:background");
		expect(included).toContain("file:resources/lecture-3.md");
		expect(included).not.toContain("file:resources/syllabus.md");
	});

	it("opens at most eight files and prefers one the learner attached", () => {
		const pieces = [
			piece({ id: "file:attached.md", kind: "file", attached: true }),
			...Array.from({ length: CONTEXT_MAX_FILES }, (_, i) => piece({ id: `file:other-${i}.md`, kind: "file" })),
		];
		const answers: Record<string, { type: "noul"; noul: number }> = { i0: { type: "noul", noul: INCLUDE_FILE_AT } };
		for (let i = 1; i < pieces.length; i++) answers[`i${i}`] = { type: "noul", noul: 0.99 };
		const included = includedPieceIds(pieces, answers);
		expect(included).toHaveLength(CONTEXT_MAX_FILES);
		expect(included[0]).toBe("file:attached.md");
		expect(included).not.toContain(`file:other-${CONTEXT_MAX_FILES - 1}.md`);
	});

	it("rejects a context request that is not a list of pieces", () => {
		expect(parseContextRequest({ message: "hi" })).toBeNull();
		expect(parseContextRequest({ message: "hi", pieces: [{ id: "x", kind: "nope", title: "X", text: "y" }] })).toBeNull();
		const parsed = parseContextRequest({
			message: "Read lecture 3",
			pieces: [{ id: "file:resources/lecture-3.md", kind: "file", title: "lecture-3.md", text: "limits", attached: true }],
		});
		expect(parsed?.pieces[0]).toMatchObject({ id: "file:resources/lecture-3.md", attached: true });
	});
});

describe("prepareTutorTurn", () => {
	function vault() {
		const io = new MemoryVaultIO();
		io.files.set("resources/lecture-3.md", "# Lecture 3\n\nThe chain rule: rates multiply along a composition.\n");
		io.files.set("resources/syllabus.md", "# Syllabus\n\nWeek 1 is review.\n");
		io.files.set("courses/secret.md", "Outside the read folders.");
		return io;
	}

	it("keeps the full prompt and only the attachment when Jev is not configured", async () => {
		const io = vault();
		const attached = [await loadVaultFile(io, "resources/lecture-3.md")];
		const prepared = await prepareTutorTurn({
			message: "What's in this file?",
			profile,
			tutorContext: "Use the formula sheet.",
			attached,
			io,
			access: { readFolders: ["resources"], writeFolders: [] },
		});
		expect(prepared.selected).toBe(false);
		const access = { readFolders: ["resources"], writeFolders: [] };
		expect(prepared.system).toBe(buildSystemPrompt(undefined, access));
		expect(prepared.files.map((file) => file.path)).toEqual(["resources/lecture-3.md"]);
		expect(prepared.note).toBe("");
		expect(prepared.profile).toBeUndefined();
	});

	it("sends only the sections and files Jev kept", async () => {
		const io = vault();
		const attached = [await loadVaultFile(io, "resources/lecture-3.md")];
		let judged: ContextPiece[] = [];
		const prepared = await prepareTutorTurn({
			selector: {
				async select(_message, pieces) {
					judged = pieces;
					return ["learner:background", "file:resources/lecture-3.md"];
				},
			},
			message: "What's the chain rule in lecture 3?",
			extra: "# Context\nToday is 2026-10-09.",
			profile,
			tutorContext: "Use the formula sheet.",
			attached,
			io,
			access: { readFolders: ["resources"], writeFolders: [] },
		});
		expect(judged.some((item) => item.id === "answer-first")).toBe(false);
		expect(judged.some((item) => item.id === "method:exam-prep")).toBe(true);
		expect(judged.some((item) => item.id === "file:resources/syllabus.md")).toBe(true);
		expect(judged.some((item) => item.id === "file:courses/secret.md")).toBe(false);
		expect(prepared.selected).toBe(true);
		expect(prepared.system.startsWith("# Answer first")).toBe(true);
		expect(prepared.system).toContain("Today is 2026-10-09.");
		expect(prepared.system).toContain("Studied physics");
		expect(prepared.system).not.toContain("# Exam prep");
		expect(prepared.system).not.toContain("# Flashcards");
		expect(prepared.system).not.toContain("Rushes the algebra");
		expect(prepared.system).not.toContain("formula sheet");
		expect(prepared.profile).toContain("Studied physics");
		expect(prepared.profile).not.toContain("Rushes the algebra");
		expect(prepared.tutorContext).toBe("");
		expect(prepared.files.map((file) => file.path)).toEqual(["resources/lecture-3.md"]);
		expect(prepared.note).toContain("resources/syllabus.md");
		expect(prepared.note).not.toContain("secret.md");
	});

	it("opens a vault file the learner did not attach when Jev says it is needed", async () => {
		const io = vault();
		const prepared = await prepareTutorTurn({
			selector: { async select() { return ["file:resources/syllabus.md", "method:exam-prep"]; } },
			message: "What does the syllabus say we cover?",
			profile,
			tutorContext: "",
			attached: [],
			io,
			access: { readFolders: ["resources"], writeFolders: [] },
		});
		expect(prepared.files.map((file) => file.path)).toEqual(["resources/syllabus.md"]);
		expect(prepared.files[0].text).toContain("Week 1");
		expect(prepared.system).toContain("# Exam prep");
		expect(prepared.system).not.toContain("# Flashcards");
		expect(prepared.note).toContain("resources/lecture-3.md");
	});

	it("keeps today's context when the call fails, and still aborts when the learner stops", async () => {
		const io = vault();
		const attached = [await loadVaultFile(io, "resources/lecture-3.md")];
		const failed = await prepareTutorTurn({
			selector: { async select() { throw new Error("offline"); } },
			message: "hi",
			profile,
			tutorContext: "",
			attached,
			io,
			access: { readFolders: ["resources"], writeFolders: [] },
		});
		expect(failed.selected).toBe(false);
		expect(failed.files).toEqual(attached);
		expect(failed.system).toContain("# Exam prep");

		const signal = AbortSignal.abort();
		await expect(
			prepareTutorTurn({
				selector: { async select() { throw new Error("aborted"); } },
				message: "hi",
				profile,
				tutorContext: "",
				attached,
				signal,
			}),
		).rejects.toThrow(/aborted/);
	});
});

describe("tutor turn", () => {
	it("uses the selected system prompt and profile for that turn", async () => {
		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		await store.setProfile(profile);
		await store.setTutorContext("Use the formula sheet.");
		let system = "";
		const provider: Provider = {
			name: "record",
			async complete(req) {
				system = req.system;
				return { content: [{ type: "text", text: "Rates multiply along a composition." }], stopReason: "end_turn" };
			},
		};
		const agent = new AgentSession({ provider, store, tools: [], system: buildSystemPrompt(), session: { id: "s" } });
		agent.setTurnContext({ system: "Answer the question. Do not quiz." });
		await agent.send("What's the chain rule?", () => {});
		expect(system).toBe("Answer the question. Do not quiz.");

		const overview = await toolByName("get_learner_overview")!.run(
			{},
			{ store, profile: "## Background\n\nStudied physics.", tutorContext: "" },
		);
		expect(overview.text).toContain("Studied physics");
		expect(overview.text).not.toContain("Rushes the algebra");
		expect(overview.text).not.toContain("formula sheet");
		const saved = await store.overview();
		expect(saved.profile).toContain("Rushes the algebra");
		expect(saved.tutorContext).toContain("formula sheet");
	});
});

describe("remote context selector", () => {
	it("reads the included ids and treats an unconfigured server as no decision", async () => {
		const fetchImpl = async (url: string) => {
			const down = String(url).includes("/missing/");
			const body = down ? { error: "no" } : { included: ["learner:background"] };
			return {
				ok: !down,
				status: down ? 503 : 200,
				statusText: "",
				headers: { get: () => null },
				text: async () => JSON.stringify(body),
				json: async () => body,
				arrayBuffer: async () => new ArrayBuffer(0),
				body: null,
			};
		};
		const selector = remoteContextSelector("https://groundwork.test", fetchImpl);
		await expect(selector.select("hi", [])).resolves.toEqual(["learner:background"]);
		const down = remoteContextSelector("https://groundwork.test/missing", fetchImpl);
		await expect(down.select("hi", [])).resolves.toBeNull();
	});

	it("names files that stayed closed", () => {
		expect(filesLeftClosedNote([])).toBe("");
		expect(filesLeftClosedNote(["resources/syllabus.md"])).toContain("read_vault_file");
	});
});
