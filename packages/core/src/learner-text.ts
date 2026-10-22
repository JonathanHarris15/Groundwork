import { TOOLS } from "./tools";

/** Shown when a reply is only an internal fixture id. */
export const LOST_REPLY = "I lost that reply. Ask me to continue.";

const CANARY = /\btest_tutor_prevention_\d+\b/g;
const ONLY_FIXTURE = /^\s*test_[a-z0-9_]{3,}\s*$/i;
const FIXTURE_PREFIX = "test_";

/** Gate summaries and other lines that are for the model, not the learner. */
const STATUS_PHRASES = ["Waiting until they ask to study", "Not quizzing now", "No tool returned an error.", "No tool returned an error"];

const GATE_SUMMARIES = new Set(["Waiting until they ask to study", "Not quizzing now", "Wrapping up", "Research limit reached", "Stopped a repeat fetch"]);

const EXTRA_TOOL_NAMES = ["web_search", "web_fetch", "WebSearch", "WebFetch", "Read"];

/** True when this buffer could still grow into nothing but an internal test id. */
export function holdsFixturePrefix(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	if (trimmed.length > 80) return false;
	return ONLY_FIXTURE.test(trimmed) || /^test_[a-z0-9_]*$/i.test(trimmed) || FIXTURE_PREFIX.startsWith(trimmed.toLowerCase());
}

/** A final reply that is blank, or only an internal test id. The turn should continue. */
export function isGarbageReply(text: string): boolean {
	return !text.trim() || ONLY_FIXTURE.test(text);
}

/**
 * Learner-visible text. A reply that is only an internal test id is replaced.
 * The same id inside a real sentence is removed. Ordinary prose that merely
 * says "test" is left as written.
 */
export function scrubLearnerText(text: string): string {
	let next = text;
	if (ONLY_FIXTURE.test(next)) next = LOST_REPLY;
	else if (CANARY.test(next)) {
		CANARY.lastIndex = 0;
		next =
			next
				.replace(CANARY, "")
				.replace(/[ \t]{2,}/g, " ")
				.replace(/\n{3,}/g, "\n\n")
				.trim() || LOST_REPLY;
	}
	CANARY.lastIndex = 0;
	if (next === LOST_REPLY) return next;
	return sanitizeTutorOutput(next);
}

/**
 * A tool failure the learner should hear, without the tool's name.
 * A study gate, a step limit, or "No tool returned an error." is not one of these.
 */
export function learnerToolError(line: string): string | null {
	const flat = line.replace(/\s+/g, " ").trim();
	if (!flat) return null;
	const payloads = splitToolPayloads(flat);
	if (payloads) {
		const kept = payloads.filter((payload) => !isInternalPayload(payload));
		return kept.length ? kept.join(" ") : null;
	}
	if (isInternalPayload(flat)) return null;
	const cleaned = sanitizeTutorOutput(flat).trim();
	return cleaned || null;
}

/** True when this tool result is a gate or a step limit, not a failure to show. */
export function isInternalToolReport(summary: string | undefined, text: string): boolean {
	const flatSummary = (summary ?? "").replace(/\s+/g, " ").trim();
	if (flatSummary && (GATE_SUMMARIES.has(flatSummary) || flatSummary.startsWith("Stopped fetching "))) return true;
	const flat = text.replace(/\s+/g, " ").trim();
	return !!flat && isInternalPayload(flat);
}

/**
 * Drop internal tool status from learner-visible text.
 * A line that is only `quiz: Waiting until they ask to study` (one tool, or several
 * joined by spaces) goes away. A real tool failure keeps its sentence and loses the
 * `set_goal:` prefix. Ordinary prose is left as written.
 */
