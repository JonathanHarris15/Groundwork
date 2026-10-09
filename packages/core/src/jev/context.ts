/**
 * Jev chooses what a tutor turn needs to see.
 *
 * The teaching method, the learner profile, and vault files are split into
 * pieces. One noul per piece. Code applies the thresholds. A missing answer
 * keeps an instruction or profile section (dropping a rule is worse than
 * extra text) and leaves a file closed (opening the wrong file is expensive).
 * A failed call, or no selector, keeps today's full prompt and only the
 * files the learner attached.
 */

import type { FolderAccess } from "../access";
import { fileKind, listVaultFiles, loadVaultFile, basename, type VaultFile } from "../files";
import type { HttpClient } from "../http";
import { httpClient } from "../http";
import type { VaultIO } from "../io";
import { splitMarkdown } from "../markdown";
import { buildSystemPrompt, promptParts, type PromptPart } from "../prompt";
import { asRecord } from "../unknown";

/** Drop a rule only when Jev is fairly sure this message does not need it. */
export const INCLUDE_INSTRUCTION_AT = 0.35;
export const INCLUDE_LEARNER_AT = 0.45;
export const INCLUDE_FILE_AT = 0.6;
/** Files judged in one call. The rest stay closed and can be opened with a tool. */
export const CONTEXT_FILE_CANDIDATES = 24;
/** Files actually opened, highest need first. Attached files win a tie. */
export const CONTEXT_MAX_FILES = 8;
export const CONTEXT_MAX_PIECES = 80;
const INSTRUCTION_EXCERPT_CHARS = 1_200;
const FILE_EXCERPT_CHARS = 600;
const MESSAGE_CHARS = 4_000;

export type ContextKind = "instruction" | "learner" | "file";

export interface ContextPiece {
	id: string;
	kind: ContextKind;
	title: string;
	text: string;
	/** The learner attached this file to the message being judged. */
	attached?: boolean;
}

export interface ContextSelector {
	/** Optional piece ids to include. `null` means the call did not run. */
	select(message: string, pieces: ContextPiece[], signal?: AbortSignal): Promise<string[] | null>;
}

const LEARNER_UNUSED =
	"No part of the learner profile was needed for this message. Do not treat the profile as empty, and do not rewrite it.";

export interface PreparedTutorTurn {
	system: string;
	files: VaultFile[];
	/** Set when the profile sent to the tutor is not the whole saved file. */
	profile?: string;
	/** Set when the tutor notes sent this turn are not the whole saved note. */
	tutorContext?: string;
	/** Hidden note naming files that stayed closed. */
	note: string;
	selected: boolean;
}

export function learnerPieces(profile: string, tutorContext: string): ContextPiece[] {
	const pieces: ContextPiece[] = splitMarkdown(profile).map((piece) => ({
		id: `learner:${piece.id}`,
		kind: "learner" as const,
		title: piece.title,
		text: piece.text,
	}));
	const notes = tutorContext.trim();
	if (notes) {
		pieces.push({ id: "learner:tutor-notes", kind: "learner", title: "Tutor notes", text: notes });
	}
	return pieces;
}

/** One System One request. Question ids are indexes; the piece id stays in the text the model sees only as a title. */
export function contextRequest(message: string, pieces: ContextPiece[]): {
	state: { task: string; message: string };
	model: "jev-latest";
	questions: Record<string, unknown>;
} {
	const questions: Record<string, unknown> = {};
	pieces.forEach((piece, index) => {
		questions[`i${index}`] = {
			type: "noul",
			instructions: {
				question: questionFor(piece.kind),
				material: materialFor(piece),
			},
			criteria: criteriaFor(piece.kind),
		};
	});
	return {
		state: {
			task: "Choose material for one tutor turn. Include a piece only when the reply would be wrong or incomplete without it.",
			message: clip(message, MESSAGE_CHARS),
		},
		model: "jev-latest",
		questions,
	};
}

function questionFor(kind: ContextKind): string {
	if (kind === "file") return "Does the tutor need the contents of `material` to do what this message asks?";
	if (kind === "learner") return "Does `material` change how the tutor should handle this message?";
	return "Does `material` change what the tutor should do on this message?";
}

function criteriaFor(kind: ContextKind): { true: string; false: string } {
	if (kind === "file") {
		return {
			true: "The learner asked about this file, or the reply needs a fact that is in it.",
			false: "The file is about something else, or the message does not need a file.",
		};
	}
	if (kind === "learner") {
		return {
			true: "A fact here about this learner would change the reply.",
			false: "Nothing here bears on this message.",
		};
	}
	return {
		true: "This rule applies to what the learner just asked.",
		false: "This rule is about a different situation than this message.",
	};
}

