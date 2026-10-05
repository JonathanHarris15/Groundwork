/**
 * Tutor memory lives on the account. The Obsidian vault is only the optional
 * folders the learner picks as extra context.
 *
 * `TutorMemory` is the private record: concept notes, goals, evidence, chats,
 * and the learner profile. `KnowledgeSnapshot` is the public map derived from
 * it (titles, prerequisite links, mastery). The profile page draws the snapshot
 * and does not receive note bodies.
 */

import { EMPTY_GROUNDWORK_GRAPH, layoutGroundworkGraph, type GroundworkGraph } from "./groundwork-graph";
import type { ConceptStatus } from "./model";

export const CONCEPT_STATUSES = ["unassessed", "learning", "shaky", "solid", "rusty"] as const;

export type SnapshotGoalStatus = "active" | "paused" | "done";

export interface SnapshotConcept {
	id: string;
	title: string;
	prerequisites: string[];
	status: ConceptStatus;
	/** Mastery right now, 0–1. */
	current: number;
	domain?: string;
}

export interface SnapshotGoal {
	title: string;
	status: SnapshotGoalStatus;
	built: number;
	open: number;
	/** Subject shared by most concepts on this goal. */
	domain?: string;
}

/** Private tutor memory stored on the account, as the same text files the store already uses. */
export interface TutorMemory {
	updatedAt: string;
	files: Record<string, string>;
}

const MEMORY_PATH =
	/^(?:learner\.md|concepts\/[^/]+\.md|goals\/[^/]+\.md|sessions\/[^/]+\.md|exams\/[^/]+\.md|tests\/[^/]+\.md|\.groundwork\/focus\.json|\.groundwork\/tutor-context\.md|\.groundwork\/flashcards\.json|\.groundwork\/chats\/[^/]+\.json|\.groundwork\/evidence\/[^/]+\.jsonl)$/;

export const TUTOR_MEMORY_LIMITS = { files: 4000, fileChars: 400_000, totalChars: 8_000_000 };

export function isTutorMemoryPath(path: string): boolean {
	return MEMORY_PATH.test(path);
}

export function emptyTutorMemory(): TutorMemory {
	return { updatedAt: "", files: {} };
}

/** Keep only account-memory paths from a working file map. */
export function tutorMemoryFiles(files: Iterable<[string, string]>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, content] of files) {
		if (isTutorMemoryPath(path)) out[path] = content;
	}
	return out;
}

/** Replace account-memory files in a working copy. Other files in the map are left alone. */
export function replaceTutorMemoryFiles(files: Map<string, string>, memory: Pick<TutorMemory, "files">): void {
	for (const path of [...files.keys()]) {
		if (isTutorMemoryPath(path)) files.delete(path);
	}
	for (const [path, content] of Object.entries(memory.files)) {
		if (isTutorMemoryPath(path)) files.set(path, content);
	}
}

/** Accept a memory bundle from the network. Rejects vault context files and oversized notes. */
export function parseTutorMemoryFiles(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tutor memory needs a files object.");
	const raw = value as Record<string, unknown>;
	const entries = Object.entries(raw);
	if (entries.length > TUTOR_MEMORY_LIMITS.files) throw new Error("Too many memory files.");
	const files: Record<string, string> = {};
	let total = 0;
	for (const [path, content] of entries) {
		if (!isTutorMemoryPath(path)) throw new Error(`"${path}" is not tutor memory. Vault files stay in the folders you pick as context.`);
		if (typeof content !== "string") throw new Error(`"${path}" is not text.`);
		if (content.length > TUTOR_MEMORY_LIMITS.fileChars) throw new Error(`"${path}" is too large.`);
		total += content.length;
		if (total > TUTOR_MEMORY_LIMITS.totalChars) throw new Error("Tutor memory is too large.");
		files[path] = content;
	}
	return files;
}

export interface KnowledgeSnapshot {
	updatedAt: string;
	concepts: SnapshotConcept[];
	goals: SnapshotGoal[];
	counts: Record<ConceptStatus, number>;
}

