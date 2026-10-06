import { isUserKeyProvider, PLANS, type PlanId, type UserKeyProvider } from "./plans";

/** Calendar month the credit window belongs to, UTC. */
export function periodKey(now: Date = new Date()): string {
	return now.toISOString().slice(0, 7);
}

export interface AccountRecord {
	uid: string;
	plan: PlanId | null;
	/** `YYYY-MM` of `spentUsd`. A new month starts spent back at 0. */
	period: string;
	spentUsd: number;
	/** Chosen on the account site. Falls back to the Google account name when empty. */
	displayName?: string;
	email?: string;
	stripeCustomerId?: string;
	/** Bring-your-own-model only. Hosted plans ignore this and call Groundwork's model. */
	tutorVia?: "claude" | "key";
	tutorProvider?: UserKeyProvider;
	/** Hosted plans. Absent means Light. */
	tutorWeight?: TutorWeight;
	/** First-touch ad click, stored once when the account is created or first seen with it. */
	attribution?: StoredAttribution;
	/** Set the first time Obsidian links this account. Absent until then. */
	obsidianConnectedAt?: string;
}

/** Campaign fields captured on the site and kept on the account. Not shown to the client. */
export interface StoredAttribution {
	utmSource?: string;
	utmMedium?: string;
	utmCampaign?: string;
	utmTerm?: string;
	utmContent?: string;
	gclid?: string;
}

/** Hosted tutor size. Light is the default. Bring-your-own-model accounts ignore this. */
export type TutorWeight = "light" | "heavy";

export function isTutorWeight(value: unknown): value is TutorWeight {
	return value === "light" || value === "heavy";
}

/** How a bring-your-own-model account wants the tutor to run. Claude is the default. */
export interface TutorChoice {
	via: "claude" | "key";
	provider: UserKeyProvider | null;
}

export interface AccountView {
	plan: PlanId | null;
	needsPlan: boolean;
	name: string;
	priceUsdPerMonth: number;
	creditUsd: number;
	spentUsd: number;
	remainingUsd: number;
	ownModel: boolean;
	displayName: string | null;
	email: string | null;
	/** A Stripe customer exists, so billing can be managed in the portal. */
	hasBilling: boolean;
	tutorVia: "claude" | "key";
	tutorProvider: UserKeyProvider | null;
	tutorWeight: TutorWeight;
}

/** Account fields a client may show. Dollar credit balances are not among them. */
export interface PublicAccount {
	plan: PlanId | null;
	needsPlan: boolean;
	name: string;
	priceUsdPerMonth: number;
	ownModel: boolean;
	displayName: string | null;
	email: string | null;
	hasBilling: boolean;
	/** Share of this month's hosted budget already used, from 0 to 1. */
	budgetUsed: number;
	tutorVia: "claude" | "key";
	tutorProvider: UserKeyProvider | null;
	tutorWeight: TutorWeight;
}

export function emptyAccount(uid: string, now: Date = new Date()): AccountRecord {
	return { uid, plan: null, period: periodKey(now), spentUsd: 0 };
}

/** Roll a stale period forward. Does not mutate `record`. */
export function currentAccount(record: AccountRecord, now: Date = new Date()): AccountRecord {
	const period = periodKey(now);
	if (record.period === period) return record;
	return { ...record, period, spentUsd: 0 };
}

export function viewAccount(record: AccountRecord, now: Date = new Date()): AccountView {
	const current = currentAccount(record, now);
	if (!current.plan) {
		return {
			plan: null,
			needsPlan: true,
			name: "Choose a plan",
			priceUsdPerMonth: 0,
			creditUsd: 0,
			spentUsd: 0,
			remainingUsd: 0,
			ownModel: false,
			displayName: current.displayName ?? null,
			email: current.email ?? null,
			hasBilling: !!current.stripeCustomerId,
			...tutorFields(current),
		};
	}
	const plan = PLANS[current.plan];
	const spent = roundUsd(current.spentUsd);
	return {
		plan: current.plan,
		needsPlan: false,
		name: plan.name,
		priceUsdPerMonth: plan.priceUsdPerMonth,
		creditUsd: plan.hostedCreditUsd,
		spentUsd: spent,
		remainingUsd: roundUsd(Math.max(0, plan.hostedCreditUsd - spent)),
		ownModel: plan.ownModel,
		displayName: current.displayName ?? null,
		email: current.email ?? null,
		hasBilling: !!current.stripeCustomerId,
		...tutorFields(current),
	};
}

export function tutorChoiceFrom(record: AccountRecord): TutorChoice {
	const fields = tutorFields(record);
	return { via: fields.tutorVia, provider: fields.tutorProvider };
}

