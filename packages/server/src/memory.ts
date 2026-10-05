import {
	emptyTutorMemory,
	knowledgeSnapshot,
	KnowledgeStore,
	MemoryVaultIO,
	parseKnowledgeSnapshot,
	parseTutorMemoryFiles,
	type KnowledgeSnapshot,
	type SnapshotConcept,
	type SnapshotGoal,
	type TutorMemory,
} from "@groundwork/core";

/** Tutor memory plus the public map derived from it. */
export interface TutorMemoryRecord {
	memory: TutorMemory;
	knowledge: KnowledgeSnapshot;
}

/** Shared store so any server process can draw the dashboard. */
export interface TutorMemoryStore {
	read(uid: string): Promise<TutorMemoryRecord | null>;
	write(uid: string, record: TutorMemoryRecord): Promise<void>;
}

/** The account changed since this device last loaded it. The save is refused so it can merge. */
export class MemoryConflict extends Error {
	constructor(readonly memory: TutorMemory) {
		super("The account was updated on another device.");
		this.name = "MemoryConflict";
	}
}

/** Tutor memory for each signed-in account. Notes stay here; they are not a vault folder. */
export class MemoryDirectory {
	private readonly memories = new Map<string, TutorMemory>();
	private readonly maps = new Map<string, KnowledgeSnapshot>();
	/** Bumped on every save so a read that started earlier cannot overwrite it. */
	private readonly revision = new Map<string, number>();

	constructor(private readonly store?: TutorMemoryStore) {}

	async get(uid: string): Promise<TutorMemory> {
		const saved = await this.readStore(uid);
		if (saved) return saved.memory;
		return this.memories.get(uid) ?? emptyTutorMemory();
	}

	/**
	 * Public map for the profile.
	 * Concept notes stored on the account are included even when the saved
	 * snapshot lists only some of them. Quiz status from the snapshot is kept.
	 */
	async knowledge(uid: string): Promise<KnowledgeSnapshot | null> {
		const saved = await this.readStore(uid);
		const memory = saved?.memory ?? this.memories.get(uid);
		const snapshot = saved?.knowledge ?? this.maps.get(uid) ?? null;
		if (!memory || Object.keys(memory.files).length === 0) return snapshot;
		try {
			return mergeKnowledge(await knowledgeFromMemory(memory), snapshot);
		} catch (err) {
			console.error("Groundwork could not read saved concept notes.", err);
			return snapshot;
		}
	}

	async put(uid: string, body: unknown): Promise<TutorMemory> {
		const record = body && typeof body === "object" ? (body as { files?: unknown; knowledge?: unknown; baseUpdatedAt?: unknown }) : {};
		const files = parseTutorMemoryFiles(record.files);
		const knowledge = parseKnowledgeSnapshot(record.knowledge);
		if (typeof record.baseUpdatedAt === "string") {
			const stored = await this.current(uid);
			if (stored?.memory.updatedAt && stored.memory.updatedAt !== record.baseUpdatedAt) throw new MemoryConflict(stored.memory);
		}
		const updatedAt = new Date().toISOString();
		knowledge.updatedAt = updatedAt;
		const memory: TutorMemory = { updatedAt, files };
		const revision = (this.revision.get(uid) ?? 0) + 1;
		this.revision.set(uid, revision);
		this.memories.set(uid, memory);
		this.maps.set(uid, knowledge);
		if (this.store) await this.store.write(uid, { memory, knowledge });
		return memory;
	}

	private async current(uid: string): Promise<TutorMemoryRecord | null> {
		const saved = await this.readStore(uid);
		if (saved) return saved;
		const memory = this.memories.get(uid);
		if (!memory) return null;
		const knowledge = this.maps.get(uid);
		if (!knowledge) return null;
		return { memory, knowledge };
	}

	private async readStore(uid: string): Promise<TutorMemoryRecord | null> {
		if (!this.store) return null;
		const seen = this.revision.get(uid) ?? 0;
		const saved = await this.store.read(uid);
		if (!saved) return null;
		if ((this.revision.get(uid) ?? 0) !== seen) {
			const memory = this.memories.get(uid);
			const knowledge = this.maps.get(uid);
			if (memory && knowledge) return { memory, knowledge };
			return null;
		}
		this.memories.set(uid, saved.memory);
		this.maps.set(uid, saved.knowledge);
		return saved;
	}
}

/** Concepts and goals implied by the notes stored on the account. */
async function knowledgeFromMemory(memory: TutorMemory): Promise<KnowledgeSnapshot> {
	const io = new MemoryVaultIO();
	for (const [path, content] of Object.entries(memory.files)) io.files.set(path, content);
	const store = new KnowledgeStore(io);
	const concepts = [...(await store.concepts()).values()].map((concept) => ({
		id: concept.id,
		title: concept.title,
		prerequisites: concept.prerequisites,
		domain: concept.domain,
		stats: { status: concept.stats.status, current: concept.stats.current },
	}));
	const goals = (await store.goals()).map((goal) => ({
		title: goal.title,
		status: goal.status,
		targets: goal.targets,
		built: goal.built,
	}));
	return knowledgeSnapshot(concepts, goals, memory.updatedAt || new Date(0).toISOString());
}

/**
 * Every concept note counts. A concept already in the snapshot keeps the quiz
 * status published with it. Notes the snapshot never listed are still shown.
 */
function mergeKnowledge(fromFiles: KnowledgeSnapshot, saved: KnowledgeSnapshot | null): KnowledgeSnapshot {
	if (!saved) return fromFiles;
	const concepts = new Map<string, SnapshotConcept>(saved.concepts.map((concept) => [concept.id, concept]));
	for (const concept of fromFiles.concepts) {
		if (!concepts.has(concept.id)) concepts.set(concept.id, concept);
	}
	const goals = new Map<string, SnapshotGoal>(fromFiles.goals.map((goal) => [goal.title, goal]));
	for (const goal of saved.goals) {
		if (!goals.has(goal.title)) goals.set(goal.title, goal);
	}
	if (concepts.size === saved.concepts.length && goals.size === saved.goals.length) return saved;
	return knowledgeSnapshot(
		[...concepts.values()].map((concept) => ({
			id: concept.id,
			title: concept.title,
			prerequisites: concept.prerequisites,
			domain: concept.domain,
			stats: { status: concept.status, current: concept.current },
		})),
		[...goals.values()].map((goal) => ({
			title: goal.title,
			status: goal.status,
			targets: Array.from({ length: goal.open }, () => "open"),
			built: Array.from({ length: goal.built }, () => "built"),
			domain: goal.domain,
		})),
		saved.updatedAt || fromFiles.updatedAt,
	);
}
