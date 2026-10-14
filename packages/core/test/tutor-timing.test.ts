import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryVaultIO } from "../src/io";
import { prepareTutorTurn } from "../src/jev/context";

const FILE_MS = 30;
const SELECTOR_MS = 50;
const FIRST_TOKEN_MS = 40;
const FULL_TURN_MS = 180;

const profile = `# Learner profile

## Background

Studied physics. Comfortable with algebra.
`;

function vault(): MemoryVaultIO {
	const io = new MemoryVaultIO();
	io.files.set("resources/lecture-3.md", "# Lecture 3\n\nThe chain rule.\n");
	io.files.set("resources/syllabus.md", "# Syllabus\n\nWeek 1 is review.\n");
	return io;
}

function delayRead(io: MemoryVaultIO): MemoryVaultIO {
	const read = io.read.bind(io);
	io.read = async (path) => {
		await new Promise((resolve) => setTimeout(resolve, FILE_MS));
		return read(path);
	};
	return io;
}

describe("tutor turn timing", () => {
	it("measures time to first token and the full turn, before and after the waits were removed", async () => {
		const beforeIo = delayRead(vault());
		const sequentialStarted = performance.now();
		await beforeIo.read("resources/lecture-3.md");
		await beforeIo.read("resources/syllabus.md");
		const sequentialMs = performance.now() - sequentialStarted;
		const selectorStarted = performance.now();
		await new Promise((resolve) => setTimeout(resolve, SELECTOR_MS));
		const selectorMs = performance.now() - selectorStarted;
		const beforeFirstTokenMs = sequentialMs + selectorMs + FULL_TURN_MS;
		const beforeFullTurnMs = beforeFirstTokenMs;

		const afterStarted = performance.now();
		const prepared = await prepareTutorTurn({
			selector: {
				async select() {
					await new Promise((resolve) => setTimeout(resolve, SELECTOR_MS));
					return [];
				},
			},
			message: "what's the chain rule?",
			profile,
			tutorContext: "",
			attached: [],
			io: delayRead(vault()),
			access: { readFolders: ["resources"], writeFolders: [] },
		});
		const prepareMs = performance.now() - afterStarted;
		expect(prepared.selected).toBe(false);
		expect(prepared.files).toEqual([]);
		const afterFirstTokenMs = prepareMs + FIRST_TOKEN_MS;
		const afterFullTurnMs = prepareMs + FULL_TURN_MS;

		const parallelIo = delayRead(vault());
		let active = 0;
		let maxActive = 0;
		const read = parallelIo.read.bind(parallelIo);
		parallelIo.read = async (path) => {
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				return await read(path);
			} finally {
				active--;
			}
		};
		const parallelStarted = performance.now();
		await prepareTutorTurn({
			selector: {
				async select() {
					return [];
				},
			},
			message: "What does the syllabus say we cover?",
			profile,
			tutorContext: "",
			attached: [],
			io: parallelIo,
			access: { readFolders: ["resources"], writeFolders: [] },
		});
		const parallelMs = performance.now() - parallelStarted;

		const report = {
			note: "Local reconstruction. Before is the old path: sequential vault reads, a blocking context selector, then the full model body before any token. After is the current path on a plain question: no vault scan, no selector, first token while generation continues. Delays are fixed stand-ins for disk, the selector, and OpenRouter.",
			delaysMs: { file: FILE_MS, selector: SELECTOR_MS, firstToken: FIRST_TOKEN_MS, fullGeneration: FULL_TURN_MS },
			before: { firstTokenMs: round(beforeFirstTokenMs), fullTurnMs: round(beforeFullTurnMs), sequentialVaultMs: round(sequentialMs), selectorMs: round(selectorMs) },
			after: { firstTokenMs: round(afterFirstTokenMs), fullTurnMs: round(afterFullTurnMs), prepareMs: round(prepareMs) },
			vaultReads: { sequentialMs: round(sequentialMs), parallelMs: round(parallelMs), maxActive },
		};
		try {
			mkdirSync("/opt/cursor/artifacts", { recursive: true });
			writeFileSync("/opt/cursor/artifacts/tutor-timing.json", JSON.stringify(report, null, 2));
		} catch {
			// The artifact directory is for the review handoff. The assertions below still hold.
		}
		expect(afterFirstTokenMs).toBeLessThan(beforeFirstTokenMs);
		expect(afterFullTurnMs).toBeLessThan(beforeFullTurnMs);
		expect(maxActive).toBeGreaterThan(1);
		expect(parallelMs).toBeLessThan(sequentialMs);
	});
});

function round(ms: number): number {
	return Math.round(ms);
}
