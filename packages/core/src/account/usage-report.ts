import type { PlanId } from "./plans";
import { PLANS } from "./plans";
import type { StoredMembership } from "./usage";
import type { UsageFeature } from "./usage-feature";
import { USAGE_FEATURES } from "./usage-feature";

/** Shown on the admin dashboard. ISO weeks start Monday, UTC. */
export const CONSISTENT_USER_DEFINITION =
	"A consistent user is active on at least one day in 3 of the last 4 ISO weeks. An active day is a UTC day with at least one recorded use. ISO weeks start on Monday.";

/**
 * How Free is metered. Dollar amounts of the allowance stay off public pages;
 * this sentence is for the admin dashboard.
 */
export const USAGE_METER_NOTE =
	"Free use is hosted model spend in USD. Each call is priced from its token counts at the listed OpenRouter rates for Light and Heavy. The total resets at the start of each calendar month, UTC. Unused allowance expires. Jev grading is not drawn from that allowance.";

export type UsagePlan = PlanId | "none";
export type UsageModel = "light" | "heavy" | "unknown";
export type ExcludeReason = "admin" | "coupon" | "test";
export type HitOutcome = "upgraded" | "waited" | "churned" | "open";

export interface UsageDayRow {
	uid: string;
	day: string;
	plan: UsagePlan;
	model: UsageModel;
	feature: UsageFeature;
	calls: number;
	costUsd: number;
	chargedUsd: number;
	inputTokens: number;
	outputTokens: number;
}

export interface UsageLedgerRow {
	uid: string;
	period: string;
	plan: UsagePlan;
	costUsd: number;
	chargedUsd: number;
}

export interface UsageEventRow {
	uid: string;
	at: string;
	kind: "checkout" | "upgraded";
	plan: "byom" | "included";
}

export interface UsageAccountRow {
	uid: string;
	email?: string;
	plan: PlanId | null;
	createdAt?: string;
	period?: string;
	spentUsd?: number;
	couponCode?: string;
	tutorWeight?: "light" | "heavy";
	membership?: StoredMembership;
}

/** A Firebase Auth user. Account documents are joined onto this list. */
export interface AuthUserRef {
	uid: string;
	/** Firebase Auth `metadata.creationTime`, as an ISO string. */
	createdAt?: string;
}

/**
 * Account totals for the top of the admin usage page. Counts only.
 * `users` is the Auth population. `free + paid + noPlan + other` equals `users`.
 * `orphans` are Firestore account documents outside that population.
 */
export interface AccountCensus {
	users: number;
	free: number;
	/** Auth users with no plan on the account document, including Auth users with no document. */
	noPlan: number;
	/** Auth users on Bring your own model or Groundwork without an active or trialing subscription. */
	other: number;
	joinedLast7Days: number;
	paid: number;
	byom: number;
	included: number;
	/** Active or trialing memberships whose price after discounts is more than $0. */
	paying: number;
	/** Active or trialing memberships on the 100% off GROUNDWORKTESTER coupon. */
	comped: number;
	/** Firestore account documents whose uid is not a Firebase Auth user. */
	orphans: number;
}

export interface LimitMoments {
	users: number;
	meanPct: number | null;
	medianPct: number | null;
	p75Pct: number | null;
	p90Pct: number | null;
	meanUsd: number | null;
	medianUsd: number | null;
	p75Usd: number | null;
	p90Usd: number | null;
}

export interface UserLimitRow {
	uid: string;
	email: string | null;
	period: string;
	pct: number;
	costUsd: number;
	chargedUsd: number;
	hit: boolean;
	hitDay: number | null;
	outcome: HitOutcome | null;
	consistent: boolean;
	excluded: ExcludeReason[];
}

