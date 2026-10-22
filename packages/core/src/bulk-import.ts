/**
 * One goal from a stack of documents.
 *
 * Sub-agents each read a shard (by vault path, never the whole bulk in one
 * request). A merge step dedupes names, builds one prerequisite graph, and
 * checks it: no duplicate concepts, no cycles, no dangling prerequisites,
 * every concept traceable to a document. The caller writes that graph with
 * `set_goal`.
 *
 * Hosted Light and Heavy run the sub-agents on the Groundwork server and
 * charge the hosted allowance for each call. Bring your own model uses the
 * same fan-out with the saved key, and that key is billed by its provider,
 * not by the hosted allowance. A Claude subscription never reaches this
 * server path: the plugin asks the tutor to open each file with
 * `read_vault_file` instead.
 *
 * The plugin saves the stack as a job, then asks for one shard at a time.
 * The website proxy closes a request at about 60 seconds. A job step is one
 * model call, and the plugin asks again until the goal is stored.
 */

import { directSourceReference, sourceBoundConceptReason } from "./concept-title";
import { courseIsEmpty, groundCourse, mergeCourseInputs, sourceSlice, type CourseInput, type SourceDoc } from "./course-grounding";
import { chunkLectureText, DOCUMENT_TEXT_MAX, LECTURE_CHUNK_CHARS } from "./document-text";
import { cancelLater, later } from "./timers";
import { findCycle } from "./graph";
import type { HttpClient, HttpResponse } from "./http";
import { classifyLearnerAsk, visibleAsk } from "./intent";
import { slugify } from "./markdown";
import type { GoalInput } from "./store";
import { JSON_BODY_LIMIT_BYTES, uploadTooLargeError } from "./upload-limit";

/** A stack this size, with a study ask, is read in shards instead of one turn. */
export const BULK_MIN_FILES = 3;
/** Files in one sub-agent request. */
export const BULK_SHARD_MAX_FILES = 2;
/** Characters of document text in one sub-agent request. */
export const BULK_SHARD_MAX_CHARS = 60_000;
/** Characters kept from one document before it is split into lecture parts. */
export const BULK_FILE_MAX_CHARS = DOCUMENT_TEXT_MAX;
/** Documents in one import, before a long lecture is split into parts. */
export const BULK_MAX_DOCUMENTS = 80;
/** Parts after that split. A lecture longer than one part still arrives whole. */
export const BULK_MAX_PARTS = 160;
/** Characters of document text in one HTTP body. Well under the 30 MB cap. */
export const BULK_REQUEST_MAX_CHARS = 400_000;
export const BULK_PARALLELISM = 3;
/** Extra attempts after a shard's first failure. */
export const BULK_RETRIES = 2;
/** Concept titles in one rename call. Small enough that the call finishes inside the website timeout. */
export const BULK_MERGE_BATCH = 20;

export const BUILDING_LABEL = "Building one plan";

export function readingLabel(done: number, total: number): string {
	const noun = total === 1 ? "document" : "documents";
	return `Reading ${total} ${noun}... ${done}/${total}`;
}

export interface BulkFile {
	path: string;
	name: string;
	text: string;
}

export interface ConceptSource {
	path: string;
	locator: string;
}

export interface ExtractedConcept {
	title: string;
	summary?: string;
	prerequisites: string[];
	requiredLevel?: number;
	sources: ConceptSource[];
	excerpts?: Array<{ quote: string; provenance?: string }>;
	preferredMethod?: string;
	alternates?: string[];
	methodConflict?: string;
}

export interface BulkProgress {
	phase: "reading" | "building";
	done: number;
	total: number;
	label: string;
}

export interface BulkCompletion {
	text: string;
	usage: { input: number; output: number };
}

export interface BulkModel {
	complete(input: { system: string; user: string; phase: "extract" | "merge" }): Promise<BulkCompletion>;
}

export interface BulkImportResult {
	goal: GoalInput;
	concepts: number;
	edges: number;
	shards: number;
	documents: number;
	usage: { input: number; output: number };
	elapsedMs: number;
	progress: string[];
	notes: string[];
	budgetUsed?: number;
}

export class BulkImportError extends Error {
	readonly status: number;

	constructor(message: string, status = 422) {
		super(message);
		this.name = "BulkImportError";
		this.status = status;
	}
}

/** True when this message is asking for one goal over a stack of documents. */
export function shouldBulkImport(paths: readonly string[], userText: string): boolean {
	const unique = new Set(paths.map((path) => path.trim()).filter(Boolean));
	if (unique.size < BULK_MIN_FILES) return false;
	return asksForCohesiveGoal(userText);
}

export function asksForCohesiveGoal(userText: string): boolean {
	const visible = visibleAsk(userText);
	if (!visible) return false;
	const ask = classifyLearnerAsk(visible);
	if (ask === "survey" || ask === "artifact") return false;
	if (ask === "study") return true;
	return wantsOneGoal(visible);
}

function wantsOneGoal(text: string): boolean {
	return (
		/\b(learn|study|cover)\b.{0,80}\b(all|everything|these|them)\b/i.test(text) ||
		/\b(one|a|single)\s+goal\b/i.test(text) ||
		/\bgoal\b.{0,60}\b(all|these|documents|decks|lectures|slides|files|homework)\b/i.test(text)
	);
}

export function bulkGoalTitle(userText: string, explicit?: string): string {
	const given = explicit?.trim();
	if (given) return clipTitle(given);
	const visible = visibleAsk(userText).replace(/\s+/g, " ").trim();
	if (visible.length >= 8 && visible.length <= 72 && !visible.endsWith("?")) return clipTitle(visible.replace(/[.!]+$/, ""));
	return "Learn these materials";
}

function clipTitle(title: string): string {
	const clean = title.replace(/\s+/g, " ").trim();
	return clean.length > 72 ? clean.slice(0, 72).replace(/\s+\S*$/, "") || clean.slice(0, 72) : clean;
}

/** Split a long lecture on page or slide boundaries. Every part is sent; the path stays the file's path. */
export function filesForWire(files: BulkFile[]): BulkFile[] {
	const out: BulkFile[] = [];
	for (const file of files) {
		const name = file.name || file.path.split("/").pop() || file.path;
		const text = file.text.length > BULK_FILE_MAX_CHARS ? file.text.slice(0, BULK_FILE_MAX_CHARS) : file.text;
		const chunks = chunkLectureText(text, LECTURE_CHUNK_CHARS);
		if (chunks.length <= 1) {
			out.push({ path: file.path, name, text: chunks[0] ?? "" });
			continue;
		}
		chunks.forEach((chunk, index) => {
			out.push({ path: file.path, name: `${name} (part ${index + 1})`, text: chunk });
		});
	}
	return out;
}