function materialFor(piece: ContextPiece): Record<string, string> {
	const material: Record<string, string> = {
		kind: piece.kind,
		title: piece.title,
		text: clip(piece.text, piece.kind === "file" ? FILE_EXCERPT_CHARS : INSTRUCTION_EXCERPT_CHARS),
	};
	if (piece.attached) material.attached = "The learner attached this file to this message.";
	return material;
}

export function includedPieceIds(pieces: ContextPiece[], answers: Record<string, { type?: string; noul?: number }>): string[] {
	const scored = pieces.map((piece, index) => {
		const answer = answers[`i${index}`];
		const noul = answer?.type === "noul" && typeof answer.noul === "number" ? answer.noul : undefined;
		return { piece, noul };
	});
	const kept = scored.filter((row) => row.piece.kind !== "file" && keepPiece(row.piece, row.noul)).map((row) => row.piece.id);
	const files = scored
		.filter((row) => row.piece.kind === "file" && keepPiece(row.piece, row.noul))
		.sort((a, b) => Number(!!b.piece.attached) - Number(!!a.piece.attached) || (b.noul ?? 0) - (a.noul ?? 0))
		.slice(0, CONTEXT_MAX_FILES)
		.map((row) => row.piece.id);
	return [...kept, ...files];
}

function keepPiece(piece: ContextPiece, noul: number | undefined): boolean {
	if (noul === undefined) return piece.kind !== "file";
	if (piece.kind === "file") return noul >= INCLUDE_FILE_AT;
	if (piece.kind === "learner") return noul >= INCLUDE_LEARNER_AT;
	return noul >= INCLUDE_INSTRUCTION_AT;
}

export function parseContextRequest(body: unknown): { message: string; pieces: ContextPiece[] } | null {
	const record = asRecord(body);
	if (!record || typeof record.message !== "string") return null;
	if (!Array.isArray(record.pieces) || record.pieces.length > CONTEXT_MAX_PIECES) return null;
	const pieces: ContextPiece[] = [];
	for (const value of record.pieces) {
		const piece = asRecord(value);
		if (!piece) return null;
		const id = piece.id;
		const kind = piece.kind;
		const title = piece.title;
		const text = piece.text;
		if (typeof id !== "string" || typeof title !== "string" || typeof text !== "string") return null;
		if (kind !== "instruction" && kind !== "learner" && kind !== "file") return null;
		if (!id.trim() || id.length > 300 || title.length > 300 || text.length > 2_000) return null;
		pieces.push({ id, kind, title, text, ...(piece.attached === true ? { attached: true } : {}) });
	}
	return { message: record.message.slice(0, MESSAGE_CHARS), pieces };
}

/** Calls the Groundwork server. The Jev key never leaves that server. */
export function remoteContextSelector(baseUrl: string, fetchImpl: HttpClient = httpClient(), authorization?: () => Promise<string | null>): ContextSelector {
	const root = baseUrl.replace(/\/$/, "");
	return {
		async select(message, pieces, signal) {
			const token = await authorization?.();
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (token) headers.authorization = `Bearer ${token}`;
			const res = await fetchImpl(`${root}/v1/context`, {
				method: "POST",
				headers,
				body: JSON.stringify({ message, pieces: pieces.map(forWire) }),
				signal,
			});
			if (res.status === 503) return null;
			if (!res.ok) throw new Error(`Context selection failed (${res.status}).`);
			const body = asRecord(await res.json());
			if (!body || !Array.isArray(body.included)) throw new Error("Context selection returned no choices.");
			return body.included.filter((id): id is string => typeof id === "string");
		},
	};
}

function forWire(piece: ContextPiece): ContextPiece {
	return {
		id: piece.id,
		kind: piece.kind,
		title: piece.title,
		text: clip(piece.text, piece.kind === "file" ? FILE_EXCERPT_CHARS : INSTRUCTION_EXCERPT_CHARS),
		...(piece.attached ? { attached: true } : {}),
	};
}

export async function prepareTutorTurn(input: {
	selector?: ContextSelector | null;
	message: string;
	extra?: string;
	access?: FolderAccess;
	profile: string;
	tutorContext: string;
	attached: VaultFile[];
	io?: VaultIO;
	signal?: AbortSignal;
}): Promise<PreparedTutorTurn> {
	const full = unselectedTurn(input);
	if (!input.selector) return full;
	try {
		const parts = promptParts(input.extra, input.access);
		const instructions = parts.filter((part) => !part.required).map(instructionPiece);
		const learner = learnerPieces(input.profile, input.tutorContext);
		const files = input.io ? await filePieces(input.io, input.access?.readFolders ?? [], input.attached) : attachedPieces(input.attached);
		const optional = [...instructions, ...learner, ...files].slice(0, CONTEXT_MAX_PIECES);
		if (!optional.length) return full;
		const include = await input.selector.select(input.message, optional, input.signal);
		if (!include) return full;
		return applySelection(input, parts, learner, files, new Set(include));
	} catch (err) {
		if (input.signal?.aborted) throw err;
		return unselectedTurn(input);
	}
}

