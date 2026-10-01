import { isPlanId, PLANS, type AccountView, type FreeResponseJudgment, type FreeResponseToGrade } from "@groundwork/core";
import type { AccountDirectory } from "./accounts";
import type { Auth } from "./auth";
import { SecretDirectory, SecretError } from "./secrets";

export interface ServerDeps {
	auth: Auth;
	accounts: AccountDirectory;
	secrets: SecretDirectory;
	jev: boolean;
	grade(items: FreeResponseToGrade[], signal?: AbortSignal): Promise<Array<FreeResponseJudgment | null>>;
}

export interface RouteResult {
	status: number;
	json: unknown;
}

export async function route(method: string, path: string, body: unknown, deps: ServerDeps, authorization?: string): Promise<RouteResult> {
	try {
		if (method === "GET" && path === "/health") {
			return { status: 200, json: { ok: true, jev: deps.jev, firebase: deps.auth.firebase } };
		}
		if (method === "GET" && path === "/v1/plans") {
			return { status: 200, json: { plans: Object.values(PLANS) } };
		}
		if (hasClientKey(body)) {
			return { status: 400, json: { error: "Model keys are not accepted on this request. Jev is configured on the server." } };
		}

		const uid = await deps.auth.uid(authorization);

		if (method === "GET" && path === "/v1/account") {
			return { status: 200, json: deps.accounts.get(uid) };
		}
		if (method === "POST" && path === "/v1/account/plan") {
			const plan = (body as { plan?: unknown } | null)?.plan;
			if (!isPlanId(plan)) return { status: 400, json: { error: "Choose free, byom, or included." } };
			return { status: 200, json: deps.accounts.setPlan(uid, plan) satisfies AccountView };
		}
		if (method === "GET" && path === "/v1/secrets") {
			return { status: 200, json: { providers: deps.secrets.saved(uid) } };
		}
		if (method === "POST" && path === "/v1/secrets") {
			const input = body as { provider?: unknown; apiKey?: unknown } | null;
			const saved = deps.secrets.save(uid, String(input?.provider ?? ""), String(input?.apiKey ?? ""));
			return { status: 200, json: { saved, providers: deps.secrets.saved(uid) } };
		}
		if (method === "POST" && path === "/v1/grade") {
			if (!deps.jev) return { status: 503, json: { error: "TYPESAFE_API_KEY is not set on the Groundwork server." } };
			const items = (body as { items?: unknown } | null)?.items;
			if (!Array.isArray(items) || !items.length) return { status: 400, json: { error: "Send the written answers to grade." } };
			if (items.length > 40) return { status: 400, json: { error: "Grade at most 40 answers at once." } };
			const parsed = items.map(parseItem);
			if (parsed.some((item) => !item)) return { status: 400, json: { error: "Each answer needs a question, a reference, and the text they wrote." } };
			const judgments = await deps.grade(parsed as FreeResponseToGrade[]);
			return { status: 200, json: { judgments } };
		}
		return { status: 404, json: { error: "Not found." } };
	} catch (err) {
		if (err instanceof SecretError) return { status: 400, json: { error: err.message } };
		const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
		const message = err instanceof Error ? err.message : "Request failed.";
		return { status, json: { error: message } };
	}
}

function hasClientKey(body: unknown): boolean {
	if (!body || typeof body !== "object") return false;
	const record = body as Record<string, unknown>;
	if ("typesafeApiKey" in record || "TYPESAFE_API_KEY" in record) return true;
	return "apiKey" in record && !("provider" in record);
}

function parseItem(value: unknown): FreeResponseToGrade | null {
	if (!value || typeof value !== "object") return null;
	const item = value as FreeResponseToGrade;
	if (typeof item.question !== "string" || typeof item.reference !== "string" || typeof item.answer !== "string") return null;
	if (!item.question.trim() || !item.reference.trim()) return null;
	return {
		question: item.question,
		reference: item.reference,
		answer: item.answer,
		rubric: typeof item.rubric === "string" ? item.rubric : undefined,
		note: typeof item.note === "string" ? item.note : undefined,
		hintTranscript: typeof item.hintTranscript === "string" ? item.hintTranscript : undefined,
	};
}
