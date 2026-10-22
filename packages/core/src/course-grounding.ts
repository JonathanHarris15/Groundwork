import { getSection } from "./markdown";

/** Heading on a concept note. Empty when the concept has no course excerpts yet. */
export const COURSE_SECTION = "From your course";
export const MAX_EXCERPTS = 5;
export const MAX_QUOTE_CHARS = 400;

export interface CourseExcerpt {
	/** Verbatim, or whitespace-normalized, substring of the source. At most 400 characters. */
	quote: string;
	/** File name plus page or slide. Plain text, not a path and not a wikilink. */
	provenance: string;
	/** YYYY-MM-DD the excerpt was stored. */
	imported: string;
}

export interface CourseMethod {
	/** The professor's approach, notation, and step order. Absent when sources disagree. */
	preferred?: string;
	alternates: string[];
	/** Set when two sources name different methods. Neither is treated as the only one. */
	conflict?: string;
}

export interface CourseGrounding {
	excerpts: CourseExcerpt[];
	method: CourseMethod;
}

export interface CourseExcerptInput {
	quote: string;
	provenance?: string;
	/** Vault path or file name the quote was copied from. Not stored on the concept. */
	path?: string;
	/** Extracted text the quote must appear in. */
	sourceText?: string;
}

export interface CourseInput {
	excerpts?: CourseExcerptInput[];
	preferredMethod?: string;
	alternates?: string[];
	methodConflict?: string;
	/** Internal. Set after the quotes have been checked against extracted text. */
	verified?: boolean;
}

export interface SourceDoc {
	path: string;
	name: string;
	text: string;
}

const STOP = new Set(
	"about after also because before being choose chosen choosing different every from have into method order steps that their then there these this those using which with would your this".split(" "),
);

export function whitespaceNormalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function emptyCourse(): CourseGrounding {
	return { excerpts: [], method: { alternates: [] } };
}

export function courseIsEmpty(course: CourseGrounding): boolean {
	return !course.excerpts.length && !course.method.preferred && !course.method.conflict && !course.method.alternates.length;
}

