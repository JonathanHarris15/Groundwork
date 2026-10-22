import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hostedCostUsd } from "../src/account/tutor";
import {
	BUILDING_LABEL,
	BULK_MIN_FILES,
	packBulkRequests,
	planShards,
	readingLabel,
	requestBulkGoal,
	runBulkImport,
	shouldBulkImport,
	type BulkModel,
} from "../src/bulk-import";
import { LECTURE_CHUNK_CHARS } from "../src/document-text";
import { JSON_BODY_LIMIT_BYTES } from "../src/upload-limit";
import { findCycle } from "../src/graph";
import { prepareTutorTurn } from "../src/jev/context";
import { MemoryVaultIO } from "../src/io";
import { slugify } from "../src/markdown";
import { KnowledgeStore } from "../src/store";
import { BULK_ASK, nineDeckFiles, scriptedBulkReply } from "./fixtures/bulk-decks";

function scriptedModel(delayMs = 0): BulkModel & { maxInFlight: number; calls: number } {
	let inFlight = 0;
	const state = { maxInFlight: 0, calls: 0 };
	const model: BulkModel & { maxInFlight: number; calls: number } = {
		maxInFlight: 0,
		calls: 0,
		async complete(req) {
			inFlight += 1;
			state.maxInFlight = Math.max(state.maxInFlight, inFlight);
			model.maxInFlight = state.maxInFlight;
			state.calls += 1;
			model.calls = state.calls;
			if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
			inFlight -= 1;
			const reply = scriptedBulkReply(req.system, req.user);
			return reply;
		},
	};
	return model;
}

function jsonReply(payload: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		headers: { get: () => "application/json" },
		text: async () => JSON.stringify(payload),
		json: async () => payload,
		arrayBuffer: async () => new ArrayBuffer(0),
		body: null,
	};
}

