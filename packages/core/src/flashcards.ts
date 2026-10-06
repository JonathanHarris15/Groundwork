/**
 * Flashcards live on the account (`.groundwork/flashcards.json`).
 * They are written into the vault only when the learner asks: `exportFlashcards`
 * copies them as plain Markdown into `flashcards/` inside the folders they chose.
 * A hand edit of an exported card is pulled back onto the account by `syncFlashcards`.
 * Deleting a deck or a card leaves those notes in the vault and does not pull them back.
 * A study sitting lives in memory. Ratings do not schedule the next day.
 * Older accounts still store `due` and `intervalMinutes`. Those fields are left
 * in place and are not used to decide which cards appear.
 */

import { cleanFolderList } from "./access";
import { ensureDir, type VaultIO } from "./io";
import { parseNote, safeFileName, serializeNote, slugify } from "./markdown";
import type { Outcome } from "./model";
import { PATHS, type KnowledgeStore } from "./store";

export const FLASHCARDS_DIR = "flashcards";

/** Stable id for cards that were not put in a named deck. Exported notes still say `deck: library`. */
export const DEFAULT_DECK_ID = "library";
/** Shown in the Library pane. Older accounts stored this deck as "Library". */
export const DEFAULT_DECK_TITLE = "Unsorted";
const LEGACY_DEFAULT_DECK_TITLE = "Library";
const RETIRED_CAP = 5000;

export type CardRating = "again" | "hard" | "good" | "easy";
export type CardState = "new" | "learning" | "review";

export interface Flashcard {
	id: string;
	deckId: string;
	concept: string;
	front: string;
	back: string;
	/** Set when the card fails atomic Q/A rules — hidden from review until fixed. */
	qualityIssue?: string;
	/** Account concept path, when the card was made from a teaching note. */
	source?: string;
	createdAt: string;
	updatedAt: string;
	state: CardState;
	due: string;
	intervalMinutes: number;
	ease: number;
	reps: number;
	lapses: number;
	lastRating?: CardRating;
	lastReviewed?: string;
	/** Stable name inside `flashcards/`. */
	fileName?: string;
	/** Hash of concept + front + back last written to the vault. */
	contentKey?: string;
}

export interface FlashDeck {
	id: string;
	title: string;
	goalId?: string;
	fileName?: string;
}

export interface FlashcardLibrary {
	updatedAt: string;
	/** Ignored. Older accounts stored this; cards are never made from teaching notes. */
	addFromTeachingNotes: boolean;
	decks: FlashDeck[];
	cards: Flashcard[];
	/** Deck ids the learner deleted, until that deck is created again. */
	retiredDeckIds: string[];
	/** Card ids the learner deleted. A leftover export must not bring the card back. */
	retiredCardIds: string[];
}

const RATINGS: CardRating[] = ["again", "hard", "good", "easy"];
const EASE_START = 2.5;
/**
 * Hard waits this many other cards in the sitting.
 * With fewer cards left, it waits until the end of what remains.
 */
export const SESSION_HARD_GAP = 3;

export function flashcardsDir(writeFolder: string): string {
	return `${writeFolder}/${FLASHCARDS_DIR}`;
}

export function emptyFlashcardLibrary(now = new Date()): FlashcardLibrary {
	return {
		updatedAt: now.toISOString(),
		addFromTeachingNotes: false,
		decks: [],
		cards: [],
		retiredDeckIds: [],
		retiredCardIds: [],
	};
}

const FLASHCARD_BACK_MAX_WORDS = 8;

/** One concept, one short answer. Returns a learner-facing reason when invalid. */
export function flashcardQualityIssue(front: string, back: string): string | null {
	const f = front.trim();
	const b = back.trim();
	if (!f || !b) return "A card needs a question and a short answer.";
	const words = b.split(/\s+/).filter(Boolean);
	if (words.length > FLASHCARD_BACK_MAX_WORDS) return "Answer must be a few words, not a paragraph or list.";
	if (b.includes("\n")) return "Answer must be one line — a few words max.";
	if (/[,;]/.test(b) && words.length >= 3) return "One atomic answer — no comma-separated lists (e.g. not “min, max, saddle”).";
	if (/^(what are|list|name all|types of)/i.test(f) && words.length > 2) return "Ask one specific question that has a single short answer.";
	if (/\b(and|or)\b/i.test(b) && words.length > 3) return "One idea per card — split multi-part answers.";
	return null;
}

export function flashcardContentKey(concept: string, front: string, back: string): string {
	const text = `${concept.trim()}\n${front.trim()}\n${back.trim()}`;
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	return `k${h.toString(36)}`;
}

