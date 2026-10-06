import { isPlanId, isTutorWeight, isUserKeyProvider, PLANS, presentAccount, presentGroundwork, PROVIDER_LABEL, publicPlan, type FreeResponseJudgment, type FreeResponseToGrade, type PlanId } from "@groundwork/core";
import type { AccountDirectory } from "./accounts";
import type { Auth } from "./auth";
import type { Billing } from "./billing";
import { MemoryConflict, type MemoryDirectory } from "./memory";
import { SecretDirectory, SecretError } from "./secrets";
import { completeTutor, describeTutor } from "./tutor";
import { obsidianOpen } from "./obsidian-open";
import { attributionFromHeader } from "./tracking";
import { allowCheckoutAmount } from "./public-limit";
import { webConfig } from "./web-config";

export interface ServerDeps {
	auth: Auth;
	accounts: AccountDirectory;
	secrets: SecretDirectory;
	billing: Billing;
	jev: boolean;
	memory: MemoryDirectory;
	grade(items: FreeResponseToGrade[], signal?: AbortSignal): Promise<Array<FreeResponseJudgment | null>>;
	/** Shared key for Free and Groundwork. Absent until the server is configured. */
	openRouterKey?: string;
	fetchImpl?: typeof fetch;
}

export interface RouteResult {
	status: number;
	json: unknown;
}

export interface RouteMeta {
	origin?: string;
	rawBody?: string;
	stripeSignature?: string;
	/** URI-encoded JSON of utm_* and gclid, sent by the site after a landing. */
	attribution?: string;
	sessionId?: string;
	/** Client address for the public checkout-amount limit. */
	ip?: string;
}

