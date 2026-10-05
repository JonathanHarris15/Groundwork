import { isUserKeyProvider, USER_KEY_PROVIDERS, type UserKeyProvider } from "@groundwork/core";
import type { SecretStore } from "./secret-store";

/**
 * Learner provider keys.
 * With a store, a key saved on one server process is available to the next,
 * and to every other Cloud Run instance. The response surface only reports
 * which providers are saved. Jev is not a slot here.
 */
const MAX_SECRET_CHARS = 512;

export class SecretDirectory {
	private readonly byUser = new Map<string, Map<UserKeyProvider, string>>();

	constructor(private readonly store?: SecretStore) {}

	async save(uid: string, provider: string, apiKey: string): Promise<UserKeyProvider> {
		if (!isUserKeyProvider(provider)) {
			throw new SecretError(provider === "jev" || provider === "typesafe" ? "Answer grading runs on Groundwork's servers. It is not an API key you paste." : `Unknown provider "${provider}".`);
		}
		const key = apiKey.trim();
		if (!key) throw new SecretError("Paste the API key.");
		if (key.length > MAX_SECRET_CHARS) throw new SecretError("That API key is too long.");
		if (this.store) {
			await this.store.update(uid, (current) => ({ ...current, [provider]: key }));
			this.byUser.delete(uid);
			return provider;
		}
		const slot = await this.slot(uid);
		slot.set(provider, key);
		this.byUser.set(uid, slot);
		return provider;
	}

	/** For a later model proxy. Never send this back to the client. */
	async get(uid: string, provider: UserKeyProvider): Promise<string | undefined> {
		return (await this.slot(uid)).get(provider);
	}

	async saved(uid: string): Promise<Record<UserKeyProvider, boolean>> {
		const slot = await this.slot(uid);
		return Object.fromEntries(USER_KEY_PROVIDERS.map((p) => [p, slot.has(p)])) as Record<UserKeyProvider, boolean>;
	}

	/** Read the store every time so another instance's write is visible. */
	private async slot(uid: string): Promise<Map<UserKeyProvider, string>> {
		if (this.store) {
			const saved = await this.store.read(uid);
			const slot = new Map<UserKeyProvider, string>();
			if (saved) {
				for (const provider of USER_KEY_PROVIDERS) {
					const key = saved[provider];
					if (key) slot.set(provider, key);
				}
			}
			return slot;
		}
		let slot = this.byUser.get(uid);
		if (!slot) {
			slot = new Map();
			this.byUser.set(uid, slot);
		}
		return slot;
	}
}

export class SecretError extends Error {}