function newId(prefix: string): string {
	const bytes = new Uint8Array(8);
	const cryptoObj = globalThis.crypto;
	if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the rating button says. These are moves inside the sitting, not a calendar. */
export function sessionRatingHint(rating: CardRating): string {
	if (rating === "again") return "Right away";
	if (rating === "hard") return "Later";
	return "Done";
}

/** Cards that can be studied. A quality problem hides a card until the wording is fixed. Due dates are ignored. */
export function studyableCards(cards: readonly Flashcard[]): Flashcard[] {
	return cards.filter((card) => !card.qualityIssue);
}

export function shuffleCards<T>(items: readonly T[], rng: () => number = Math.random): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const swap = out[i];
		out[i] = out[j]!;
		out[j] = swap!;
	}
	return out;
}

/** Every studyable card in the deck, shuffled. Nothing is left out because of a due date. */
export function startStudySession(cards: readonly Flashcard[], rng: () => number = Math.random): Flashcard[] {
	return shuffleCards(studyableCards(cards), rng);
}

/**
 * Rate the card at the front of the sitting.
 * Again is the next card. Hard waits `SESSION_HARD_GAP` other cards, or until the end if fewer remain.
 * Good and Easy leave the sitting.
 */
export function applySessionRating(queue: readonly Flashcard[], rating: CardRating): Flashcard[] {
	if (!queue.length) return [];
	const [card, ...rest] = queue;
	if (rating === "good" || rating === "easy") return rest;
	if (rating === "again") return [card!, ...rest];
	const gap = Math.min(SESSION_HARD_GAP, rest.length);
	return [...rest.slice(0, gap), card!, ...rest.slice(gap)];
}

/** Remember the rating. Does not move `due` or the interval. */
export function applyRating(card: Flashcard, rating: CardRating, now: Date): Flashcard {
	const stamp = now.toISOString();
	return {
		...card,
		reps: rating === "good" || rating === "easy" ? card.reps + 1 : card.reps,
		lapses: rating === "again" ? card.lapses + 1 : card.lapses,
		lastRating: rating,
		lastReviewed: stamp,
		updatedAt: stamp,
	};
}

export function ratingOutcome(rating: CardRating): { outcome: Outcome; difficulty: number } {
	if (rating === "again") return { outcome: "incorrect", difficulty: 2 };
	if (rating === "hard") return { outcome: "partial", difficulty: 3 };
	if (rating === "good") return { outcome: "correct", difficulty: 3 };
	return { outcome: "correct", difficulty: 4 };
}

export function auditFlashcardLibrary(lib: FlashcardLibrary): boolean {
	let changed = false;
	for (const card of lib.cards) {
		const issue = flashcardQualityIssue(card.front, card.back);
		if (issue) {
			if (card.qualityIssue !== issue) {
				card.qualityIssue = issue;
				changed = true;
			}
		} else if (card.qualityIssue) {
			delete card.qualityIssue;
			changed = true;
		}
	}
	return changed;
}

export function makeCard(input: { id?: string; deckId: string; concept: string; front: string; back: string; source?: string; now?: Date }): Flashcard {
	const now = (input.now ?? new Date()).toISOString();
	const concept = input.concept.trim();
	const front = input.front.trim();
	const back = input.back.trim();
	const qualityIssue = flashcardQualityIssue(front, back) ?? undefined;
	return {
		id: input.id || newId("fc_"),
		deckId: input.deckId,
		concept,
		front,
		back,
		source: input.source,
		createdAt: now,
		updatedAt: now,
		state: "new",
		due: now,
		intervalMinutes: 0,
		ease: EASE_START,
		reps: 0,
		lapses: 0,
		contentKey: flashcardContentKey(concept, front, back),
		qualityIssue,
	};
}

function asRating(value: unknown): CardRating | undefined {
	return RATINGS.includes(value as CardRating) ? (value as CardRating) : undefined;
}

function asState(value: unknown): CardState {
	return value === "learning" || value === "review" || value === "new" ? value : "new";
}

function idList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const id = item.trim();
		if (!id || id.length > 200 || out.includes(id)) continue;
		out.push(id);
		if (out.length >= RETIRED_CAP) break;
	}
	return out;
}

function rememberRetired(list: readonly string[] | undefined, ids: readonly string[]): string[] {
	const next = [...(list ?? [])];
	for (const raw of ids) {
		const id = raw.trim();
		if (!id || next.includes(id)) continue;
		next.push(id);
	}
	return next.length > RETIRED_CAP ? next.slice(next.length - RETIRED_CAP) : next;
}

