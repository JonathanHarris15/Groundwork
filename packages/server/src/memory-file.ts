import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseKnowledgeSnapshot, parseTutorMemoryFiles } from "@groundwork/core";
import type { TutorMemoryRecord, TutorMemoryStore } from "./memory";

interface FileDb {
	users: Record<string, { memory: { updatedAt: string; files: Record<string, string> }; knowledge: unknown }>;
}

/** Tutor memory on disk. One file, so a restarted local server still has the map. */
export class FileTutorMemoryStore implements TutorMemoryStore {
	private queue: Promise<void> = Promise.resolve();

	constructor(readonly file: string) {}

	async read(uid: string): Promise<TutorMemoryRecord | null> {
		const db = await this.load();
		const row = db.users[uid];
		if (!row) return null;
		return {
			memory: { updatedAt: row.memory.updatedAt, files: parseTutorMemoryFiles(row.memory.files) },
			knowledge: parseKnowledgeSnapshot(row.knowledge),
		};
	}

	async write(uid: string, record: TutorMemoryRecord): Promise<void> {
		await this.update((db) => {
			db.users[uid] = { memory: record.memory, knowledge: record.knowledge };
		});
	}

	private async update(fn: (db: FileDb) => void): Promise<void> {
		const run = this.queue.then(async () => {
			const db = await this.load();
			fn(db);
			await this.save(db);
		});
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		await run;
	}

	private async load(): Promise<FileDb> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as FileDb;
			if (!parsed || typeof parsed !== "object" || !parsed.users || typeof parsed.users !== "object") return { users: {} };
			return parsed;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return { users: {} };
			throw e;
		}
	}

	private async save(db: FileDb): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(db));
		await rename(tmp, this.file);
	}
}