/** The quote as it appears in the source, or null when it is not a substring. */
export function sourceSlice(quote: string, source: string): string | null {
	const trimmed = quote.replace(/\s+/g, " ").trim();
	if (!trimmed || trimmed.length > MAX_QUOTE_CHARS) return null;
	if (/\[\[|resources\//i.test(trimmed)) return null;
	if (source.includes(trimmed)) return trimmed;
	const parts = trimmed.split(" ").map(escapeRegExp);
	if (!parts.length || parts.some((part) => !part)) return null;
	const match = new RegExp(parts.join("\\s+")).exec(source);
	if (!match) return null;
	const slice = match[0].replace(/\s+/g, " ").trim();
	if (!slice || slice.length > MAX_QUOTE_CHARS) return null;
	return slice;
}

export function sanitizeProvenance(label: string): string {
	const text = label
		.replace(/\[\[|\]\]/g, "")
		.replace(/resources\//gi, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\/+/, "");
	if (!text || /\[\[|\]\]|resources\//i.test(text)) {
		throw new Error("Provenance is the file name and a page or slide, not a link.");
	}
	return text.slice(0, 160);
}

export function provenanceForQuote(doc: SourceDoc, quote: string): string {
	const file = (doc.name || doc.path).split("/").pop() || "course file";
	const at = indexOfQuote(doc.text, quote);
	const before = at >= 0 ? doc.text.slice(0, at) : "";
	const marks = [...before.matchAll(/--- (page|slide) (\d+) ---/g)];
	const last = marks.at(-1);
	const where = last ? `${last[1]} ${last[2]}` : "";
	return sanitizeProvenance(where ? `${file}, ${where}` : file);
}

export function parseCourseGrounding(body: string): CourseGrounding {
	const section = getSection(body, COURSE_SECTION);
	if (!section) return emptyCourse();
	return parseCourseSection(section);
}

export function parseCourseSection(section: string): CourseGrounding {
	const preferred = /^Preferred method:\s*(.+)$/m.exec(section)?.[1]?.trim();
	const conflict = /^Method conflict:\s*(.+)$/m.exec(section)?.[1]?.trim();
	const alternates: string[] = [];
	const alt = section.match(/^Alternates:\n([\s\S]*?)(?:\n(?:Method conflict:|Excerpts:)|\n\n|$)/m);
	if (alt?.[1]) {
		for (const line of alt[1].split("\n")) {
			const item = /^- (.+)$/.exec(line.trim());
			if (item?.[1]) alternates.push(item[1].trim());
		}
	}
	const excerpts: CourseExcerpt[] = [];
	for (const block of section.split(/\n(?=- Quote: )/)) {
		const quote = /^- Quote: (.+)$/m.exec(block)?.[1]?.trim();
		const where = /^ {2}Where: (.+)$/m.exec(block)?.[1]?.trim();
		const imported = /^ {2}Imported: (\d{4}-\d{2}-\d{2})$/m.exec(block)?.[1];
		if (!quote || !where || !imported) continue;
		if (quote.length > MAX_QUOTE_CHARS || /\[\[|resources\//i.test(quote)) continue;
		try {
			excerpts.push({ quote, provenance: sanitizeProvenance(where), imported });
		} catch {
			// A stored line that is a link is ignored. The rest of the note still loads.
		}
	}
	return {
		excerpts: excerpts.slice(0, MAX_EXCERPTS),
		method: {
			...(preferred ? { preferred } : {}),
			alternates,
			...(conflict ? { conflict } : {}),
		},
	};
}

export function renderCourseSection(course: CourseGrounding): string {
	if (courseIsEmpty(course)) return "";
	const lines: string[] = [];
	if (course.method.preferred && !course.method.conflict) lines.push(`Preferred method: ${oneLine(course.method.preferred)}`, "");
	if (course.method.alternates.length) {
		lines.push("Alternates:", ...course.method.alternates.map((item) => `- ${oneLine(item)}`), "");
	}
	if (course.method.conflict) lines.push(`Method conflict: ${oneLine(course.method.conflict)}`, "");
	if (course.excerpts.length) {
		lines.push("Excerpts:");
		for (const excerpt of course.excerpts) {
			lines.push(`- Quote: ${oneLine(excerpt.quote)}`, `  Where: ${excerpt.provenance}`, `  Imported: ${excerpt.imported}`);
		}
	}
	return lines.join("\n").trim();
}

export function mergeCourse(existing: CourseGrounding, incoming: CourseGrounding): CourseGrounding {
	const excerpts = mergeExcerpts(existing.excerpts, incoming.excerpts);
	const method = mergeMethods(existing.method, incoming.method);
	return { excerpts, method };
}

export function mergeCourseInputs(left?: CourseInput, right?: CourseInput): CourseInput | undefined {
	if (!left && !right) return undefined;
	const excerpts = [...(left?.excerpts ?? []), ...(right?.excerpts ?? [])];
	const alternates = [...(left?.alternates ?? []), ...(right?.alternates ?? [])];
	const preferred = [left?.preferredMethod, right?.preferredMethod].filter((item): item is string => !!item?.trim());
	const conflicts = [left?.methodConflict, right?.methodConflict].filter((item): item is string => !!item?.trim());
	let methodConflict = conflicts.join(" ");
	let preferredMethod: string | undefined = preferred[0];
	if (preferred.length > 1 && !methodsAgree(preferred[0]!, preferred[1]!)) {
		methodConflict = methodConflict || conflictLine(preferred[0]!, preferred[1]!);
		preferredMethod = undefined;
		for (const item of preferred) if (!alternates.includes(item)) alternates.push(item);
	} else if (preferred.length > 1) {
		preferredMethod = preferred.sort((a, b) => b.length - a.length)[0];
	}
	return {
		...(excerpts.length ? { excerpts } : {}),
		...(preferredMethod ? { preferredMethod } : {}),
		...(alternates.length ? { alternates } : {}),
		...(methodConflict ? { methodConflict } : {}),
	};
}

/**
 * Quotes copied from the documents, plus a preferred method when the text names one.
 * A proposed quote that is not in the text is listed in `rejected` and dropped.
 */
export function groundCourse(title: string, docs: SourceDoc[], proposed: CourseInput | undefined, imported: string): { grounding: CourseGrounding; rejected: string[] } {
	const rejected: string[] = [];
	const excerpts: CourseExcerpt[] = [];
	for (const excerpt of proposed?.excerpts ?? []) {
		const doc = docForExcerpt(docs, excerpt);
		const source = excerpt.sourceText ?? doc?.text ?? "";
		const quote = source ? sourceSlice(excerpt.quote, source) : null;
		if (!quote || (!doc && !excerpt.sourceText)) {
			rejected.push(excerpt.quote);
			continue;
		}
		const provenance = provenanceLabel(excerpt, doc, quote);
		pushExcerpt(excerpts, { quote, provenance, imported });
	}
	for (const doc of docs) {
		for (const sentence of sentencesAbout(title, doc)) {
			if (excerpts.length >= MAX_EXCERPTS) break;
			pushExcerpt(excerpts, { quote: sentence, provenance: provenanceForQuote(doc, sentence), imported });
		}
	}
	const detected = methodsFromDocs(title, docs, excerpts);
	const proposedMethod = proposed?.preferredMethod?.trim();
	const corpus = [...docs.map((doc) => doc.text), ...excerpts.map((excerpt) => excerpt.quote)].join("\n");
	const proposedLine = storableMethod(proposedMethod);
	let preferred = proposedLine && methodIsGrounded(proposedLine, corpus) ? proposedLine : undefined;
	const alternates = [
		...(proposed?.alternates ?? []).map((item) => storableMethod(item)).filter((item): item is string => !!item && methodIsGrounded(item, corpus)),
		...detected.alternates,
	];
	let conflict = proposed?.methodConflict?.trim() || detected.conflict;
	if (preferred && detected.preferred && !methodsAgree(preferred, detected.preferred)) {
		conflict = conflict || conflictLine(preferred, detected.preferred);
		if (!alternates.includes(preferred)) alternates.push(preferred);
		if (!alternates.includes(detected.preferred)) alternates.push(detected.preferred);
		preferred = undefined;
	} else if (!preferred && detected.preferred) preferred = detected.preferred;
	const method = mergeMethods(
		{ preferred, alternates: [], ...(conflict ? { conflict } : {}) },
		{ alternates },
	);
	return { grounding: { excerpts: excerpts.slice(0, MAX_EXCERPTS), method }, rejected };
}

/** What get_concepts, get_goal, teach, and quiz hand to the tutor. */
export function courseTeachingText(course: CourseGrounding): string {
	if (courseIsEmpty(course)) return "";
	const lines = ["From your course:"];
	if (course.method.conflict) {
		lines.push(`Method conflict: ${course.method.conflict}`);
		lines.push("Name both methods. Do not treat either as the only correct one.");
	} else if (course.method.preferred) {
		lines.push(`Preferred method: ${course.method.preferred}`);
		lines.push("Teach this method, its notation, and its step order. The worked example and the quiz use it. Another valid method is still correct: accept it, then one sentence toward this method where the difference matters.");
	}
	for (const alternate of course.method.alternates) lines.push(`Alternate: ${alternate}`);
	for (const excerpt of course.excerpts) lines.push(`Quote: "${excerpt.quote}" (${excerpt.provenance}, imported ${excerpt.imported})`);
	return lines.join("\n");
}

export function courseForTutor(course: CourseGrounding): {
	preferredMethod: string | null;
	alternates: string[];
	conflict: string | null;
	excerpts: CourseExcerpt[];
	teach: string;
} {
	return {
		preferredMethod: course.method.conflict ? null : course.method.preferred ?? null,
		alternates: course.method.alternates,
		conflict: course.method.conflict ?? null,
		excerpts: course.excerpts,
		teach: courseTeachingText(course),
	};
}

/** A quiz the tutor writes has to use the preferred method. A conflict does not force one. */
export function quizMethodGap(text: string, course: CourseGrounding): string | null {
	const method = course.method.preferred;
	if (!method || course.method.conflict) return null;
	if (followsPreferredMethod(text, method)) return null;
	const alternate = course.method.alternates[0];
	return [
		`Write the quiz with the professor's preferred method: ${method}`,
		alternate ? `An alternate (${alternate}) can be named as an alternate. It is not the method the question uses.` : "",
		"Use that method's notation and step order in the question, the worked solution, and the explanation.",
	]
		.filter(Boolean)
		.join(" ");
}

export function gradeNudge(course: CourseGrounding): string {
	if (course.method.conflict) return `Method conflict: ${course.method.conflict} Accept either method.`;
	if (!course.method.preferred) return "";
	return `Preferred method: ${course.method.preferred} Another valid method is still correct. If they used one, add one sentence toward the preferred method where the difference matters.`;
}

export function followsPreferredMethod(text: string, method: string): boolean {
	const blob = whitespaceNormalize(text).toLowerCase();
	const caps = method.match(/\b[A-Z]{3,}\b/g) ?? [];
	if (caps.length) return caps.some((token) => blob.includes(token.toLowerCase()));
	const quoted = [...method.matchAll(/"([^"]{6,})"/g)].map((match) => whitespaceNormalize(match[1] ?? "").toLowerCase());
	if (quoted.length) return quoted.some((quote) => quote && blob.includes(quote));
	const words = significantWords(method);
	if (!words.length) return true;
	const hits = words.filter((word) => blob.includes(word.toLowerCase()));
	return hits.length >= Math.min(2, words.length);
}

/** A grounding that has already been checked, ready to store. */
export function verifiedCourseInput(course: CourseGrounding): CourseInput {
	return {
		verified: true,
		excerpts: course.excerpts.map((excerpt) => ({ quote: excerpt.quote, provenance: excerpt.provenance })),
		...(course.method.preferred ? { preferredMethod: course.method.preferred } : {}),
		...(course.method.alternates.length ? { alternates: [...course.method.alternates] } : {}),
		...(course.method.conflict ? { methodConflict: course.method.conflict } : {}),
	};
}

export function inputFromGrounding(course: CourseGrounding, docs: SourceDoc[]): CourseInput {
	return {
		excerpts: course.excerpts.map((excerpt) => {
			const doc = docs.find((item) => excerpt.provenance.startsWith((item.name || item.path).split("/").pop() ?? "\0"));
			return {
				quote: excerpt.quote,
				provenance: excerpt.provenance,
				path: doc?.path,
				sourceText: doc?.text,
			};
		}),
		...(course.method.preferred ? { preferredMethod: course.method.preferred } : {}),
		...(course.method.alternates.length ? { alternates: course.method.alternates } : {}),
		...(course.method.conflict ? { methodConflict: course.method.conflict } : {}),
	};
}

function mergeExcerpts(existing: CourseExcerpt[], incoming: CourseExcerpt[]): CourseExcerpt[] {
	const out: CourseExcerpt[] = [];
	for (const excerpt of [...existing, ...incoming]) {
		const key = whitespaceNormalize(excerpt.quote).toLowerCase();
		if (!key || out.some((item) => whitespaceNormalize(item.quote).toLowerCase() === key)) continue;
		out.push(excerpt);
	}
	if (out.length <= MAX_EXCERPTS) return out;
	const picked: CourseExcerpt[] = [];
	const seen = new Set<string>();
	for (const excerpt of out) {
		if (seen.has(excerpt.provenance)) continue;
		seen.add(excerpt.provenance);
		picked.push(excerpt);
		if (picked.length === MAX_EXCERPTS) return picked;
	}
	for (const excerpt of out) {
		if (picked.includes(excerpt)) continue;
		picked.push(excerpt);
		if (picked.length === MAX_EXCERPTS) break;
	}
	return picked;
}

function mergeMethods(left: CourseMethod, right: CourseMethod): CourseMethod {
	const preferred = [left.preferred, right.preferred].filter((item): item is string => !!item?.trim()).map(oneLine);
	const unique: string[] = [];
	for (const item of preferred) {
		if (!unique.some((have) => methodsAgree(have, item))) unique.push(item);
		else {
			const index = unique.findIndex((have) => methodsAgree(have, item));
			if (index >= 0 && item.length > unique[index]!.length) unique[index] = item;
		}
	}
	const alternates = dedupeLines([...(left.alternates ?? []), ...(right.alternates ?? [])]);
	const conflicts = [left.conflict, right.conflict].filter((item): item is string => !!item?.trim());
	if (unique.length > 1 || conflicts.length) {
		const statements = unique.length ? unique : preferred;
		for (const item of statements) if (!alternates.includes(item)) alternates.push(item);
		return {
			alternates,
			conflict: conflicts[0] || (statements.length >= 2 ? conflictLine(statements[0]!, statements[1]!) : conflicts[0]),
		};
	}
	const chosen = unique[0];
	return {
		...(chosen ? { preferred: chosen } : {}),
		alternates: alternates.filter((item) => !chosen || !methodsAgree(item, chosen)),
	};
}

function methodsAgree(a: string, b: string): boolean {
	const left = whitespaceNormalize(a).toLowerCase();
	const right = whitespaceNormalize(b).toLowerCase();
	if (!left || !right) return false;
	if (left === right || left.includes(right) || right.includes(left)) return true;
	const caps = (text: string) => new Set((text.match(/\b[A-Z]{3,}\b/g) ?? []).map((token) => token.toLowerCase()));
	const leftCaps = caps(a);
	for (const token of caps(b)) if (leftCaps.has(token)) return true;
	const A = new Set(significantWords(a));
	const B = new Set(significantWords(b));
	if (!A.size || !B.size) return false;
	let overlap = 0;
	for (const word of A) if (B.has(word)) overlap++;
	return overlap / Math.max(A.size, B.size) >= 0.6;
}

function conflictLine(a: string, b: string): string {
	return `Sources disagree on the method. One says: ${oneLine(a)} The other says: ${oneLine(b)}`;
}

const PREFERRED_RE = /\b(preferred method|we always use|always choose|choose u by|use the [a-z0-9 -]{2,40} method|do not use the)\b/i;
const ALTERNATE_RE = /\b(alternate method|another method|alternatively|you can also use)\b/i;

function methodsFromDocs(title: string, docs: SourceDoc[], _excerpts: CourseExcerpt[]): { preferred?: string; alternates: string[]; conflict?: string } {
	const preferred: string[] = [];
	const alternates: string[] = [];
	for (const doc of docs) {
		const scanned = scanCourse(title, doc);
		preferred.push(...scanned.preferred);
		alternates.push(...scanned.alternates);
	}
	const uniquePreferred = dedupeLines(preferred);
	if (uniquePreferred.length > 1 && !methodsAgree(uniquePreferred[0]!, uniquePreferred[1]!)) {
		return {
			alternates: dedupeLines([...alternates, ...uniquePreferred]),
			conflict: conflictLine(uniquePreferred[0]!, uniquePreferred[1]!),
		};
	}
	return { preferred: uniquePreferred[0], alternates: dedupeLines(alternates) };
}

function methodIsGrounded(method: string, corpus: string): boolean {
	return followsPreferredMethod(corpus, method) || significantWords(method).some((word) => corpus.toLowerCase().includes(word.toLowerCase()));
}

function sentencesAbout(title: string, doc: SourceDoc): string[] {
	return scanCourse(title, doc).excerpts.slice(0, 2);
}

/**
 * Sentences about this concept. A slide or section title counts for the lines under it,
 * so "We always choose u by LIATE." is kept when the slide is titled with the concept.
 */
function scanCourse(title: string, doc: SourceDoc): { excerpts: string[]; preferred: string[]; alternates: string[] } {
	const excerpts: string[] = [];
	const preferred: string[] = [];
	const alternates: string[] = [];
	let headingMatches = false;
	let pendingTitle = false;
	for (const raw of doc.text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (/^--- (?:page|slide) \d+ ---$/.test(line)) {
			pendingTitle = true;
			headingMatches = false;
			continue;
		}
		if (/^#{1,3}\s+/.test(line)) {
			pendingTitle = false;
			headingMatches = sentenceAboutTitle(title, line.replace(/^#+\s*/, ""));
			continue;
		}
		if (pendingTitle && line.length <= 80 && !/[.!?]$/.test(line)) {
			pendingTitle = false;
			headingMatches = sentenceAboutTitle(title, line);
			continue;
		}
		pendingTitle = false;
		for (const sentence of sentencesIn(line)) {
			if (sentence.length > MAX_QUOTE_CHARS || /\[\[|resources\//i.test(sentence)) continue;
			if (!sentenceAboutTitle(title, sentence) && !headingMatches) continue;
			const slice = sourceSlice(sentence, doc.text);
			if (!slice) continue;
			const kind = PREFERRED_RE.test(slice) ? "preferred" : ALTERNATE_RE.test(slice) ? "alternate" : "";
			if (kind === "preferred") preferred.push(oneLine(slice));
			else if (kind === "alternate") alternates.push(oneLine(slice));
			if ((kind && slice.length >= 20) || slice.length >= 40) excerpts.push(slice);
		}
	}
	return { excerpts, preferred, alternates };
}

function storableMethod(text: string | undefined): string | undefined {
	if (!text?.trim()) return undefined;
	const line = oneLine(text);
	if (!line || /\[\[|\]\]|resources\//i.test(line)) return undefined;
	return line;
}

function sentencesIn(text: string): string[] {
	const stripped = text.replace(/^--- (?:page|slide) \d+ ---$/gm, " ");
	return stripped
		.split(/\n+|(?<=[.!?])\s+/)
		.map((sentence) => sentence.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim())
		.filter((sentence) => /[A-Za-z]{3}/.test(sentence));
}

function sentenceAboutTitle(title: string, sentence: string): boolean {
	const words = significantWords(title);
	if (!words.length) return false;
	const blob = sentence.toLowerCase();
	return words.some((word) => blob.includes(word.toLowerCase()));
}

function significantWords(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 4 && !STOP.has(word));
}

function docForExcerpt(docs: SourceDoc[], excerpt: CourseExcerptInput): SourceDoc | undefined {
	const path = excerpt.path?.trim();
	if (!path) return docs.find((doc) => excerpt.sourceText && doc.text === excerpt.sourceText) ?? docs[0];
	const name = path.split("/").pop()?.toLowerCase();
	return docs.find((doc) => doc.path === path || doc.name.toLowerCase() === name || doc.path.toLowerCase().endsWith(`/${name}`));
}

function provenanceLabel(excerpt: CourseExcerptInput, doc: SourceDoc | undefined, quote: string): string {
	if (excerpt.provenance?.trim()) return sanitizeProvenance(excerpt.provenance);
	if (doc) return provenanceForQuote(doc, quote);
	const name = excerpt.path?.split("/").pop();
	return sanitizeProvenance(name || "course file");
}

function pushExcerpt(out: CourseExcerpt[], excerpt: CourseExcerpt): void {
	const key = whitespaceNormalize(excerpt.quote).toLowerCase();
	if (!key || out.some((item) => whitespaceNormalize(item.quote).toLowerCase() === key)) return;
	out.push(excerpt);
}

function indexOfQuote(text: string, quote: string): number {
	const exact = text.indexOf(quote);
	if (exact >= 0) return exact;
	const parts = quote.trim().split(/\s+/).map(escapeRegExp);
	const match = new RegExp(parts.join("\\s+")).exec(text);
	return match?.index ?? -1;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function dedupeLines(items: string[]): string[] {
	const out: string[] = [];
	for (const item of items) {
		const line = oneLine(item);
		if (!line || out.some((have) => have.toLowerCase() === line.toLowerCase())) continue;
		out.push(line);
	}
	return out;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
