import { type Firestore } from "firebase-admin/firestore";
import { openFirestore } from "./firestore";
import { parseKnowledgeSnapshot, parseTutorMemoryFiles } from "@groundwork/core";
import { MemoryConflict, type TutorMemoryRecord, type TutorMemoryStore, type TutorMemoryWriteOptions } from "./memory";

const MAX_PART = 700_000;

/** Split UTF-8 text on character boundaries so a later join is the same string. */
export function splitUtf8(text: string, maxBytes: number): string[] {
	const buf = Buffer.from(text);
	if (!buf.length) return [""];
	const parts: string[] = [];
	let start = 0;
	while (start < buf.length) {
		let end = Math.min(start + maxBytes, buf.length);
		if (end < buf.length) {
			while (end > start && (buf[end]! & 0xc0) === 0x80) end--;
			if (end === start) end = Math.min(start + maxBytes, buf.length);
		}
		parts.push(buf.subarray(start, end).toString("utf8"));
		start = end;
	}
	return parts;
}

/**
 * Tutor memory in Firestore, so any Cloud Run instance can draw the dashboard.
 * Admin SDK only. The browser never reads this collection.
 */
export class FirestoreTutorMemoryStore implements TutorMemoryStore {
	constructor(private readonly firestore: () => Firestore = openFirestore) {}

	async read(uid: string): Promise<TutorMemoryRecord | null> {
		const ref = this.firestore().collection("tutorMemory").doc(uid);
		const snap = await ref.get();
		if (!snap.exists) return null;
		const data = snap.data() ?? {};
		const parts = typeof data.parts === "number" ? data.parts : 0;
		let payload = typeof data.payload === "string" ? data.payload : "";
		if (parts > 0) {
			const docs = await ref.collection("parts").get();
			const chunks = new Array<string>(parts).fill("");
			for (const doc of docs.docs) {
				const index = Number(doc.id);
				if (Number.isInteger(index) && index >= 0 && index < parts) chunks[index] = String(doc.get("text") ?? "");
			}
			payload = chunks.join("");
		}
		if (!payload) return null;
		const parsed = JSON.parse(payload) as { memory?: { updatedAt?: unknown; files?: unknown }; knowledge?: unknown };
		const files = parseTutorMemoryFiles(parsed.memory?.files);
		const knowledge = parseKnowledgeSnapshot(parsed.knowledge);
		const updatedAt = typeof parsed.memory?.updatedAt === "string" ? parsed.memory.updatedAt : knowledge.updatedAt;
		return { memory: { updatedAt, files }, knowledge };
	}

	async write(uid: string, record: TutorMemoryRecord, options?: TutorMemoryWriteOptions): Promise<void> {
		const db = this.firestore();
		const ref = db.collection("tutorMemory").doc(uid);
		const snap = await ref.get();
		if (options?.ifUpdatedAt !== undefined) {
			const currentAt = snap.exists ? String(snap.data()?.updatedAt ?? "") : "";
			if (currentAt !== options.ifUpdatedAt) {
				const saved = await this.read(uid);
				throw new MemoryConflict(saved?.memory ?? { updatedAt: currentAt, files: {} });
			}
		}
		const payload = JSON.stringify(record);
		const parts = Buffer.byteLength(payload) <= 900_000 ? [] : splitUtf8(payload, MAX_PART);
		const writeOpts = snap.exists ? { lastUpdateTime: snap.updateTime } : undefined;
		if (!parts.length) {
			await ref.set({ payload, parts: 0, updatedAt: record.memory.updatedAt }, writeOpts);
		} else {
			await ref.set({ payload: "", parts: parts.length, updatedAt: record.memory.updatedAt }, writeOpts);
			let batch = db.batch();
			let ops = 0;
			for (const [index, text] of parts.entries()) {
				batch.set(ref.collection("parts").doc(String(index)), { text });
				ops++;
				if (ops === 400) {
					await batch.commit();
					batch = db.batch();
					ops = 0;
				}
			}
			if (ops) await batch.commit();
		}
		const existing = await ref.collection("parts").get();
		let batch = db.batch();
		let ops = 0;
		for (const doc of existing.docs) {
			const index = Number(doc.id);
			if (Number.isInteger(index) && index >= 0 && index < parts.length) continue;
			batch.delete(doc.ref);
			ops++;
			if (ops === 400) {
				await batch.commit();
				batch = db.batch();
				ops = 0;
			}
		}
		if (ops) await batch.commit();
	}
}

/** Log a store failure and keep serving the in-memory copy. */
export class BestEffortStore implements TutorMemoryStore {
	constructor(private readonly store: TutorMemoryStore) {}

	async read(uid: string): Promise<TutorMemoryRecord | null> {
		try {
			return await this.store.read(uid);
		} catch (err) {
			console.error("Groundwork could not read saved tutor memory.", err);
			return null;
		}
	}

	async write(uid: string, record: TutorMemoryRecord, options?: TutorMemoryWriteOptions): Promise<void> {
		try {
			await this.store.write(uid, record, options);
		} catch (err) {
			if (err instanceof MemoryConflict) throw err;
			console.error("Groundwork could not save tutor memory.", err);
		}
	}
}
