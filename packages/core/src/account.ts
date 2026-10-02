/**
 * Tutor memory lives on the account. The Obsidian vault is only the optional
 * folders the learner picks as extra context.
 *
 * `TutorMemory` is the private record: concept notes, goals, evidence, chats,
 * and the learner profile. `KnowledgeSnapshot` is the public map derived from
 * it (titles, prerequisite links, mastery). The profile page draws the snapshot
 * and does not receive note bodies.
 */

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
}

export interface MapNode extends SnapshotConcept {
	x: number;
	y: number;
}

export interface ConceptMapLayout {
	width: number;
	height: number;
	nodes: MapNode[];
	edges: Array<{ from: string; to: string }>;
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
		goals: goals.map((g) => ({
			title: g.title.trim() || "Untitled goal",
			status: g.status,
			built: g.built.length,
			open: g.targets.length,
		})),
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
		const title = requireText(c.title, 120, `Concept ${id}`);
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
		goals.push({
			title: requireText(g.title, 120, `Goal ${i}`),
			status,
			targets: Array.from({ length: open }, () => "open"),
			built: Array.from({ length: built }, () => "built"),
		});
	}
	const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt : new Date(0).toISOString();
	return knowledgeSnapshot(concepts, goals, updatedAt);
}

/**
 * Layered map: prerequisites sit lower, dependents above them.
 * Wider layers grow the canvas so labels keep a gap.
 */
export function layoutConceptMap(concepts: SnapshotConcept[]): ConceptMapLayout {
	const byId = new Map(concepts.map((c) => [c.id, c]));
	const depth = new Map<string, number>();
	const visiting = new Set<string>();
	const depthOf = (id: string): number => {
		const known = depth.get(id);
		if (known != null) return known;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		let max = 0;
		for (const p of byId.get(id)?.prerequisites ?? []) {
			if (byId.has(p)) max = Math.max(max, depthOf(p) + 1);
		}
		visiting.delete(id);
		depth.set(id, max);
		return max;
	};
	for (const c of concepts) depthOf(c.id);

	const layers = new Map<number, SnapshotConcept[]>();
	for (const c of concepts) {
		const d = depth.get(c.id) ?? 0;
		const row = layers.get(d) ?? [];
		row.push(c);
		layers.set(d, row);
	}
	const keys = [...layers.keys()].sort((a, b) => a - b);
	const padY = 64;
	const rowH = 118;
	const left = 56;
	const right = 168;
	const gap = 200;
	let widest = 1;
	for (const row of layers.values()) widest = Math.max(widest, row.length);
	const inner = Math.max(0, widest - 1) * gap;
	const width = Math.max(760, left + inner + right);
	const height = padY * 2 + Math.max(keys.length, 1) * rowH - (keys.length ? rowH - 80 : 0);
	const maxDepth = keys.at(-1) ?? 0;
	const nodes: MapNode[] = [];
	for (const d of keys) {
		const row = (layers.get(d) ?? []).slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
		row.forEach((c, i) => {
			const x = row.length === 1 ? left + (width - left - right) / 2 : left + i * gap;
			const y = padY + (maxDepth - d) * rowH + 28;
			nodes.push({ ...c, x: round(x), y: round(y) });
		});
	}
	const edges: Array<{ from: string; to: string }> = [];
	for (const c of concepts) {
		for (const p of c.prerequisites) {
			if (byId.has(p)) edges.push({ from: p, to: c.id });
		}
	}
	edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
	return { width: round(width), height: round(Math.max(height, 220)), nodes, edges };
}

export interface AccountUser {
	id: string;
	email: string;
	handle: string;
	displayName: string;
}

export interface AuthSession {
	token: string;
	user: AccountUser;
}

/** A goal as the website may show it: a name and a status, never a quota. */
export interface WebsiteGoal {
	title: string;
	status: SnapshotGoalStatus;
}

export interface WebsiteMapNode {
	id: string;
	title: string;
	prerequisites: string[];
	status: ConceptStatus;
	x: number;
	y: number;
	domain?: string;
}

export interface ProfilePayload {
	user: AccountUser;
	updatedAt: string | null;
	map: { width: number; height: number; nodes: WebsiteMapNode[]; edges: Array<{ from: string; to: string }> };
	goals: WebsiteGoal[];
	counts: Record<ConceptStatus, number>;
}