/** Older accounts called the catch-all deck "Library", which is this pane's name. */
function settleDefaultDeckTitle(lib: FlashcardLibrary): void {
	const deck = lib.decks.find((d) => d.id === DEFAULT_DECK_ID);
	if (!deck || deck.title !== LEGACY_DEFAULT_DECK_TITLE) return;
	const taken = (title: string) => lib.decks.some((d) => d !== deck && d.title.toLowerCase() === title.toLowerCase());
	let title = DEFAULT_DECK_TITLE;
	if (taken(title)) title = "Unsorted cards";
	let n = 2;
	while (taken(title)) {
		title = `Unsorted cards ${n}`;
		n += 1;
	}
	deck.title = title;
}

function assertDeckTitle(title: string): string {
	const name = title.trim();
	if (!name) throw new Error("A deck needs a name.");
	if (name.length > 120) throw new Error("That deck name is too long.");
	if (name.toLowerCase() === LEGACY_DEFAULT_DECK_TITLE.toLowerCase()) {
		throw new Error("Library is this pane. Name the deck something else.");
	}
	return name;
}

export function parseFlashcardLibrary(value: unknown): FlashcardLibrary {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Flashcards file is not an object.");
	const raw = value as Record<string, unknown>;
	const decksIn = Array.isArray(raw.decks) ? raw.decks : [];
	const cardsIn = Array.isArray(raw.cards) ? raw.cards : [];
	if (decksIn.length > 500 || cardsIn.length > 5000) throw new Error("Too many flashcards.");
	const decks: FlashDeck[] = [];
	for (const item of decksIn) {
		if (!item || typeof item !== "object") continue;
		const d = item as Record<string, unknown>;
		if (typeof d.id !== "string" || !d.id.trim() || typeof d.title !== "string" || !d.title.trim()) continue;
		decks.push({
			id: d.id.trim(),
			title: d.title.trim(),
			goalId: typeof d.goalId === "string" ? d.goalId : undefined,
			fileName: typeof d.fileName === "string" ? d.fileName : undefined,
		});
	}
	const cards: Flashcard[] = [];
	for (const item of cardsIn) {
		if (!item || typeof item !== "object") continue;
		const c = item as Record<string, unknown>;
		if (typeof c.id !== "string" || !c.id.trim()) continue;
		if (typeof c.front !== "string" || typeof c.back !== "string" || typeof c.concept !== "string") continue;
		if (!c.front.trim() || !c.back.trim() || !c.concept.trim()) continue;
		if (c.front.length > 8000 || c.back.length > 8000) continue;
		const createdAt = typeof c.createdAt === "string" ? c.createdAt : new Date(0).toISOString();
		cards.push({
			id: c.id.trim(),
			deckId: typeof c.deckId === "string" && c.deckId.trim() ? c.deckId.trim() : DEFAULT_DECK_ID,
			concept: c.concept.trim(),
			front: c.front.trim(),
			back: c.back.trim(),
			source: typeof c.source === "string" ? c.source : undefined,
			createdAt,
			updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : createdAt,
			state: asState(c.state),
			due: typeof c.due === "string" ? c.due : createdAt,
			intervalMinutes: typeof c.intervalMinutes === "number" && c.intervalMinutes >= 0 ? c.intervalMinutes : 0,
			ease: typeof c.ease === "number" && c.ease > 0 ? c.ease : EASE_START,
			reps: typeof c.reps === "number" && c.reps >= 0 ? c.reps : 0,
			lapses: typeof c.lapses === "number" && c.lapses >= 0 ? c.lapses : 0,
			lastRating: asRating(c.lastRating),
			lastReviewed: typeof c.lastReviewed === "string" ? c.lastReviewed : undefined,
			fileName: typeof c.fileName === "string" ? c.fileName : undefined,
			contentKey: typeof c.contentKey === "string" ? c.contentKey : undefined,
			qualityIssue:
				typeof c.qualityIssue === "string" && c.qualityIssue.trim()
					? c.qualityIssue.trim()
					: flashcardQualityIssue(c.front.trim(), c.back.trim()) ?? undefined,
		});
	}
	const liveCards = new Set(cards.map((card) => card.id));
	const liveDecks = new Set(decks.map((deck) => deck.id));
	const lib: FlashcardLibrary = {
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		addFromTeachingNotes: raw.addFromTeachingNotes === true,
		decks,
		cards,
		retiredDeckIds: idList(raw.retiredDeckIds).filter((id) => id !== DEFAULT_DECK_ID && !liveDecks.has(id)),
		retiredCardIds: idList(raw.retiredCardIds).filter((id) => !liveCards.has(id)),
	};
	settleDefaultDeckTitle(lib);
	return lib;
}

export function serializeFlashcardLibrary(lib: FlashcardLibrary): string {
	return `${JSON.stringify(lib, null, 2)}\n`;
}

export async function loadFlashcardLibrary(io: VaultIO): Promise<FlashcardLibrary> {
	if (!(await io.exists(PATHS.flashcards))) return emptyFlashcardLibrary();
	const lib = parseFlashcardLibrary(JSON.parse(await io.read(PATHS.flashcards)));
	auditFlashcardLibrary(lib);
	return lib;
}