/** Groups files so one HTTP body stays under the character budget. */
export function packBulkRequests(files: BulkFile[], maxChars = BULK_REQUEST_MAX_CHARS): BulkFile[][] {
	const batches: BulkFile[][] = [];
	let current: BulkFile[] = [];
	let chars = 0;
	for (const file of files) {
		const size = file.text.length + file.path.length + file.name.length;
		if (current.length && chars + size > maxChars) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(file);
		chars += size;
	}
	if (current.length) batches.push(current);
	return batches;
}

/** Groups files so one sub-agent sees a bounded slice. */
export function planShards(files: BulkFile[], opts: { maxFiles?: number; maxChars?: number } = {}): BulkFile[][] {
	const maxFiles = opts.maxFiles ?? BULK_SHARD_MAX_FILES;
	const maxChars = opts.maxChars ?? BULK_SHARD_MAX_CHARS;
	const shards: BulkFile[][] = [];
	let current: BulkFile[] = [];
	let chars = 0;
	for (const file of files) {
		const size = Math.min(file.text.length, maxChars);
		if (current.length && (current.length >= maxFiles || chars + size > maxChars)) {
			shards.push(current);
			current = [];
			chars = 0;
		}
		current.push(file);
		chars += size;
	}
	if (current.length) shards.push(current);
	return shards;
}

export function readingProgress(done: number, total: number): BulkProgress {
	return { phase: "reading", done, total, label: readingLabel(done, total) };
}

export function buildingProgress(total: number): BulkProgress {
	return { phase: "building", done: total, total, label: BUILDING_LABEL };
}

const EXTRACT_SYSTEM = [
	"You extract concepts from course documents for one learning goal.",
	'Return JSON only, no markdown: {"concepts":[{"title":"Limit","summary":"The value a function approaches.","prerequisites":[],"requiredLevel":2,"sources":[{"path":"resources/lecture-1.md","locator":"slide 2"}]},{"title":"One-sided limit","summary":"A limit from the left or the right.","prerequisites":["Limit"],"requiredLevel":2,"sources":[{"path":"resources/lecture-1.md","locator":"slide 4"}]}]}',
	"A concept is one idea a quiz can ask about. Limit and One-sided limit are two concepts. A lecture, a chapter, or a slide deck is not a concept.",
	"Read the whole document. Emit one concept for each distinct idea it teaches. The list grows with the document: a lecture with many ideas is many concepts, not one outline entry.",
	"prerequisites are the direct earlier ideas, by the titles you used.",
	"Every concept needs a source path copied from a document tag and a locator (slide, page, or section).",
	"When the text states a method, add preferredMethod in the professor's words, and alternates for a method the text calls an alternate. Copy up to three verbatim quotes of at most 400 characters that appear in the document. A quote that is not in the text is dropped.",
	"Do not invent concepts that these documents do not teach. Do not stop after the first few ideas.",
].join("\n");

const MERGE_SYSTEM = [
	"You reconcile concept names taken from separate documents into one list.",
	'Return JSON only, no markdown: {"renames":[{"from":"Limits","to":"Limit"}]}',
	"kept are titles already accepted. concepts are the only titles you may rename, against kept and against each other.",
	"Rename a title only when it is the same concept as another title. Return at most one rename per concept.",
	"Do not add concepts. Do not drop concepts.",
].join("\n");

export async function runBulkImport(input: {
	files: BulkFile[];
	userText: string;
	title?: string;
	model: BulkModel;
	onProgress?: (event: BulkProgress) => void;
	signal?: AbortSignal;
	concurrency?: number;
	retries?: number;
}): Promise<BulkImportResult> {
	const started = Date.now();
	const files = filesForWire(input.files).filter((file) => file.path.trim());
	if (!files.length) throw new BulkImportError("Name the documents to read.");
	const progress: string[] = [];
	const note = (event: BulkProgress) => {
		progress.push(event.label);
		input.onProgress?.(event);
	};
	const usage = { input: 0, output: 0 };
	const extracted = await extractBulkFiles({
		files,
		userText: input.userText,
		model: input.model,
		onProgress: note,
		signal: input.signal,
		concurrency: input.concurrency,
		retries: input.retries,
		usage,
	});
	note(buildingProgress(files.length));
	const merged = await mergeBulkConcepts({
		concepts: extracted.concepts,
		documents: [...new Set(files.map((file) => file.path))],
		files,
		userText: input.userText,
		title: input.title,
		model: input.model,
		usage,
		signal: input.signal,
		shards: extracted.shards,
		progress,
		started,
	});
	return merged;
}

export async function extractBulkFiles(input: {
	files: BulkFile[];
	userText: string;
	model: BulkModel;
	onProgress?: (event: BulkProgress) => void;
	signal?: AbortSignal;
	concurrency?: number;
	retries?: number;
	usage?: { input: number; output: number };
}): Promise<{ concepts: ExtractedConcept[]; shards: number; usage: { input: number; output: number } }> {
	const files = filesForWire(input.files).filter((file) => file.path.trim());
	const usage = input.usage ?? { input: 0, output: 0 };
	const shards = planShards(files);
	input.onProgress?.(readingProgress(0, files.length));
	let done = 0;
	const extracted = await mapPool(shards, input.concurrency ?? BULK_PARALLELISM, async (shard) => {
		const concepts = await readShard(shard, input.userText, input.model, usage, input.retries ?? BULK_RETRIES, input.signal);
		done += shard.length;
		input.onProgress?.(readingProgress(done, files.length));
		return concepts;
	});
	return { concepts: extracted.flat(), shards: shards.length, usage };
}

async function readShard(
	shard: BulkFile[],
	userText: string,
	model: BulkModel,
	usage: { input: number; output: number },
	retries: number,
	signal?: AbortSignal,
): Promise<ExtractedConcept[]> {
	const names = shard.map((file) => file.name).join(", ");
	try {
		return await withRetry(async () => {
			const completion = await model.complete({ system: EXTRACT_SYSTEM, user: shardPrompt(shard, userText), phase: "extract" });
			addUsage(usage, completion.usage);
			const concepts = parseExtract(completion.text);
			const snapped = concepts.map((concept) => snapConcept(concept, shard)).filter((concept): concept is ExtractedConcept => !!concept);
			return withDocumentIdeas(snapped, shard);
		}, retries, signal);
	} catch (err) {
		if (err instanceof BulkImportError && err.status < 500) throw err;
		const why = err instanceof Error ? err.message : "The document read failed.";
		throw new BulkImportError(`Could not read ${names}. ${why}`, err instanceof BulkImportError ? err.status : 502);
	}
}