/** Drop dollar signs from anything the website will print. */
export function stripDollars(value: string): string {
	return value.replaceAll("$", "").replace(/ {2,}/g, " ").trim();
}

/**
 * The profile the site is allowed to render. No currency, and no “given vs left”
 * counts (`built` / `open` / mastery percent).
 */
export function presentForWebsite(profile: {
	user: AccountUser;
	updatedAt: string | null;
	map: ConceptMapLayout;
	goals: SnapshotGoal[];
	counts: Record<ConceptStatus, number>;
}): ProfilePayload {
	return {
		user: {
			id: profile.user.id,
			email: stripDollars(profile.user.email),
			handle: stripDollars(profile.user.handle),
			displayName: stripDollars(profile.user.displayName),
		},
		updatedAt: profile.updatedAt,
		counts: profile.counts,
		goals: profile.goals.map((g) => ({ title: stripDollars(g.title), status: g.status })),
		map: {
			width: profile.map.width,
			height: profile.map.height,
			edges: profile.map.edges,
			nodes: profile.map.nodes.map((n) => {
				const node: WebsiteMapNode = {
					id: n.id,
					title: stripDollars(n.title),
					prerequisites: n.prerequisites,
					status: n.status,
					x: n.x,
					y: n.y,
				};
				if (n.domain) node.domain = stripDollars(n.domain);
				return node;
			}),
		},
	};
}

export class AccountError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "AccountError";
	}
}

/** Browser- and Node-safe client. The token stays with the caller, never in the vault. */
export class AccountClient {
	constructor(
		readonly baseUrl: string,
		private token: string | null = null,
	) {}

	async register(input: { email: string; password: string; displayName: string; handle?: string }): Promise<AuthSession> {
		return this.auth("/api/register", input);
	}

	async login(input: { email: string; password: string }): Promise<AuthSession> {
		return this.auth("/api/login", input);
	}

	async logout(): Promise<void> {
		await this.request("POST", "/api/logout");
		this.token = null;
	}

	async me(): Promise<AccountUser> {
		const body = await this.request<{ user: AccountUser }>("GET", "/api/me");
		return body.user;
	}

	async putKnowledge(snapshot: KnowledgeSnapshot): Promise<{ updatedAt: string }> {
		return this.request("PUT", "/api/me/knowledge", snapshot);
	}

	async getMemory(): Promise<TutorMemory> {
		return this.request("GET", "/api/me/memory");
	}

	async putMemory(input: { files: Record<string, string>; knowledge: KnowledgeSnapshot }): Promise<TutorMemory> {
		return this.request("PUT", "/api/me/memory", input);
	}

	/** Tutor memory on the Groundwork website. The plugin does not ask for a separate server. */
	async getHostedMemory(): Promise<TutorMemory> {
		return this.request("GET", "/v1/memory");
	}

	async putHostedMemory(input: { files: Record<string, string>; knowledge: KnowledgeSnapshot }): Promise<TutorMemory> {
		return this.request("PUT", "/v1/memory", input);
	}

	async profile(): Promise<ProfilePayload> {
		return this.request("GET", "/api/me/profile");
	}

	async publicProfile(handle: string): Promise<ProfilePayload> {
		return this.request("GET", `/api/profiles/${encodeURIComponent(handle)}`);
	}

	private async auth(path: string, body: unknown): Promise<AuthSession> {
		const session = await this.request<AuthSession>("POST", path, body, false);
		this.token = session.token;
		return session;
	}

	private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (e) {
			throw new AccountError(`Could not reach the account server. ${(e as Error).message}`, 0);
		}
		const text = await response.text();
		const parsed = text ? (JSON.parse(text) as unknown) : {};
		if (!response.ok) {
			const message = parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string" ? (parsed as { error: string }).error : response.statusText;
			throw new AccountError(message || "Account request failed.", response.status);
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
	const parsed = text ? (JSON.parse(text) as { id_token?: unknown; refresh_token?: unknown; error?: { message?: unknown } }) : {};
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
	if (id.length > 80) throw new Error(`${label} id is too long.`);
	return id;
}

function nonNegInt(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10000) return 0;
	return value;
}