export async function route(method: string, path: string, body: unknown, deps: ServerDeps, authorization?: string, meta: RouteMeta = {}): Promise<RouteResult> {
	try {
		const opened = obsidianOpen(method, path);
		if (opened) return opened;
		if (method === "GET" && path === "/health") {
			return { status: 200, json: { ok: true, jev: deps.jev, firebase: deps.auth.firebase, billing: deps.billing.configured } };
		}
		if (method === "GET" && path === "/v1/plans") {
			return { status: 200, json: { plans: Object.values(PLANS).map(publicPlan) } };
		}
		if (method === "GET" && path === "/v1/web-config") {
			return { status: 200, json: webConfig(deps.billing.configured, deps.auth.firebase) };
		}
		if (method === "POST" && path === "/v1/stripe/webhook") {
			await deps.billing.applyEvent(meta.rawBody ?? "", meta.stripeSignature);
			return { status: 200, json: { received: true } };
		}
		if (method === "GET" && path === "/v1/billing/checkout-amount") {
			if (meta.ip && !allowCheckoutAmount(meta.ip)) return { status: 429, json: { error: "Too many requests." } };
			const amountUsd = await deps.billing.checkoutAmount?.(meta.sessionId ?? "");
			if (amountUsd == null) return { status: 404, json: { error: "Unknown checkout." } };
			return { status: 200, json: { amountUsd, currency: "USD" } };
		}
		if (hasClientKey(body)) {
			return { status: 400, json: { error: "Do not send API keys on this request. Paste keys under Your model on the account page." } };
		}

		const identity = await deps.auth.uid(authorization);
		const uid = identity.uid;
		if (path !== "/v1/groundwork" && path !== "/v1/memory" && path !== "/v1/grade") {
			try {
				await deps.billing.sync?.(uid, identity.email);
			} catch (err) {
				console.error("Groundwork could not read the Stripe subscription.", err);
			}
		}
		const openedAccount = await deps.accounts.seen(uid, { email: identity.email, name: identity.name }, attributionFromHeader(meta.attribution));
		const view = openedAccount.view;

		if (method === "POST" && path === "/v1/auth/sign-out") {
			await deps.auth.revokeRefreshTokens(uid, authorization);
			return { status: 200, json: { ok: true } };
		}

		if (method === "GET" && path === "/v1/account") {
			return { status: 200, json: { ...presentAccount(view), created: openedAccount.created } };
		}
		if (method === "POST" && path === "/v1/account/obsidian-connected") {
			return { status: 200, json: await deps.accounts.connectObsidian(uid) };
		}
		if (method === "POST" && path === "/v1/account/profile") {
			const displayName = (body as { displayName?: unknown } | null)?.displayName;
			if (typeof displayName !== "string" || !displayName.trim()) return { status: 400, json: { error: "Send a display name." } };
			return { status: 200, json: presentAccount(await deps.accounts.rename(uid, displayName)) };
		}
		if (method === "POST" && path === "/v1/account/plan") {
			const plan = (body as { plan?: unknown } | null)?.plan;
			if (!isPlanId(plan)) return { status: 400, json: { error: "Choose free, byom, or included." } };
			if (plan !== "free") return paidPlanRefused(deps);
			const current = await deps.accounts.get(uid);
			if (deps.billing.configured && (current.plan === "byom" || current.plan === "included")) {
				return { status: 409, json: { error: "A Stripe subscription is active on this account. Change or cancel it from billing." } };
			}
			return { status: 200, json: presentAccount(await deps.accounts.setPlan(uid, plan)) };
		}
		if (method === "POST" && path === "/v1/billing/checkout") {
			const plan = (body as { plan?: unknown } | null)?.plan;
			if (plan !== "byom" && plan !== "included") return { status: 400, json: { error: "Choose a paid plan." } };
			const url = await deps.billing.checkout(uid, identity.email ?? view.email ?? undefined, plan, meta.origin || "http://127.0.0.1:8787");
			return { status: 200, json: { url } };
		}
		if (method === "POST" && path === "/v1/billing/portal") {
			const url = await deps.billing.portal(uid, meta.origin || "http://127.0.0.1:8787");
			return { status: 200, json: { url } };
		}
		if (method === "GET" && path === "/v1/tutor") {
			return { status: 200, json: describeTutor({ view, choice: await deps.accounts.choice(uid), saved: await deps.secrets.saved(uid) }) };
		}
		if (method === "POST" && path === "/v1/tutor/setup") {
			const input = body as { via?: unknown; provider?: unknown } | null;
			const via = input?.via;
			if (via !== "claude" && via !== "key") return { status: 400, json: { error: "Choose Claude or a saved key." } };
			if (!view.ownModel) return { status: 400, json: { error: "This plan uses Groundwork's model. Bring your own model is the plan for a Claude subscription or a key you paste." } };
			if (via === "key") {
				if (!isUserKeyProvider(input?.provider)) return { status: 400, json: { error: "Choose a provider." } };
				if (!(await deps.secrets.saved(uid))[input.provider]) return { status: 400, json: { error: `Paste a ${PROVIDER_LABEL[input.provider]} key first.` } };
				const next = await deps.accounts.setTutor(uid, { via, provider: input.provider });
				return { status: 200, json: describeTutor({ view: next, choice: await deps.accounts.choice(uid), saved: await deps.secrets.saved(uid) }) };
			}
			const next = await deps.accounts.setTutor(uid, { via: "claude" });
			return { status: 200, json: describeTutor({ view: next, choice: await deps.accounts.choice(uid), saved: await deps.secrets.saved(uid) }) };
		}
		if (method === "POST" && path === "/v1/tutor/weight") {
			if (view.ownModel) return { status: 400, json: { error: "This plan uses your own model." } };
			const weight = (body as { weight?: unknown } | null)?.weight;
			if (!isTutorWeight(weight)) return { status: 400, json: { error: "Choose Light or Heavy." } };
			const next = await deps.accounts.setTutorWeight(uid, weight);
			return { status: 200, json: describeTutor({ view: next, choice: await deps.accounts.choice(uid), saved: await deps.secrets.saved(uid) }) };
		}
		if (method === "POST" && path === "/v1/tutor/complete") {
			return completeTutor(
				{
					view,
					choice: await deps.accounts.choice(uid),
					saved: await deps.secrets.saved(uid),
					userKey: (provider) => deps.secrets.get(uid, provider),
					openRouterKey: deps.openRouterKey,
					fetchImpl: deps.fetchImpl ?? fetch,
					charge: (cost) => deps.accounts.charge(uid, cost),
				},
				body,
			);
		}
		if (method === "GET" && path === "/v1/secrets") {
			return { status: 200, json: { providers: await deps.secrets.saved(uid) } };
		}
		if (method === "POST" && path === "/v1/secrets") {
			const input = body as { provider?: unknown; apiKey?: unknown } | null;
			const saved = await deps.secrets.save(uid, String(input?.provider ?? ""), String(input?.apiKey ?? ""));
			return { status: 200, json: { saved, providers: await deps.secrets.saved(uid) } };
		}
		if (method === "GET" && path === "/v1/groundwork") {
			return { status: 200, json: presentGroundwork(await deps.memory.knowledge(uid)) };
		}
		if (path === "/v1/memory" && (method === "GET" || method === "PUT")) {
			if (method === "GET") return { status: 200, json: await deps.memory.get(uid) };
			try {
				return { status: 200, json: await deps.memory.put(uid, body) };
			} catch (err) {
				if (err instanceof MemoryConflict) {
					return { status: 409, json: { error: "The account was updated on another device.", memory: err.memory } };
				}
				return { status: 400, json: { error: err instanceof Error ? err.message : "Could not store tutor memory." } };
			}
		}
		if (method === "POST" && path === "/v1/grade") {
			if (!deps.jev) return { status: 503, json: { error: "Written-answer grading is not set up on this server yet." } };
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
		if (isPermissionDenied(err)) {
			console.error("Groundwork could not use the account database.", err);
			return { status: 503, json: { error: "Your account could not be opened. Try signing in again." } };
		}
		const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
		const message = err instanceof Error ? err.message : "Request failed.";
		return { status, json: { error: message } };
	}
}

function isPermissionDenied(err: unknown): boolean {
	const code = (err as { code?: unknown }).code;
	if (code === 7 || code === "7" || code === "PERMISSION_DENIED") return true;
	const message = err instanceof Error ? err.message : "";
	return message.includes("PERMISSION_DENIED");
}

function paidPlanRefused(deps: ServerDeps): RouteResult {
	if (!deps.billing.configured) {
		return { status: 503, json: { error: "Stripe isn't connected yet, so a paid plan can't be started." } };
	}
	return { status: 402, json: { error: "Paid plans start in Stripe checkout." } };
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

export type { PlanId };
