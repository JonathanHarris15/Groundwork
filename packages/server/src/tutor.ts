import {
	AnthropicEventParser,
	asRecord,
	buildUpstream,
	FLASHCARDS_REQUIRE_UPGRADE,
	FLASHCARDS_UPGRADE_ERROR,
	HEAVY_REQUIRES_UPGRADE,
	HEAVY_UPGRADE_ERROR,
	hostedCostUsd,
	isHostedFlashcardGeneration,
	parseTutorCall,
	presentAccount,
	providerKind,
	readUpstream,
	tutorDecision,
	tutorStatus,
	upstreamErrorMessage,
	sanitizeTutorOutput,
	tutorEventLine,
	TutorTextFilter,
	usageFeatureFromClient,
	type AccountView,
	type ContentBlock,
	type TutorCall,
	type TutorChoice,
	type TutorStatus,
	type UpstreamResult,
	type UsageFeature,
	type UserKeyProvider,
} from "@groundwork/core";
import type { FetchLike } from "./platform-fetch";

export interface TutorCallContext {
	view: AccountView;
	choice: TutorChoice;
	saved: Partial<Record<UserKeyProvider, boolean>>;
	userKey(provider: UserKeyProvider): Promise<string | undefined> | string | undefined;
	openRouterKey: string | undefined;
	fetchImpl: FetchLike;
	charge(costUsd: number): Promise<{ view: AccountView; chargedUsd: number }>;
	/** Counts and costs for this call. Omit to skip the usage log. */
	record?(entry: { feature: UsageFeature; model: "light" | "heavy" | "unknown"; costUsd: number; chargedUsd: number; inputTokens: number; outputTokens: number }): Promise<void>;
}

export function describeTutor(ctx: Pick<TutorCallContext, "view" | "choice" | "saved">): TutorStatus {
	return tutorStatus(tutorDecision(ctx.view, ctx.choice, ctx.saved), ctx.view, ctx.choice);
}

export interface TutorHttpResult {
	status: number;
	json: unknown;
	headers?: Record<string, string>;
	/** Set when the reply is server-sent events. The HTTP status is already 200. */
	sse?: (write: (chunk: string) => void, signal: AbortSignal) => Promise<void>;
}

export async function completeTutor(ctx: TutorCallContext, body: unknown): Promise<{ status: number; json: unknown }> {
	const ready = await gateTutor(ctx, body);
	if (!ready.ok) return ready;
	const upstream = buildUpstream(ready.decision, ready.apiKey, ready.call);
	let response: Response;
	try {
		response = await ctx.fetchImpl(upstream.url, {
			method: "POST",
			headers: upstream.headers,
			body: JSON.stringify(upstream.body),
		});
	} catch {
		return { status: 502, json: { error: "The model provider could not be reached." } };
	}
	const text = await response.text();
	let parsed: unknown = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = { error: text };
		}
	}
	if (!response.ok) {
		return { status: 502, json: { error: upstreamErrorMessage(parsed, [ready.apiKey]) } };
	}
	const read = readUpstream(upstream.kind, parsed);
	if (!read.ok) return { status: 502, json: { error: upstreamErrorMessage({ error: read.error }, [ready.apiKey]) } };
	return settleTutor(ctx, body, ready, read.result);
}