export interface SnapshotConceptInput {
	id: string;
	title: string;
	prerequisites: string[];
	domain?: string;
	stats: { status: ConceptStatus; current: number };
}

export interface SnapshotGoalInput {
	title: string;
	status: SnapshotGoalStatus;
	targets: readonly string[];
	built: readonly string[];
	domain?: string;
}

const EMPTY_COUNTS = (): Record<ConceptStatus, number> => ({
	unassessed: 0,
	learning: 0,
	shaky: 0,
	solid: 0,
	rusty: 0,
});

/** Build the payload the plugin publishes. Extra fields on the inputs are dropped. */
export function knowledgeSnapshot(concepts: SnapshotConceptInput[], goals: SnapshotGoalInput[], updatedAt: string): KnowledgeSnapshot {
	const ids = new Set(concepts.map((c) => c.id).filter(Boolean));
	const counts = EMPTY_COUNTS();
	const out: SnapshotConcept[] = [];
	for (const c of concepts) {
		if (!c.id || !ids.has(c.id)) continue;
		const status = CONCEPT_STATUSES.includes(c.stats.status) ? c.stats.status : "unassessed";
		counts[status]++;
		const concept: SnapshotConcept = {
			id: c.id,
			title: c.title.trim() || c.id,
			prerequisites: [...new Set(c.prerequisites.filter((p) => p !== c.id && ids.has(p)))],
			status,
			current: clamp01(c.stats.current),
		};
		if (c.domain?.trim()) concept.domain = c.domain.trim();
		out.push(concept);
	}
	out.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
	return {
		updatedAt,
		concepts: out,
		goals: goals.map((g) => {
			const goal: SnapshotGoal = {
				title: g.title.trim() || "Untitled goal",
				status: g.status,
				built: g.built.length,
				open: g.targets.length,
			};
			const domain = goalSubject(g, out);
			if (domain) goal.domain = domain;
			return goal;
		}),
		counts,
	};
}

/** Accept a snapshot from the network. Rejects anything that is not the map. */
export function parseKnowledgeSnapshot(value: unknown): KnowledgeSnapshot {
	if (!value || typeof value !== "object") throw new Error("Knowledge snapshot must be an object.");
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.concepts)) throw new Error("Knowledge snapshot needs a concepts array.");
	if (raw.concepts.length > 2000) throw new Error("Too many concepts.");
	const concepts: SnapshotConceptInput[] = raw.concepts.map((item, i) => {
		if (!item || typeof item !== "object") throw new Error(`Concept ${i} is not an object.`);
		const c = item as Record<string, unknown>;
		const id = requireSlug(c.id, `Concept ${i}`);
		const title = requireText(c.title, 300, `Concept ${id}`);
		const status = c.status;
		if (typeof status !== "string" || !CONCEPT_STATUSES.includes(status as ConceptStatus)) {
			throw new Error(`Concept ${id} has an unknown status.`);
		}
		const current = typeof c.current === "number" && Number.isFinite(c.current) ? c.current : 0;
		const prerequisites = Array.isArray(c.prerequisites) ? c.prerequisites.map((p, j) => requireSlug(p, `${id} prerequisite ${j}`)) : [];
		const domain = typeof c.domain === "string" ? c.domain : undefined;
		return { id, title, prerequisites, domain, stats: { status: status as ConceptStatus, current } };
	});
	const goals: SnapshotGoalInput[] = [];
	const rawGoals = Array.isArray(raw.goals) ? raw.goals : [];
	if (rawGoals.length > 200) throw new Error("Too many goals.");
	for (const [i, item] of rawGoals.entries()) {
		if (!item || typeof item !== "object") throw new Error(`Goal ${i} is not an object.`);
		const g = item as Record<string, unknown>;
		const status = g.status;
		if (status !== "active" && status !== "paused" && status !== "done") throw new Error(`Goal ${i} has an unknown status.`);
		const built = nonNegInt(g.built);
		const open = nonNegInt(g.open);
		const domain = typeof g.domain === "string" && g.domain.trim() ? g.domain.trim().slice(0, 80) : undefined;
		goals.push({
			title: requireText(g.title, 300, `Goal ${i}`),
			status,
			targets: Array.from({ length: open }, () => "open"),
			built: Array.from({ length: built }, () => "built"),
			domain,
		});
	}
	const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt : new Date(0).toISOString();
	return knowledgeSnapshot(concepts, goals, updatedAt);
}

