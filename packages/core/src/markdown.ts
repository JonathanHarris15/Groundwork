import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
		const parsed = parseYaml(m[1]);
		if (parsed && typeof parsed === "object") frontmatter = parsed as Record<string, unknown>;
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

/**
 * Replace (or append) a region delimited by HTML comments. Everything outside
 * the markers is left untouched, so users and the agent can freely edit the
 * rest of a note while generated sections stay current.
 */
export function upsertRegion(body: string, name: string, content: string): string {
	const start = `<!-- groundwork:${name} -->`;
	const end = `<!-- /groundwork:${name} -->`;
	const block = `${start}\n${content.trim()}\n${end}`;
	const s = body.indexOf(start);
	const e = body.indexOf(end);
	if (s !== -1 && e !== -1 && e > s) {
		return body.slice(0, s) + block + body.slice(e + end.length);
	}
	return `${body.trimEnd()}\n\n${block}\n`;
}

/** Returns the markdown under `## heading` (until the next `## `), or undefined. */
export function getSection(body: string, heading: string): string | undefined {
	const lines = body.split("\n");
	const idx = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
	if (idx === -1) return undefined;
	const out: string[] = [];
	for (let i = idx + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i]) || lines[i].startsWith("<!-- groundwork:")) break;
		out.push(lines[i]);
	}
	return out.join("\n").trim();
}

/** Sets the content under `## heading`, creating the section before any generated region if missing. */
export function setSection(body: string, heading: string, content: string): string {
	const lines = body.split("\n");
	const idx = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
	const block = [`## ${heading}`, "", content.trim(), ""];
	if (idx === -1) {
		const regionIdx = lines.findIndex((l) => l.startsWith("<!-- groundwork:"));
		if (regionIdx === -1) return `${body.trimEnd()}\n\n${block.join("\n")}`;
		lines.splice(regionIdx, 0, ...block);
		return lines.join("\n");
	}
	let end = idx + 1;
	while (end < lines.length && !/^##\s/.test(lines[end]) && !lines[end].startsWith("<!-- groundwork:")) end++;
	lines.splice(idx, end - idx, ...block);
	return lines.join("\n");
}
