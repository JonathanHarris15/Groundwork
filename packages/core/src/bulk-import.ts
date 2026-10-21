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
 */

import { directSourceReference, sourceBoundConceptReason } from "./concept-title";
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
/** Characters of one document sent to a sub-agent. The rest stays in the vault. */
export const BULK_FILE_MAX_CHARS = 80_000;
/** Characters of document text in one HTTP body. Well under the 30 MB cap. */
export const BULK_REQUEST_MAX_CHARS = 400_000;
export const BULK_PARALLELISM = 3;
/** Extra attempts after a shard's first failure. */
export const BULK_RETRIES = 2;

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

export function filesForWire(files: BulkFile[]): BulkFile[] {
	return files.map((file) => ({
		path: file.path,
		name: file.name || file.path.split("/").pop() || file.path,
		text: file.text.length > BULK_FILE_MAX_CHARS ? file.text.slice(0, BULK_FILE_MAX_CHARS) : file.text,
	}));
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
	'Return JSON only, no markdown: {"concepts":[{"title":"Limit","summary":"The value a function approaches.","prerequisites":[],"requiredLevel":2,"sources":[{"path":"resources/lecture-1.md","locator":"slide 2"}]}]}',
	"A concept is a reusable idea, such as Limit or Chain rule. Never name a file, a lecture, a homework, or a slide deck as a concept.",
	"prerequisites are the direct earlier ideas, by the titles you used.",
	"Every concept needs a source path copied from a document tag and a locator (slide, page, or section).",
	"Do not invent concepts that these documents do not teach.",
].join("\n");