export async function mergeBulkConcepts(input: {
	concepts: ExtractedConcept[];
	documents: string[];
	files?: BulkFile[];
	userText: string;
	title?: string;
	model: BulkModel;
	usage?: { input: number; output: number };
	signal?: AbortSignal;
	shards?: number;
	progress?: string[];
	started?: number;
}): Promise<BulkImportResult> {
	const usage = input.usage ?? { input: 0, output: 0 };
	const nodes = dedupedMergeNodes(input.concepts);
	const renames: Array<{ from: string; to: string }> = [];
	let cursor = 0;
	while (cursor < nodes.length) {
		const range = mergeBatchRange(nodes.length, cursor);
		if (!range) break;
		const batch = await renameMergeBatch(input.model, nodes.slice(range.from, range.to), nodes.slice(0, range.from).map((node) => node.title), input.signal);
		renames.push(...batch.renames);
		addUsage(usage, batch.usage);
		cursor = range.to;
	}
	return assembleMergedGoal({
		nodes,
		renames,
		documents: input.documents,
		files: input.files,
		userText: input.userText,
		title: input.title,
		usage,
		shards: input.shards,
		progress: input.progress,
		started: input.started,
	});
}

/** One stable list for every rename batch. The cursor walks this list. */
export function dedupedMergeNodes(concepts: ExtractedConcept[]): ExtractedConcept[] {
	return dedupeConcepts(concepts.map(cleanConcept).filter((concept): concept is ExtractedConcept => !!concept));
}

/** The next rename slice, or null when every title has been offered to the model. */
export function mergeBatchRange(total: number, cursor: number, batch = BULK_MERGE_BATCH): { from: number; to: number } | null {
	if (total <= 0 || cursor >= total) return null;
	const from = Math.max(0, cursor);
	return { from, to: Math.min(total, from + batch) };
}

/** One model call. A failure leaves this batch unnamed rather than holding the request open for a retry. */
export async function renameMergeBatch(
	model: BulkModel,
	batch: ExtractedConcept[],
	kept: string[],
	signal?: AbortSignal,
): Promise<{ renames: Array<{ from: string; to: string }>; usage: { input: number; output: number } }> {
	if (!batch.length) return { renames: [], usage: { input: 0, output: 0 } };
	if (signal?.aborted) throw new BulkImportError("Cancelled.", 499);
	try {
		const completion = await model.complete({
			system: MERGE_SYSTEM,
			user: JSON.stringify({ kept, concepts: batch.map(mergeView) }),
			phase: "merge",
		});
		return { renames: parseRenames(completion.text), usage: completion.usage ?? { input: 0, output: 0 } };
	} catch (err) {
		if (signal?.aborted) throw new BulkImportError("Cancelled.", 499);
		if (err instanceof BulkImportError && err.status === 499) throw err;
		return { renames: [], usage: { input: 0, output: 0 } };
	}
}

/** Code only. Applies the renames from every batch and checks the graph. */
export function assembleMergedGoal(input: {
	nodes: ExtractedConcept[];
	renames: Array<{ from: string; to: string }>;
	documents: string[];
	files?: BulkFile[];
	userText: string;
	title?: string;
	usage?: { input: number; output: number };
	shards?: number;
	progress?: string[];
	started?: number;
}): BulkImportResult {
	const started = input.started ?? Date.now();
	const usage = input.usage ?? { input: 0, output: 0 };
	const progress = input.progress ?? [];
	if (!input.nodes.length) throw new BulkImportError("No concepts could be read from these documents.");
	const repaired = repairGraph(dedupeConcepts(applyRenames(input.nodes, input.renames)));
	const grounded = attachCourse(repaired.nodes, input.files ?? []);
	const goal = toGoalInput(grounded, input.documents, input.userText, input.title);
	const edges = goal.nodes.reduce((sum, node) => sum + (node.prerequisites?.length ?? 0), 0);
	return {
		goal,
		concepts: goal.nodes.length,
		edges,
		shards: input.shards ?? planShards(input.documents.map((path) => ({ path, name: path, text: "" }))).length,
		documents: input.documents.length,
		usage,
		elapsedMs: Date.now() - started,
		progress,
		notes: repaired.notes,
	};
}

function shardPrompt(files: BulkFile[], userText: string): string {
	const ask = visibleAsk(userText).slice(0, 500);
	const docs = files
		.map((file) => `<file path="${file.path.replace(/"/g, "")}">\n${file.text.slice(0, BULK_SHARD_MAX_CHARS)}\n</file>`)
		.join("\n\n");
	return [
		`The learner asked: ${ask}`,
		"List every quiz-sized idea in these documents. Two different ideas stay two concepts. Do not collapse a document into a single title.",
		"",
		docs,
	].join("\n");
}

function mergeView(concept: ExtractedConcept): { title: string; prerequisites: string[]; sources: string[] } {
	return {
		title: concept.title,
		prerequisites: concept.prerequisites,
		sources: concept.sources.map((source) => source.path),
	};
}

function addUsage(total: { input: number; output: number }, usage: { input: number; output: number } | undefined): void {
	if (!usage) return;
	if (Number.isFinite(usage.input)) total.input += usage.input;
	if (Number.isFinite(usage.output)) total.output += usage.output;
}

async function withRetry<T>(fn: () => Promise<T>, retries: number, signal?: AbortSignal): Promise<T> {
	let last: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (signal?.aborted) throw new BulkImportError("Cancelled.", 499);
		try {
			return await fn();
		} catch (err) {
			if (signal?.aborted) throw new BulkImportError("Cancelled.", 499);
			if (err instanceof BulkImportError && err.status < 500) throw err;
			last = err;
		}
	}
	throw last instanceof Error ? last : new BulkImportError("The document read failed.", 502);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	if (!items.length) return [];
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			const item = items[index];
			if (item === undefined) continue;
			out[index] = await fn(item, index);
		}
	});
	await Promise.all(workers);
	return out;
}

export function parseExtract(text: string): ExtractedConcept[] {
	const body = parseJsonObject(text);
	const rows = Array.isArray(body.concepts) ? body.concepts : [];
	const concepts: ExtractedConcept[] = [];
	for (const row of rows) {
		const concept = cleanConcept(row);
		if (concept) concepts.push(concept);
	}
	return concepts;
}

function parseRenames(text: string): Array<{ from: string; to: string }> {
	const body = parseJsonObject(text);
	if (!Array.isArray(body.renames)) return [];
	const renames: Array<{ from: string; to: string }> = [];
	for (const row of body.renames) {
		if (!isRecord(row)) continue;
		const from = stringField(row, "from");
		const to = stringField(row, "to");
		if (from && to) renames.push({ from, to });
	}
	return renames;
}

