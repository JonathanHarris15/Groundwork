import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
		expect(names).toEqual(
			expect.arrayContaining([
				"get_learner_overview",
				"set_goal",
				"quiz",
				"submit_quiz_answer",
				"grade_answer",
				"practice_test",
				"submit_practice_test",
				"grade_practice_test",
				"sync_vault",
				"ingest_exam_materials",
			]),
		);
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
		expect(prompts.prompts.map((p) => p.name)).toEqual(expect.arrayContaining(["teach", "review", "exam", "practice-test"]));
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
		expect(seen.requestedSchema.properties.familiarity.oneOf.map((o: any) => o.title)[0]).toBe("I've never seen this");
	}, 30_000);

	it("records familiarity on 'I don't know' and hands free responses to the tutor to grade", async () => {
		const vault = mkdtempSync(path.join(os.tmpdir(), "gw-mcp-"));
		const client = await connect(vault);
		await client.callTool({ name: "upsert_concept", arguments: { title: "Slope of a line" } });

		const q = text(await client.callTool({ name: "quiz", arguments: quizArgs }));
		expect(q).toContain("almost have it");
		const id = /quiz_id "([^"]+)"/.exec(q)![1];
		const idk = text(await client.callTool({ name: "submit_quiz_answer", arguments: { quiz_id: id, answer: "I don't know, rings a bell" } }));
		expect(idk).toContain("Familiarity: Rings a bell, but I'm not sure (2/3)");
		expect(idk).toContain("Next move");

		const free = text(
			await client.callTool({
				name: "quiz",
				arguments: { ...quizArgs, format: "free", options: undefined, correctAnswer: undefined, referenceAnswer: "$3$", question: "Compute the slope through $(1,2)$ and $(3,8)$." },
			}),
		);
		expect(free).toContain("Write your answer");
		const freeId = /quiz_id "([^"]+)"/.exec(free)![1];
		const submitted = text(await client.callTool({ name: "submit_quiz_answer", arguments: { quiz_id: freeId, answer: "$\\frac{6}{2} = 3$" } }));
		expect(submitted).toContain("call grade_answer");
		const graded = text(await client.callTool({ name: "grade_answer", arguments: { quiz_id: submitted.match(/quiz_id "([^"]+)"/)![1], outcome: "correct", feedback: "Yes." } }));
		expect(graded).toContain("CORRECTLY");

		const evidence = readFileSync(path.join(vault, ".groundwork/evidence/slope-of-a-line.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(evidence.map((e) => [e.outcome, e.familiarity])).toEqual([
			["dont_know", 2],
			["correct", undefined],
		]);
	}, 30_000);

	it("runs a practice test in chat, then evaluates it", async () => {
		const vault = mkdtempSync(path.join(os.tmpdir(), "gw-mcp-"));
		const client = await connect(vault);
		await client.callTool({ name: "upsert_concept", arguments: { title: "Slope of a line" } });
		const freeQ = { concept: "Slope of a line", question: "Slope of $y = 2x + 1$?", format: "free", referenceAnswer: "$2$", explanation: "Coefficient of x.", difficulty: 1 };
		const t = text(await client.callTool({ name: "practice_test", arguments: { title: "Lines quiz", questions: [quizArgs, freeQ] } }));
		expect(t).toContain("## Lines quiz");
		expect(t).toContain("**1.**");
		expect(t).toContain("**C.** I don't know");
		const testId = /test_id "([^"]+)"/.exec(t)![1];

		const sub = text(
			await client.callTool({
				name: "submit_practice_test",
				arguments: { test_id: testId, answers: [{ question: 1, answer: "A" }, { question: 2, answer: "$2$" }] },
			}),
		);
		expect(sub).toContain("1 free-response answer still need");
		const done = text(await client.callTool({ name: "grade_practice_test", arguments: { test_id: testId, grades: [{ question: 2, outcome: "correct", feedback: "Right." }] } }));
		expect(done).toContain("2/2 (100%)");
		expect(readdirSync(path.join(vault, "tests"))).toHaveLength(1);
	}, 30_000);

	it("uses one elicitation form for a whole practice test", async () => {
		const vault = mkdtempSync(path.join(os.tmpdir(), "gw-mcp-"));
		let seen: any;
		const client = await connect(vault, (req) => {
			seen = req.params;
			return { action: "accept", content: { q1: "__dont_know__", q1_familiarity: "3" } };
		});
		await client.callTool({ name: "upsert_concept", arguments: { title: "Slope of a line" } });
		const r = text(await client.callTool({ name: "practice_test", arguments: { title: "Form test", questions: [quizArgs] } }));
		expect(Object.keys(seen.requestedSchema.properties)).toEqual(["q1", "q1_familiarity"]);
		expect(r).toContain("0/1 (0%)");
		expect(r).toContain("Very familiar, I almost have it");
	}, 30_000);
});
