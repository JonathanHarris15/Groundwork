import { choosePlan, emptyAccount, viewAccount, type AccountRecord, type AccountView, type PlanId } from "@groundwork/core";

/** In-memory accounts until the Firebase service account is attached. */
export class AccountDirectory {
	private readonly accounts = new Map<string, AccountRecord>();

	get(uid: string, now: Date = new Date()): AccountView {
		return viewAccount(this.record(uid, now), now);
	}

	setPlan(uid: string, plan: PlanId, now: Date = new Date()): AccountView {
		const next = choosePlan(this.record(uid, now), plan, now);
		this.accounts.set(uid, next);
		return viewAccount(next, now);
	}

	private record(uid: string, now: Date): AccountRecord {
		return this.accounts.get(uid) ?? emptyAccount(uid, now);
	}
}