export interface UsageReport {
	generatedAt: string;
	meter: string;
	consistentUser: string;
	limitUsd: number;
	weeks: Array<{ week: string; activeFree: number; checkouts: number; signups: number }>;
	cohorts: Array<{
		week: string;
		size: number;
		day1: Rate;
		day7: Rate;
		day30: Rate;
	}>;
	activeDays: Array<{ period: string; users: number; mean: number | null; median: number | null }>;
	limits: Array<{
		period: string;
		partial: boolean;
		overall: LimitMoments;
		consistent: LimitMoments;
		hit100: number;
		hit100Share: number | null;
		hitDayMedian: number | null;
		outcomes: Record<HitOutcome, number>;
	}>;
	features: Array<{ feature: UsageFeature; calls: number; costUsd: number; inputTokens: number; outputTokens: number }>;
	models: Array<{ model: UsageModel; calls: number; costUsd: number; inputTokens: number; outputTokens: number }>;
	proposal: {
		period: string;
		partial: boolean;
		sample: number;
		small: boolean;
		p50Usd: number | null;
		p75Usd: number | null;
		lowUsd: number | null;
		highUsd: number | null;
	};
	upgrades: { clicks: number; clickers: number; upgrades: number; convertedClickers: number };
	excluded: { admin: number; coupon: number; test: number };
	users: UserLimitRow[];
	distribution: Array<{ label: string; count: number }>;
	census: AccountCensus;
}

interface Rate {
	eligible: number;
	returned: number;
	rate: number | null;
}

export interface UsageReportInput {
	now: Date;
	accounts: UsageAccountRow[];
	days: UsageDayRow[];
	ledgers: UsageLedgerRow[];
	events: UsageEventRow[];
	adminEmails: readonly string[];
	limitUsd?: number;
	/**
	 * Firebase Auth users. When set, every metric uses this list joined to account
	 * documents. Documents whose uid is absent are orphans. Omit it only when Auth
	 * is not configured, such as local development.
	 */
	authUsers?: readonly AuthUserRef[];
}

const SMALL_SAMPLE = 20;
const PROPOSAL_FACTOR = 0.9;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TESTER_COUPON = "GROUNDWORKTESTER";

/**
 * Totals for the Auth population.
 * Paid means an active or trialing BYOM or Groundwork subscription.
 * A user is in exactly one of free, paid, noPlan, or other.
 */
export function accountCensus(accounts: UsageAccountRow[], now: Date, orphans = 0): AccountCensus {
	const cutoff = now.getTime() - WEEK_MS;
	const census: AccountCensus = {
		users: 0,
		free: 0,
		noPlan: 0,
		other: 0,
		joinedLast7Days: 0,
		paid: 0,
		byom: 0,
		included: 0,
		paying: 0,
		comped: 0,
		orphans,
	};
	for (const account of accounts) {
		census.users += 1;
		const created = account.createdAt ? Date.parse(account.createdAt) : Number.NaN;
		if (Number.isFinite(created) && created >= cutoff && created <= now.getTime()) census.joinedLast7Days += 1;
		const membership = countableMembership(account.membership);
		if (membership) {
			census.paid += 1;
			if (membership.plan === "byom") census.byom += 1;
			else census.included += 1;
			const comped = (membership.couponCode ?? "").trim().toUpperCase() === TESTER_COUPON && !(typeof membership.amountUsd === "number" && membership.amountUsd > 0);
			if (typeof membership.amountUsd === "number" && membership.amountUsd > 0) census.paying += 1;
			else if (comped) census.comped += 1;
			continue;
		}
		if (account.plan === "free") census.free += 1;
		else if (account.plan == null) census.noPlan += 1;
		else census.other += 1;
	}
	return census;
}

/** Keep Auth users, and count account documents that are not among them. */
export function scopeToAuthUsers(input: UsageReportInput): UsageReportInput & { orphans: number } {
	if (!input.authUsers) return { ...input, orphans: 0 };
	const docs = new Map<string, UsageAccountRow>();
	for (const account of input.accounts) if (!docs.has(account.uid)) docs.set(account.uid, account);
	const accounts: UsageAccountRow[] = [];
	const allowed = new Set<string>();
	for (const user of input.authUsers) {
		if (allowed.has(user.uid)) continue;
		allowed.add(user.uid);
		const doc = docs.get(user.uid);
		if (!doc) {
			accounts.push({ uid: user.uid, plan: null, createdAt: user.createdAt });
			continue;
		}
		accounts.push(doc.createdAt ? doc : { ...doc, createdAt: user.createdAt });
	}
	let orphans = 0;
	for (const account of input.accounts) if (!allowed.has(account.uid)) orphans += 1;
	const keep = (uid: string) => allowed.has(uid);
	return {
		...input,
		accounts,
		days: input.days.filter((row) => keep(row.uid)),
		ledgers: input.ledgers.filter((row) => keep(row.uid)),
		events: input.events.filter((row) => keep(row.uid)),
		orphans,
	};
}

