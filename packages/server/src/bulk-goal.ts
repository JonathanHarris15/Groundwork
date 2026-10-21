import {
	buildUpstream,
	bulkEventLine,
	BulkImportError,
	extractBulkFiles,
	HEAVY_REQUIRES_UPGRADE,
	HEAVY_UPGRADE_ERROR,
	heuristicBulkModel,
	hostedCostUsd,
	mergeBulkConcepts,
	parseBulkRequest,
	presentAccount,
	readUpstream,
	runBulkImport,
	tutorDecision,
	upstreamErrorMessage,
	type BulkImportResult,
	type BulkModel,
	type TutorCall,
} from "@groundwork/core";
import type { TutorCallContext, TutorHttpResult } from "./tutor";

/**
 * Parallel sub-agents for one goal.
 * Each model call is charged on its own. Hosted Light and Heavy draw the
 * allowance. A saved key is sent to that provider and is not metered here.
 * The Claude subscription has no server key, so this route refuses it.
 */
export async function importBulkGoal(ctx: TutorCallContext, body: unknown): Promise<TutorHttpResult> {
	const parsed = parseBulkRequest(body);
	if ("error" in parsed) return { status: 400, json: { error: parsed.error } };
	const decision = tutorDecision(ctx.view, ctx.choice, ctx.saved);
	if (decision.action === "blocked") return { status: decision.status, json: { error: decision.error } };
	if (decision.action === "claude") {
		return {
			status: 409,
			json: { error: "This account uses the Claude subscription on this computer. Bulk import runs through Groundwork's model or a saved key." },
		};
	}
	if (ctx.view.plan === "free" && decision.action === "hosted" && decision.weight === "heavy") {
		return { status: 402, json: { error: HEAVY_UPGRADE_ERROR, code: HEAVY_REQUIRES_UPGRADE } };
	}

	const stub = process.env.GROUNDWORK_TUTOR_STUB === "1";
	let apiKey = "";
	if (!stub) {
		const rawKey = decision.key === "groundwork" ? ctx.openRouterKey : await ctx.userKey(decision.provider);
		apiKey = rawKey?.trim() ?? "";
		if (!apiKey) {
			if (decision.key === "groundwork") return { status: 503, json: { error: "OPENROUTER_API_KEY is not set on the Groundwork server." } };
			return { status: 409, json: { error: "Paste a provider key on the website, or switch the tutor to your Claude subscription." } };
		}
	}

	const ready = decision;
	const modelFor = (signal?: AbortSignal) => (stub ? heuristicBulkModel() : chargingModel(ctx, ready, apiKey, signal));

	if (parsed.stream && parsed.phase === "import") {
		return {
			status: 200,
			json: { streaming: true },
			sse: async (write, signal) => {
				try {
					const result = await runBulkImport({
						files: parsed.files,
						userText: parsed.userText,
						title: parsed.title,
						model: modelFor(signal),
						signal,
						onProgress: (event) => write(bulkEventLine({ type: "progress", ...event })),
					});
					if (signal.aborted) return;
					write(bulkEventLine({ type: "done", ...publicResult(result, ctx) }));
				} catch (err) {
					if (signal.aborted) return;
					const status = err instanceof BulkImportError ? err.status : 502;
					const error = err instanceof Error ? err.message : "The bulk import did not finish.";
					write(bulkEventLine({ type: "error", error, status }));
				}
			},
		};
	}

	try {
		if (parsed.phase === "extract") {
			const extracted = await extractBulkFiles({ files: parsed.files, userText: parsed.userText, model: modelFor() });
			return { status: 200, json: { concepts: extracted.concepts } };
		}
		if (parsed.phase === "merge") {
			const result = await mergeBulkConcepts({
				concepts: parsed.concepts,
				documents: parsed.documents,
				userText: parsed.userText,
				title: parsed.title,
				model: modelFor(),
			});
			return { status: 200, json: publicResult(result, ctx) };
		}
		const result = await runBulkImport({ files: parsed.files, userText: parsed.userText, title: parsed.title, model: modelFor() });
		return { status: 200, json: publicResult(result, ctx) };
	} catch (err) {
		const status = err instanceof BulkImportError ? err.status : 502;
		const error = err instanceof Error ? err.message : "The bulk import did not finish.";
		return { status, json: { error } };
	}
}

function publicResult(result: BulkImportResult, ctx: TutorCallContext): BulkImportResult {
	const shown = presentAccount(ctx.view);
	return {
		goal: result.goal,
		concepts: result.concepts,
		edges: result.edges,
		shards: result.shards,
		documents: result.documents,
		usage: result.usage,
		elapsedMs: result.elapsedMs,
		progress: result.progress,
		notes: result.notes,
		budgetUsed: result.budgetUsed ?? shown.budgetUsed,
	};
}

/**
 * The view on `ctx` is the account before this import. Charges update the
 * stored account; the response budget is read from the last charge when the
 * caller replaces `ctx.view`. We keep the latest view on the context object
 * the route already holds, which `charge` returns.
 */
function chargingModel(
	ctx: TutorCallContext,
	decision: Extract<ReturnType<typeof tutorDecision>, { action: "hosted" | "key" }>,
	apiKey: string,
	signal?: AbortSignal,
): BulkModel {
	let tail: Promise<void> = Promise.resolve();
	const lock = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
	return {
		async complete(req) {
			if (signal?.aborted) throw new BulkImportError("Cancelled.", 499);
			const call: TutorCall = {
				system: req.system,
				messages: [{ role: "user", content: req.user }],
				tools: [],
				maxTokens: 4096,
			};
			const upstream = buildUpstream(decision, apiKey, call, false);
			let response: Response;
			try {
				response = await ctx.fetchImpl(upstream.url, {
					method: "POST",
					headers: upstream.headers,
					body: JSON.stringify(upstream.body),
					signal,
				});
			} catch (err) {
				if (signal?.aborted) throw new BulkImportError("Cancelled.", 499);
				throw new BulkImportError(err instanceof Error ? err.message : "The model provider could not be reached.", 502);
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
			if (!response.ok) throw new BulkImportError(upstreamErrorMessage(parsed, [apiKey]), 502);
			const read = readUpstream(upstream.kind, parsed);
			if (!read.ok) throw new BulkImportError(upstreamErrorMessage({ error: read.error }, [apiKey]), 502);
			const usage = read.result.usage;
			const weight = decision.action === "hosted" ? decision.weight : "unknown";
			let costUsd = 0;
			let chargedUsd = 0;
			if (decision.action === "hosted") {
				costUsd = hostedCostUsd(usage, decision.weight);
				const billed = await lock(() => ctx.charge(costUsd));
				chargedUsd = billed.chargedUsd;
				ctx.view = billed.view;
			}
			if (ctx.record) {
				try {
					await lock(() =>
						ctx.record!({
							feature: "exam_prep",
							model: weight,
							costUsd,
							chargedUsd,
							inputTokens: usage.input,
							outputTokens: usage.output,
						}),
					);
				} catch (err) {
					console.error("Could not record bulk import usage.", err);
				}
			}
			const reply = read.result.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			return { text: reply, usage: { input: usage.input, output: usage.output } };
		},
	};
}