const MERGE_SYSTEM = [
	"You reconcile concept names taken from separate documents into one list.",
	'Return JSON only, no markdown: {"renames":[{"from":"Limits","to":"Limit"}]}',
	"Rename a title only when it is the same concept as another title in the list.",
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
		documents: files.map((file) => file.path),
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
			return concepts.map((concept) => snapConcept(concept, shard)).filter((concept): concept is ExtractedConcept => !!concept);
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
	userText: string;
	title?: string;
	model: BulkModel;
	usage?: { input: number; output: number };
	signal?: AbortSignal;
	shards?: number;
	progress?: string[];
	started?: number;
}): Promise<BulkImportResult> {
	const started = input.started ?? Date.now();
	const usage = input.usage ?? { input: 0, output: 0 };
	const progress = input.progress ?? [];
	if (!input.concepts.length) throw new BulkImportError("No concepts could be read from these documents.");
	let nodes = dedupeConcepts(input.concepts.map(cleanConcept).filter((concept): concept is ExtractedConcept => !!concept));
	const renames = await withRetry(async () => {
		const completion = await input.model.complete({
			system: MERGE_SYSTEM,
			user: JSON.stringify({ concepts: nodes.map(mergeView) }),
			phase: "merge",
		});
		addUsage(usage, completion.usage);
		return parseRenames(completion.text);
	}, 1, input.signal).catch(() => [] as Array<{ from: string; to: string }>);
	nodes = dedupeConcepts(applyRenames(nodes, renames));
	const repaired = repairGraph(nodes);
	const goal = toGoalInput(repaired.nodes, input.documents, input.userText, input.title);
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
	return `The learner asked: ${ask}\n\n${docs}`;
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
	return {
		title,
		...(summary ? { summary } : {}),
		prerequisites: [...new Set(prerequisites)],
		...(level ? { requiredLevel: Math.min(5, Math.max(1, Math.round(level))) } : {}),
		sources,
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
	return { ...concept, sources: snapped.slice(0, 6) };
}

function safeSummary(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const clean = text.replace(/\s+/g, " ").trim().slice(0, 240);
	if (!clean || sourceBoundConceptReason(clean) || directSourceReference(clean)) return undefined;
	return clean;
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
	return {
		title,
		...(summary ? { summary } : {}),
		prerequisites,
		...(levels.length ? { requiredLevel: Math.max(...levels) } : {}),
		sources,
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
		nodes: nodes.map((node) => ({
			title: node.title,
			prerequisites: node.prerequisites,
			...(node.summary ? { summary: node.summary } : {}),
			...(node.requiredLevel ? { requiredLevel: node.requiredLevel } : {}),
		})),
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
	const files = parseFiles(raw.files);
	const concepts = parseConceptList(raw.concepts);
	const documents = Array.isArray(raw.documents) ? raw.documents.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, 40) : [];
	if (phase !== "merge" && !files.length) return { error: "Name the documents to read." };
	if (phase === "merge" && !concepts.length) return { error: "Send the concepts to merge." };
	if ((phase === "import" || phase === "extract") && files.length > 40) return { error: "Send at most 40 documents." };
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
		files.push({ path: path.slice(0, 300), name: name.slice(0, 200), text });
		if (files.length >= 40) break;
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

/** Plugin call. One request when the text fits; otherwise shard requests, then one merge. */
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
	const batches = packBulkRequests(files);
	if (batches.length <= 1) {
		return postBulk(input, { phase: "import", userText: input.userText, title: input.title, files, concepts: [], documents: files.map((file) => file.path), stream: true });
	}
	const concepts: ExtractedConcept[] = [];
	let done = 0;
	input.onProgress?.(readingProgress(0, files.length));
	await mapPool(batches, BULK_PARALLELISM, async (batch) => {
		const part = await postExtract(input, {
			phase: "extract",
			userText: input.userText,
			files: batch,
			concepts: [],
			documents: batch.map((file) => file.path),
			stream: false,
		});
		concepts.push(...part);
		done += batch.length;
		input.onProgress?.(readingProgress(Math.min(done, files.length), files.length));
	});
	input.onProgress?.(buildingProgress(files.length));
	return postBulk(input, {
		phase: "merge",
		userText: input.userText,
		title: input.title,
		files: [],
		concepts,
		documents: files.map((file) => file.path),
		stream: false,
	});
}

async function postExtract(
	input: { origin: string; token: string; fetchImpl: HttpClient; signal?: AbortSignal },
	body: BulkRequest,
): Promise<ExtractedConcept[]> {
	const payload = JSON.stringify(body);
	if (byteSize(payload) > JSON_BODY_LIMIT_BYTES) throw new BulkImportError(uploadTooLargeError(), 413);
	const res = await input.fetchImpl(`${input.origin.replace(/\/+$/, "")}/v1/tutor/bulk-import`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${input.token}` },
		body: payload,
		signal: input.signal,
	});
	const text = await res.text();
	let parsed: unknown = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = { error: text };
		}
	}
	if (!res.ok) {
		const message = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : "The bulk import did not finish.";
		throw new BulkImportError(message, res.status);
	}
	return conceptsFromExtract(parsed);
}

async function postBulk(
	input: {
		origin: string;
		token: string;
		fetchImpl: HttpClient;
		onProgress?: (event: BulkProgress) => void;
		signal?: AbortSignal;
	},
	body: BulkRequest,
): Promise<BulkImportResult> {
	const payload = JSON.stringify(body);
	if (byteSize(payload) > JSON_BODY_LIMIT_BYTES) throw new BulkImportError(uploadTooLargeError(), 413);
	const res = await input.fetchImpl(`${input.origin.replace(/\/+$/, "")}/v1/tutor/bulk-import`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "text/event-stream, application/json", authorization: `Bearer ${input.token}` },
		body: payload,
		signal: input.signal,
	});
	return readBulkResponse(res, input.onProgress);
}

function byteSize(text: string): number {
	return typeof Buffer !== "undefined" ? Buffer.byteLength(text) : new TextEncoder().encode(text).byteLength;
}

async function readBulkResponse(res: HttpResponse, onProgress?: (event: BulkProgress) => void): Promise<BulkImportResult> {
	const type = res.headers.get("content-type") ?? "";
	if (type.includes("text/event-stream")) return readBulkStream(res, onProgress);
	const text = await res.text();
	let body: unknown = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = { error: text };
		}
	}
	if (!res.ok) {
		const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "The bulk import did not finish.";
		throw new BulkImportError(message, res.status);
	}
	const result = resultFrom(body);
	if (!result) throw new BulkImportError("The bulk import did not return a goal.");
	return result;
}

async function readBulkStream(res: HttpResponse, onProgress?: (event: BulkProgress) => void): Promise<BulkImportResult> {
	let buffer = "";
	const found: { done: BulkImportResult | null; failed: { error: string; status?: number } | null } = { done: null, failed: null };
	const take = (chunk: string) => {
		const combined = buffer + chunk;
		const parts = combined.split("\n\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			const data = part
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("\n");
			if (!data) continue;
			try {
				const event = JSON.parse(data) as BulkWireEvent;
				if (event.type === "progress") onProgress?.(event);
				else if (event.type === "done") found.done = resultFrom(event);
				else if (event.type === "error") found.failed = { error: event.error, status: event.status };
			} catch {
				// A bad event is skipped. The buffer keeps a partial frame.
			}
		}
	};
	if (res.body) {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const next = await reader.read();
			if (next.value) take(decoder.decode(next.value, { stream: !next.done }));
			if (next.done) break;
		}
		take(decoder.decode());
	} else {
		take(await res.text());
	}
	if (buffer.trim()) take("\n\n");
	if (found.failed) throw new BulkImportError(found.failed.error || "The bulk import did not finish.", found.failed.status ?? res.status);
	if (!res.ok && !found.done) throw new BulkImportError("The bulk import did not finish.", res.status);
	if (!found.done) throw new BulkImportError("The bulk import did not return a goal.");
	return found.done;
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

/** Extract phase returns concepts, not a goal. The multi-request client reads them here. */
export function conceptsFromExtract(value: unknown): ExtractedConcept[] {
	if (!value || typeof value !== "object") return [];
	return parseConceptList((value as { concepts?: unknown }).concepts);
}
