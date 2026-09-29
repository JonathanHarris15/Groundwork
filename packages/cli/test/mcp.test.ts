import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/groundwork.js");
const clients: Client[] = [];

async function connect(vault: string, elicit?: (req: any) => any) {
	const client = new Client({ name: "test", version: "1" }, { capabilities: elicit ? { elicitation: {} } : {} });
	if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req));
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--vault", vault, "--no-sync"] }));
	clients.push(client);
	return client;
}

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

afterEach(async () => {
	for (const c of clients.splice(0)) await c.close();
});

const quizArgs = {
	concept: "Slope of a line",
	question: "Slope through $(1,2)$ and $(3,8)$?",
	options: [
		{ label: "$3$", value: "three" },
		{ label: "$\\frac{1}{3}$", value: "third", misconception: "divides run by rise" },
	],
	correctAnswer: "three",
	explanation: "Rise over run: 6/2 = 3.",
	difficulty: 2,
	kind: "probe",
	shuffle: false,
};

describe("groundwork mcp", () => {
	it("serves the tools, teaching method, and a chat-mode quiz", async () => {
		const vault = mkdtempSync(path.join(os.tmpdir(), "gw-mcp-"));
		const client = await connect(vault);

		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["get_learner_overview", "set_goal", "quiz", "submit_quiz_answer", "sync_vault"]));
		expect(names).not.toContain("ask_user");

		const overview = text(await client.callTool({ name: "get_learner_overview", arguments: {} }));
		expect(overview).toContain("Unconditional truths first");

		await client.callTool({ name: "upsert_concept", arguments: { title: "Slope of a line" } });
		const q = text(await client.callTool({ name: "quiz", arguments: quizArgs }));
		expect(q).toContain("**A.** $3$");
		expect(q).toContain("**C.** I don't know");
		const id = /quiz_id "([^"]+)"/.exec(q)![1];

		const graded = text(await client.callTool({ name: "submit_quiz_answer", arguments: { quiz_id: id, answer: "B" } }));
		expect(graded).toContain("INCORRECTLY");
		expect(graded).toContain("divides run by rise");

		const evidence = readFileSync(path.join(vault, ".groundwork/evidence/slope-of-a-line.jsonl"), "utf8");
		expect(evidence).toContain('"outcome":"incorrect"');

		const prompts = await client.listPrompts();
		expect(prompts.prompts.map((p) => p.name)).toContain("teach");
	}, 30_000);

	it("uses an elicitation form when the client supports it", async () => {
		const vault = mkdtempSync(path.join(os.tmpdir(), "gw-mcp-"));
		let seen: any;
		const client = await connect(vault, (req) => {
			seen = req.params;
			return { action: "accept", content: { answer: "three", note: "rise over run" } };
		});
		await client.callTool({ name: "upsert_concept", arguments: { title: "Slope of a line" } });
		const r = text(await client.callTool({ name: "quiz", arguments: quizArgs }));
		expect(seen.message).toContain("Slope through (1,2) and (3,8)?");
		expect(seen.requestedSchema.properties.answer.oneOf.map((o: any) => o.title)).toEqual(["A. 3", "B. (1)/(3)", "I don't know"]);
		expect(r).toContain("CORRECTLY");
		expect(r).toContain("Learner's note: rise over run");
	}, 30_000);
});
