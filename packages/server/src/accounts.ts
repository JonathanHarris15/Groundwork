import {
	choosePlan,
	clearStripeCustomer,
	currentAccount,
	emptyAccount,
	periodKey,
	rememberProfile,
	setDisplayName,
	setStripeCustomer,
	setTutorChoice,
	setTutorWeight,
	settleHosted,
	tutorChoiceFrom,
	viewAccount,
	type AccountRecord,
	type AccountView,
	type PlanId,
	type StoredAttribution,
	type TutorChoice,
	type TutorWeight,
} from "@groundwork/core";
import type { AccountStore, ListedAccount } from "./account-store";

/**
 * Accounts for signed-in learners.
 * With a store, the plan, name, billing customer, tutor choice, and monthly spend
 * survive a restart and are visible to every server process.
 */
export interface AccountHooks {
	/** The stored month is about to roll forward. `closed` still has that month's spend. */
	onPeriodClose?(closed: AccountRecord): Promise<void>;
	/** Hosted spend was just written. */
	onSpend?(record: AccountRecord): Promise<void>;
}

export class AccountDirectory {
	private readonly accounts = new Map<string, AccountRecord>();

	constructor(
		private readonly store?: AccountStore,
		private readonly hooks?: AccountHooks,
	) {}

	async get(uid: string, now: Date = new Date()): Promise<AccountView> {
		return viewAccount(await this.record(uid, now), now);
	}

	async seen(
		uid: string,
		profile: { email?: string; name?: string },
		attribution?: StoredAttribution | null,
		now: Date = new Date(),
	): Promise<{ view: AccountView; created: boolean }> {
		const existing = await this.readRecord(uid);
		const view = await this.commit(uid, now, (record) => {
			let next = rememberProfile(currentAccount(record, now), profile);
			if (attribution && !hasAttribution(next.attribution)) next = { ...next, attribution };
			return next;
		});
		const created = !existing && !!(await this.readRecord(uid));
		return { view, created };
	}

	/** First call for an account returns `{ first: true }`. Later calls do not. */
	async connectObsidian(uid: string, now: Date = new Date()): Promise<{ first: boolean }> {
		const existing = await this.readRecord(uid);
		if (existing?.obsidianConnectedAt) return { first: false };
		await this.commit(uid, now, (record) => {
			if (record.obsidianConnectedAt) return currentAccount(record, now);
			return { ...currentAccount(record, now), obsidianConnectedAt: now.toISOString() };
		});
		return { first: true };
	}

	async setPlan(uid: string, plan: PlanId, now: Date = new Date()): Promise<AccountView> {
		return this.commit(uid, now, (record) => choosePlan(record, plan, now));
	}

	async rename(uid: string, name: string, now: Date = new Date()): Promise<AccountView> {
		return this.commit(uid, now, (record) => setDisplayName(record, name));
	}

	async customerId(uid: string, now: Date = new Date()): Promise<string | undefined> {
		return (await this.record(uid, now)).stripeCustomerId;
	}

	async attachCustomer(uid: string, customerId: string, now: Date = new Date()): Promise<void> {
		await this.commit(uid, now, (record) => setStripeCustomer(record, customerId));
	}

	/** Forget a customer id Stripe no longer has, so the next checkout can create one. */
	async clearCustomer(uid: string, now: Date = new Date()): Promise<void> {
		await this.commit(uid, now, (record) => clearStripeCustomer(record));
	}

	async choice(uid: string, now: Date = new Date()): Promise<TutorChoice> {
		return tutorChoiceFrom(await this.record(uid, now));
	}

	async setTutor(uid: string, choice: { via: "claude" | "key"; provider?: string | null }, now: Date = new Date()): Promise<AccountView> {
		return this.commit(uid, now, (record) => setTutorChoice(record, choice, now));
	}

	async setTutorWeight(uid: string, weight: TutorWeight, now: Date = new Date()): Promise<AccountView> {
		return this.commit(uid, now, (record) => setTutorWeight(record, weight, now));
	}

	/** Apply one hosted tutor turn to the allowance. */
	async charge(uid: string, costUsd: number, now: Date = new Date()): Promise<{ view: AccountView; chargedUsd: number }> {
		let chargedUsd = 0;
		const view = await this.commit(uid, now, (record) => {
			const settled = settleHosted(record, costUsd, now);
			chargedUsd = settled.chargedUsd;
			return settled.account;
		});
		const saved = await this.readRecord(uid);
		if (saved && saved.spentUsd > 0) await this.safeHook(this.hooks?.onSpend?.bind(this.hooks), saved);
		return { view, chargedUsd };
	}