export function sanitizeTutorOutput(text: string): string {
	if (!text) return text;
	const kept = text.split("\n").flatMap((line) => {
		const next = sanitizeLine(line);
		return next === null ? [] : [next];
	});
	return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Streaming backstop. Complete lines are cleaned immediately. A tail that could
 * still grow into a gate phrase or a `tool: phrase` line is held until it
 * diverges or the reply ends.
 */
export class TutorTextFilter {
	private held = "";

	push(chunk: string): string {
		if (!chunk) return "";
		this.held += chunk;
		let emit = "";
		while (true) {
			const nl = this.held.indexOf("\n");
			if (nl < 0) break;
			const line = this.held.slice(0, nl + 1);
			this.held = this.held.slice(nl + 1);
			emit += sanitizeTutorOutput(line);
		}
		const keep = leakPrefixLength(this.held);
		const ready = this.held.slice(0, this.held.length - keep);
		this.held = this.held.slice(this.held.length - keep);
		emit += sanitizeTutorOutput(ready);
		return emit;
	}

	flush(): string {
		const held = this.held;
		this.held = "";
		const cut = leakPrefixLength(held);
		const suffix = held.slice(held.length - cut);
		if (cut > 0 && discardOpenLeak(suffix)) return sanitizeTutorOutput(held.slice(0, held.length - cut));
		return sanitizeTutorOutput(held);
	}
}

function sanitizeLine(line: string): string | null {
	if (!line.trim()) return line;
	const payloads = splitToolPayloads(line.trim());
	if (payloads) {
		const kept = payloads.filter((payload) => !isInternalPayload(payload));
		if (!kept.length) return null;
		return kept.join(" ");
	}
	let next = line;
	const names = toolAlt();
	const phrases = STATUS_PHRASES.map(escapeRegExp).sort((a, b) => b.length - a.length).join("|");
	next = next.replace(new RegExp(`(?:(?:${names}):\\s*)+(?:${phrases})`, "g"), "");
	next = next.replace(new RegExp(phrases, "g"), "");
	next = next.replace(/Not yet\. [A-Za-z0-9_]+ did not run because this message did not ask to study\.(?:[\s\S]*?Then wait\.)?/g, "");
	next = next.replace(/Not now\. [A-Za-z0-9_]+ did not run because they asked not to quiz on this turn\.(?:[\s\S]*?reply Start\.)?/g, "");
	next = next.replace(/Tools are closed for this reply\. Tell the learner where this stands, in text\. Do not ask another question\./g, "");
	next = next.replace(/The research limit for this reply is used up \(\d+ page reads\)\. Answer the learner with what you have\. Do not fetch or search\./g, "");
	next = next.replace(/You already fetched this page in this turn\. (?:Here it is again\. Do not fetch it again\.|Stop fetching it and answer with what you have\.)/g, "");
	next = next.replace(/You have read \S+ several times this turn\. Stop fetching that site and answer with what you have\./g, "");
	next = next.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/g, "");
	return next.trim() ? next : null;
}

function isInternalPayload(payload: string): boolean {
	const text = payload.trim();
	if (!text) return true;
	if (GATE_SUMMARIES.has(text) || text.startsWith("Stopped fetching ")) return true;
	if (STATUS_PHRASES.some((phrase) => text === phrase || text.startsWith(phrase))) return true;
	if (/^Not yet\./.test(text) || /^Not now\./.test(text)) return true;
	if (text.startsWith("Tools are closed for this reply.")) return true;
	if (text.startsWith("The research limit for this reply")) return true;
	if (text.startsWith("You already fetched this page")) return true;
	if (text.startsWith("You have read ") && text.includes("Stop fetching")) return true;
	return false;
}

function splitToolPayloads(line: string): string[] | null {
	const re = new RegExp(`(?:^|\\s)(?:${toolAlt()}):\\s*`, "g");
	const marks: Array<{ index: number; end: number }> = [];
	for (const match of line.matchAll(re)) {
		if (match.index === undefined) continue;
		marks.push({ index: match.index, end: match.index + match[0].length });
	}
	if (!marks.length || line.slice(0, marks[0].index).trim()) return null;
	const payloads: string[] = [];
	for (let i = 0; i < marks.length; i++) {
		const start = marks[i].end;
		const end = i + 1 < marks.length ? marks[i + 1].index : line.length;
		payloads.push(line.slice(start, end).trim());
	}
	return payloads;
}

/**
 * How much of an unfinished line to keep back. A suffix is held only when it
 * still fits a gate phrase or a `tool: gate` line. A finished gate is not held:
 * sanitizing the ready text removes it. Ordinary words are not held, including
 * a token such as "A limit" that merely shares letters with a tool name.
 */