function parseJsonObject(text: string): Record<string, unknown> {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const raw = fenced?.[1] ?? text;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("The model did not return a concept list.");
	const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The model did not return a concept list.");
	return parsed as Record<string, unknown>;
}

function cleanConcept(value: unknown): ExtractedConcept | null {
	if (!value || typeof value !== "object") return null;
	const title = clipTitle(stringField(value, "title") ?? "");
	if (!title || sourceBoundConceptReason(title)) return null;
	const summary = safeSummary(stringField(value, "summary"));
	const prerequisites = stringList(value, "prerequisites")
		.map((item) => clipTitle(item))
		.filter((item) => item && !sourceBoundConceptReason(item) && !sameConcept(item, title));
	const level = numberField(value, "requiredLevel");
	const sources = sourceList(value);
	const excerpts = excerptList(value);
	const preferredMethod = stringField(value, "preferredMethod");
	const alternates = stringList(value, "alternates").slice(0, 4);
	const methodConflict = stringField(value, "methodConflict");
	return {
		title,
		...(summary ? { summary } : {}),
		prerequisites: [...new Set(prerequisites)],
		...(level ? { requiredLevel: Math.min(5, Math.max(1, Math.round(level))) } : {}),
		sources,
		...(excerpts.length ? { excerpts } : {}),
		...(preferredMethod ? { preferredMethod } : {}),
		...(alternates.length ? { alternates } : {}),
		...(methodConflict ? { methodConflict } : {}),
	};
}

function snapConcept(concept: ExtractedConcept, files: BulkFile[]): ExtractedConcept | null {
	if (!files.length) return null;
	const fallback = files[0];
	if (!fallback) return null;
	const sources = concept.sources.length ? concept.sources : [{ path: fallback.path, locator: "document" }];
	const snapped: ConceptSource[] = [];
	for (const source of sources) {
		const path = files.find((file) => file.path === source.path || file.name === source.path || source.path.endsWith(`/${file.name}`))?.path ?? fallback.path;
		const locator = source.locator.replace(/\s+/g, " ").trim().slice(0, 80) || "document";
		const key = `${path}\0${locator}`;
		if (!snapped.some((item) => `${item.path}\0${item.locator}` === key)) snapped.push({ path, locator });
	}
	const excerpts = verifyExcerpts(concept, files);
	return { ...concept, sources: snapped.slice(0, 6), ...(excerpts.length ? { excerpts } : { excerpts: undefined }) };
}

function verifyExcerpts(concept: ExtractedConcept, files: BulkFile[]): Array<{ quote: string; provenance?: string }> {
	const out: Array<{ quote: string; provenance?: string }> = [];
	for (const excerpt of concept.excerpts ?? []) {
		const paths = concept.sources.map((source) => source.path);
		const corpus = files
			.filter((file) => !paths.length || paths.includes(file.path))
			.map((file) => file.text)
			.join("\n");
		const quote = sourceSlice(excerpt.quote, corpus || files.map((file) => file.text).join("\n"));
		if (!quote) continue;
		if (out.some((item) => item.quote.toLowerCase() === quote.toLowerCase())) continue;
		out.push({ quote, ...(excerpt.provenance ? { provenance: excerpt.provenance } : {}) });
	}
	return out.slice(0, 5);
}

function safeSummary(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const clean = text.replace(/\s+/g, " ").trim().slice(0, 240);
	if (!clean || sourceBoundConceptReason(clean) || directSourceReference(clean)) return undefined;
	return clean;
}

function excerptList(value: object): Array<{ quote: string; provenance?: string }> {
	const raw = (value as { excerpts?: unknown }).excerpts;
	if (!Array.isArray(raw)) return [];
	const excerpts: Array<{ quote: string; provenance?: string }> = [];
	for (const row of raw) {
		if (!isRecord(row)) continue;
		const quote = stringField(row, "quote")?.replace(/\s+/g, " ").trim().slice(0, 400);
		if (!quote) continue;
		const provenance = stringField(row, "provenance");
		excerpts.push({ quote, ...(provenance ? { provenance } : {}) });
	}
	return excerpts.slice(0, 5);
}

function sourceList(value: object): ConceptSource[] {
	const raw = (value as { sources?: unknown }).sources;
	if (!Array.isArray(raw)) return [];
	const sources: ConceptSource[] = [];
	for (const row of raw) {
		if (!isRecord(row)) continue;
		const path = stringField(row, "path");
		if (!path) continue;
		const locator = stringField(row, "locator") || "document";
		sources.push({ path, locator });
	}
	return sources;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: object, key: string): string | undefined {
	const raw = (value as Record<string, unknown>)[key];
	return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function numberField(value: object, key: string): number | undefined {
	const raw = (value as Record<string, unknown>)[key];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function stringList(value: object, key: string): string[] {
	const raw = (value as Record<string, unknown>)[key];
	if (!Array.isArray(raw)) return [];
	return raw.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim());
}

const TITLE_STOP = new Set("a an the of to in on for and or with from into over under using use how what which that this these those".split(" "));

function titleTokens(title: string): Set<string> {
	return new Set(
		title
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((token) => token.length > 2 && !TITLE_STOP.has(token))
			.map(stemToken),
	);
}

function stemToken(token: string): string {
	if (token.length > 4 && token.endsWith("es") && !token.endsWith("ses")) return token.slice(0, -2);
	if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
	return token;
}

function bareTitle(title: string): string {
	return title.replace(/^(?:the|a|an)\s+/i, "").trim();
}

export function sameConcept(a: string, b: string): boolean {
	if (slugify(bareTitle(a)) === slugify(bareTitle(b))) return true;
	const left = titleTokens(a);
	const right = titleTokens(b);
	if (!left.size || !right.size) return false;
	let overlap = 0;
	for (const token of left) if (right.has(token)) overlap++;
	return overlap >= Math.min(left.size, right.size) && overlap / Math.max(left.size, right.size) >= 0.6;
}

export function dedupeConcepts(concepts: ExtractedConcept[]): ExtractedConcept[] {
	const groups: ExtractedConcept[][] = [];
	for (const concept of concepts) {
		const group = groups.find((items) => items[0] && sameConcept(items[0].title, concept.title));
		if (group) group.push(concept);
		else groups.push([concept]);
	}
	return groups.map(mergeGroup);
}

function mergeGroup(group: ExtractedConcept[]): ExtractedConcept {
	const title = canonicalTitle(group.map((concept) => concept.title));
	const prerequisites = [...new Set(group.flatMap((concept) => concept.prerequisites))].filter((item) => !sameConcept(item, title));
	const sources: ConceptSource[] = [];
	for (const concept of group) {
		for (const source of concept.sources) {
			if (!sources.some((item) => item.path === source.path && item.locator === source.locator)) sources.push(source);
		}
	}
	const summary = group.map((concept) => concept.summary).find((item) => !!item);
	const levels = group.map((concept) => concept.requiredLevel).filter((level): level is number => !!level);
	const course = mergeExtractedCourse(group);
	return {
		title,
		...(summary ? { summary } : {}),
		prerequisites,
		...(levels.length ? { requiredLevel: Math.max(...levels) } : {}),
		sources,
		...course,
	};
}

function mergeExtractedCourse(group: ExtractedConcept[]): Pick<ExtractedConcept, "excerpts" | "preferredMethod" | "alternates" | "methodConflict"> {
	let course: CourseInput | undefined;
	for (const concept of group) {
		course = mergeCourseInputs(course, {
			excerpts: concept.excerpts?.map((excerpt) => ({ quote: excerpt.quote, provenance: excerpt.provenance })),
			preferredMethod: concept.preferredMethod,
			alternates: concept.alternates,
			methodConflict: concept.methodConflict,
		});
	}
	if (!course) return {};
	return {
		...(course.excerpts?.length ? { excerpts: course.excerpts.map((excerpt) => ({ quote: excerpt.quote, provenance: excerpt.provenance })) } : {}),
		...(course.preferredMethod ? { preferredMethod: course.preferredMethod } : {}),
		...(course.alternates?.length ? { alternates: course.alternates } : {}),
		...(course.methodConflict ? { methodConflict: course.methodConflict } : {}),
	};
}

function canonicalTitle(titles: string[]): string {
	const counts = new Map<string, number>();
	for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);
	const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0];
	return best?.[0] ?? titles[0] ?? "";
}