	async list(): Promise<ListedAccount[]> {
		if (!this.store) return [...this.accounts.values()].map((record) => ({ record }));
		return this.store.list();
	}

	/** Stamp a signup time discovered from the account document. Does not invent one. */
	async rememberCreated(uid: string, createdAt: string, now: Date = new Date()): Promise<void> {
		const existing = await this.readRecord(uid);
		if (!existing || existing.createdAt) return;
		await this.commit(uid, now, (record) => (record.createdAt ? record : { ...record, createdAt }));
	}

	async markCoupon(uid: string, code: string, now: Date = new Date()): Promise<void> {
		const cleaned = code.trim();
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(cleaned)) return;
		const existing = await this.readRecord(uid);
		if (!existing || existing.couponCode === cleaned) return;
		await this.commit(uid, now, (record) => (record.couponCode === cleaned ? record : { ...record, couponCode: cleaned }));
	}

	async findByCustomer(customerId: string): Promise<AccountRecord | undefined> {
		if (this.store) {
			const uid = await this.store.findByCustomer(customerId);
			if (!uid) return undefined;
			return (await this.store.read(uid)) ?? undefined;
		}
		for (const record of this.accounts.values()) {
			if (record.stripeCustomerId === customerId) return record;
		}
		return undefined;
	}

	private async readRecord(uid: string): Promise<AccountRecord | null> {
		if (!this.store) return this.accounts.get(uid) ?? null;
		return this.store.read(uid);
	}

	private async record(uid: string, now: Date): Promise<AccountRecord> {
		return (await this.readRecord(uid)) ?? emptyAccount(uid, now);
	}

	/**
	 * Apply `change` to the stored account.
	 * A read that already matches is not written again, so a page view does not
	 * stamp the database. Real edits are applied inside the store so two
	 * processes cannot drop each other's plan.
	 */
	private async commit(uid: string, now: Date, change: (record: AccountRecord) => AccountRecord): Promise<AccountView> {
		if (!this.store) {
			const current = this.accounts.get(uid) ?? null;
			await this.closePeriod(current, now);
			const next = stampCreated(current, change(current ?? emptyAccount(uid, now)), now);
			this.accounts.set(uid, next);
			return viewAccount(next, now);
		}
		const existing = await this.store.read(uid);
		await this.closePeriod(existing, now);
		const base = existing ?? emptyAccount(uid, now);
		const preview = stampCreated(existing, change(base), now);
		if (existing && sameAccount(existing, preview)) return viewAccount(preview, now);
		if (!existing && sameAccount(preview, emptyAccount(uid, now))) return viewAccount(preview, now);
		const saved = await this.store.update(uid, (record) => stampCreated(record, change(record ?? emptyAccount(uid, now)), now));
		return viewAccount(saved, now);
	}

	private async closePeriod(record: AccountRecord | null, now: Date): Promise<void> {
		if (!record || !(record.spentUsd > 0) || record.period === periodKey(now)) return;
		await this.safeHook(this.hooks?.onPeriodClose?.bind(this.hooks), record);
	}

	private async safeHook(hook: ((record: AccountRecord) => Promise<void>) | undefined, record: AccountRecord): Promise<void> {
		if (!hook) return;
		try {
			await hook(record);
		} catch (err) {
			console.error("Could not snapshot hosted spend.", err);
		}
	}
}

function stampCreated(previous: AccountRecord | null, next: AccountRecord, now: Date): AccountRecord {
	if (previous?.createdAt || next.createdAt) return next;
	if (previous) return next;
	return { ...next, createdAt: now.toISOString() };
}

function sameAccount(a: AccountRecord, b: AccountRecord): boolean {
	return (
		a.uid === b.uid &&
		a.plan === b.plan &&
		a.period === b.period &&
		a.spentUsd === b.spentUsd &&
		a.displayName === b.displayName &&
		a.email === b.email &&
		a.stripeCustomerId === b.stripeCustomerId &&
		a.tutorVia === b.tutorVia &&
		a.tutorProvider === b.tutorProvider &&
		a.tutorWeight === b.tutorWeight &&
		a.obsidianConnectedAt === b.obsidianConnectedAt &&
		a.createdAt === b.createdAt &&
		a.couponCode === b.couponCode &&
		attributionKey(a.attribution) === attributionKey(b.attribution)
	);
}

function hasAttribution(value: StoredAttribution | undefined): boolean {
	return attributionKey(value).length > 0;
}

function attributionKey(value: StoredAttribution | undefined): string {
	if (!value) return "";
	return [value.utmSource, value.utmMedium, value.utmCampaign, value.utmTerm, value.utmContent, value.gclid].filter(Boolean).join("\0");
}
