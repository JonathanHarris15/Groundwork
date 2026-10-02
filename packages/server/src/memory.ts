import { emptyTutorMemory, parseKnowledgeSnapshot, parseTutorMemoryFiles, type KnowledgeSnapshot, type TutorMemory } from "@groundwork/core";

/** Tutor memory for each signed-in account. Notes stay here; they are not a vault folder. */
export class MemoryDirectory {
	private readonly memories = new Map<string, TutorMemory>();
	private readonly maps = new Map<string, KnowledgeSnapshot>();

	get(uid: string): TutorMemory {
		return this.memories.get(uid) ?? emptyTutorMemory();
	}

	/** Public map saved with tutor memory. Null until Obsidian has synced this account. */
	knowledge(uid: string): KnowledgeSnapshot | null {
		return this.maps.get(uid) ?? null;
	}

	put(uid: string, body: unknown): TutorMemory {
		const record = body && typeof body === "object" ? (body as { files?: unknown; knowledge?: unknown }) : {};
		const files = parseTutorMemoryFiles(record.files);
		const knowledge = parseKnowledgeSnapshot(record.knowledge);
		const updatedAt = new Date().toISOString();
		knowledge.updatedAt = updatedAt;
		const memory: TutorMemory = { updatedAt, files };
		this.memories.set(uid, memory);
		this.maps.set(uid, knowledge);
		return memory;
	}
}