function unselectedTurn(input: { extra?: string; access?: FolderAccess; attached: VaultFile[] }): PreparedTutorTurn {
	return { system: buildSystemPrompt(input.extra, input.access), files: input.attached, note: "", selected: false };
}

function instructionPiece(part: PromptPart): ContextPiece {
	return { id: part.id, kind: "instruction", title: part.title, text: part.text };
}

function attachedPieces(attached: VaultFile[]): ContextPiece[] {
	return attached.slice(0, CONTEXT_FILE_CANDIDATES).map((file) => ({
		id: `file:${file.path}`,
		kind: "file" as const,
		title: file.path,
		text: attachedExcerpt(file),
		attached: true,
	}));
}

async function filePieces(io: VaultIO, folders: readonly string[], attached: VaultFile[]): Promise<ContextPiece[]> {
	const pieces: ContextPiece[] = [];
	const seen = new Set<string>();
	const push = async (path: string, isAttached: boolean) => {
		if (!path || seen.has(path) || pieces.length >= CONTEXT_FILE_CANDIDATES) return;
		seen.add(path);
		const file = attached.find((item) => item.path === path);
		pieces.push({
			id: `file:${path}`,
			kind: "file",
			title: path,
			text: file ? attachedExcerpt(file) : await vaultExcerpt(io, path),
			attached: isAttached,
		});
	};
	for (const file of attached) await push(file.path, true);
	for (const folder of folders) {
		let paths: string[] = [];
		try {
			paths = await listVaultFiles(io, folder);
		} catch {
			continue;
		}
		for (const path of paths) await push(path, false);
	}
	return pieces;
}

function attachedExcerpt(file: VaultFile): string {
	if (file.text?.trim()) return clip(file.text, FILE_EXCERPT_CHARS);
	if (file.skipped) return file.skipped;
	return `${file.kind} file named ${basename(file.path)}. The contents are not in this excerpt.`;
}

async function vaultExcerpt(io: VaultIO, path: string): Promise<string> {
	const { kind } = fileKind(path);
	if (kind !== "text") return `${kind} file named ${basename(path)}. The contents are not in this excerpt.`;
	try {
		return clip(await io.read(path), FILE_EXCERPT_CHARS);
	} catch {
		return "Could not read a text excerpt.";
	}
}

async function applySelection(
	input: { extra?: string; access?: FolderAccess; attached: VaultFile[]; io?: VaultIO; profile: string; tutorContext: string },
	parts: PromptPart[],
	learner: ContextPiece[],
	files: ContextPiece[],
	include: Set<string>,
): Promise<PreparedTutorTurn> {
	const optional = parts.filter((part) => !part.required);
	const system = optional.every((part) => include.has(part.id))
		? buildSystemPrompt(input.extra, input.access)
		: parts
				.filter((part) => part.required || include.has(part.id))
				.map((part) => part.text)
				.join("\n\n");
	const opened = new Set(files.filter((piece) => include.has(piece.id)).map((piece) => piece.title));
	const loaded: VaultFile[] = [];
	for (const path of opened) {
		const already = input.attached.find((file) => file.path === path);
		if (already) {
			loaded.push(already);
			continue;
		}
		if (input.io) loaded.push(await loadVaultFile(input.io, path));
	}
	const profilePieces = learner.filter((piece) => piece.id !== "learner:tutor-notes");
	const keptProfile = profilePieces.filter((piece) => include.has(piece.id));
	const profile = profilePieces.length ? (keptProfile.length ? keptProfile.map((piece) => piece.text).join("\n\n") : LEARNER_UNUSED) : undefined;
	const notes = learner.find((piece) => piece.id === "learner:tutor-notes");
	const tutorContext = notes && !include.has(notes.id) ? "" : undefined;
	// The profile reaches the model even when this turn never calls get_learner_overview.
	// The tool override still hides the sections that were left out.
	const shown = [system];
	if (keptProfile.length) shown.push(keptProfile.map((piece) => piece.text).join("\n\n"));
	if (notes && include.has(notes.id)) shown.push(`# Tutor notes\n\n${notes.text}`);
	const leftClosed = files.filter((piece) => !opened.has(piece.title)).map((piece) => piece.title);
	return { system: shown.join("\n\n"), files: loaded, profile, tutorContext, note: filesLeftClosedNote(leftClosed), selected: true };
}

export function filesLeftClosedNote(paths: string[]): string {
	if (!paths.length) return "";
	const shown = paths.slice(0, 12);
	const more = paths.length - shown.length;
	return [
		"<files_left_closed>",
		`These files were not opened for this message: ${shown.join(", ")}${more ? `, and ${more} more` : ""}.`,
		"Open one with read_vault_file only if this message actually needs it.",
		"</files_left_closed>",
	].join("\n");
}

function clip(text: string, max: number): string {
	const clean = text.trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max)}\n…`;
}