function applyRenames(nodes: ExtractedConcept[], renames: Array<{ from: string; to: string }>): ExtractedConcept[] {
	let current = nodes.map((node) => ({ ...node, prerequisites: [...node.prerequisites], sources: [...node.sources] }));
	for (const rename of renames) {
		const to = clipTitle(rename.to);
		if (!to || sourceBoundConceptReason(to)) continue;
		const from = current.find((node) => sameConcept(node.title, rename.from));
		if (!from || sameConcept(from.title, to)) continue;
		const target = current.find((node) => node !== from && sameConcept(node.title, to));
		const previous = from.title;
		if (target) {
			target.prerequisites.push(...from.prerequisites);
			for (const source of from.sources) {
				if (!target.sources.some((item) => item.path === source.path && item.locator === source.locator)) target.sources.push(source);
			}
			if (!target.summary && from.summary) target.summary = from.summary;
			if ((from.requiredLevel ?? 0) > (target.requiredLevel ?? 0)) target.requiredLevel = from.requiredLevel;
			const course = mergeExtractedCourse([target, from]);
			target.excerpts = course.excerpts;
			target.preferredMethod = course.preferredMethod;
			target.alternates = course.alternates;
			target.methodConflict = course.methodConflict;
			current = current.filter((node) => node !== from);
			for (const node of current) node.prerequisites = node.prerequisites.map((item) => (sameConcept(item, previous) ? target.title : item));
		} else {
			from.title = to;
			for (const node of current) node.prerequisites = node.prerequisites.map((item) => (sameConcept(item, previous) ? to : item));
		}
	}
	return current;
}

function repairGraph(concepts: ExtractedConcept[]): { nodes: ExtractedConcept[]; notes: string[] } {
	const notes: string[] = [];
	let nodes = dedupeConcepts(concepts).map((node) => ({
		...node,
		prerequisites: [...new Set(node.prerequisites.filter((item) => item && !sameConcept(item, node.title) && !sourceBoundConceptReason(item)))],
		sources: node.sources.filter((source) => source.path.trim()),
	}));
	nodes = nodes.filter((node) => {
		if (!node.sources.length) {
			notes.push(`Left “${node.title}” off the map because it had no source document.`);
			return false;
		}
		return true;
	});
	const resolve = (title: string) => nodes.find((node) => sameConcept(node.title, title));
	for (const node of nodes) {
		const kept: string[] = [];
		for (const prerequisite of node.prerequisites) {
			const hit = resolve(prerequisite);
			if (!hit) {
				notes.push(`Left “${prerequisite}” off the map because it was not in the documents.`);
				continue;
			}
			if (!kept.some((item) => sameConcept(item, hit.title))) kept.push(hit.title);
		}
		node.prerequisites = kept;
	}
	for (let guard = 0; guard < nodes.length + 1; guard++) {
		const byId = new Map(nodes.map((node) => [slugify(node.title), node]));
		const edges = new Map<string, string[]>();
		for (const node of nodes) {
			edges.set(
				slugify(node.title),
				node.prerequisites.map((item) => slugify(item)).filter((id) => byId.has(id)),
			);
		}
		const cycle = findCycle(edges);
		if (!cycle || cycle.length < 2) break;
		const removed = dropCycleEdge(nodes, byId, cycle);
		if (!removed) break;
		notes.push(`Removed the prerequisite “${removed.to}” from “${removed.from}” so the map has no cycle.`);
	}
	assertGraph(nodes);
	return { nodes, notes };
}

/** Prefer to drop the edge that points from a broader concept back at a later one. */
function dropCycleEdge(
	nodes: ExtractedConcept[],
	byId: Map<string, ExtractedConcept>,
	cycle: string[],
): { from: string; to: string } | null {
	const ids = cycle.slice(0, -1);
	const outside = (node: ExtractedConcept, otherId: string) =>
		node.prerequisites.some((item) => slugify(item) !== otherId && nodes.some((candidate) => slugify(candidate.title) === slugify(item)));
	if (ids.length === 2) {
		const left = byId.get(ids[0] ?? "");
		const right = byId.get(ids[1] ?? "");
		if (left && right && outside(left, ids[1] ?? "") && !outside(right, ids[0] ?? "")) {
			left.prerequisites = left.prerequisites.filter((item) => slugify(item) !== ids[1]);
			return { from: left.title, to: right.title };
		}
		if (left && right && outside(right, ids[0] ?? "") && !outside(left, ids[1] ?? "")) {
			right.prerequisites = right.prerequisites.filter((item) => slugify(item) !== ids[0]);
			return { from: right.title, to: left.title };
		}
	}
	const from = byId.get(cycle[cycle.length - 2] ?? "");
	const to = byId.get(cycle[0] ?? "");
	if (!from || !to) return null;
	const before = from.prerequisites.length;
	from.prerequisites = from.prerequisites.filter((item) => slugify(item) !== slugify(to.title));
	if (from.prerequisites.length === before) return null;
	return { from: from.title, to: to.title };
}

