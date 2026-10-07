/**
 * What a signed-in learner can buy.
 *
 * Hosted credit is generative-model spend (OpenRouter), in dollars, reset
 * each calendar month. Free and Groundwork share one server key. We do not
 * mint a key per learner. Bring your own model uses a key the learner pastes,
 * or the Claude subscription on their computer, which never comes to the server.
 * Jev is not part of that credit: every plan uses it, and that key stays on
 * the Groundwork server.
 *
 * Public copy never states how many dollars of that credit a plan includes
 * or how many dollars remain. The only prices we show are $6/month and
 * $20/month. `hostedCreditUsd` stays on the server; `publicPlan` is what
 * the website and any other client may receive.
 */

export type PlanId = "free" | "byom" | "included";

export interface Plan {
	id: PlanId;
	/** Shown on the plan picker. */
	name: string;
	priceUsdPerMonth: number;
	/** Generative-model allowance. Unused credit expires at the end of the month. */
	hostedCreditUsd: number;
	/** The learner supplies Claude on this computer, or a provider API key. */
	ownModel: boolean;
	summary: string;
}

export const PLANS: Record<PlanId, Plan> = {
	free: {
		id: "free",
		name: "Free",
		priceUsdPerMonth: 0,
		hostedCreditUsd: 1.25,
		ownModel: false,
		summary: "Groundwork's smaller model. Enough to actually study.",
	},
	byom: {
		id: "byom",
		name: "Bring your own model",
		priceUsdPerMonth: 6,
		hostedCreditUsd: 0,
		ownModel: true,
		summary: "Use the Claude subscription on this computer, or paste a key from OpenRouter, Anthropic, Google, xAI, or OpenAI.",
	},
	included: {
		id: "included",
		name: "Groundwork",
		priceUsdPerMonth: 20,
		hostedCreditUsd: 12,
		ownModel: false,
		summary: "We run the models. Light by default.",
	},
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export function isPlanId(value: unknown): value is PlanId {
	return typeof value === "string" && value in PLANS;
}

/**
 * Provider keys a learner may save on their profile. Jev is absent on purpose:
 * it is Groundwork's key, not something the account settings collect.
 */
export const USER_KEY_PROVIDERS = ["anthropic", "openrouter", "google", "xai", "openai"] as const;
export type UserKeyProvider = (typeof USER_KEY_PROVIDERS)[number];

export function isUserKeyProvider(value: unknown): value is UserKeyProvider {
	return typeof value === "string" && (USER_KEY_PROVIDERS as readonly string[]).includes(value);
}

/** Plan fields a client may show. The hosted allowance is not one of them. */
export interface PublicPlan {
	id: PlanId;
	name: string;
	priceUsdPerMonth: number;
	ownModel: boolean;
	summary: string;
}

export function publicPlan(plan: Plan): PublicPlan {
	return {
		id: plan.id,
		name: plan.name,
		priceUsdPerMonth: plan.priceUsdPerMonth,
		ownModel: plan.ownModel,
		summary: plan.summary,
	};
}