function unretireDeck(lib: FlashcardLibrary, id: string): void {
	if (!lib.retiredDeckIds.includes(id)) return;
	lib.retiredDeckIds = lib.retiredDeckIds.filter((deckId) => deckId !== id);
}

export function ensureDeck(lib: FlashcardLibrary, id: string, title: string): FlashDeck {
	unretireDeck(lib, id);
	let deck = lib.decks.find((d) => d.id === id);
	if (!deck) {
		deck = { id, title: title.trim() || "Deck" };
		lib.decks.push(deck);
	}
	return deck;
}

function deckMatching(lib: FlashcardLibrary, wanted: string): FlashDeck | undefined {
	const name = wanted.trim();
	const slug = slugify(name);
	const lower = name.toLowerCase();
	return lib.decks.find((d) => {
		if (d.id === name || d.title.toLowerCase() === lower) return true;
		if (!slug || d.id !== slug) return false;
		// The catch-all id stays "library" after its title moved to Unsorted.
		if (d.id === DEFAULT_DECK_ID && slugify(d.title) !== slug) return false;
		return true;
	});
}

function nextDeckId(lib: FlashcardLibrary, base: string): string {
	const stem = base || "deck";
	if (!lib.decks.some((d) => d.id === stem)) return stem;
	let n = 2;
	while (lib.decks.some((d) => d.id === `${stem}-${n}`)) n++;
	return `${stem}-${n}`;
}

/** Find a deck by name or id, or create one. An empty name, or the old name "Library", is the catch-all deck. */
function resolveDeck(lib: FlashcardLibrary, wanted: string): FlashDeck {
	const name = wanted.trim();
	if (!name || name.toLowerCase() === LEGACY_DEFAULT_DECK_TITLE.toLowerCase()) {
		const existing = lib.decks.find((d) => d.id === DEFAULT_DECK_ID);
		return existing ?? ensureDeck(lib, DEFAULT_DECK_ID, DEFAULT_DECK_TITLE);
	}
	const found = deckMatching(lib, name);
	if (found) return found;
	return ensureDeck(lib, nextDeckId(lib, slugify(name) || "deck"), name);
}

function uniqueName(used: Set<string>, base: string, deck = false): string {
	const stem = safeFileName(base) || (deck ? "Deck" : "Card");
	let name = `${stem}.md`;
	if (!used.has(name)) {
		used.add(name);
		return name;
	}
	if (deck) {
		name = `${stem} deck.md`;
		let n = 2;
		while (used.has(name)) {
			name = `${stem} deck ${n}.md`;
			n++;
		}
		used.add(name);
		return name;
	}
	let n = 2;
	while (used.has(name)) {
		name = `${stem} ${n}.md`;
		n++;
	}
	used.add(name);
	return name;
}

/** Gives every card and every non-empty deck a stable Markdown file name. */
export function assignFlashcardFiles(lib: FlashcardLibrary): void {
	const used = new Set<string>();
	for (const card of lib.cards) {
		if (card.fileName && !used.has(card.fileName)) {
			used.add(card.fileName);
			continue;
		}
		card.fileName = uniqueName(used, card.concept || "Card");
	}
	for (const deck of lib.decks) {
		if (!lib.cards.some((c) => c.deckId === deck.id)) {
			deck.fileName = undefined;
			continue;
		}
		if (deck.fileName && !used.has(deck.fileName)) {
			used.add(deck.fileName);
			continue;
		}
		deck.fileName = uniqueName(used, deck.title || "Deck", true);
	}
}

export function serializeCardMarkdown(card: Flashcard, deckTitle: string): string {
	const body = `## Front\n\n${card.front.trim()}\n\n## Back\n\n${card.back.trim()}\n`;
	return serializeNote(
		{
			groundwork: "flashcard",
			id: card.id,
			deck: card.deckId,
			deckTitle,
			concept: card.concept,
			state: card.state,
			due: card.due,
			intervalMinutes: card.intervalMinutes,
			ease: card.ease,
			reps: card.reps,
			lapses: card.lapses,
			source: card.source,
			contentKey: card.contentKey,
		},
		body,
	);
}

export function serializeDeckMarkdown(deck: FlashDeck, cards: Flashcard[]): string {
	const lines = cards.map((c) => {
		const name = (c.fileName ?? "card").replace(/\.md$/, "");
		const lead = c.front.split("\n")[0]?.slice(0, 80) ?? "";
		return `- [[${name}]] — ${lead}`;
	});
	return serializeNote(
		{ groundwork: "flashcard-deck", id: deck.id, title: deck.title },
		`# ${deck.title}\n\nCards in this deck. Edit a card's note to change the question or the answer. The review schedule stays on your Groundwork account.\n\n${lines.join("\n")}\n`,
	);
}

