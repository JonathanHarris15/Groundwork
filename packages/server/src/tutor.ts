import {
	buildUpstream,
	hostedCostUsd,
	parseTutorCall,
	presentAccount,
	readUpstream,
	tutorDecision,
	tutorStatus,
	upstreamErrorMessage,
	type AccountView,
	type TutorChoice,
	type TutorStatus,
	type UserKeyProvider,
} from "@groundwork/core";

export interface TutorCallContext {
	view: AccountView;
	choice: TutorChoice;
	saved: Partial<Record<UserKeyProvider, boolean>>;
	userKey(provider: UserKeyProvider): string | undefined;
	openRouterKey: string | undefined;
	fetchImpl: typeof fetch;
	charge(costUsd: number): AccountView;
}

export function describeTutor(ctx: Pick<TutorCallContext, "view" | "choice" | "saved">): TutorStatus {
	return tutorStatus(tutorDecision(ctx.view, ctx.choice, ctx.saved), ctx.view, ctx.choice);
}

export async function completeTutor(ctx: TutorCallContext, body: unknown): Promise<{ status: number; json: unknown }> {
	const decision = tutorDecision(ctx.view, ctx.choice, ctx.saved);
	if (decision.action === "blocked") return { status: decision.status, json: { error: decision.error } };
	if (decision.action === "claude") {
		return {
			status: 409,
			json: { error: "This account uses the Claude subscription on this computer. Send the lesson from Obsidian after Check connection." },
		};
	}
	const call = parseTutorCall(body);
	if (!call) return { status: 400, json: { error: "Send the tutor turn: a system prompt, messages, and tools." } };

	const apiKey = decision.key === "groundwork" ? ctx.openRouterKey?.trim() : ctx.userKey(decision.provider)?.trim();
	if (!apiKey) {
		if (decision.key === "groundwork") return { status: 503, json: { error: "OPENROUTER_API_KEY is not set on the Groundwork server." } };
		return { status: 409, json: { error: "Paste a provider key on the website, or switch the tutor to your Claude subscription." } };
	}

	const upstream = buildUpstream(decision, apiKey, call);
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
		return { status: 502, json: { error: upstreamErrorMessage(parsed, [apiKey]) } };
	}
	const read = readUpstream(upstream.kind, parsed);
	if (!read.ok) return { status: 502, json: { error: upstreamErrorMessage({ error: read.error }, [apiKey]) } };

	let view = ctx.view;
	if (decision.action === "hosted") view = ctx.charge(hostedCostUsd(read.result.usage));
	const shown = presentAccount(view);
	return {
		status: 200,
		json: {
			content: read.result.content,
			stopReason: read.result.stopReason,
			usage: read.result.usage,
			budgetUsed: shown.budgetUsed,
			route: { action: decision.action, model: upstreamModel(decision, call.model), provider: decision.provider, label: tutorStatus(decision, view, ctx.choice).label },
		},
	};
}

function upstreamModel(decision: Extract<ReturnType<typeof tutorDecision>, { action: "hosted" | "key" }>, requested: string | undefined): string {
	return decision.action === "hosted" ? decision.model : requested || decision.model;
}
