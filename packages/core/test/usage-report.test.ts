import { describe, expect, it } from "vitest";
import {
	addUtcDays,
	buildUsageReport,
	CONSISTENT_USER_DEFINITION,
	exclusionReasons,
	isConsistentUser,
	isoWeekKey,
	mean,
	percentile,
	recentIsoWeeks,
	type UsageAccountRow,
	type UsageDayRow,
	type UsageReportInput,
} from "../src/account/usage-report";

const ADMIN = ["jono591737@gmail.com"];
const NOW = new Date("2026-10-09T15:00:00.000Z");

function account(over: Partial<UsageAccountRow> & { uid: string }): UsageAccountRow {
	return { plan: "free", period: "2026-10", spentUsd: 0, ...over };
}

function day(over: Partial<UsageDayRow> & { uid: string; day: string }): UsageDayRow {
	return {
		plan: "free",
		model: "light",
		feature: "tutor_chat",
		calls: 1,
		costUsd: 0.1,
		chargedUsd: 0.1,
		inputTokens: 100,
		outputTokens: 20,
		...over,
	};
}

function report(over: Partial<UsageReportInput> = {}) {
	return buildUsageReport({
		now: NOW,
		accounts: [],
		days: [],
		ledgers: [],
		events: [],
		adminEmails: ADMIN,
		limitUsd: 1.25,
		...over,
	});
}

describe("usage rollup math", () => {
	it("computes mean and inclusive percentiles", () => {
		expect(mean([])).toBeNull();
		expect(mean([1, 2, 3])).toBe(2);
		expect(percentile([], 0.5)).toBeNull();
		expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
		expect(percentile([1, 2, 3, 4, 5], 0.75)).toBe(4);
		expect(percentile([1, 2, 3, 4, 5], 0.9)).toBe(4.6);
		expect(percentile([4], 0.9)).toBe(4);
	});

	it("uses ISO weeks that start on Monday", () => {
		expect(isoWeekKey("2026-01-01")).toBe("2026-W01");
		expect(isoWeekKey("2026-10-09")).toBe(isoWeekKey("2026-10-05"));
		expect(isoWeekKey("2026-10-04")).not.toBe(isoWeekKey("2026-10-05"));
		const weeks = recentIsoWeeks(NOW, 4);
		expect(weeks).toHaveLength(4);
		expect(weeks[3]).toBe(isoWeekKey("2026-10-09"));
		expect(new Set(weeks).size).toBe(4);
	});

	it("treats 3 active weeks out of the last 4 as consistent", () => {
		const weeks = recentIsoWeeks(NOW, 4);
		expect(CONSISTENT_USER_DEFINITION).toMatch(/3 of the last 4 ISO weeks/);
		expect(isConsistentUser(new Set(weeks.slice(0, 3)), NOW)).toBe(true);
		expect(isConsistentUser(new Set(weeks.slice(2)), NOW)).toBe(false);
		expect(isConsistentUser(new Set([weeks[3] ?? ""]), NOW)).toBe(false);
	});

	it("keeps the ledger from being added on top of the same spend", () => {
		const built = report({
			accounts: [account({ uid: "ada", spentUsd: 1, createdAt: "2026-10-01T00:00:00.000Z" })],
			days: [day({ uid: "ada", day: "2026-10-08", chargedUsd: 0.2, costUsd: 0.2 })],
			ledgers: [{ uid: "ada", period: "2026-10", plan: "free", costUsd: 1, chargedUsd: 1 }],
		});
		const ada = built.users.find((row) => row.uid === "ada");
		expect(ada?.chargedUsd).toBe(1);
		expect(ada?.costUsd).toBe(1);
		expect(ada?.pct).toBe(80);
	});

	it("keeps a last call that costs more than the remaining allowance", () => {
		const built = report({
			accounts: [account({ uid: "ada", spentUsd: 1.25 })],
			days: [day({ uid: "ada", day: "2026-10-03", chargedUsd: 1.25, costUsd: 1.4 })],
		});
		const ada = built.users.find((row) => row.uid === "ada");
		expect(ada?.chargedUsd).toBe(1.25);
		expect(ada?.costUsd).toBe(1.4);
		expect(ada?.hit).toBe(true);
		expect(ada?.pct).toBe(100);
	});
});

