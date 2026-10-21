import {
	buildUpstream,
	buildingProgress,
	bulkEventLine,
	BulkImportError,
	BULK_RETRIES,
	extractBulkFiles,
	HEAVY_REQUIRES_UPGRADE,
	HEAVY_UPGRADE_ERROR,
	heuristicBulkModel,
	hostedCostUsd,
	mergeBulkConcepts,
	parseBulkRequest,
	presentAccount,
	readingLabel,
	readUpstream,
	runBulkImport,
	tutorDecision,
	upstreamErrorMessage,
	type BulkImportResult,
	type BulkModel,
	type TutorCall,
} from "@groundwork/core";
import { bulkJobProgress, type BulkJobRecord, type BulkJobStore } from "./bulk-job";
import type { TutorCallContext, TutorHttpResult } from "./tutor";

/**
 * Parallel sub-agents for one goal.
 * Each model call is charged on its own. Hosted Light and Heavy draw the
 * allowance. A saved key is sent to that provider and is not metered here.
 * The Claude subscription has no server key, so this route refuses it.
 */
export async function importBulkGoal(ctx: TutorCallContext, body: unknown, jobs: BulkJobStore, uid: string): Promise<TutorHttpResult> {
	if (isRecord(body) && body.step === true) return stepBulkJob(ctx, body, jobs, uid);
	if (isRecord(body) && body.job === true) return createBulkJob(ctx, body, jobs, uid);
	const parsed = parseBulkRequest(body);
	if ("error" in parsed) return { status: 400, json: { error: parsed.error } };
	const ready = await readyModel(ctx);
	if ("error" in ready) return ready.error;
	const modelFor = ready.model;

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

/**
 * The plugin posts the documents once, then asks for one shard at a time.
 * Each step is one model call, short enough for the website proxy.
 * The job stays in Firestore, so a dropped request does not drop the work.
 */
async function createBulkJob(ctx: TutorCallContext, body: unknown, jobs: BulkJobStore, uid: string): Promise<TutorHttpResult> {
	const parsed = parseBulkRequest(body);
	if ("error" in parsed) return { status: 400, json: { error: parsed.error } };
	const ready = await readyModel(ctx);
	if ("error" in ready) return ready.error;
	const job = await jobs.create({ uid, userText: parsed.userText, title: parsed.title, files: parsed.files });
	return { status: 200, json: { jobId: job.id, status: "open", event: bulkJobProgress(job) } };
}

async function stepBulkJob(ctx: TutorCallContext, body: Record<string, unknown>, jobs: BulkJobStore, uid: string): Promise<TutorHttpResult> {
	const jobId = typeof body.jobId === "string" ? body.jobId : "";
	if (!/^[a-f0-9]{32}$/.test(jobId)) return { status: 400, json: { error: "Send the bulk import id." } };
	const ready = await readyModel(ctx);
	if ("error" in ready) return ready.error;
	const claimed = await jobs.claim(jobId, uid, Date.now());
	if (!claimed) return { status: 404, json: { error: "No bulk import with that id." } };
	const { job, claim } = claimed;
	if (claim.kind === "wait") return { status: 200, json: { status: "wait", event: bulkJobProgress(job) } };
	if (claim.kind === "error") return { status: 200, json: { status: "error", error: claim.error } };
	if (claim.kind === "done") {
		if (!job.result) return { status: 200, json: { status: "error", error: "The bulk import did not return a goal." } };
		return doneJson(job.result, ctx, job);
	}
	const model = ready.model();
	if (claim.kind === "shard") return runShard(jobs, jobId, job, claim.index, claim.claimId, model);
	return runMerge(jobs, jobId, job, claim.claimId, model, ctx);
}

async function runShard(jobs: BulkJobStore, jobId: string, job: BulkJobRecord, index: number, claimId: number, model: BulkModel): Promise<TutorHttpResult> {
	const shard = job.shards[index];
	if (!shard) return { status: 200, json: { status: "error", error: "The bulk import did not finish." } };
	try {
		const files = await jobs.files(jobId, shard.fileIndexes);
		const extracted = await extractBulkFiles({ files, userText: job.userText, model, concurrency: 1, retries: BULK_RETRIES });
		const updated = await jobs.finishShard(jobId, index, claimId, extracted.concepts, extracted.usage);
		return { status: 200, json: { status: "open", event: bulkJobProgress(updated ?? job) } };
	} catch (err) {
		const message = err instanceof Error ? err.message : "The bulk import did not finish.";
		await jobs.failShard(jobId, index, claimId, message);
		return { status: 200, json: { status: "error", error: message } };
	}
}

async function runMerge(jobs: BulkJobStore, jobId: string, job: BulkJobRecord, claimId: number, model: BulkModel, ctx: TutorCallContext): Promise<TutorHttpResult> {
	try {
		const usage = { input: 0, output: 0 };
		for (const shard of job.shards) {
			usage.input += shard.usage.input;
			usage.output += shard.usage.output;
		}
		let done = 0;
		const progress = job.shards.map((shard) => {
			done += shard.fileIndexes.length;
			return readingLabel(done, job.paths.length);
		});
		progress.push(buildingProgress(job.paths.length).label);
		const result = await mergeBulkConcepts({
			concepts: job.shards.flatMap((shard) => shard.concepts),
			documents: job.paths,
			userText: job.userText,
			title: job.title,
			model,
			usage,
			shards: job.shards.length,
			progress,
			started: job.startedAt || Date.now(),
		});
		const updated = await jobs.finishMerge(jobId, claimId, result);
		return doneJson(updated?.result ?? result, ctx, updated ?? job);
	} catch (err) {
		const message = err instanceof Error ? err.message : "The bulk import did not finish.";
		await jobs.failMerge(jobId, claimId, message);
		return { status: 200, json: { status: "error", error: message } };
	}
}

function doneJson(result: BulkImportResult, ctx: TutorCallContext, job: BulkJobRecord): TutorHttpResult {
	return { status: 200, json: { ...publicResult(result, ctx), status: "done", event: buildingProgress(job.paths.length) } };
}

type ReadyModel = { model: (signal?: AbortSignal) => BulkModel } | { error: TutorHttpResult };

async function readyModel(ctx: TutorCallContext): Promise<ReadyModel> {
	const decision = tutorDecision(ctx.view, ctx.choice, ctx.saved);
	if (decision.action === "blocked") return { error: { status: decision.status, json: { error: decision.error } } };
	if (decision.action === "claude") {
		return {
			error: {
				status: 409,
				json: { error: "This account uses the Claude subscription on this computer. Bulk import runs through Groundwork's model or a saved key." },
			},
		};
	}
	if (ctx.view.plan === "free" && decision.action === "hosted" && decision.weight === "heavy") {
		return { error: { status: 402, json: { error: HEAVY_UPGRADE_ERROR, code: HEAVY_REQUIRES_UPGRADE } } };
	}
	const stub = process.env.GROUNDWORK_TUTOR_STUB === "1";
	let apiKey = "";
	if (!stub) {
		const rawKey = decision.key === "groundwork" ? ctx.openRouterKey : await ctx.userKey(decision.provider);
		apiKey = rawKey?.trim() ?? "";
		if (!apiKey) {
			if (decision.key === "groundwork") return { error: { status: 503, json: { error: "OPENROUTER_API_KEY is not set on the Groundwork server." } } };
			return { error: { status: 409, json: { error: "Paste a provider key on the website, or switch the tutor to your Claude subscription." } } };
		}
	}
	const settled = decision;
	return { model: (signal?: AbortSignal) => (stub ? heuristicBulkModel() : chargingModel(ctx, settled, apiKey, signal)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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
				maxTokens: 8192,
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