export interface ParsedCardFile {
	kind: "card";
	id: string;
	deckId: string;
	concept: string;
	front: string;
	back: string;
	contentKey: string;
	source?: string;
}

export function parseCardFile(text: string): ParsedCardFile | { kind: "deck"; id: string } | null {
	const { frontmatter, body } = parseNote(text);
	if (frontmatter.groundwork === "flashcard-deck") {
		return { kind: "deck", id: typeof frontmatter.id === "string" ? frontmatter.id.trim() : "" };
	}
	if (frontmatter.groundwork !== "flashcard") return null;
	const lines = body.replace(/^\uFEFF/, "").split("\n");
	let frontStart = 0;
	let backAt = -1;
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (t === "## Front") frontStart = i + 1;
		if (t === "## Back") {
			backAt = i;
			break;
		}
	}
	const front = (backAt < 0 ? lines.slice(frontStart) : lines.slice(frontStart, backAt)).join("\n").trim();
	const back = backAt < 0 ? "" : lines.slice(backAt + 1).join("\n").trim();
	return {
		kind: "card",
		id: typeof frontmatter.id === "string" ? frontmatter.id.trim() : "",
		deckId: typeof frontmatter.deck === "string" && frontmatter.deck.trim() ? frontmatter.deck.trim() : DEFAULT_DECK_ID,
		concept: typeof frontmatter.concept === "string" ? frontmatter.concept.trim() : "",
		front,
		back,
		contentKey: typeof frontmatter.contentKey === "string" ? frontmatter.contentKey : "",
		source: typeof frontmatter.source === "string" ? frontmatter.source : undefined,
	};
}

/**
 * Pull question/answer edits out of vault card notes. Scheduling in those files is ignored.
 * If the same card was edited in more than one write folder, the last folder in the list wins.
 */
export async function adoptVaultEdits(vault: VaultIO, writeFolders: readonly string[], lib: FlashcardLibrary, now = new Date()): Promise<boolean> {
	let changed = false;
	for (const folder of cleanFolderList(writeFolders)) {
		const dir = flashcardsDir(folder);
		if (!(await vault.exists(dir))) continue;
		let files: string[] = [];
		try {
			files = (await vault.list(dir)).files;
		} catch {
			continue;
		}
		for (const path of files) {
			if (!path.endsWith(".md")) continue;
			let text = "";
			try {
				text = await vault.read(path);
			} catch {
				continue;
			}
			const parsed = parseCardFile(text);
			if (!parsed || parsed.kind !== "card") continue;
			if (!parsed.front || !parsed.back || !parsed.concept) continue;
			const key = flashcardContentKey(parsed.concept, parsed.front, parsed.back);
			const id = parsed.id || `fc_${key}`;
			const fileName = path.split("/").pop();
			const existing = lib.cards.find((c) => c.id === id);
			if (!existing) {
				if (lib.retiredCardIds.includes(id) || lib.retiredDeckIds.includes(parsed.deckId)) continue;
				const deckTitle = parsed.deckId === DEFAULT_DECK_ID ? DEFAULT_DECK_TITLE : parsed.deckId;
				ensureDeck(lib, parsed.deckId, deckTitle);
				const card = makeCard({ id, deckId: parsed.deckId, concept: parsed.concept, front: parsed.front, back: parsed.back, source: parsed.source, now });
				card.fileName = fileName;
				card.contentKey = key;
				lib.cards.push(card);
				changed = true;
				continue;
			}
			// A file we wrote is internally consistent. A hand edit changes the body and leaves contentKey behind.
			if (parsed.contentKey && key === parsed.contentKey) continue;
			if (!parsed.contentKey && flashcardContentKey(existing.concept, existing.front, existing.back) === key) continue;
			if (existing.front === parsed.front && existing.back === parsed.back && existing.concept === parsed.concept) continue;
			existing.front = parsed.front;
			existing.back = parsed.back;
			existing.concept = parsed.concept;
			existing.contentKey = key;
			existing.updatedAt = now.toISOString();
			if (fileName) existing.fileName = fileName;
			changed = true;
		}
	}
	return changed;
}

function leavesRetiredExport(parsed: ParsedCardFile | { kind: "deck"; id: string }, lib: FlashcardLibrary): boolean {
	const retiredCards = lib.retiredCardIds ?? [];
	const retiredDecks = lib.retiredDeckIds ?? [];
	if (parsed.kind === "deck") return Boolean(parsed.id && retiredDecks.includes(parsed.id));
	if (parsed.id && retiredCards.includes(parsed.id)) return true;
	return Boolean(parsed.deckId && retiredDecks.includes(parsed.deckId));
}