function countableMembership(membership: StoredMembership | undefined): StoredMembership | null {
	if (!membership) return null;
	if (membership.status !== "active" && membership.status !== "trialing") return null;
	if (membership.plan !== "byom" && membership.plan !== "included") return null;
	return membership;
}

export function utcDay(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

export function addUtcDays(day: string, n: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + n);
	return date.toISOString().slice(0, 10);
}

export function nextPeriod(period: string): string {
	const [year, month] = period.split("-").map(Number);
	const date = new Date(Date.UTC(year || 1970, (month || 1) - 1 + 1, 1));
	return date.toISOString().slice(0, 7);
}

/** ISO week key, `YYYY-Www`, for a UTC calendar day or instant. */
export function isoWeekKey(dayOrDate: string | Date): string {
	const date = typeof dayOrDate === "string" ? new Date(`${dayOrDate.slice(0, 10)}T00:00:00Z`) : dayOrDate;
	const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const weekday = utc.getUTCDay() || 7;
	utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
	const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The ISO week of `now` and the weeks before it, oldest first. */
export function recentIsoWeeks(now: Date, count = 4): string[] {
	const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const weekday = cursor.getUTCDay() || 7;
	cursor.setUTCDate(cursor.getUTCDate() - (weekday - 1));
	const keys: string[] = [];
	for (let i = count - 1; i >= 0; i--) {
		const day = new Date(cursor);
		day.setUTCDate(cursor.getUTCDate() - i * 7);
		keys.push(isoWeekKey(day));
	}
	return keys;
}

/** Linear percentile, the same convention as Excel PERCENTILE.INC. `p` is 0–1. */
export function percentile(values: number[], p: number): number | null {
	if (!values.length || !(p >= 0) || p > 1) return null;
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0] ?? null;
	const rank = (sorted.length - 1) * p;
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	const left = sorted[low] ?? 0;
	const right = sorted[high] ?? left;
	if (low === high) return left;
	return left + (right - left) * (rank - low);
}

