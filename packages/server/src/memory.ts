import { emptyTutorMemory, parseKnowledgeSnapshot, parseTutorMemoryFiles, type KnowledgeSnapshot, type TutorMemory } from "@groundwork/core";

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

	/** Public map saved with tutor memory. Null until Obsidian has synced this account. */
	async knowledge(uid: string): Promise<KnowledgeSnapshot | null> {
		const saved = await this.readStore(uid);
		if (saved) return saved.knowledge;
		return this.maps.get(uid) ?? null;
	}

	async put(uid: string, body: unknown): Promise<TutorMemory> {
		const record = body && typeof body === "object" ? (body as { files?: unknown; knowledge?: unknown }) : {};
		const files = parseTutorMemoryFiles(record.files);
		const knowledge = parseKnowledgeSnapshot(record.knowledge);
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