async function holdsRetiredExport(vault: VaultIO, path: string, lib: FlashcardLibrary): Promise<boolean> {
	if (!(await vault.exists(path))) return false;
	try {
		const parsed = parseCardFile(await vault.read(path));
		return Boolean(parsed && leavesRetiredExport(parsed, lib));
	} catch {
		return false;
	}
}

async function claimExportName(vault: VaultIO, dir: string, fileName: string, taken: Set<string>, lib: FlashcardLibrary): Promise<string> {
	const stem = fileName.replace(/\.md$/i, "").replace(/ \d+$/, "");
	let name = fileName;
	let n = 2;
	while (taken.has(name) || (await holdsRetiredExport(vault, `${dir}/${name}`, lib))) {
		name = `${stem} ${n}.md`;
		n += 1;
		if (n > 50) break;
	}
	taken.add(name);
	return name;
}

export async function mirrorFlashcards(vault: VaultIO, writeFolders: readonly string[], lib: FlashcardLibrary): Promise<string[]> {
	const folders = cleanFolderList(writeFolders);
	assignFlashcardFiles(lib);
	for (const card of lib.cards) card.contentKey = flashcardContentKey(card.concept, card.front, card.back);
	const mirrored: string[] = [];
	for (const folder of folders) {
		const dir = flashcardsDir(folder);
		const exists = await vault.exists(dir);
		if (!lib.cards.length && !exists) continue;
		if (lib.cards.length) await ensureDir(vault, dir);
		const keep = new Set<string>();
		const taken = new Set<string>();
		for (const card of lib.cards) {
			if (!card.fileName) continue;
			card.fileName = await claimExportName(vault, dir, card.fileName, taken, lib);
			const deck = lib.decks.find((d) => d.id === card.deckId);
			const path = `${dir}/${card.fileName}`;
			await vault.write(path, serializeCardMarkdown(card, deck?.title ?? card.deckId));
			keep.add(path);
		}
		for (const deck of lib.decks) {
			if (!deck.fileName) continue;
			deck.fileName = await claimExportName(vault, dir, deck.fileName, taken, lib);
			const cards = lib.cards.filter((c) => c.deckId === deck.id);
			const path = `${dir}/${deck.fileName}`;
			await vault.write(path, serializeDeckMarkdown(deck, cards));
			keep.add(path);
		}
		let existing: string[] = [];
		try {
			existing = (await vault.list(dir)).files;
		} catch {
			existing = [];
		}
		for (const path of existing) {
			if (keep.has(path) || !path.endsWith(".md")) continue;
			let text = "";
			try {
				text = await vault.read(path);
			} catch {
				continue;
			}
			const parsed = parseCardFile(text);
			if (!parsed) continue;
			if (leavesRetiredExport(parsed, lib)) continue;
			await vault.remove(path);
		}
		mirrored.push(dir);
	}
	return mirrored;
}

/** Drop mirrored card notes. Leaves any other file in the write folder alone. */
export async function removeFlashcardMirrors(vault: VaultIO, writeFolders: readonly string[]): Promise<void> {
	for (const folder of cleanFolderList(writeFolders)) {
		const dir = flashcardsDir(folder);
		if (!(await vault.exists(dir))) continue;
		let files: string[] = [];
		try {
			files = (await vault.list(dir)).files;
		} catch {
			continue;
		}
		for (const path of files) {
			if (!path.endsWith(".md")) continue;
			let text = "";
			try {
				text = await vault.read(path);
			} catch {
				continue;
			}
			if (parseCardFile(text)) await vault.remove(path);
		}
	}
}

function fingerprint(lib: FlashcardLibrary): string {
	return JSON.stringify({
		addFromTeachingNotes: lib.addFromTeachingNotes,
		retiredDeckIds: lib.retiredDeckIds ?? [],
		retiredCardIds: lib.retiredCardIds ?? [],
		decks: lib.decks.map((d) => ({ id: d.id, title: d.title, goalId: d.goalId ?? null, fileName: d.fileName ?? null })),
		cards: lib.cards.map((c) => ({
			id: c.id,
			deckId: c.deckId,
			concept: c.concept,
			front: c.front,
			back: c.back,
			source: c.source ?? null,
			createdAt: c.createdAt,
			state: c.state,
			due: c.due,
			intervalMinutes: c.intervalMinutes,
			ease: c.ease,
			reps: c.reps,
			lapses: c.lapses,
			lastRating: c.lastRating ?? null,
			lastReviewed: c.lastReviewed ?? null,
			fileName: c.fileName ?? null,
			contentKey: c.contentKey ?? null,
		})),
	});
}

