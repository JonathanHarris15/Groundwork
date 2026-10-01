import { PLANS, type PlanId } from "./plans";

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
	};
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

function roundUsd(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}