function tutorFields(record: AccountRecord): { tutorVia: "claude" | "key"; tutorProvider: UserKeyProvider | null; tutorWeight: TutorWeight } {
	return {
		tutorVia: record.tutorVia === "key" ? "key" : "claude",
		tutorProvider: isUserKeyProvider(record.tutorProvider) ? record.tutorProvider : null,
		tutorWeight: record.tutorWeight === "heavy" ? "heavy" : "light",
	};
}

export function presentAccount(view: AccountView): PublicAccount {
	const budgetUsed = view.ownModel || view.creditUsd <= 0 ? 0 : Math.min(1, view.spentUsd / view.creditUsd);
	return {
		plan: view.plan,
		needsPlan: view.needsPlan,
		name: view.name,
		priceUsdPerMonth: view.priceUsdPerMonth,
		ownModel: view.ownModel,
		displayName: view.displayName,
		email: view.email,
		hasBilling: view.hasBilling,
		budgetUsed,
		tutorVia: view.tutorVia,
		tutorProvider: view.tutorProvider,
		tutorWeight: view.tutorWeight,
	};
}

/** Fill email and name from Google the first time we see them. A chosen display name stays. */
export function rememberProfile(record: AccountRecord, profile: { email?: string; name?: string }): AccountRecord {
	return {
		...record,
		email: record.email || profile.email || undefined,
		displayName: record.displayName || profile.name || undefined,
	};
}

export function setDisplayName(record: AccountRecord, name: string): AccountRecord {
	const displayName = name.trim().slice(0, 80);
	return { ...record, displayName: displayName || undefined };
}

export function setStripeCustomer(record: AccountRecord, customerId: string): AccountRecord {
	return { ...record, stripeCustomerId: customerId };
}

/** Drop a Stripe customer id that does not exist in the current mode. */
export function clearStripeCustomer(record: AccountRecord): AccountRecord {
	if (!record.stripeCustomerId) return record;
	const next = { ...record };
	delete next.stripeCustomerId;
	return next;
}

export function setTutorWeight(record: AccountRecord, weight: TutorWeight, now: Date = new Date()): AccountRecord {
	const current = currentAccount(record, now);
	return { ...current, tutorWeight: weight };
}

export function setTutorChoice(record: AccountRecord, choice: { via: "claude" | "key"; provider?: string | null }, now: Date = new Date()): AccountRecord {
	const current = currentAccount(record, now);
	if (choice.via === "claude") return { ...current, tutorVia: "claude" };
	const provider = isUserKeyProvider(choice.provider) ? choice.provider : isUserKeyProvider(current.tutorProvider) ? current.tutorProvider : undefined;
	return { ...current, tutorVia: "key", tutorProvider: provider };
}

export function choosePlan(record: AccountRecord, plan: PlanId, now: Date = new Date()): AccountRecord {
	const current = currentAccount(record, now);
	return { ...current, plan };
}

/**
 * Charge generative-model spend against hosted credit.
 * Jev is not charged here. Bring-your-own-model has no hosted credit to draw.
 */
export function spendHosted(record: AccountRecord, costUsd: number, now: Date = new Date()): { ok: true; account: AccountRecord } | { ok: false; reason: string; account: AccountRecord } {
	const current = currentAccount(record, now);
	const view = viewAccount(current, now);
	if (!(costUsd > 0) || !Number.isFinite(costUsd)) return { ok: false, reason: "Nothing to charge.", account: current };
	if (view.needsPlan) return { ok: false, reason: "Choose a plan first.", account: current };
	if (view.ownModel) return { ok: false, reason: "This plan uses your own model.", account: current };
	if (costUsd > view.remainingUsd + 1e-9) return { ok: false, reason: "Monthly credit is used up.", account: current };
	return { ok: true, account: { ...current, spentUsd: roundUsd(current.spentUsd + costUsd) } };
}

/**
 * Record hosted spend after a tutor call.
 * A turn that costs more than the remainder still finishes; the ledger stops at the allowance.
 * The next turn is refused once nothing is left.
 */
export function settleHosted(record: AccountRecord, costUsd: number, now: Date = new Date()): { account: AccountRecord; chargedUsd: number; exhausted: boolean } {
	const current = currentAccount(record, now);
	const view = viewAccount(current, now);
	const exhaustedAlready = !view.needsPlan && !view.ownModel && view.remainingUsd <= 0;
	if (!(costUsd > 0) || !Number.isFinite(costUsd)) return { account: current, chargedUsd: 0, exhausted: exhaustedAlready };
	if (view.needsPlan || view.ownModel || view.remainingUsd <= 0) return { account: current, chargedUsd: 0, exhausted: exhaustedAlready };
	const charged = roundUsd(Math.min(costUsd, view.remainingUsd));
	const account = { ...current, spentUsd: roundUsd(current.spentUsd + charged) };
	return { account, chargedUsd: charged, exhausted: viewAccount(account, now).remainingUsd <= 0 };
}

function roundUsd(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}
