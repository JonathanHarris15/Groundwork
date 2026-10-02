/**
 * What a signed-in learner can buy.
 *
 * Hosted credit is generative-model spend (OpenRouter), in dollars, reset
 * each calendar month. Jev is not part of that credit: every plan uses it,
 * the key stays on the Groundwork server, and we absorb its cost because a
 * grading call is a few hundred tokens at $0.042 per million.
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
		hostedCreditUsd: 3,
		ownModel: false,
		summary: "$3 of model credit a month on our smaller model. Enough to actually study.",
	},
	byom: {
		id: "byom",
		name: "Bring your own model",
		priceUsdPerMonth: 9,
		hostedCreditUsd: 0,
		ownModel: true,
		summary: "Use the Claude subscription on this computer, or paste a key from OpenRouter, Anthropic, Google, xAI, or OpenAI.",
	},
	included: {
		id: "included",
		name: "Groundwork",
		priceUsdPerMonth: 20,
		hostedCreditUsd: 8,
		ownModel: false,
		summary: "We run the models. $8 of credit a month, smaller model by default.",
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