export function mean(values: number[]): number | null {
	if (!values.length) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isTestEmail(email: string | undefined): boolean {
	if (!email) return false;
	const lower = email.trim().toLowerCase();
	if (lower.endsWith("@example.com") || lower.endsWith("@example.org") || lower.endsWith("@test.com")) return true;
	const local = lower.split("@")[0] ?? "";
	if (local === "test" || local.startsWith("test+") || local.includes("+test")) return true;
	if (lower.includes("groundworktester")) return true;
	return false;
}

export function exclusionReasons(account: UsageAccountRow, adminEmails: readonly string[]): ExcludeReason[] {
	const reasons: ExcludeReason[] = [];
	const email = account.email?.trim().toLowerCase();
	if (email && adminEmails.some((admin) => admin.toLowerCase() === email)) reasons.push("admin");
	if (account.couponCode?.trim().toUpperCase() === "GROUNDWORKTESTER") reasons.push("coupon");
	if (isTestEmail(account.email)) reasons.push("test");
	return reasons;
}

/**
 * A user is consistent when at least 3 of the last 4 ISO weeks contain an active day.
 * `activeWeeks` is the set of ISO week keys in which they were active.
 */
export function isConsistentUser(activeWeeks: ReadonlySet<string>, now: Date): boolean {
	const recent = recentIsoWeeks(now, 4);
	let hits = 0;
	for (const week of recent) if (activeWeeks.has(week)) hits += 1;
	return hits >= 3;
}

export function buildUsageReport(source: UsageReportInput): UsageReport {
	const scoped = scopeToAuthUsers(source);
	const input = scoped;
	const now = input.now;
	const today = utcDay(now);
	const currentPeriod = now.toISOString().slice(0, 7);
	const limitUsd = input.limitUsd ?? PLANS.free.hostedCreditUsd;
	const excluded = new Map<string, ExcludeReason[]>();
	for (const account of input.accounts) {
		const reasons = exclusionReasons(account, input.adminEmails);
		if (reasons.length) excluded.set(account.uid, reasons);
	}

	const daysByUid = new Map<string, UsageDayRow[]>();
	for (const row of input.days) {
		if (!(row.calls > 0) && !(row.costUsd > 0) && !(row.chargedUsd > 0)) continue;
		const list = daysByUid.get(row.uid) ?? [];
		list.push(row);
		daysByUid.set(row.uid, list);
	}

	const freeActiveDays = new Map<string, Set<string>>();
	const anyActiveDays = new Map<string, Set<string>>();
	for (const [uid, rows] of daysByUid) {
		if (excluded.has(uid)) continue;
		for (const row of rows) {
			if (!(row.calls > 0)) continue;
			const any = anyActiveDays.get(uid) ?? new Set<string>();
			any.add(row.day);
			anyActiveDays.set(uid, any);
			if (row.plan === "free") {
				const free = freeActiveDays.get(uid) ?? new Set<string>();
				free.add(row.day);
				freeActiveDays.set(uid, free);
			}
		}
	}

	const weeks = recentIsoWeeks(now, 12).map((week) => {
		let activeFree = 0;
		for (const days of freeActiveDays.values()) {
			for (const day of days) {
				if (isoWeekKey(day) === week) {
					activeFree += 1;
					break;
				}
			}
		}
		const checkouts = input.events.filter((event) => event.kind === "checkout" && isoWeekKey(event.at) === week && !excluded.has(event.uid)).length;
		const signups = input.accounts.filter((account) => {
			if (excluded.has(account.uid) || account.plan !== "free" || !account.createdAt) return false;
			return isoWeekKey(account.createdAt) === week;
		}).length;
		return { week, activeFree, checkouts, signups };
	});

	const cohortMembers = input.accounts.filter((account) => account.createdAt && account.plan === "free" && !excluded.has(account.uid));
	const byCohort = new Map<string, UsageAccountRow[]>();
	for (const account of cohortMembers) {
		const week = isoWeekKey(account.createdAt ?? "");
		const list = byCohort.get(week) ?? [];
		list.push(account);
		byCohort.set(week, list);
	}
	const cohorts = [...byCohort.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([week, members]) => ({
			week,
			size: members.length,
			day1: returnRate(members, 1, today, anyActiveDays),
			day7: returnRate(members, 7, today, anyActiveDays),
			day30: returnRate(members, 30, today, anyActiveDays),
		}));

	const periodList = recentPeriods(currentPeriod, 4);
	const populations = new Map<string, UsageAccountRow[]>();
	for (const period of periodList) populations.set(period, limitPopulation(period, currentPeriod, input, excluded));

	const activeDays = periodList.map((period) => {
		const users = populations.get(period) ?? [];
		const counts = users.map((account) => daysInPeriod(freeActiveDays.get(account.uid), period));
		return { period, users: users.length, mean: mean(counts), median: percentile(counts, 0.5) };
	});

	const consistentIds = new Set<string>();
	for (const [uid, days] of freeActiveDays) {
		const weekSet = new Set<string>();
		for (const day of days) weekSet.add(isoWeekKey(day));
		if (isConsistentUser(weekSet, now)) consistentIds.add(uid);
	}

	const userRows: UserLimitRow[] = [];
	const limits = periodList.map((period) => {
		const users = populations.get(period) ?? [];
		const rows = users.map((account) => userLimit(account, period, input, limitUsd, consistentIds, excluded, now, freeActiveDays));
		if (period === currentPeriod) userRows.push(...rows);
		const overall = moments(rows);
		const consistentRows = rows.filter((row) => row.consistent);
		const hitRows = rows.filter((row) => row.hit);
		const hitDays = hitRows.map((row) => row.hitDay).filter((day): day is number => day != null);
		return {
			period,
			partial: period === currentPeriod,
			overall,
			consistent: moments(consistentRows),
			hit100: hitRows.length,
			hit100Share: rows.length ? hitRows.length / rows.length : null,
			hitDayMedian: percentile(hitDays, 0.5),
			outcomes: countOutcomes(hitRows),
		};
	});

	const focus = focusPeriod(currentPeriod, populations, input);
	const focusUsers = (populations.get(focus.period) ?? []).filter((account) => consistentIds.has(account.uid));
	const focusCosts = focusUsers.map((account) => spendFor(account.uid, focus.period, "free", input).costUsd);
	const p50 = percentile(focusCosts, 0.5);
	const p75 = percentile(focusCosts, 0.75);
	const proposal = {
		period: focus.period,
		partial: focus.partial,
		sample: focusUsers.length,
		small: focusUsers.length < SMALL_SAMPLE,
		p50Usd: p50,
		p75Usd: p75,
		lowUsd: p50 == null ? null : p50 * PROPOSAL_FACTOR,
		highUsd: p75 == null ? null : p75 * PROPOSAL_FACTOR,
	};

	const featureTotals = new Map<UsageFeature, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }>();
	for (const feature of USAGE_FEATURES) featureTotals.set(feature, { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
	const modelTotals = new Map<UsageModel, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }>();
	for (const model of ["light", "heavy", "unknown"] as const) modelTotals.set(model, { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
	let dayCharged = 0;
	for (const row of input.days) {
		if (row.plan !== "free" || excluded.has(row.uid) || !row.day.startsWith(currentPeriod)) continue;
		const feature = featureTotals.get(row.feature) ?? featureTotals.get("unknown");
		if (feature) {
			feature.calls += row.calls;
			feature.costUsd += row.costUsd;
			feature.inputTokens += row.inputTokens;
			feature.outputTokens += row.outputTokens;
		}
		const model = modelTotals.get(row.model) ?? modelTotals.get("unknown");
		if (model) {
			model.calls += row.calls;
			model.costUsd += row.costUsd;
			model.inputTokens += row.inputTokens;
			model.outputTokens += row.outputTokens;
		}
		dayCharged += row.chargedUsd;
	}
	let ledgerCharged = 0;
	for (const account of populations.get(currentPeriod) ?? []) {
		ledgerCharged += Math.max(ledgerOf(account.uid, currentPeriod, "free", input.ledgers)?.chargedUsd ?? 0, accountSpend(account, currentPeriod));
	}
	const unitemized = roundUsd(Math.max(0, ledgerCharged - dayCharged));
	if (unitemized > 0) {
		const unknown = featureTotals.get("unknown");
		if (unknown) unknown.costUsd += unitemized;
		const model = modelTotals.get("unknown");
		if (model) model.costUsd += unitemized;
	}

	const clickers = new Set(input.events.filter((event) => event.kind === "checkout" && !excluded.has(event.uid)).map((event) => event.uid));
	const upgraded = new Set(input.events.filter((event) => event.kind === "upgraded" && !excluded.has(event.uid)).map((event) => event.uid));
	let convertedClickers = 0;
	for (const uid of clickers) if (upgraded.has(uid)) convertedClickers += 1;

	for (const account of input.accounts) {
		const reasons = excluded.get(account.uid);
		if (!reasons?.length) continue;
		const spent = spendFor(account.uid, currentPeriod, "free", input);
		if (account.plan !== "free" && spent.chargedUsd <= 0 && spent.costUsd <= 0) continue;
		userRows.push(userLimit(account, currentPeriod, input, limitUsd, consistentIds, excluded, now, freeActiveDays));
	}

	const currentRows = userRows.filter((row) => !row.excluded.length);
	const distribution = [
		{ label: "0%", count: currentRows.filter((row) => row.pct <= 0).length },
		{ label: "1–25%", count: currentRows.filter((row) => row.pct > 0 && row.pct <= 25).length },
		{ label: "26–50%", count: currentRows.filter((row) => row.pct > 25 && row.pct <= 50).length },
		{ label: "51–75%", count: currentRows.filter((row) => row.pct > 50 && row.pct <= 75).length },
		{ label: "76–99%", count: currentRows.filter((row) => row.pct > 75 && row.pct < 100).length },
		{ label: "100%", count: currentRows.filter((row) => row.pct >= 100).length },
	];

	let admin = 0;
	let coupon = 0;
	let test = 0;
	for (const reasons of excluded.values()) {
		if (reasons.includes("admin")) admin += 1;
		if (reasons.includes("coupon")) coupon += 1;
		if (reasons.includes("test")) test += 1;
	}

	return {
		generatedAt: now.toISOString(),
		meter: USAGE_METER_NOTE,
		consistentUser: CONSISTENT_USER_DEFINITION,
		limitUsd,
		weeks,
		cohorts,
		activeDays,
		limits,
		features: [...featureTotals.entries()].map(([feature, totals]) => ({ feature, ...roundTotals(totals) })),
		models: [...modelTotals.entries()].map(([model, totals]) => ({ model, ...roundTotals(totals) })),
		proposal,
		upgrades: {
			clicks: input.events.filter((event) => event.kind === "checkout" && !excluded.has(event.uid)).length,
			clickers: clickers.size,
			upgrades: upgraded.size,
			convertedClickers,
		},
		excluded: { admin, coupon, test },
		users: userRows,
		distribution,
		census: accountCensus(input.accounts, now, scoped.orphans),
	};
}

function roundTotals(totals: { calls: number; costUsd: number; inputTokens: number; outputTokens: number }) {
	return { ...totals, costUsd: roundUsd(totals.costUsd) };
}

function returnRate(members: UsageAccountRow[], offset: number, today: string, active: Map<string, Set<string>>): Rate {
	let eligible = 0;
	let returned = 0;
	for (const account of members) {
		const signup = (account.createdAt ?? "").slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(signup)) continue;
		const target = addUtcDays(signup, offset);
		if (target > today) continue;
		eligible += 1;
		if (active.get(account.uid)?.has(target)) returned += 1;
	}
	return { eligible, returned, rate: eligible ? returned / eligible : null };
}

function recentPeriods(current: string, count: number): string[] {
	const periods = [current];
	let cursor = current;
	for (let i = 1; i < count; i++) {
		cursor = previousPeriod(cursor);
		periods.push(cursor);
	}
	return periods.reverse();
}

function previousPeriod(period: string): string {
	const [year, month] = period.split("-").map(Number);
	const date = new Date(Date.UTC(year || 1970, (month || 1) - 1 - 1, 1));
	return date.toISOString().slice(0, 7);
}

function limitPopulation(period: string, current: string, input: UsageReportInput, excluded: Map<string, ExcludeReason[]>): UsageAccountRow[] {
	const seen = new Set<string>();
	const out: UsageAccountRow[] = [];
	for (const account of input.accounts) {
		if (excluded.has(account.uid) || seen.has(account.uid)) continue;
		const spent = spendFor(account.uid, period, "free", input);
		const currentFree = period === current && account.plan === "free";
		if (!currentFree && spent.chargedUsd <= 0 && spent.costUsd <= 0) continue;
		seen.add(account.uid);
		out.push(account);
	}
	return out;
}

function accountSpend(account: UsageAccountRow, period: string): number {
	if (account.plan !== "free" || account.period !== period) return 0;
	return account.spentUsd && account.spentUsd > 0 ? account.spentUsd : 0;
}

function ledgerOf(uid: string, period: string, plan: UsagePlan, ledgers: UsageLedgerRow[]): UsageLedgerRow | undefined {
	return ledgers.find((row) => row.uid === uid && row.period === period && row.plan === plan);
}

function spendFor(uid: string, period: string, plan: UsagePlan, input: UsageReportInput): { costUsd: number; chargedUsd: number } {
	let cost = 0;
	let charged = 0;
	let otherPlanCharged = 0;
	for (const row of input.days) {
		if (row.uid !== uid || !row.day.startsWith(period)) continue;
		if (row.plan === plan) {
			cost += row.costUsd;
			charged += row.chargedUsd;
		} else if (row.chargedUsd > 0) otherPlanCharged += row.chargedUsd;
	}
	const ledger = ledgerOf(uid, period, plan, input.ledgers);
	const account = input.accounts.find((item) => item.uid === uid);
	const fromAccount = account && plan === "free" ? accountSpend(account, period) : 0;
	if (otherPlanCharged > 0 && fromAccount > 0) {
		return { costUsd: roundUsd(cost), chargedUsd: roundUsd(charged) };
	}
	return {
		costUsd: roundUsd(Math.max(cost, ledger?.costUsd ?? 0, fromAccount)),
		chargedUsd: roundUsd(Math.max(charged, ledger?.chargedUsd ?? 0, fromAccount)),
	};
}

function daysInPeriod(days: Set<string> | undefined, period: string): number {
	if (!days) return 0;
	let count = 0;
	for (const day of days) if (day.startsWith(period)) count += 1;
	return count;
}

function userLimit(
	account: UsageAccountRow,
	period: string,
	input: UsageReportInput,
	limitUsd: number,
	consistentIds: Set<string>,
	excluded: Map<string, ExcludeReason[]>,
	now: Date,
	freeDays: Map<string, Set<string>>,
): UserLimitRow {
	const spent = spendFor(account.uid, period, "free", input);
	const pct = limitUsd > 0 ? (spent.chargedUsd / limitUsd) * 100 : 0;
	const hit = spent.chargedUsd >= limitUsd - 1e-9 && limitUsd > 0;
	const hitDay = hit ? firstHitDay(account.uid, period, input.days, limitUsd) : null;
	const reasons = excluded.get(account.uid) ?? [];
	return {
		uid: account.uid,
		email: account.email ?? null,
		period,
		pct: Math.round(pct * 100) / 100,
		costUsd: spent.costUsd,
		chargedUsd: spent.chargedUsd,
		hit,
		hitDay,
		outcome: hit ? outcomeFor(account.uid, period, hitDay, input, now, freeDays) : null,
		consistent: consistentIds.has(account.uid),
		excluded: reasons,
	};
}

function firstHitDay(uid: string, period: string, days: UsageDayRow[], limitUsd: number): number | null {
	const byDay = new Map<string, number>();
	for (const row of days) {
		if (row.uid !== uid || row.plan !== "free" || !row.day.startsWith(period)) continue;
		byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.chargedUsd);
	}
	const ordered = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	let running = 0;
	for (const [day, charged] of ordered) {
		running += charged;
		if (running >= limitUsd - 1e-9) return Number(day.slice(8, 10));
	}
	return null;
}

function outcomeFor(uid: string, period: string, hitDay: number | null, input: UsageReportInput, now: Date, freeDays: Map<string, Set<string>>): HitOutcome {
	const hitAt = hitDay ? `${period}-${String(hitDay).padStart(2, "0")}T00:00:00.000Z` : `${period}-01T00:00:00.000Z`;
	const upgraded = input.events.some((event) => event.uid === uid && event.kind === "upgraded" && event.at >= hitAt);
	if (upgraded) return "upgraded";
	const following = nextPeriod(period);
	const activeNext = [...(freeDays.get(uid) ?? [])].some((day) => day.startsWith(following));
	if (activeNext) return "waited";
	const current = now.toISOString().slice(0, 7);
	if (current <= following) return "open";
	return "churned";
}

function moments(rows: UserLimitRow[]): LimitMoments {
	const pcts = rows.map((row) => row.pct);
	const usd = rows.map((row) => row.costUsd);
	return {
		users: rows.length,
		meanPct: mean(pcts),
		medianPct: percentile(pcts, 0.5),
		p75Pct: percentile(pcts, 0.75),
		p90Pct: percentile(pcts, 0.9),
		meanUsd: mean(usd),
		medianUsd: percentile(usd, 0.5),
		p75Usd: percentile(usd, 0.75),
		p90Usd: percentile(usd, 0.9),
	};
}

function countOutcomes(rows: UserLimitRow[]): Record<HitOutcome, number> {
	const outcomes: Record<HitOutcome, number> = { upgraded: 0, waited: 0, churned: 0, open: 0 };
	for (const row of rows) {
		if (row.outcome) outcomes[row.outcome] += 1;
	}
	return outcomes;
}

function focusPeriod(current: string, populations: Map<string, UsageAccountRow[]>, input: UsageReportInput): { period: string; partial: boolean } {
	const complete = [...populations.keys()].filter((period) => period < current).sort();
	for (let i = complete.length - 1; i >= 0; i--) {
		const period = complete[i];
		if (!period) continue;
		const users = populations.get(period) ?? [];
		if (users.some((account) => spendFor(account.uid, period, "free", input).costUsd > 0)) return { period, partial: false };
	}
	return { period: current, partial: true };
}

function roundUsd(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}