function assertGraph(nodes: ExtractedConcept[]): void {
	if (!nodes.length) throw new BulkImportError("No concepts could be read from these documents.");
	const ids = new Set<string>();
	for (const node of nodes) {
		const id = slugify(node.title);
		if (!id || ids.has(id)) throw new BulkImportError("The concept list still has a duplicate.");
		ids.add(id);
		if (sourceBoundConceptReason(node.title)) throw new BulkImportError(`“${node.title}” names a document, not a concept.`);
		if (!node.sources.length) throw new BulkImportError(`“${node.title}” is not traceable to a document.`);
	}
	const known = new Set(nodes.map((node) => slugify(node.title)));
	for (const node of nodes) {
		for (const prerequisite of node.prerequisites) {
			if (!known.has(slugify(prerequisite))) throw new BulkImportError(`“${prerequisite}” is not a concept on this goal.`);
		}
	}
	const edges = new Map<string, string[]>();
	for (const node of nodes) edges.set(slugify(node.title), node.prerequisites.map((item) => slugify(item)));
	if (findCycle(edges)) throw new BulkImportError("The concept map still has a cycle.");
}

function courseFromExtracted(node: ExtractedConcept): CourseInput | undefined {
	const path = node.sources.find((source) => source.path.trim())?.path;
	const excerpts = (node.excerpts ?? []).map((excerpt) => ({
		quote: excerpt.quote,
		...(excerpt.provenance ? { provenance: excerpt.provenance } : {}),
		...(path ? { path } : {}),
	}));
	if (!excerpts.length && !node.preferredMethod && !node.alternates?.length && !node.methodConflict) return undefined;
	return {
		...(excerpts.length ? { excerpts } : {}),
		...(node.preferredMethod ? { preferredMethod: node.preferredMethod } : {}),
		...(node.alternates?.length ? { alternates: node.alternates } : {}),
		...(node.methodConflict ? { methodConflict: node.methodConflict } : {}),
	};
}

/** Copy verified quotes and the professor's method onto each concept. A quote that is not in the text is left out. */
function attachCourse(nodes: ExtractedConcept[], files: BulkFile[]): ExtractedConcept[] {
	if (!files.length) return nodes;
	const byPath = new Map<string, string>();
	for (const file of files) {
		const prev = byPath.get(file.path) ?? "";
		byPath.set(file.path, prev ? `${prev}\n${file.text}` : file.text);
	}
	const imported = new Date().toISOString().slice(0, 10);
	return nodes.map((node) => {
		const docs: SourceDoc[] = [];
		const seen = new Set<string>();
		for (const source of node.sources) {
			if (!source.path || seen.has(source.path)) continue;
			seen.add(source.path);
			const text = byPath.get(source.path);
			if (!text?.trim()) continue;
			docs.push({ path: source.path, name: source.path.split("/").pop() ?? source.path, text });
		}
		if (!docs.length) return node;
		const grounded = groundCourse(
			node.title,
			docs,
			{
				excerpts: node.excerpts?.map((excerpt) => ({ quote: excerpt.quote, provenance: excerpt.provenance, path: docs[0]?.path })),
				preferredMethod: node.preferredMethod,
				alternates: node.alternates,
				methodConflict: node.methodConflict,
			},
			imported,
		);
		if (courseIsEmpty(grounded.grounding)) {
			return { ...node, excerpts: undefined, preferredMethod: undefined, alternates: undefined, methodConflict: undefined };
		}
		const course = grounded.grounding;
		return {
			...node,
			excerpts: course.excerpts.map((excerpt) => ({ quote: excerpt.quote, provenance: excerpt.provenance })),
			preferredMethod: course.method.preferred,
			alternates: course.method.alternates.length ? course.method.alternates : undefined,
			methodConflict: course.method.conflict,
		};
	});
}

function toGoalInput(nodes: ExtractedConcept[], documents: string[], userText: string, explicit?: string): GoalInput {
	const title = bulkGoalTitle(userText, explicit);
	const sinks = nodes.filter((node) => !nodes.some((other) => other.prerequisites.some((item) => sameConcept(item, node.title)))).map((node) => node.title);
	const targets = sinks.length ? sinks : nodes.map((node) => node.title);
	const why = visibleAsk(userText).replace(/\s+/g, " ").trim().slice(0, 280);
	return {
		title,
		objective: `Build these concepts from the documents, foundations first: ${targets.join(", ")}.`,
		...(why ? { why } : {}),
		approach: "One plan for every document. Foundations come first, and each concept is traceable to a source in Traces.",
		targets,
		nodes: nodes.map((node) => {
			const course = courseFromExtracted(node);
			return {
				title: node.title,
				prerequisites: node.prerequisites,
				...(node.summary ? { summary: node.summary } : {}),
				...(node.requiredLevel ? { requiredLevel: node.requiredLevel } : {}),
				...(course ? { course } : {}),
			};
		}),
		sources: [...new Set(documents.map((path) => path.trim()).filter(Boolean))],
		traces: nodes.flatMap((node) => node.sources.map((source) => ({ title: node.title, path: source.path, locator: source.locator }))),
	};
}

export function bulkGoalNote(input: { title: string; concepts: number; targets: string[]; frontier: string }): string {
	return [
		"<bulk_goal>",
		`Groundwork read the documents in parallel and saved one goal: ${input.title}.`,
		`${input.concepts} concepts. Targets: ${input.targets.join(", ") || "the foundations"}.`,
		input.frontier ? `Frontier: ${input.frontier}.` : "",
		"The goal is already on the account. Do not call set_goal or ingest_exam_materials again.",
		"Call quiz now on the frontier concept. The card is the question. Define every symbol the first time you use it.",
		"</bulk_goal>",
	]
		.filter(Boolean)
		.join("\n");
}

/** A local stand-in used when the server is stubbed. It reads headings, not a model. */
export function heuristicBulkModel(): BulkModel {
	return {
		async complete(input) {
			if (input.phase === "merge") return { text: JSON.stringify({ renames: [] }), usage: { input: 0, output: 0 } };
			return { text: JSON.stringify({ concepts: conceptsFromHeadings(input.user) }), usage: { input: 0, output: 0 } };
		},
	};
}

const GENERIC_HEADING =
	/^(introduction|overview|agenda|outline|summary|review|questions|objectives|learning objectives|today|recap|announcements|references|further reading|thank you|welcome|housekeeping)$/i;

/** Headings the model skipped still count. A short model outline cannot hide the rest of a lecture. */
function withDocumentIdeas(fromModel: ExtractedConcept[], shard: BulkFile[]): ExtractedConcept[] {
	const fromDoc = conceptsFromHeadings(shardPrompt(shard, ""));
	const extra = fromDoc.filter((heading) => !GENERIC_HEADING.test(heading.title) && !fromModel.some((concept) => sameConcept(concept.title, heading.title)));
	return [...fromModel, ...extra];
}

