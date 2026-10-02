import {
	choosePlan,
	emptyAccount,
	rememberProfile,
	setDisplayName,
	setStripeCustomer,
	setTutorChoice,
	settleHosted,
	tutorChoiceFrom,
	viewAccount,
	type AccountRecord,
	type AccountView,
	type PlanId,
	type TutorChoice,
} from "@groundwork/core";

/** In-memory accounts until the Firebase service account is attached. */
export class AccountDirectory {
	private readonly accounts = new Map<string, AccountRecord>();

	get(uid: string, now: Date = new Date()): AccountView {
		return viewAccount(this.record(uid, now), now);
	}

	seen(uid: string, profile: { email?: string; name?: string }, now: Date = new Date()): AccountView {
		const next = rememberProfile(this.record(uid, now), profile);
		this.accounts.set(uid, next);
		return viewAccount(next, now);
	}

	setPlan(uid: string, plan: PlanId, now: Date = new Date()): AccountView {
		const next = choosePlan(this.record(uid, now), plan, now);
		this.accounts.set(uid, next);
		return viewAccount(next, now);
	}

	rename(uid: string, name: string, now: Date = new Date()): AccountView {
		const next = setDisplayName(this.record(uid, now), name);
		this.accounts.set(uid, next);
		return viewAccount(next, now);
	}

	customerId(uid: string, now: Date = new Date()): string | undefined {
		return this.record(uid, now).stripeCustomerId;
	}

	attachCustomer(uid: string, customerId: string, now: Date = new Date()): void {
		this.accounts.set(uid, setStripeCustomer(this.record(uid, now), customerId));
	}

	choice(uid: string, now: Date = new Date()): TutorChoice {
		return tutorChoiceFrom(this.record(uid, now));
	}

	setTutor(uid: string, choice: { via: "claude" | "key"; provider?: string | null }, now: Date = new Date()): AccountView {
		const next = setTutorChoice(this.record(uid, now), choice, now);
		this.accounts.set(uid, next);
		return viewAccount(next, now);
	}

	/** Apply one hosted tutor turn to the allowance. */
	charge(uid: string, costUsd: number, now: Date = new Date()): AccountView {
		const settled = settleHosted(this.record(uid, now), costUsd, now);
		this.accounts.set(uid, settled.account);
		return viewAccount(settled.account, now);
	}

	findByCustomer(customerId: string): AccountRecord | undefined {
		for (const record of this.accounts.values()) {
			if (record.stripeCustomerId === customerId) return record;
		}
		return undefined;
	}

	private record(uid: string, now: Date): AccountRecord {
		return this.accounts.get(uid) ?? emptyAccount(uid, now);
	}
}