/** Anthropic-shaped providers (OpenRouter hosted, Anthropic, OpenRouter keys) stream tokens. Other providers stay one JSON body. */
export async function openTutorStream(ctx: TutorCallContext, body: unknown): Promise<TutorHttpResult> {
	const ready = await gateTutor(ctx, body);
	if (!ready.ok) return ready;
	const kind = providerKind(ready.decision.action === "hosted" ? "openrouter" : ready.decision.provider);
	if (kind !== "anthropic") return completeTutor(ctx, body);

	const upstream = buildUpstream(ready.decision, ready.apiKey, ready.call, true);
	const upstreamAbort = new AbortController();
	let response: Response;
	try {
		response = await ctx.fetchImpl(upstream.url, {
			method: "POST",
			headers: upstream.headers,
			body: JSON.stringify(upstream.body),
			signal: upstreamAbort.signal,
		});
	} catch {
		return { status: 502, json: { error: "The model provider could not be reached." } };
	}
	const type = response.headers.get("content-type") ?? "";
	if (!response.ok || !type.includes("text/event-stream")) {
		const text = await response.text();
		let parsed: unknown = null;
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = { error: text };
			}
		}
		if (!response.ok) return { status: 502, json: { error: upstreamErrorMessage(parsed, [ready.apiKey]) } };
		const read = readUpstream("anthropic", parsed);
		if (!read.ok) return { status: 502, json: { error: upstreamErrorMessage({ error: read.error }, [ready.apiKey]) } };
		return settleTutor(ctx, body, ready, read.result);
	}
	return {
		status: 200,
		json: { streaming: true },
		sse: (write, signal) => pipeAnthropic(ctx, body, ready, response, write, signal, upstreamAbort),
	};
}

type ReadyTutor = {
	ok: true;
	decision: Extract<ReturnType<typeof tutorDecision>, { action: "hosted" | "key" }>;
	call: TutorCall;
	apiKey: string;
};

async function gateTutor(ctx: TutorCallContext, body: unknown): Promise<{ ok: false; status: number; json: unknown } | ReadyTutor> {
	const decision = tutorDecision(ctx.view, ctx.choice, ctx.saved);
	if (decision.action === "blocked") return { ok: false, status: decision.status, json: { error: decision.error } };
	if (decision.action === "claude") {
		return {
			ok: false,
			status: 409,
			json: { error: "This account uses the Claude subscription on this computer. Send the lesson from Obsidian after Check connection." },
		};
	}
	const call = parseTutorCall(body);
	if (!call) return { ok: false, status: 400, json: { error: "Send the tutor turn: a system prompt, messages, and tools." } };
	const upgrade = freeHostedUpgrade(ctx.view, decision, call);
	if (upgrade) return { ok: false, ...upgrade };

	if (process.env.GROUNDWORK_TUTOR_STUB === "1") {
		const status = describeTutor(ctx);
		const shown = presentAccount(ctx.view);
		return {
			ok: false,
			status: 200,
			json: {
				content: [{ type: "text", text: "Stub tutor reply for E2E. **Bold**, `inline code`, and $E=mc^2$ render in the pane." }],
				stopReason: "end_turn",
				usage: { input: 16, output: 32 },
				budgetUsed: shown.budgetUsed,
				route: { action: status.action, model: status.model ?? "stub", provider: status.provider, label: status.label },
			},
		};
	}

	const rawKey = decision.key === "groundwork" ? ctx.openRouterKey : await ctx.userKey(decision.provider);
	const apiKey = rawKey?.trim();
	if (!apiKey) {
		if (decision.key === "groundwork") return { ok: false, status: 503, json: { error: "OPENROUTER_API_KEY is not set on the Groundwork server." } };
		return { ok: false, status: 409, json: { error: "Paste a provider key on the website, or switch the tutor to your Claude subscription." } };
	}
	return { ok: true, decision, call, apiKey };
}

async function settleTutor(ctx: TutorCallContext, body: unknown, ready: ReadyTutor, result: UpstreamResult): Promise<{ status: number; json: unknown }> {
	let view = ctx.view;
	let chargedUsd = 0;
	let costUsd = 0;
	const model = ready.decision.action === "hosted" ? ready.decision.weight : "unknown";
	if (ready.decision.action === "hosted") {
		costUsd = hostedCostUsd(result.usage, ready.decision.weight);
		const billed = await ctx.charge(costUsd);
		view = billed.view;
		chargedUsd = billed.chargedUsd;
	}
	if (ctx.record) {
		try {
			await ctx.record({
				feature: usageFeatureFromClient(featureOf(body)),
				model,
				costUsd,
				chargedUsd,
				inputTokens: result.usage.input,
				outputTokens: result.usage.output,
			});
		} catch (err) {
			console.error("Could not record tutor usage.", err);
		}
	}
	const shown = presentAccount(view);
	return {
		status: 200,
		json: {
			content: sanitizeTutorContent(result.content),
			stopReason: result.stopReason,
			usage: result.usage,
			budgetUsed: shown.budgetUsed,
			route: {
				action: ready.decision.action,
				model: upstreamModel(ready.decision, ready.call.model),
				provider: ready.decision.provider,
				label: tutorStatus(ready.decision, view, ctx.choice).label,
			},
		},
	};
}