function leakPrefixLength(text: string): number {
	if (!text) return 0;
	const scanFrom = Math.max(0, text.length - 180);
	const scan = text.slice(scanFrom);
	let hold = 0;
	for (let i = 0; i < scan.length; i++) {
		if (i > 0 && !/\s/.test(scan[i - 1] ?? "")) continue;
		const suffix = scan.slice(i);
		if (!leakOpen(suffix)) continue;
		let from = scanFrom + i;
		while (from > 0 && /[ \t]/.test(text[from - 1] ?? "")) from -= 1;
		hold = text.length - from;
	}
	return hold;
}

/** An unfinished gate. A line sanitize would already delete is finished, so it is not held. */
function leakOpen(suffix: string): boolean {
	const trimmed = suffix.trimStart();
	if (!trimmed) return false;
	if (sanitizeLine(trimmed) === null) return false;
	return leakCandidate(trimmed);
}

/** Drop a held tail only when it is clearly a gate, not a short word that shares a prefix. */
function discardOpenLeak(suffix: string): boolean {
	const trimmed = suffix.trim();
	if (!trimmed) return false;
	if (trimmed.includes(":")) return true;
	if (/^(?:Not yet|Not now|Waiting|No tool|Wrapping|Research limit|Stopped fetching|Tools are closed|The research limit|You already fetched|You have read )/.test(trimmed)) return true;
	return trimmed.length >= 12 && (statusPrefix(trimmed) || gateSentenceOpen(trimmed));
}

function leakCandidate(text: string): boolean {
	if (statusPrefix(text) || gateSentenceOpen(text)) return true;
	return toolStatusOpen(text);
}

function statusPrefix(text: string): boolean {
	return [...STATUS_PHRASES, ...GATE_SUMMARIES].some((phrase) => phrase.startsWith(text));
}

function gateSentenceOpen(text: string): boolean {
	if ("Not yet.".startsWith(text) || "Not now.".startsWith(text)) return true;
	const yet = /^Not yet\. ([A-Za-z0-9_]*)([\s\S]*)$/.exec(text);
	if (yet) return (yet[2] ?? "") === "" || " did not run because this message did not ask to study.".startsWith(yet[2] ?? "");
	const now = /^Not now\. ([A-Za-z0-9_]*)([\s\S]*)$/.exec(text);
	if (now) return (now[2] ?? "") === "" || " did not run because they asked not to quiz on this turn.".startsWith(now[2] ?? "");
	const prefixes = ["Tools are closed for this reply.", "The research limit for this reply", "You already fetched this page", "Stopped fetching "];
	if (prefixes.some((phrase) => phrase.startsWith(text))) return true;
	if (/^Tools are closed for this reply\. Tell the learner where this stands, in text\b/.test(text)) return true;
	if (/^The research limit for this reply is used up\b/.test(text)) return true;
	if (/^You already fetched this page in this turn\b/.test(text)) return true;
	if (/^Stopped fetching \S+$/.test(text)) return true;
	if (/^You have read \S*$/.test(text)) return true;
	if (/^You have read \S+ several times this turn\b/.test(text)) return true;
	return false;
}

function toolStatusOpen(text: string): boolean {
	const names = toolNames();
	if (names.some((name) => name.startsWith(text))) return true;
	const parts = splitToolPayloads(text);
	if (!parts) return false;
	const earlier = parts.slice(0, -1);
	if (earlier.some((part) => !isInternalPayload(part))) return false;
	const last = parts[parts.length - 1] ?? "";
	if (!last) return true;
	if (isInternalPayload(last)) {
		const tail = /([A-Za-z0-9_]+)$/.exec(text.trimEnd())?.[1] ?? "";
		return names.some((name) => name.startsWith(tail) && name !== tail);
	}
	return statusPrefix(last) || gateSentenceOpen(last);
}

let cachedToolNames: string[] | null = null;

function toolNames(): string[] {
	if (!cachedToolNames) {
		cachedToolNames = [...new Set([...TOOLS.map((tool) => tool.name), ...EXTRA_TOOL_NAMES])].sort((a, b) => b.length - a.length);
	}
	return cachedToolNames;
}

function toolAlt(): string {
	return toolNames().map(escapeRegExp).join("|");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