describe("bulk import", () => {
	it("starts a bulk read only for a study ask over a stack of documents", () => {
		const paths = Array.from({ length: 9 }, (_, i) => `resources/lecture-${i}.md`);
		expect(shouldBulkImport(paths, BULK_ASK)).toBe(true);
		expect(shouldBulkImport(paths, "Make a goal to learn all of these decks")).toBe(true);
		expect(shouldBulkImport(paths.slice(0, BULK_MIN_FILES - 1), BULK_ASK)).toBe(false);
		expect(shouldBulkImport(paths, "Summarize these lectures")).toBe(false);
		expect(shouldBulkImport(paths, "Put together a study guide for these files")).toBe(false);
		expect(shouldBulkImport(paths, "What is a limit?")).toBe(false);
	});

	it("packs nine documents into shards of at most two", () => {
		const shards = planShards(nineDeckFiles());
		expect(shards).toHaveLength(5);
		expect(shards.map((shard) => shard.length)).toEqual([2, 2, 2, 2, 1]);
		expect(readingLabel(4, 9)).toBe("Reading 9 documents... 4/9");
		expect(BUILDING_LABEL).toBe("Building one plan");
	});

	it("turns nine decks into one acyclic goal and keeps a trace for every concept", async () => {
		const model = scriptedModel(20);
		const started = Date.now();
		const result = await runBulkImport({ files: nineDeckFiles(), userText: BULK_ASK, model });
		const elapsedMs = Date.now() - started;
		expect(result.progress).toContain("Reading 9 documents... 4/9");
		expect(result.progress).toContain("Building one plan");
		expect(result.shards).toBe(5);
		expect(result.documents).toBe(9);
		expect(model.maxInFlight).toBeGreaterThan(1);
		expect(model.maxInFlight).toBeLessThanOrEqual(3);
		expect(elapsedMs).toBeLessThan(model.calls * 20);

		const store = new KnowledgeStore(new MemoryVaultIO());
		await store.ensureLayout();
		const report = await store.setGoal(result.goal, { judgments: "off" });
		await store.setWorkingGoal(report.goal.title);
		expect(await store.goals()).toHaveLength(1);
		expect((await store.workingGoal())?.title).toBe(report.goal.title);

		const titles = report.nodes.map((node) => node.title);
		expect(new Set(titles.map((title) => slugify(title))).size).toBe(titles.length);
		expect(titles.filter((title) => slugify(title) === "limit")).toEqual(["Limit"]);
		expect(titles).not.toContain("FTC");
		expect(titles).not.toContain("Limits");
		expect(titles).not.toContain("Eigenvalue");
		expect(titles.some((title) => /lecture|slides|homework/i.test(title))).toBe(false);
		expect(titles).toContain("Fundamental theorem");
		expect(titles).toContain("Chain rule");

		const prereq = (title: string) => report.nodes.find((node) => node.title === title)?.prerequisites.map((id) => report.nodes.find((node) => node.id === id)?.title);
		expect(prereq("Derivative")).toEqual(["Limit"]);
		expect(prereq("Chain rule")).toEqual(["Derivative"]);
		expect(prereq("Fundamental theorem")?.sort()).toEqual(["Definite integral", "Derivative"].sort());

		const edges = new Map(report.nodes.map((node) => [node.id, node.prerequisites]));
		expect(findCycle(edges)).toBeNull();
		const edgeCount = report.nodes.reduce((sum, node) => sum + node.prerequisites.length, 0);
		expect(edgeCount).toBe(result.edges);
		expect(result.concepts).toBe(report.nodes.length);
		expect(report.goal.targets).not.toContain(report.nodes.find((node) => node.title === "Limit")?.id);
		expect(report.goal.sources).toHaveLength(9);

		const goalText = await store.io.read(report.goal.path);
		for (const node of report.nodes) {
			expect(goalText).toContain(node.title);
			expect(goalText).toContain("resources/");
		}
		expect(goalText).toContain("## Traces");
		for (const concept of (await store.concepts()).values()) {
			expect(concept.body).not.toMatch(/resources\//);
		}

		const perCall = hostedCostUsd({ input: 1000, output: 200 }, "light");
		const costUsd = Math.round(model.calls * perCall * 10_000) / 10_000;
		mkdirSync("/opt/cursor/artifacts", { recursive: true });
		writeFileSync(
			"/opt/cursor/artifacts/bulk-import-run.json",
			JSON.stringify(
				{
					documents: 9,
					concepts: result.concepts,
					edges: edgeCount,
					shards: result.shards,
					elapsedMs,
					modelCalls: model.calls,
					maxInFlight: model.maxInFlight,
					costUsd,
					usage: result.usage,
					goal: report.goal.title,
				},
				null,
				2,
			),
		);
	});

	it("keeps a concept for each taught idea when the model only returns an outline", async () => {
		const decks = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India"];
		const ideas = ["Limit", "Slope", "Series", "Vector", "Matrix", "Sample"];
		const files = decks.map((deck, index) => {
			const sections = ideas.map((idea, section) => {
				const title = `${deck} ${idea}`;
				const prior = section === 0 ? "" : `${deck} ${ideas[section - 1]}`;
				return `# ${title}\nA quiz can ask this on its own.\nlocator: section ${section + 1}\n${prior ? `prerequisites: ${prior}\n` : ""}`;
			});
			return { path: `resources/lecture-${index + 1}.md`, name: `lecture-${index + 1}.md`, text: sections.join("\n") };
		});
		const model: BulkModel = {
			async complete(req) {
				if (req.phase === "merge") return { text: JSON.stringify({ renames: [] }), usage: { input: 10, output: 10 } };
				const concepts = files.flatMap((file, index) =>
					req.user.includes(file.path) ? [{ title: `${decks[index]} Limit`, prerequisites: [], sources: [{ path: file.path, locator: "section 1" }] }] : [],
				);
				return { text: JSON.stringify({ concepts }), usage: { input: 10, output: 10 } };
			},
		};
		const result = await runBulkImport({ files, userText: BULK_ASK, model });
		expect(result.concepts).toBe(54);
		expect(result.concepts).toBeGreaterThan(files.length * 4);
		expect(result.edges).toBe(45);
		const edges = new Map(result.goal.nodes.map((node) => [slugify(node.title), (node.prerequisites ?? []).map((title) => slugify(title))]));
		expect(findCycle(edges)).toBeNull();
	});

	it("retries a shard that fails once", async () => {
		let boom = true;
		const model: BulkModel = {
			async complete(req) {
				if (boom && req.phase === "extract") {
					boom = false;
					throw new Error("The model provider could not be reached.");
				}
				return scriptedBulkReply(req.system, req.user);
			},
		};
		const files = nineDeckFiles().slice(0, 3);
		const result = await runBulkImport({ files, userText: BULK_ASK, model, retries: 1 });
		expect(result.concepts).toBeGreaterThan(0);
		expect(boom).toBe(false);
	});

	it("polls a job so a long stack is not one hosted request", async () => {
		const files = [1, 2, 3, 4, 5, 6].map((n) => ({
			path: `resources/lecture-${n}.md`,
			name: `lecture-${n}.md`,
			text: `# Lecture ${n}\n${"x".repeat(90_000)}`,
		}));
		const wire = files.map((file) => ({ ...file, text: file.text.slice(0, 80_000) }));
		expect(packBulkRequests(wire).length).toBeGreaterThan(1);
		const bodies: Array<Record<string, unknown>> = [];
		const labels: string[] = [];
		let failed = false;
		let steps = 0;
		const jobId = "ab".repeat(16);
		const goal = {
			status: "done",
			event: { phase: "building", done: 6, total: 6, label: "Building one plan" },
			goal: { title: "Learn these materials", nodes: [{ title: "Limit", prerequisites: [] }], sources: files.map((file) => file.path), traces: [] },
			concepts: 1,
			edges: 0,
			shards: 4,
			documents: 6,
			usage: { input: 1, output: 1 },
			elapsedMs: 1,
			progress: [],
			notes: [],
		};
		const result = await requestBulkGoal({
			origin: "https://groundwork.test",
			token: "token",
			files,
			userText: BULK_ASK,
			fetchImpl: async (_url, init) => {
				const raw = init?.body ?? "";
				expect(Buffer.byteLength(raw)).toBeLessThan(JSON_BODY_LIMIT_BYTES);
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				bodies.push(parsed);
				if (parsed.job === true) {
					const sent = parsed.files as Array<{ text: string }>;
					expect(sent.length).toBeGreaterThan(6);
					let total = 0;
					for (const file of sent) {
						expect(file.text.length).toBeLessThanOrEqual(LECTURE_CHUNK_CHARS);
						total += file.text.length;
					}
					expect(total).toBe(files.reduce((sum, file) => sum + file.text.length, 0));
					return jsonReply({ jobId, status: "open", event: { phase: "reading", done: 0, total: 6, label: "Reading 6 documents... 0/6" } });
				}
				expect(parsed.step).toBe(true);
				expect(parsed.jobId).toBe(jobId);
				expect(raw.includes("x".repeat(1000))).toBe(false);
				if (!failed) {
					failed = true;
					return jsonReply({ error: "The website timed out." }, 502);
				}
				steps += 1;
				if (steps < 3) {
					return jsonReply({ status: "open", event: { phase: "reading", done: steps * 2, total: 6, label: `Reading 6 documents... ${steps * 2}/6` } });
				}
				if (steps === 3) return jsonReply({ status: "wait", event: { phase: "building", done: 6, total: 6, label: "Building one plan" } });
				return jsonReply(goal);
			},
			onProgress: (event) => labels.push(event.label),
		});
		expect(bodies.some((body) => body.job === true)).toBe(true);
		expect(bodies.filter((body) => body.step === true).length).toBeGreaterThan(1);
		expect(labels.some((label) => label.startsWith("Reading 6 documents"))).toBe(true);
		expect(labels).toContain("Building one plan");
		expect(result.documents).toBe(6);
		expect(result.goal.nodes.map((node) => node.title)).toEqual(["Limit"]);
	});

	it("leaves vault files closed after a bulk import already read them", async () => {
		const prepared = await prepareTutorTurn({
			message: `${BULK_ASK}\n<bulk_goal>Frontier: Limit.</bulk_goal>`,
			profile: "",
			tutorContext: "",
			attached: [{ path: "resources/lecture-1-limits.md", kind: "text", mediaType: "text/markdown", size: 20, text: "# Limit" }],
			includeFiles: false,
		});
		expect(prepared.files).toEqual([]);
	});
});