/** A concept the dashboard may name. Status is how the quiz left it, never a score. */
export interface WebsiteConcept {
	id: string;
	title: string;
	status: ConceptStatus;
}

/** A finished goal on the dashboard: a name, how many concepts it holds, and its subject. */
export interface WebsiteGroundworkGoal {
	title: string;
	status: "done";
	concepts: number;
	domain?: string;
}

/** Learned concepts, their graph, and finished goals for the account dashboard. */
export interface WebsiteGroundwork {
	updatedAt: string | null;
	concepts: WebsiteConcept[];
	goals: WebsiteGroundworkGoal[];
	graph: GroundworkGraph;
}

/** Drop dollar signs from anything the website will print. */
export function stripDollars(value: string): string {
	return value.replaceAll("$", "").replace(/ {2,}/g, " ").trim();
}

/**
 * Stats the account dashboard may print. Every concept the tutor has is
 * included, quizzed or not — that is the count the tutor reports. A goal
 * counts once it is finished. Note text, mastery, and given-versus-left
 * quotas stay off the page.
 */
export function presentGroundwork(snapshot: KnowledgeSnapshot | null): WebsiteGroundwork {
	if (!snapshot) return { updatedAt: null, concepts: [], goals: [], graph: EMPTY_GROUNDWORK_GRAPH };
	const learned = snapshot.concepts.map((c) => {
		const concept: SnapshotConcept = {
			...c,
			title: stripDollars(c.title),
			prerequisites: c.prerequisites,
		};
		if (c.domain) concept.domain = stripDollars(c.domain);
		return concept;
	});
	const graph = layoutGroundworkGraph(learned);
	const order = new Map(graph.legend.map((item, i) => [item.domain, i]));
	const goals = snapshot.goals
		.filter((g) => g.status === "done")
		.map((g) => {
			const goal: WebsiteGroundworkGoal = { title: stripDollars(g.title), status: "done", concepts: g.built + g.open };
			if (g.domain) goal.domain = stripDollars(g.domain);
			return goal;
		})
		.sort((a, b) => (order.get(a.domain ?? "") ?? 99) - (order.get(b.domain ?? "") ?? 99) || a.title.localeCompare(b.title));
	return {
		updatedAt: snapshot.updatedAt || null,
		concepts: learned.map((c) => ({ id: c.id, title: c.title, status: c.status })),
		goals,
		graph,
	};
}