async function diskHasLegacyLibraryTitle(io: VaultIO): Promise<boolean> {
	if (!(await io.exists(PATHS.flashcards))) return false;
	try {
		const raw = JSON.parse(await io.read(PATHS.flashcards)) as { decks?: Array<{ id?: string; title?: string }> };
		return Array.isArray(raw.decks) && raw.decks.some((deck) => deck?.id === DEFAULT_DECK_ID && deck?.title === LEGACY_DEFAULT_DECK_TITLE);
	} catch {
		return false;
	}
}

async function persist(store: KnowledgeStore, lib: FlashcardLibrary, now: Date): Promise<void> {
	if (!lib.retiredDeckIds) lib.retiredDeckIds = [];
	if (!lib.retiredCardIds) lib.retiredCardIds = [];
	settleDefaultDeckTitle(lib);
	assignFlashcardFiles(lib);
	for (const card of lib.cards) card.contentKey = flashcardContentKey(card.concept, card.front, card.back);
	let prev: FlashcardLibrary | null = null;
	if (await store.io.exists(PATHS.flashcards)) {
		try {
			prev = await loadFlashcardLibrary(store.io);
		} catch {
			prev = null;
		}
	}
	const legacyTitle = await diskHasLegacyLibraryTitle(store.io);
	if (!prev || fingerprint(prev) !== fingerprint(lib) || legacyTitle) {
		lib.updatedAt = now.toISOString();
		await store.writeFile(PATHS.flashcards, serializeFlashcardLibrary(lib));
	}
}

/** Pull hand edits of exported cards back onto the account. Does not write anything into the vault, and does not make cards. */
export async function syncFlashcards(store: KnowledgeStore, writeFolders: readonly string[], now = new Date()): Promise<FlashcardLibrary> {
	const lib = await loadFlashcardLibrary(store.io);
	await adoptVaultEdits(store.context, writeFolders, lib, now);
	await persist(store, lib, now);
	return lib;
}

/** Copy the account deck into `flashcards/` in each chosen folder. Hand edits are kept first. */
export async function exportFlashcards(store: KnowledgeStore, writeFolders: readonly string[], now = new Date()): Promise<string[]> {
	const lib = await loadFlashcardLibrary(store.io);
	await adoptVaultEdits(store.context, writeFolders, lib, now);
	await persist(store, lib, now);
	const written = await mirrorFlashcards(store.context, writeFolders, lib);
	await persist(store, lib, now);
	return written;
}

export async function createDeck(store: KnowledgeStore, title: string, now = new Date()): Promise<FlashDeck> {
	const name = assertDeckTitle(title);
	const lib = await loadFlashcardLibrary(store.io);
	const deck = resolveDeck(lib, name);
	await persist(store, lib, now);
	return deck;
}

export async function renameDeck(store: KnowledgeStore, deckId: string, title: string, now = new Date()): Promise<FlashDeck> {
	const name = assertDeckTitle(title);
	const id = deckId.trim();
	const lib = await loadFlashcardLibrary(store.io);
	const deck = lib.decks.find((d) => d.id === id);
	if (!deck) throw new Error("That deck is already gone.");
	if (deck.title === name) return deck;
	if (lib.decks.some((d) => d.id !== id && d.title.toLowerCase() === name.toLowerCase())) {
		throw new Error("A deck already has that name.");
	}
	deck.title = name;
	await persist(store, lib, now);
	return deck;
}

/** Remove a deck and its cards from the account. Exported vault notes are left in place. */
export async function deleteDeck(store: KnowledgeStore, deckId: string, now = new Date()): Promise<void> {
	const id = deckId.trim();
	const lib = await loadFlashcardLibrary(store.io);
	const deck = lib.decks.find((d) => d.id === id);
	if (!deck) throw new Error("That deck is already gone.");
	if (id === DEFAULT_DECK_ID) throw new Error(`${deck.title} stays. Cards that aren't put in a deck go there.`);
	const gone = lib.cards.filter((card) => card.deckId === id).map((card) => card.id);
	lib.decks = lib.decks.filter((d) => d.id !== id);
	lib.cards = lib.cards.filter((card) => card.deckId !== id);
	lib.retiredDeckIds = rememberRetired(lib.retiredDeckIds, [id]);
	lib.retiredCardIds = rememberRetired(lib.retiredCardIds, gone);
	await persist(store, lib, now);
}

