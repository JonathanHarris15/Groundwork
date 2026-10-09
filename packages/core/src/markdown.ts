import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { asUnknown } from "./unknown";

export interface ParsedNote {
	frontmatter: Record<string, unknown>;
	body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseNote(text: string): ParsedNote {
	const m = FM_RE.exec(text);
	if (!m) return { frontmatter: {}, body: text };
	let frontmatter: Record<string, unknown> = {};
	try {
		const parsed = asUnknown(parseYaml(m[1]));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
	} catch {
		// A hand-edited note with broken YAML keeps its body; stats are rebuilt from evidence.
	}
	return { frontmatter, body: text.slice(m[0].length) };
}

export function serializeNote(frontmatter: Record<string, unknown>, body: string): string {
	const clean: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(frontmatter)) if (v !== undefined) clean[k] = v;
	const yaml = stringifyYaml(clean, { lineWidth: 0 }).trimEnd();
	return `---\n${yaml}\n---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

/** Characters Obsidian (or common filesystems) refuse in file names. */
export function safeFileName(title: string): string {
	return title
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
}

export function slugify(title: string): string {
	return title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function wikilink(title: string): string {
	return `[[${title}]]`;
}

/** Accepts "[[Title]]", "[[Title|alias]]", or "Title" and returns "Title". */
export function unwikilink(value: string): string {
	const m = /^\s*\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]\s*$/.exec(value);
	return (m ? m[1] : value).trim();
}

export interface MarkdownSection {
	id: string;
	title: string;
	text: string;
}

/**
 * Split on `#` and `##` headings. Fenced code and display math stay inside
 * the section they were opened in, so a heading-looking line in a sample
 * does not start a new piece.
 */
export function splitMarkdown(markdown: string): MarkdownSection[] {
	const lines = markdown.split("\n");
	const heads: number[] = [];
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (fence) {
			if (trimmed.startsWith(fence)) fence = null;
			continue;
		}
		const marker = /^(```+|~~~+|\$\$)/.exec(trimmed);
		if (marker) {
			if (!(marker[1] === "$$" && trimmed.length > 2 && trimmed.endsWith("$$"))) fence = marker[1];
			continue;
		}
		if (/^#{1,2}\s+\S/.test(lines[i])) heads.push(i);
	}
	const pieces: MarkdownSection[] = [];
	const seen = new Map<string, number>();
	const push = (title: string, text: string) => {
		const body = text.trim();
		if (!body) return;
		let id = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "section";
		const n = seen.get(id) ?? 0;
		seen.set(id, n + 1);
		if (n) id = `${id}-${n + 1}`;
		pieces.push({ id, title, text: body });
	};
	if (!heads.length) {
		push("Opening", markdown);
		return pieces;
	}
	if (heads[0] > 0) push("Opening", lines.slice(0, heads[0]).join("\n"));
	heads.forEach((start, index) => {
		const title = lines[start].replace(/^#{1,2}\s+/, "").trim();
		push(title, lines.slice(start, heads[index + 1] ?? lines.length).join("\n"));
	});
	return pieces;
}

/** Indices of lines that are `## ` headings, ignoring anything inside fenced code or $$ math blocks. */
function h2Lines(lines: string[]): Set<number> {
	const out = new Set<number>();
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (fence) {
			if (t.startsWith(fence)) fence = null;
			continue;
		}
		const m = /^(```+|~~~+|\$\$)/.exec(t);
		if (m) {
			if (!(m[1] === "$$" && t.length > 2 && t.endsWith("$$"))) fence = m[1];
			continue;
		}
		if (/^##\s/.test(lines[i])) out.add(i);
	}
	return out;
}

function findSection(lines: string[], heading: string): { start: number; end: number } | null {
	const heads = h2Lines(lines);
	const want = `## ${heading}`.toLowerCase();
	const start = [...heads].find((i) => lines[i].trim().toLowerCase() === want);
	if (start === undefined) return null;
	let end = start + 1;
	while (end < lines.length && !heads.has(end)) end++;
	return { start, end };
}

/** Returns the markdown under `## heading` (until the next `## `), or undefined. */
export function getSection(body: string, heading: string): string | undefined {
	const lines = body.split("\n");
	const s = findSection(lines, heading);
	return s ? lines.slice(s.start + 1, s.end).join("\n").trim() : undefined;
}

/**
 * Sets the content under `## heading`. A missing section is inserted before the
 * first existing section named in `before` (so generated sections stay last),
 * otherwise appended. Content must not contain its own `## ` headings; run
 * embedded markdown through `demoteHeadings` first.
 */
export function setSection(body: string, heading: string, content: string, before: string[] = []): string {
	const lines = body.split("\n");
	const block = [`## ${heading}`, "", content.trim(), ""];
	const s = findSection(lines, heading);
	if (s) {
		lines.splice(s.start, s.end - s.start, ...block);
		return lines.join("\n");
	}
	for (const b of before) {
		const at = findSection(lines, b);
		if (at) {
			lines.splice(at.start, 0, ...block);
			return lines.join("\n");
		}
	}
	return `${body.trimEnd()}\n\n${block.join("\n")}`;
}

/** Push headings down so embedded markdown (transcripts, summaries) can't break section boundaries. */
export function demoteHeadings(md: string, by = 2): string {
	const lines = md.split("\n");
	let fence: string | null = null;
	return lines
		.map((line) => {
			const t = line.trim();
			if (fence) {
				if (t.startsWith(fence)) fence = null;
				return line;
			}
			const m = /^(```+|~~~+|\$\$)/.exec(t);
			if (m) {
				if (!(m[1] === "$$" && t.length > 2 && t.endsWith("$$"))) fence = m[1];
				return line;
			}
			const h = /^(#{1,6})(\s.*)$/.exec(line);
			return h ? `${"#".repeat(Math.min(6, h[1].length + by))}${h[2]}` : line;
		})
		.join("\n");
}
