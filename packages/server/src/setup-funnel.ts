import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { openFirestore } from "./firestore";

export const SETUP_FUNNEL_STEPS = ["signup", "obsidian_download_click", "plugin_installed", "account_connected", "first_tutor_turn"] as const;

export type SetupFunnelStep = (typeof SETUP_FUNNEL_STEPS)[number];

export type SetupFunnelCounts = Record<SetupFunnelStep, number>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9:._@+-]{1,160}$/;

export function emptyFunnelCounts(): SetupFunnelCounts {
	return { signup: 0, obsidian_download_click: 0, plugin_installed: 0, account_connected: 0, first_tutor_turn: 0 };
}

/** True when this id can be counted for the step. Install ids are UUIDs. The others are account ids. */
export function funnelActor(step: SetupFunnelStep, id: string): string | null {
	const trimmed = id.trim();
	if (step === "plugin_installed") return UUID.test(trimmed) ? trimmed.toLowerCase() : null;
	return ACTOR.test(trimmed) ? trimmed : null;
}

export interface SetupFunnel {
	/** Counts the first time this id hits the step. Later calls do not add. */
	mark(step: SetupFunnelStep, id: string, now?: Date): Promise<boolean>;
	counts(): Promise<SetupFunnelCounts>;
}

interface FunnelDb {
	seen: Record<string, string>;
	counts: SetupFunnelCounts;
}

function emptyDb(): FunnelDb {
	return { seen: {}, counts: emptyFunnelCounts() };
}

function countsFromUnknown(raw: unknown): SetupFunnelCounts {
	const counts = emptyFunnelCounts();
	if (!raw || typeof raw !== "object") return counts;
	const data = raw as Record<string, unknown>;
	for (const step of SETUP_FUNNEL_STEPS) {
		const value = data[step];
		if (typeof value === "number" && value >= 0) counts[step] = value;
	}
	return counts;
}

function seenKey(step: SetupFunnelStep, id: string): string {
	return `${step}:${id}`;
}

/** In-memory funnel for tests. */
export class MemorySetupFunnel implements SetupFunnel {
	private readonly seen = new Set<string>();
	private readonly totals = emptyFunnelCounts();

	async mark(step: SetupFunnelStep, id: string, now: Date = new Date()): Promise<boolean> {
		const actor = funnelActor(step, id);
		if (!actor) return false;
		const key = seenKey(step, actor);
		if (this.seen.has(key)) return false;
		this.seen.add(key);
		this.totals[step] += 1;
		void now;
		return true;
	}

	async counts(): Promise<SetupFunnelCounts> {
		return { ...this.totals };
	}
}

/** Funnel counts on disk. Events are not backfilled from old accounts. */
export class FileSetupFunnel implements SetupFunnel {
	private queue: Promise<void> = Promise.resolve();

	constructor(readonly file: string) {}

	async mark(step: SetupFunnelStep, id: string, now: Date = new Date()): Promise<boolean> {
		const actor = funnelActor(step, id);
		if (!actor) return false;
		const key = seenKey(step, actor);
		let added = false;
		await this.enqueue(async () => {
			const db = await this.load();
			if (db.seen[key]) return;
			db.seen[key] = now.toISOString();
			db.counts[step] = (db.counts[step] ?? 0) + 1;
			added = true;
			await this.save(db);
		});
		return added;
	}

	async counts(): Promise<SetupFunnelCounts> {
		const db = await this.load();
		return { ...emptyFunnelCounts(), ...db.counts };
	}

	private async enqueue(fn: () => Promise<void>): Promise<void> {
		const run = this.queue.then(fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		await run;
	}

	private async load(): Promise<FunnelDb> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as FunnelDb;
			if (!parsed || typeof parsed !== "object") return emptyDb();
			const counts = emptyFunnelCounts();
			for (const step of SETUP_FUNNEL_STEPS) {
				const value = parsed.counts?.[step];
				if (typeof value === "number" && value >= 0) counts[step] = value;
			}
			return { seen: parsed.seen && typeof parsed.seen === "object" ? parsed.seen : {}, counts };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyDb();
			throw e;
		}
	}

	private async save(db: FunnelDb): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(db));
		await rename(tmp, this.file);
	}
}

/** Funnel counts in Firestore. Each id is stored once per step. */
export class FirestoreSetupFunnel implements SetupFunnel {
	constructor(private readonly db: Firestore = openFirestore()) {}

	async mark(step: SetupFunnelStep, id: string, now: Date = new Date()): Promise<boolean> {
		const actor = funnelActor(step, id);
		if (!actor) return false;
		const seen = this.db.collection("setupFunnelSeen").doc(`${step}__${actor.replace(/[^A-Za-z0-9:._@+-]/g, "_")}`);
		const counts = this.db.collection("setupFunnel").doc("counts");
		return this.db.runTransaction(async (tx) => {
			const snap = await tx.get(seen);
			if (snap.exists) return false;
			tx.set(seen, { step, at: now.toISOString() });
			tx.set(counts, { [step]: FieldValue.increment(1) }, { merge: true });
			return true;
		});
	}

	async counts(): Promise<SetupFunnelCounts> {
		const snap = await this.db.collection("setupFunnel").doc("counts").get();
		return countsFromUnknown(snap.data());
	}
}