function goalSubject(goal: SnapshotGoalInput, concepts: SnapshotConcept[]): string | undefined {
	const byId = new Map(concepts.map((c) => [c.id, c]));
	const counts = new Map<string, number>();
	for (const id of [...goal.built, ...goal.targets]) {
		const domain = byId.get(id)?.domain?.trim();
		if (!domain) continue;
		counts.set(domain, (counts.get(domain) ?? 0) + 1);
	}
	let best: string | undefined;
	let bestN = 0;
	for (const [domain, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		if (n > bestN) {
			best = domain;
			bestN = n;
		}
	}
	return best || goal.domain?.trim() || undefined;
}

/**
 * Three-way merge for tutor memory so two devices do not wipe each other.
 * A file only one device changed is kept. A file only one device added is kept.
 * A delete sticks when the other device left the file alone. When both changed
 * the same file, the copy being saved wins.
 */
export function mergeTutorMemoryFiles(base: Record<string, string>, local: Record<string, string>, remote: Record<string, string>): Record<string, string> {
	const paths = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
	const out: Record<string, string> = {};
	for (const path of paths) {
		const inBase = Object.prototype.hasOwnProperty.call(base, path);
		const inLocal = Object.prototype.hasOwnProperty.call(local, path);
		const inRemote = Object.prototype.hasOwnProperty.call(remote, path);
		const b = base[path];
		const l = local[path];
		const r = remote[path];
		if (inLocal && inRemote && l === r) {
			out[path] = l;
			continue;
		}
		if (inLocal && !inRemote && !inBase) {
			out[path] = l!;
			continue;
		}
		if (inRemote && !inLocal && !inBase) {
			out[path] = r!;
			continue;
		}
		if (inBase && inLocal && !inRemote) {
			if (l !== b) out[path] = l!;
			continue;
		}
		if (inBase && inRemote && !inLocal) {
			if (r !== b) out[path] = r!;
			continue;
		}
		if (inLocal && inRemote) {
			if (inBase && l === b) out[path] = r!;
			else out[path] = l!;
			continue;
		}
		if (inLocal) out[path] = l!;
		else if (inRemote) out[path] = r!;
	}
	return out;
}

export class AccountError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body?: unknown,
	) {
		super(message);
		this.name = "AccountError";
	}
}

/** Tutor memory on the Groundwork website. The token stays with the caller, never in the vault. */
export class AccountClient {
	constructor(
		readonly baseUrl: string,
		private token: string | null = null,
	) {}

	async getHostedMemory(): Promise<TutorMemory> {
		return this.request("GET", "/v1/memory");
	}

	async putHostedMemory(input: { files: Record<string, string>; knowledge: KnowledgeSnapshot; baseUpdatedAt?: string }): Promise<TutorMemory> {
		return this.request("PUT", "/v1/memory", input);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (e) {
			throw new AccountError(`Could not reach your account server. ${(e as Error).message}`, 0);
		}
		const text = await response.text();
		const parsed = text ? (JSON.parse(text) as unknown) : {};
		if (!response.ok) {
			const message = parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string" ? (parsed as { error: string }).error : response.statusText;
			throw new AccountError(message || "Account request failed.", response.status, parsed);
		}
		return parsed as T;
	}
}

export interface FirebaseSession {
	idToken: string;
	refreshToken: string;
}

/** Turn a website sign-in into an ID token. The plugin stores the refresh token, not a password. */
export async function refreshFirebaseSession(refreshToken: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<FirebaseSession> {
	let response: Response;
	try {
		response = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
		});
	} catch (e) {
		throw new AccountError(`Could not reach the website sign-in. ${(e as Error).message}`, 0);
	}
	const text = await response.text();
	let parsed: { id_token?: unknown; refresh_token?: unknown; error?: { message?: unknown } } = {};
	if (text) {
		try {
			parsed = JSON.parse(text) as typeof parsed;
		} catch {
			throw new AccountError("The website sign-in returned an unreadable response. Try again in a moment.", response.status || 0);
		}
	}
	const idToken = typeof parsed.id_token === "string" ? parsed.id_token : "";
	if (!response.ok || !idToken) {
		const message = typeof parsed.error?.message === "string" ? parsed.error.message : "The website session expired. Open Obsidian from the Groundwork website again.";
		throw new AccountError(message, response.status);
	}
	return { idToken, refreshToken: typeof parsed.refresh_token === "string" && parsed.refresh_token ? parsed.refresh_token : refreshToken };
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return round(Math.min(1, Math.max(0, n)));
}

function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function requireText(value: unknown, max: number, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} needs a title.`);
	if (value.trim().length > max) throw new Error(`${label} title is too long.`);
	return value.trim();
}

function requireSlug(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} needs an id.`);
	const id = value.trim();
	if (id.length > 240) throw new Error(`${label} id is too long.`);
	return id;
}

function nonNegInt(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10000) return 0;
	return value;
}
