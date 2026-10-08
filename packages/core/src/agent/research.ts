import type { ChatMessage, ContentBlock } from "./types";

/** Web fetches and web searches. Vault search is not research. */
export const WEB_RESEARCH_TOOLS = new Set(["fetch_public", "web_fetch", "web_search", "WebFetch", "WebSearch"]);

/** Network reads of the web allowed in one tutor turn. */
export const RESEARCH_BUDGET = 6;

/** Distinct fetches of one host before the next one is refused. */
export const HOST_FETCH_LIMIT = 3;

/** Steps held back so the last ones are an answer, with no tools. */
export const ANSWER_RESERVE = 3;

const ALREADY = "You already fetched this page in this turn. Here it is again. Do not fetch it again.";
const STOP_URL = "You already fetched this page in this turn. Stop fetching it and answer with what you have.";

export function forcingAnswer(step: number, maxSteps: number): boolean {
	const reserve = Math.min(ANSWER_RESERVE, Math.max(1, maxSteps - 1));
	return maxSteps - step <= reserve;
}

export function researchClosedNote(): string {
	return `The research limit for this reply is used up (${RESEARCH_BUDGET} page reads). Answer the learner with what you have. Do not fetch or search.`;
}

export function stepsClosedNote(): string {
	return "You are nearly out of steps. Stop calling tools. If you were quizzing, do not ask another question. Tell the learner where this stands and what comes next.";
}

/**
 * Same page, whatever fragment, slash, or host casing the model used.
 * Returns null when the string is not an http(s) URL.
 */
export function normalizeFetchUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	url.hash = "";
	url.hostname = url.hostname.replace(/\.$/, "").toLowerCase();
	if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
	if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
	const params = [...url.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
	url.search = "";
	for (const [key, value] of params) url.searchParams.append(key, value);
	return url.toString();
}

export interface ResearchGate {
	text: string;
	isError: boolean;
	summary: string;
}

/**
 * One tutor turn's memory of what was fetched. Cache hits do not touch the
 * network and do not spend the budget. A host that keeps coming up is stopped.
 */
export class ResearchTurn {
	private readonly cache = new Map<string, string>();
	private readonly hosts = new Map<string, number>();
	private readonly repeats = new Map<string, number>();
	private spent = 0;

	constructor(private readonly budget = RESEARCH_BUDGET) {}

	get used(): number {
		return this.spent;
	}

	get exhausted(): boolean {
		return this.spent >= this.budget;
	}

	/** Null means run the tool. Otherwise the loop should return this instead. */
	intercept(name: string, input: unknown): ResearchGate | null {
		if (!WEB_RESEARCH_TOOLS.has(name)) return null;
		if (this.exhausted) {
			return { text: researchClosedNote(), isError: true, summary: "Research limit reached" };
		}
		const key = this.keyFor(input);
		if (!key) return null;
		const cached = this.cache.get(key);
		if (cached !== undefined) {
			const times = (this.repeats.get(key) ?? 1) + 1;
			this.repeats.set(key, times);
			if (times >= 3) return { text: `${STOP_URL}`, isError: true, summary: "Stopped a repeat fetch" };
			return { text: `${ALREADY}\n\n${cached}`, isError: false, summary: `Already read ${hostOf(key)}` };
		}
		const host = hostOf(key);
		if ((this.hosts.get(host) ?? 0) >= HOST_FETCH_LIMIT) {
			return {
				text: `You have read ${host} several times this turn. Stop fetching that site and answer with what you have.`,
				isError: true,
				summary: `Stopped fetching ${host}`,
			};
		}
		return null;
	}

	/** Call after a research tool actually ran, including a failed attempt. */
	record(name: string, input: unknown, text: string, ok: boolean): void {
		if (!WEB_RESEARCH_TOOLS.has(name)) return;
		this.spent += 1;
		const key = this.keyFor(input);
		if (!key) return;
		const host = hostOf(key);
		this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1);
		if (!ok) return;
		this.cache.set(key, text);
		this.repeats.set(key, 1);
	}

	/** A line to append when this host is being read again and again. */
	warning(name: string, input: unknown): string | null {
		if (!WEB_RESEARCH_TOOLS.has(name)) return null;
		const key = this.keyFor(input);
		if (!key) return null;
		const seen = this.hosts.get(hostOf(key)) ?? 0;
		if (seen < HOST_FETCH_LIMIT) return null;
		return `You have read ${hostOf(key)} ${seen} times this turn. Do not fetch it again unless a different page is essential. Then answer.`;
	}

	private keyFor(input: unknown): string | null {
		const url = urlFromInput(input);
		return url ? normalizeFetchUrl(url) : null;
	}
}

function urlFromInput(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	const url = record.url ?? record.uri ?? record.href;
	return typeof url === "string" && url.trim() ? url : null;
}

function hostOf(key: string): string {
	try {
		return new URL(key).host;
	} catch {
		return key;
	}
}

export function unfinishedTurn(messages: ChatMessage[], from: number): { answer: string; note: string } {
	const prose = proseFrom(messages, from);
	const found = findingsFrom(messages, from);
	if (prose.length >= 80) return { answer: "", note: "I had to stop before this was finished." };
	if (!found.total && prose) return { answer: "", note: "I had to stop before this was finished." };
	if (!found.total) return { answer: "I had to stop before this was finished. I don't have an answer yet.", note: "I can finish this from here." };
	const earlier = found.total > found.latest.length ? `${found.total - found.latest.length} earlier results are already in the thread. ` : "";
	return {
		answer: `I had to stop before this was finished. ${earlier}Here's where I got to.\n\n${found.latest.join("\n\n")}`,
		note: "I can finish this from here.",
	};
}

function proseFrom(messages: ChatMessage[], from: number): string {
	const parts: string[] = [];
	for (const message of messages.slice(from)) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const text = textOf(block);
			if (text.trim()) parts.push(text.trim());
		}
	}
	return parts.join("\n\n");
}

function findingsFrom(messages: ChatMessage[], from: number): { latest: string[]; total: number } {
	const lines: string[] = [];
	for (const message of messages.slice(from)) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const text = toolResultText(block)?.replace(/\s+/g, " ").trim() ?? "";
			if (!text || text.startsWith("You already fetched") || text.startsWith("You have read")) continue;
			lines.push(text.slice(0, 400));
		}
	}
	return { latest: lines.slice(-4), total: lines.length };
}

function toolResultText(block: ContentBlock): string | null {
	if (block.type !== "tool_result") return null;
	const row = block as { is_error?: boolean; content?: unknown };
	if (row.is_error) return null;
	if (typeof row.content === "string") return row.content;
	if (!Array.isArray(row.content)) return "";
	return row.content.map((part) => textOf(part as ContentBlock)).join("\n");
}

function textOf(block: ContentBlock): string {
	if (block.type !== "text") return "";
	const value = (block as { text?: unknown }).text;
	return typeof value === "string" ? value : "";
}
