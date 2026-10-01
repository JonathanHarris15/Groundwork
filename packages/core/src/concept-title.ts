import { unwikilink } from "./markdown";

/**
 * A concept is a reusable idea ("Linear functions", "Affine compositions").
 * A lecture, homework, exam, or a task tied to one of those ("Lecture Note 1 fluency")
 * is a goal. The file itself is referenced from the goal, never from the concept.
 */

const FILE_EXT = /\.(?:pdf|pptx?|docx?|txt|png|jpe?g|gif|webp|csv|tex|md)\b/i;

const PREPARE = /^\s*(?:prepar(?:e|ing)|prep)\s+(?:for\b|the\b)/i;

/** Document words. "Assignment" is omitted: "the assignment problem" is a real idea. */
const ARTIFACT =
	/\b(lectures?|slides?|slide\s+decks?|homeworks?|problem\s*sets?|p-?sets?|psets?|worksheets?|handouts?|study\s+guides?|formula\s+sheets?|cheat\s+sheets?|practice\s+exams?|practice\s+tests?|practice\s+quizzes?|sample\s+exams?|mock\s+exams?|midterms?|final\s+exams?|exams?|quizzes?|hw\d*)\b/i;

/** Plural "notes" is a document. Singular "note" is only a document when numbered ("Note 1") or paired with "lecture". */
const NOTES = /\bnotes\b/i;

const NUMBERED_DOC =
	/\b(chapters?|sections?|weeks?|units?|assignments?|homeworks?|lectures?|notes?|exams?|quizzes?|hw|p-?sets?|psets?)\s*#?\s*\d+[a-z]?\b/i;

const SOLUTION_DOC =
	/\b(lectures?|notes?|homeworks?|hw\d*|exams?|quizzes?|midterms?|practice|chapters?|worksheets?|assignments?|psets?|slides?)\b/i;

/** Why `title` cannot be a concept, or null when it names a reusable idea. */
export function sourceBoundConceptReason(title: string): string | null {
	const t = unwikilink(title).trim();
	if (!t) return null;
	if (/^resources\//i.test(t) || /[\\/]/.test(t)) return "it points at a file";
	if (FILE_EXT.test(t)) return "it is a file name";
	if (PREPARE.test(t)) return "preparing for a course or exam is a goal";
	if (/\bfluency\b/i.test(t)) return "fluency on a source is a goal";
	if (/\bunaided\b/i.test(t)) return "an unaided pass over a source is a goal";
	if (/\bmastery\b/i.test(t)) return "mastery of a source is a goal";
	if (ARTIFACT.test(t) || NOTES.test(t)) return "it names a source document";
	if (NUMBERED_DOC.test(t)) return "it names a numbered source document";
	if (/\bsolutions\b/i.test(t) && SOLUTION_DOC.test(t)) return "an answer key is not a concept";
	return null;
}

export function assertAbstractConcept(title: string): void {
	const clean = unwikilink(title).trim();
	const reason = sourceBoundConceptReason(clean);
	if (!reason) return;
	throw new Error(
		`"${clean}" cannot be a concept — ${reason}. A concept is a reusable idea such as "Linear functions" or "Affine compositions". Name the document on a goal instead, and reference the file in that goal's sources.`,
	);
}

function isFileRef(target: string): boolean {
	const t = target.trim();
	return /^resources\//i.test(t) || t.includes("/") || FILE_EXT.test(t);
}

/** A file path or a wikilink to a document, if `text` names a source directly. */
export function directSourceReference(text: string): string | null {
	const link = /\[\[([^\]|#]+)/g;
	let m: RegExpExecArray | null;
	while ((m = link.exec(text))) {
		const target = m[1].trim();
		if (isFileRef(target) || sourceBoundConceptReason(target)) return target;
	}
	const path = /(?:^|[\s("'`])(resources\/[^\s)\]"'`]+)/.exec(text);
	if (path) return path[1].replace(/[.,;:]+$/, "");
	const file = /(?:^|[\s("'`])([\w.-]+\.(?:pdf|pptx?|docx?|txt|png|jpe?g|gif|webp))\b/i.exec(text);
	if (file) return file[1];
	return null;
}

export function assertConceptOmitsSources(text: string): void {
	const ref = directSourceReference(text);
	if (!ref) return;
	throw new Error(
		`A concept cannot reference a source document (${ref}). Put the file on a goal, in sources. Concepts stay reusable without the document they were learned from.`,
	);
}