function conceptsFromHeadings(user: string): ExtractedConcept[] {
	const concepts: ExtractedConcept[] = [];
	const files = [...user.matchAll(/<file path="([^"]+)">([\s\S]*?)<\/file>/g)];
	for (const file of files) {
		const path = file[1] ?? "";
		const lines = (file[2] ?? "").split("\n");
		let current: ExtractedConcept | null = null;
		for (const line of lines) {
			const heading = /^#{1,3}\s+(.+)/.exec(line.trim());
			if (heading) {
				if (current) concepts.push(current);
				const title = clipTitle(heading[1] ?? "");
				current = title && !sourceBoundConceptReason(title) ? { title, prerequisites: [], sources: [{ path, locator: "heading" }] } : null;
				continue;
			}
			if (!current) continue;
			const prerequisite = /^prerequisites:\s*(.*)$/i.exec(line.trim());
			if (prerequisite) {
				current.prerequisites = prerequisite[1]
					.split(",")
					.map((item) => clipTitle(item))
					.filter((item) => item && !sourceBoundConceptReason(item));
			}
			const locator = /^locator:\s*(.*)$/i.exec(line.trim());
			if (locator?.[1]) current.sources = [{ path, locator: locator[1].trim().slice(0, 80) }];
		}
		if (current) concepts.push(current);
	}
	return concepts;
}

export type BulkWireEvent =
	| ({ type: "progress" } & BulkProgress)
	| ({ type: "done" } & BulkImportResult)
	| { type: "error"; error: string; status?: number };

export function bulkEventLine(event: BulkWireEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export interface BulkRequest {
	phase: "import" | "extract" | "merge";
	userText: string;
	title?: string;
	files: BulkFile[];
	concepts: ExtractedConcept[];
	documents: string[];
	stream: boolean;
}

export function parseBulkRequest(body: unknown): BulkRequest | { error: string } {
	if (!body || typeof body !== "object") return { error: "Send the documents to import." };
	const raw = body as Record<string, unknown>;
	const phase = raw.phase === "extract" || raw.phase === "merge" || raw.phase === "import" ? raw.phase : "import";
	const userText = typeof raw.userText === "string" ? raw.userText.slice(0, 4_000) : "";
	const title = typeof raw.title === "string" ? raw.title.slice(0, 120) : undefined;
	if ((phase === "import" || phase === "extract") && Array.isArray(raw.files) && raw.files.length > BULK_MAX_DOCUMENTS) {
		return { error: `Send at most ${BULK_MAX_DOCUMENTS} documents.` };
	}
	const files = parseFiles(raw.files);
	const concepts = parseConceptList(raw.concepts);
	const documents = Array.isArray(raw.documents) ? raw.documents.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, BULK_MAX_DOCUMENTS) : [];
	if (phase !== "merge" && !files.length) return { error: "Name the documents to read." };
	if (phase === "merge" && !concepts.length) return { error: "Send the concepts to merge." };
	if ((phase === "import" || phase === "extract") && files.length > BULK_MAX_PARTS) return { error: `Send at most ${BULK_MAX_DOCUMENTS} documents.` };
	return { phase, userText, title, files, concepts, documents: documents.length ? documents : files.map((file) => file.path), stream: raw.stream === true };
}

function parseFiles(value: unknown): BulkFile[] {
	if (!Array.isArray(value)) return [];
	const files: BulkFile[] = [];
	for (const row of value) {
		if (!isRecord(row)) continue;
		const path = stringField(row, "path");
		if (!path || path.includes("..")) continue;
		const name = stringField(row, "name") || path.split("/").pop() || path;
		const text = typeof row.text === "string" ? row.text.slice(0, BULK_FILE_MAX_CHARS) : "";
		const chunks = chunkLectureText(text, LECTURE_CHUNK_CHARS);
		const parts = chunks.length ? chunks : [""];
		parts.forEach((chunk, index) => {
			if (files.length >= BULK_MAX_PARTS) return;
			files.push({
				path: path.slice(0, 300),
				name: (parts.length > 1 ? `${name} (part ${index + 1})` : name).slice(0, 200),
				text: chunk,
			});
		});
		if (files.length >= BULK_MAX_PARTS) break;
	}
	return files;
}

function parseConceptList(value: unknown): ExtractedConcept[] {
	if (!Array.isArray(value)) return [];
	const concepts: ExtractedConcept[] = [];
	for (const row of value) {
		const concept = cleanConcept(row);
		if (concept) concepts.push(concept);
		if (concepts.length >= 400) break;
	}
	return concepts;
}

/** How long the plugin keeps asking before it gives up on a job. */
const BULK_JOB_DEADLINE_MS = 15 * 60 * 1000;
const BULK_JOB_MAX_STEPS = 240;
const BULK_JOB_WAIT_MS = 750;
const BULK_JOB_RETRY_MS = 1000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Plugin call. The documents go up once. Later requests only carry the job id,
 * and each one runs a single shard or the merge. A proxy timeout is retried;
 * the server keeps the finished shard.
 */
export async function requestBulkGoal(input: {
	origin: string;
	token: string;
	files: BulkFile[];
	userText: string;
	title?: string;
	fetchImpl: HttpClient;
	onProgress?: (event: BulkProgress) => void;
	signal?: AbortSignal;
}): Promise<BulkImportResult> {
	const files = filesForWire(input.files);
	const started = Date.now();
	const created = await postJob(input, { job: true, userText: input.userText, title: input.title, files }, 3);
	const jobId = isRecord(created) && typeof created.jobId === "string" ? created.jobId : "";
	if (!/^[a-f0-9]{32}$/.test(jobId)) throw new BulkImportError("The bulk import did not start.");
	noteProgress(created, input.onProgress);
	const state: { done: BulkImportResult | null; error: BulkImportError | null; steps: number } = { done: null, error: null, steps: 0 };
	const workers = Array.from({ length: BULK_PARALLELISM }, () => pollJob(input, jobId, started, state));
	await Promise.all(workers);
	if (state.error) throw state.error;
	if (!state.done) throw new BulkImportError("The bulk import did not return a goal.");
	return state.done;
}