describe("retention and limit outcomes", () => {
	const weeks = recentIsoWeeks(NOW, 4);

	function activeWeeks(uid: string, which: string[]): UsageDayRow[] {
		return which.map((week) => {
			const monday = mondayOf(week);
			return day({ uid, day: monday, calls: 1, costUsd: 0.4, chargedUsd: 0.4 });
		});
	}

	it("measures day-1, day-7, and day-30 return on the signup-week cohort", () => {
		const signup = "2026-09-07T12:00:00.000Z";
		const built = report({
			accounts: [
				account({ uid: "back", createdAt: signup, period: "2026-09" }),
				account({ uid: "gone", createdAt: signup, period: "2026-09" }),
				account({ uid: "soon", createdAt: "2026-10-08T00:00:00.000Z" }),
			],
			days: [
				day({ uid: "back", day: addUtcDays("2026-09-07", 1) }),
				day({ uid: "back", day: addUtcDays("2026-09-07", 7) }),
				day({ uid: "back", day: addUtcDays("2026-09-07", 30) }),
			],
		});
		const cohort = built.cohorts.find((row) => row.week === isoWeekKey(signup));
		expect(cohort?.size).toBe(2);
		expect(cohort?.day1).toEqual({ eligible: 2, returned: 1, rate: 0.5 });
		expect(cohort?.day7).toEqual({ eligible: 2, returned: 1, rate: 0.5 });
		expect(cohort?.day30).toEqual({ eligible: 2, returned: 1, rate: 0.5 });
		const fresh = built.cohorts.find((row) => row.week === isoWeekKey("2026-10-08"));
		expect(fresh?.day7.eligible).toBe(0);
		expect(fresh?.day7.rate).toBeNull();
		expect(fresh?.day1).toEqual({ eligible: 1, returned: 0, rate: 0 });
	});

	it("counts users, recent signups, and separates paying subscriptions from the tester coupon", () => {
		const built = report({
			accounts: [
				account({ uid: "old", createdAt: "2026-09-01T00:00:00.000Z" }),
				account({ uid: "new", createdAt: "2026-10-04T00:00:00.000Z" }),
				account({ uid: "none", plan: null, createdAt: "2026-10-08T00:00:00.000Z" }),
				account({ uid: "edge", createdAt: "2026-10-02T15:00:00.000Z" }),
				account({ uid: "stale", createdAt: "2026-10-02T14:59:59.000Z" }),
				account({
					uid: "pay",
					plan: "byom",
					membership: { status: "active", plan: "byom", amountUsd: 6 },
				}),
				account({
					uid: "comp-a",
					plan: "included",
					couponCode: "GROUNDWORKTESTER",
					membership: { status: "active", plan: "included", amountUsd: 0, couponCode: "GROUNDWORKTESTER" },
				}),
				account({
					uid: "comp-b",
					plan: "included",
					membership: { status: "trialing", plan: "included", amountUsd: 0, couponCode: "groundworktester" },
				}),
				account({
					uid: "partial",
					plan: "byom",
					membership: { status: "active", plan: "byom", amountUsd: 3, couponCode: "GROUNDWORKTESTER" },
				}),
				account({
					uid: "late",
					plan: "included",
					membership: { status: "past_due" as "active", plan: "included", amountUsd: 20 },
				}),
				account({
					uid: "canceled",
					plan: "free",
					membership: { status: "canceled" as "active", plan: "included", amountUsd: 20 },
				}),
			],
		});
		expect(built.census).toEqual({
			users: 11,
			free: 5,
			joinedLast7Days: 3,
			paid: 4,
			byom: 2,
			included: 2,
			paying: 2,
			comped: 2,
		});
	});

	it("counts weekly active free users and active days in the month", () => {
		const built = report({
			accounts: [account({ uid: "ada", createdAt: "2026-10-05T00:00:00.000Z" }), account({ uid: "bea" })],
			days: [day({ uid: "ada", day: "2026-10-05" }), day({ uid: "ada", day: "2026-10-06" }), day({ uid: "bea", day: "2026-10-06", calls: 2 })],
		});
		const week = built.weeks.find((row) => row.week === isoWeekKey("2026-10-09"));
		expect(week?.activeFree).toBe(2);
		const october = built.activeDays.find((row) => row.period === "2026-10");
		expect(october?.users).toBe(2);
		expect(october?.mean).toBe(1.5);
		expect(october?.median).toBe(1.5);
	});

	it("splits limit use for everyone and for consistent users, including what happens after 100%", () => {
		const consistentDays = activeWeeks("ada", weeks.slice(0, 3));
		const built = report({
			accounts: [
				account({ uid: "ada", spentUsd: 1.25, createdAt: "2026-09-01T00:00:00.000Z" }),
				account({ uid: "bea", spentUsd: 0.25, createdAt: "2026-09-01T00:00:00.000Z" }),
				account({ uid: "cio", spentUsd: 1.25, createdAt: "2026-08-01T00:00:00.000Z", period: "2026-09" }),
				account({ uid: "dee", email: "jono591737@gmail.com", spentUsd: 1.25 }),
				account({ uid: "tester", couponCode: "GROUNDWORKTESTER", spentUsd: 1.25 }),
			],
			days: [
				...consistentDays,
				day({ uid: "ada", day: "2026-10-02", chargedUsd: 1.25, costUsd: 1.25 }),
				day({ uid: "bea", day: "2026-10-04", chargedUsd: 0.25, costUsd: 0.25 }),
				day({ uid: "cio", day: "2026-09-04", chargedUsd: 1.25, costUsd: 1.25, calls: 1 }),
				day({ uid: "dee", day: "2026-10-02", chargedUsd: 1.25, costUsd: 1.25 }),
			],
			events: [{ uid: "ada", at: "2026-10-03T00:00:00.000Z", kind: "upgraded", plan: "included" }],
		});
		const october = built.limits.find((row) => row.period === "2026-10");
		expect(october?.overall.users).toBe(3);
		expect(october?.hit100).toBe(1);
		expect(october?.consistent.users).toBe(1);
		expect(october?.outcomes.upgraded).toBe(1);
		const september = built.limits.find((row) => row.period === "2026-09");
		expect(september?.outcomes.open).toBe(1);
		expect(september?.hitDayMedian).toBe(4);
		const later = report({
			now: new Date("2026-11-02T00:00:00.000Z"),
			accounts: [account({ uid: "cio", period: "2026-09", spentUsd: 1.25, createdAt: "2026-08-01T00:00:00.000Z" })],
			days: [day({ uid: "cio", day: "2026-09-04", chargedUsd: 1.25, costUsd: 1.25 })],
		});
		expect(later.limits.find((row) => row.period === "2026-09")?.outcomes.churned).toBe(1);
		expect(built.excluded).toEqual({ admin: 1, coupon: 1, test: 0 });
		expect(built.users.find((row) => row.uid === "dee")?.excluded).toContain("admin");
		expect(built.users.find((row) => row.uid === "ada")?.hitDay).toBe(2);
		expect(built.users.find((row) => row.uid === "ada")?.outcome).toBe("upgraded");
	});

	it("proposes 90% of the consistent-user p50 to p75 and warns below 20 people", () => {
		const costs = [1, 2, 3, 4, 5];
		const accounts = costs.map((_, index) => account({ uid: `u${index}`, spentUsd: 0, period: "2026-10" }));
		const days = costs.flatMap((_, index) => activeWeeks(`u${index}`, weeks).map((row) => ({ ...row, costUsd: 0, chargedUsd: 0 })));
		const built = report({
			accounts,
			days,
			ledgers: costs.map((cost, index) => ({ uid: `u${index}`, period: "2026-09", plan: "free" as const, costUsd: cost, chargedUsd: cost })),
		});
		expect(built.proposal.period).toBe("2026-09");
		expect(built.proposal.partial).toBe(false);
		expect(built.proposal.sample).toBe(5);
		expect(built.proposal.small).toBe(true);
		expect(built.proposal.p50Usd).toBe(3);
		expect(built.proposal.p75Usd).toBe(4);
		expect(built.proposal.lowUsd).toBeCloseTo(2.7);
		expect(built.proposal.highUsd).toBeCloseTo(3.6);
	});

	it("counts a return the next period as waiting, and leaves the current period open", () => {
		const built = report({
			now: new Date("2026-10-20T00:00:00.000Z"),
			accounts: [account({ uid: "wait", period: "2026-09", spentUsd: 0 }), account({ uid: "open", spentUsd: 1.25 })],
			days: [
				day({ uid: "wait", day: "2026-09-02", chargedUsd: 1.25, costUsd: 1.25 }),
				day({ uid: "wait", day: "2026-10-02", chargedUsd: 0.1, costUsd: 0.1 }),
				day({ uid: "open", day: "2026-10-04", chargedUsd: 1.25, costUsd: 1.25 }),
			],
			ledgers: [{ uid: "wait", period: "2026-09", plan: "free", costUsd: 1.25, chargedUsd: 1.25 }],
		});
		expect(built.limits.find((row) => row.period === "2026-09")?.outcomes.waited).toBe(1);
		expect(built.limits.find((row) => row.period === "2026-10")?.outcomes.open).toBe(1);
	});

	it("flags test emails", () => {
		expect(exclusionReasons(account({ uid: "t", email: "test+qa@example.com" }), ADMIN)).toContain("test");
		expect(exclusionReasons(account({ uid: "a", email: "ada@school.edu" }), ADMIN)).toEqual([]);
	});
});

function mondayOf(week: string): string {
	const match = /^(\d{4})-W(\d{2})$/.exec(week);
	if (!match) throw new Error(week);
	const year = Number(match[1]);
	const nth = Number(match[2]);
	const date = new Date(Date.UTC(year, 0, 1));
	const weekday = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - weekday);
	const weekOneMonday = new Date(date);
	weekOneMonday.setUTCDate(date.getUTCDate() - 3);
	weekOneMonday.setUTCDate(weekOneMonday.getUTCDate() + (nth - 1) * 7);
	return weekOneMonday.toISOString().slice(0, 10);
}