async function pipeAnthropic(
	ctx: TutorCallContext,
	body: unknown,
	ready: ReadyTutor,
	response: Response,
	write: (chunk: string) => void,
	signal: AbortSignal,
	upstreamAbort: AbortController,
): Promise<void> {
	const onAbort = () => upstreamAbort.abort();
	if (signal.aborted) upstreamAbort.abort();
	else signal.addEventListener("abort", onAbort, { once: true });
	const parser = new AnthropicEventParser();
	const spoken = new TutorTextFilter();
	let result: UpstreamResult | null = null;
	let failed: string | null = null;
	const writeText = (text: string) => {
		const clean = spoken.push(text);
		if (clean && !signal.aborted) write(tutorEventLine({ type: "text", text: clean }));
	};
	const flushText = () => {
		const clean = spoken.flush();
		if (clean && !signal.aborted) write(tutorEventLine({ type: "text", text: clean }));
	};
	const take = (chunk: string) => {
		for (const event of parser.push(chunk)) {
			if (event.type === "text" && event.text) writeText(event.text);
			else if (event.type === "error") failed = event.message;
			else if (event.type === "done") result = event.result;
		}
	};
	try {
		const reader = response.body?.getReader();
		if (!reader) take(await response.text());
		else {
			const decoder = new TextDecoder();
			while (!signal.aborted) {
				const next = await reader.read();
				if (next.value) take(decoder.decode(next.value, { stream: !next.done }));
				if (next.done) break;
			}
			take(decoder.decode());
		}
	} catch (err) {
		if (!signal.aborted) failed = err instanceof Error ? err.message : "The model provider stopped the stream.";
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
	if (!result) {
		for (const event of parser.finish()) {
			if (event.type === "text" && event.text) writeText(event.text);
			else if (event.type === "done") result = event.result;
			else if (event.type === "error") failed = event.message;
		}
	}
	flushText();
	if (!result) {
		if (!signal.aborted) write(tutorEventLine({ type: "error", error: upstreamErrorMessage({ error: failed || "The model provider returned nothing." }, [ready.apiKey]), status: 502 }));
		return;
	}
	const settled = await settleTutor(ctx, body, ready, result);
	if (signal.aborted) return;
	const json = settled.json as { content: ContentBlock[]; stopReason: string; usage: UpstreamResult["usage"] };
	write(tutorEventLine({ type: "done", content: json.content, stopReason: json.stopReason, usage: json.usage }));
}

function freeHostedUpgrade(
	view: AccountView,
	decision: ReturnType<typeof tutorDecision>,
	call: TutorCall,
): { status: number; json: { error: string; code: string } } | null {
	if (view.plan !== "free" || decision.action !== "hosted") return null;
	if (isHostedFlashcardGeneration(call.messages)) {
		return { status: 402, json: { error: FLASHCARDS_UPGRADE_ERROR, code: FLASHCARDS_REQUIRE_UPGRADE } };
	}
	if (decision.weight === "heavy") {
		return { status: 402, json: { error: HEAVY_UPGRADE_ERROR, code: HEAVY_REQUIRES_UPGRADE } };
	}
	return null;
}

function sanitizeTutorContent(content: ContentBlock[]): ContentBlock[] {
	return content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		const text = sanitizeTutorOutput(block.text);
		return text === block.text ? block : { ...block, text };
	});
}

function featureOf(body: unknown): unknown {
	return asRecord(body)?.feature;
}

function upstreamModel(decision: Extract<ReturnType<typeof tutorDecision>, { action: "hosted" | "key" }>, requested: string | undefined): string {
	return decision.action === "hosted" ? decision.model : requested || decision.model;
}