export async function createFlashcard(
	store: KnowledgeStore,
	input: { concept: string; front: string; back: string; deckId?: string; deckTitle?: string; source?: string },
	now = new Date(),
): Promise<Flashcard> {
	const concept = input.concept.trim();
	const front = input.front.trim();
	const back = input.back.trim();
	if (!concept || !front || !back) throw new Error("A card needs a concept, a front, and a back.");
	const issue = flashcardQualityIssue(front, back);
	if (issue) throw new Error(issue);
	const lib = await loadFlashcardLibrary(store.io);
	const deckId = input.deckId?.trim() || DEFAULT_DECK_ID;
	const requested = input.deckTitle?.trim() || "";
	const existing = lib.decks.find((deck) => deck.id === deckId);
	const deckTitle =
		existing?.title ||
		(deckId === DEFAULT_DECK_ID && (!requested || requested.toLowerCase() === "library") ? DEFAULT_DECK_TITLE : requested || deckId);
	ensureDeck(lib, deckId, deckTitle);
	const card = makeCard({ deckId, concept, front, back, source: input.source, now });
	lib.cards.push(card);
	await persist(store, lib, now);
	return card;
}

export async function deleteFlashcard(store: KnowledgeStore, id: string, now = new Date()): Promise<void> {
	const lib = await loadFlashcardLibrary(store.io);
	const card = lib.cards.find((c) => c.id === id);
	if (!card) throw new Error("That card is already gone.");
	lib.cards = lib.cards.filter((c) => c.id !== id);
	lib.retiredCardIds = rememberRetired(lib.retiredCardIds, [card.id]);
	await persist(store, lib, now);
}

export async function rateFlashcard(store: KnowledgeStore, id: string, rating: CardRating, now = new Date()): Promise<Flashcard> {
	const lib = await loadFlashcardLibrary(store.io);
	const index = lib.cards.findIndex((c) => c.id === id);
	if (index < 0) throw new Error("That card is already gone.");
	const card = applyRating(lib.cards[index], rating, now);
	lib.cards[index] = card;
	await persist(store, lib, now);
	// Again is only a miss inside this sitting. It does not add mastery.
	if (rating !== "again" && (await store.resolve(card.concept))) {
		const { outcome, difficulty } = ratingOutcome(rating);
		await store.recordEvidence(card.concept, {
			ts: now.toISOString(),
			kind: "review",
			source: "flashcard",
			outcome,
			difficulty,
			question: card.front.slice(0, 240),
		});
	}
	return card;
}

/** Edit a card's wording in place. Its schedule and review history stay. */
export async function updateFlashcard(
	store: KnowledgeStore,
	id: string,
	input: { concept: string; front: string; back: string },
	now = new Date(),
): Promise<Flashcard> {
	const concept = input.concept.trim();
	const front = input.front.trim();
	const back = input.back.trim();
	if (!concept || !front || !back) throw new Error("A card needs a concept, a front, and a back.");
	const issue = flashcardQualityIssue(front, back);
	if (issue) throw new Error(issue);
	const lib = await loadFlashcardLibrary(store.io);
	const card = lib.cards.find((c) => c.id === id);
	if (!card) throw new Error("That card is already gone.");
	card.concept = concept;
	card.front = front;
	card.back = back;
	card.updatedAt = now.toISOString();
	delete card.qualityIssue;
	await persist(store, lib, now);
	return card;
}

/** Cards a learner can practice, in a stable order. Calendar due dates are ignored. */
export function cardsToPractice(cards: readonly Flashcard[]): Flashcard[] {
	return studyableCards(cards).sort((a, b) => a.concept.localeCompare(b.concept) || a.front.localeCompare(b.front) || a.id.localeCompare(b.id));
}

export function cardsInDeck(lib: FlashcardLibrary, deckId: string): Flashcard[] {
	if (!deckId) return lib.cards;
	return lib.cards.filter((c) => c.deckId === deckId);
}

/** Save or replace one card. `deck` is any deck name. A new name creates that deck. Omit it, or pass "Library", for the Unsorted deck. */
export async function saveFlashcard(
	store: KnowledgeStore,
	input: { concept: string; front: string; back: string; deck?: string },
	now = new Date(),
): Promise<{ card: Flashcard; deckTitle: string }> {
	const concept = input.concept.trim();
	const front = input.front.trim();
	const back = input.back.trim();
	if (!concept || !front || !back) throw new Error("A card needs a concept, a front, and a back.");
	const issue = flashcardQualityIssue(front, back);
	if (issue) throw new Error(issue);
	const lib = await loadFlashcardLibrary(store.io);
	const deck = resolveDeck(lib, input.deck ?? "");
	let card = lib.cards.find((c) => c.deckId === deck.id && c.concept.toLowerCase() === concept.toLowerCase() && c.front === front);
	if (card) {
		card.back = back;
		card.updatedAt = now.toISOString();
		card.contentKey = flashcardContentKey(concept, front, back);
		delete card.qualityIssue;
	} else {
		card = makeCard({ deckId: deck.id, concept, front, back, now });
		lib.cards.push(card);
	}
	await persist(store, lib, now);
	return { card, deckTitle: deck.title };
}
