import {
	buildUsageReport,
	PLANS,
	utcDay,
	type AccountRecord,
	type PlanId,
	type UsageDayRow,
	type UsageEventRow,
	type UsageFeature,
	type UsageModel,
	type UsageReport,
} from "@groundwork/core";
import type { AccountDirectory } from "./accounts";
import { USAGE_ADMIN_EMAILS } from "./admin-access";
import type { UsageStore } from "./usage-store";

export interface UsageCall {
	plan: PlanId | "none";
	model: UsageModel;
	feature: UsageFeature;
	calls: number;
	costUsd: number;
	chargedUsd: number;
	inputTokens: number;
	outputTokens: number;
	at?: Date;
}

/**
 * Per-user usage in the same USD the Free allowance uses, plus token counts.
 * Daily documents hold counts and costs. They never hold note or chat text.
 */
export class UsageDirectory {
	private backfilledAt = 0;

	constructor(private readonly store: UsageStore) {}

	async record(uid: string, call: UsageCall): Promise<void> {
		if (!(call.calls > 0) && !(call.costUsd > 0) && !(call.chargedUsd > 0)) return;
		const row: UsageDayRow = {
			uid,
			day: utcDay(call.at ?? new Date()),
			plan: call.plan,
			model: call.model,
			feature: call.feature,
			calls: call.calls,
			costUsd: call.costUsd,
			chargedUsd: call.chargedUsd,
			inputTokens: call.inputTokens,
			outputTokens: call.outputTokens,
		};
		await this.store.add(row);
	}

	async recordEvent(event: UsageEventRow): Promise<void> {
		await this.store.addEvent(event);
	}

	/** High-water mark for a Free month, so a later daily row is not added twice. */
	async noteSpend(record: AccountRecord): Promise<void> {
		if (record.plan !== "free" || !(record.spentUsd > 0)) return;
		await this.store.raiseLedger({
			uid: record.uid,
			period: record.period,
			plan: "free",
			costUsd: record.spentUsd,
			chargedUsd: record.spentUsd,
		});
	}

	/**
	 * Copy signup time from the account document and the current month's ledger.
	 * Older months were not stored as a history, so they cannot be rebuilt.
	 */
	async backfill(accounts: AccountDirectory, coupons: () => Promise<Array<{ uid: string; code: string }>> = async () => []): Promise<void> {
		if (Date.now() - this.backfilledAt < 60_000) return;
		const listed = await accounts.list();
		for (const row of listed) {
			try {
				await this.noteSpend(row.record);
			} catch (err) {
				console.error("Could not snapshot hosted spend.", err);
			}
			if (!row.record.createdAt && row.createTime) {
				try {
					await accounts.rememberCreated(row.record.uid, row.createTime);
				} catch (err) {
					console.error("Could not record when the account was created.", err);
				}
			}
		}
		try {
			for (const holder of await coupons()) await accounts.markCoupon(holder.uid, holder.code);
		} catch (err) {
			console.error("Could not read Stripe coupons.", err);
		}
		this.backfilledAt = Date.now();
	}

	async report(accounts: AccountDirectory, now = new Date()): Promise<UsageReport> {
		const [listed, days, ledgers, events] = await Promise.all([accounts.list(), this.store.listDays(), this.store.listLedgers(), this.store.listEvents()]);
		return buildUsageReport({
			now,
			accounts: listed.map((row) => ({
				uid: row.record.uid,
				email: row.record.email,
				plan: row.record.plan,
				createdAt: row.record.createdAt,
				period: row.record.period,
				spentUsd: row.record.spentUsd,
				couponCode: row.record.couponCode,
				tutorWeight: row.record.tutorWeight,
				membership: row.record.membership,
			})),
			days,
			ledgers,
			events,
			adminEmails: USAGE_ADMIN_EMAILS,
			limitUsd: PLANS.free.hostedCreditUsd,
		});
	}
}