async function pollJob(
	input: { origin: string; token: string; fetchImpl: HttpClient; onProgress?: (event: BulkProgress) => void; signal?: AbortSignal },
	jobId: string,
	started: number,
	state: { done: BulkImportResult | null; error: BulkImportError | null; steps: number },
): Promise<void> {
	while (!state.done && !state.error) {
		if (input.signal?.aborted) {
			state.error = new BulkImportError("Cancelled.", 499);
			return;
		}
		if (Date.now() - started > BULK_JOB_DEADLINE_MS || state.steps >= BULK_JOB_MAX_STEPS) {
			state.error = new BulkImportError("The bulk import took too long.", 504);
			return;
		}
		state.steps += 1;
		let status = 0;
		let body: unknown = null;
		try {
			const posted = await postJobOnce(input, { jobId, step: true });
			status = posted.status;
			body = posted.body;
		} catch (err) {
			if (input.signal?.aborted || (err instanceof BulkImportError && err.status === 499)) {
				state.error = new BulkImportError("Cancelled.", 499);
				return;
			}
			if (err instanceof BulkImportError && !RETRYABLE_STATUS.has(err.status)) {
				state.error = err;
				return;
			}
			try {
				await pause(BULK_JOB_RETRY_MS, input.signal);
			} catch (pauseErr) {
				state.error = pauseErr instanceof BulkImportError ? pauseErr : new BulkImportError("Cancelled.", 499);
				return;
			}
			continue;
		}
		if (state.done || state.error) return;
		if (status < 200 || status >= 300) {
			if (RETRYABLE_STATUS.has(status)) {
				try {
					await pause(BULK_JOB_RETRY_MS, input.signal);
				} catch (pauseErr) {
					state.error = pauseErr instanceof BulkImportError ? pauseErr : new BulkImportError("Cancelled.", 499);
					return;
				}
				continue;
			}
			state.error = new BulkImportError(errorMessage(body), status);
			return;
		}
		if (!isRecord(body)) {
			state.error = new BulkImportError("The bulk import did not finish.");
			return;
		}
		noteProgress(body, input.onProgress);
		if (body.status === "error") {
			state.error = new BulkImportError(typeof body.error === "string" ? body.error : "The bulk import did not finish.", 422);
			return;
		}
		if (body.status === "done") {
			const result = resultFrom(body);
			if (!result) {
				state.error = new BulkImportError("The bulk import did not return a goal.");
				return;
			}
			state.done = result;
			return;
		}
		if (body.status === "wait") {
			try {
				await pause(BULK_JOB_WAIT_MS, input.signal);
			} catch (pauseErr) {
				state.error = pauseErr instanceof BulkImportError ? pauseErr : new BulkImportError("Cancelled.", 499);
				return;
			}
		}
	}
}

async function postJob(
	input: { origin: string; token: string; fetchImpl: HttpClient; signal?: AbortSignal },
	payload: unknown,
	attempts: number,
): Promise<unknown> {
	let last: BulkImportError | null = null;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const posted = await postJobOnce(input, payload);
			if (posted.status >= 200 && posted.status < 300) return posted.body;
			last = new BulkImportError(errorMessage(posted.body), posted.status);
			if (!RETRYABLE_STATUS.has(posted.status) || attempt === attempts - 1) throw last;
		} catch (err) {
			if (input.signal?.aborted) throw new BulkImportError("Cancelled.", 499);
			if (err instanceof BulkImportError && err.status === 499) throw err;
			if (err instanceof BulkImportError && !RETRYABLE_STATUS.has(err.status)) throw err;
			last = err instanceof BulkImportError ? err : new BulkImportError(err instanceof Error ? err.message : "The bulk import did not finish.", 502);
			if (attempt === attempts - 1) throw last;
		}
		await pause(BULK_JOB_RETRY_MS, input.signal);
	}
	throw last ?? new BulkImportError("The bulk import did not start.");
}

async function postJobOnce(
	input: { origin: string; token: string; fetchImpl: HttpClient; signal?: AbortSignal },
	payload: unknown,
): Promise<{ status: number; body: unknown }> {
	const raw = JSON.stringify(payload);
	if (byteSize(raw) > JSON_BODY_LIMIT_BYTES) throw new BulkImportError(uploadTooLargeError(), 413);
	let res: HttpResponse;
	try {
		res = await input.fetchImpl(`${input.origin.replace(/\/+$/, "")}/v1/tutor/bulk-import`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${input.token}` },
			body: raw,
			signal: input.signal,
		});
	} catch (err) {
		if (input.signal?.aborted) throw new BulkImportError("Cancelled.", 499);
		throw new BulkImportError(err instanceof Error ? err.message : "The bulk import did not finish.", 502);
	}
	const text = await res.text();
	let body: unknown = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = { error: text };
		}
	}
	return { status: res.status, body };
}

function noteProgress(body: unknown, onProgress?: (event: BulkProgress) => void): void {
	if (!onProgress || !isRecord(body)) return;
	const event = progressFrom(body.event);
	if (event) onProgress(event);
}

function progressFrom(value: unknown): BulkProgress | null {
	if (!isRecord(value)) return null;
	if (value.phase !== "reading" && value.phase !== "building") return null;
	if (typeof value.label !== "string" || typeof value.done !== "number" || typeof value.total !== "number") return null;
	return { phase: value.phase, done: value.done, total: value.total, label: value.label };
}

function errorMessage(body: unknown): string {
	if (isRecord(body) && typeof body.error === "string" && body.error.trim()) return body.error;
	return "The bulk import did not finish.";
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new BulkImportError("Cancelled.", 499));
	return new Promise((resolve, reject) => {
		const timer = later(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			cancelLater(timer);
			reject(new BulkImportError("Cancelled.", 499));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function byteSize(text: string): number {
	return typeof Buffer !== "undefined" ? Buffer.byteLength(text) : new TextEncoder().encode(text).byteLength;
}

function resultFrom(value: unknown): BulkImportResult | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (raw.type === "extract") return null;
	const goal = raw.goal;
	if (!goal || typeof goal !== "object") return null;
	const typed = goal as GoalInput;
	if (typeof typed.title !== "string" || !Array.isArray(typed.nodes)) return null;
	const usage = raw.usage && typeof raw.usage === "object" ? (raw.usage as { input?: unknown; output?: unknown }) : {};
	return {
		goal: typed,
		concepts: typeof raw.concepts === "number" ? raw.concepts : typed.nodes.length,
		edges: typeof raw.edges === "number" ? raw.edges : 0,
		shards: typeof raw.shards === "number" ? raw.shards : 0,
		documents: typeof raw.documents === "number" ? raw.documents : 0,
		usage: { input: typeof usage.input === "number" ? usage.input : 0, output: typeof usage.output === "number" ? usage.output : 0 },
		elapsedMs: typeof raw.elapsedMs === "number" ? raw.elapsedMs : 0,
		progress: Array.isArray(raw.progress) ? raw.progress.filter((item): item is string => typeof item === "string") : [],
		notes: Array.isArray(raw.notes) ? raw.notes.filter((item): item is string => typeof item === "string") : [],
		...(typeof raw.budgetUsed === "number" ? { budgetUsed: raw.budgetUsed } : {}),
	};
}
