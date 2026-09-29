import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/agent/loop";
import type { ChatMessage, ContentBlock, Provider, ProviderRequest } from "../src/agent/types";
import { LIMITS, loadVaultFile, mcpContent, resolveVaultFile, userContent, withoutFileData } from "../src/files";
import { MemoryVaultIO } from "../src/io";
import { KnowledgeStore } from "../src/store";
import { TOOLS, toolByName } from "../src/tools";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF");

function vault() {
	const io = new MemoryVaultIO();
	io.writeBinary("resources/diagram.png", PNG);
	io.writeBinary("resources/Lecture 3.pdf", PDF);
	io.writeBinary("resources/slides.pptx", new Uint8Array([1, 2, 3]));
	io.files.set("resources/problems.txt", "1. Differentiate x^2.");
	io.files.set("courses/calc/notes.md", "# Limits");
	io.files.set(".groundwork/chats/c.json", "{}");
	return { io, store: new KnowledgeStore(io) };
}

describe("vault files", () => {
	it("loads images and PDFs as base64, text as text, and explains what it can't read", async () => {
		const { io } = vault();
		const png = await loadVaultFile(io, "resources/diagram.png");
		expect(png).toMatchObject({ kind: "image", mediaType: "image/png", size: PNG.length });
		expect(Buffer.from(png.data!, "base64")).toEqual(Buffer.from(PNG));
		expect(await loadVaultFile(io, "resources/Lecture 3.pdf")).toMatchObject({ kind: "pdf", mediaType: "application/pdf" });
		expect(await loadVaultFile(io, "resources/problems.txt")).toMatchObject({ kind: "text", text: "1. Differentiate x^2." });
		expect((await loadVaultFile(io, "resources/slides.pptx")).skipped).toMatch(/can't be read/);
		expect((await loadVaultFile(io, "resources/missing.png")).skipped).toMatch(/Couldn't read/);
	});

	it("refuses files over the API limits and truncates long text", async () => {
		const io = new MemoryVaultIO();
		io.writeBinary("big.png", new Uint8Array(LIMITS.image + 1));
		io.files.set("long.md", "x".repeat(LIMITS.textChars + 10));
		expect(await loadVaultFile(io, "big.png")).toMatchObject({ tooLarge: true, skipped: expect.stringMatching(/over the 5\.0 MB limit/) });
		const long = await loadVaultFile(io, "long.md");
		expect(long.truncated).toBe(true);
		expect(long.text!.length).toBe(LIMITS.textChars);
	});

	it("resolves paths, bare names in resources/, and names anywhere, but never hidden or escaping paths", async () => {
		const { io } = vault();
		expect(await resolveVaultFile(io, "resources/diagram.png")).toBe("resources/diagram.png");
		expect(await resolveVaultFile(io, "Lecture 3.pdf")).toBe("resources/Lecture 3.pdf");
		expect(await resolveVaultFile(io, "[[notes.md]]")).toBe("courses/calc/notes.md");
		expect(await resolveVaultFile(io, "lecture 3")).toBe("resources/Lecture 3.pdf");
		expect(await resolveVaultFile(io, "resources")).toBeNull();
		expect(await resolveVaultFile(io, "../etc/passwd")).toBeNull();
		expect(await resolveVaultFile(io, ".groundwork/chats/c.json")).toBeNull();
		expect(await resolveVaultFile(io, "c.json")).toBeNull();
	});

	it("builds learner messages with files before the text", async () => {
		const { io } = vault();
		const files = [await loadVaultFile(io, "resources/diagram.png"), await loadVaultFile(io, "resources/problems.txt")];
		expect(userContent("hi")).toBe("hi");
		const blocks = userContent("What is this?", files) as ContentBlock[];
		expect(blocks.map((b) => b.type)).toEqual(["text", "image", "text", "text"]);
		expect(blocks[0]).toEqual({ type: "text", text: "File: resources/diagram.png" });
		expect((blocks[2] as { text: string }).text).toContain('<file path="resources/problems.txt">');
		expect((userContent("", files) as ContentBlock[]).at(-1)!.type).toBe("text");
		expect((userContent("", files) as ContentBlock[]).length).toBe(3);
	});

	it("maps files to MCP content and strips base64 from saved history", async () => {
		const { io } = vault();
		const files = [await loadVaultFile(io, "resources/diagram.png"), await loadVaultFile(io, "resources/Lecture 3.pdf")];
		const mcp = mcpContent("Contents:", files);
		expect(mcp.map((c) => c.type)).toEqual(["text", "text", "image", "resource"]);
		expect(mcp[3]).toMatchObject({ resource: { mimeType: "application/pdf", uri: "groundwork:///resources/Lecture%203.pdf" } });

		const messages: ChatMessage[] = [
			{ role: "user", content: userContent("look", files) },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: userContent("x", files) as ContentBlock[] }] },
		];
		const saved = JSON.stringify(withoutFileData(messages));
		expect(saved).not.toContain(files[0].data!);
		expect(saved).not.toContain(files[1].data!);
		expect(saved).toContain("read_vault_file");
		expect(JSON.stringify(messages)).toContain(files[0].data!);
	});
});

describe("file tools", () => {
	it("list_vault_files lists resources/ by default and skips hidden folders", async () => {
		const { store } = vault();
		const r = await toolByName("list_vault_files")!.run({}, { store });
		expect(r.text).toContain("- resources/Lecture 3.pdf (pdf)");
		expect(r.text).not.toContain("courses/");
		const all = await toolByName("list_vault_files")!.run({ folder: "" }, { store });
		expect(all.text).toContain("courses/calc/notes.md");
		expect(all.text).not.toContain(".groundwork");
		const none = await toolByName("list_vault_files")!.run({ folder: "nope" }, { store });
		expect(none.text).toMatch(/No files in nope/);
	});

	it("read_vault_file returns the file for the model", async () => {
		const { store } = vault();
		const r = await toolByName("read_vault_file")!.run({ path: "diagram.png" }, { store });
		expect(r.files?.[0]).toMatchObject({ path: "resources/diagram.png", kind: "image" });
		const missing = await toolByName("read_vault_file")!.run({ path: "nothing.pdf" }, { store });
		expect(missing.isError).toBe(true);
	});

	it("AgentSession sends attachments and file tool results as content blocks", async () => {
		const { io, store } = vault();
		const requests: ChatMessage[][] = [];
		const provider: Provider = {
			name: "fake",
			async complete(req: ProviderRequest) {
				requests.push(structuredClone(req.messages));
				if (requests.length === 1) return { content: [{ type: "tool_use", id: "t1", name: "read_vault_file", input: { path: "Lecture 3.pdf" } }], stopReason: "tool_use" };
				return { content: [{ type: "text", text: "Got it." }], stopReason: "end_turn" };
			},
		};
		const agent = new AgentSession({ provider, store, tools: TOOLS, system: "", session: { id: "s" } });
		await agent.send("Explain this", () => {}, undefined, [await loadVaultFile(io, "resources/diagram.png")]);
		const first = requests[0][0].content as ContentBlock[];
		expect(first.map((b) => b.type)).toEqual(["text", "image", "text"]);
		const result = (requests[1][2].content as ContentBlock[])[0] as Extract<ContentBlock, { type: "tool_result" }>;
		expect(result.type).toBe("tool_result");
		expect((result.content as ContentBlock[]).map((b) => b.type)).toEqual(["text", "text", "document"]);
	});
});
