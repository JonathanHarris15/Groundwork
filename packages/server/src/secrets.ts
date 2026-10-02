import { isUserKeyProvider, USER_KEY_PROVIDERS, type UserKeyProvider } from "@groundwork/core";

/**
 * Learner provider keys, held for the life of this process.
 * The response surface only reports which providers are saved.
 * Jev is not a slot here.
 */
export class SecretDirectory {
	private readonly byUser = new Map<string, Map<UserKeyProvider, string>>();

	save(uid: string, provider: string, apiKey: string): UserKeyProvider {
		if (!isUserKeyProvider(provider)) {
			throw new SecretError(provider === "jev" || provider === "typesafe" ? "Jev is configured on the server. It is not a key you paste." : `Unknown provider "${provider}".`);
		}
		const key = apiKey.trim();
		if (!key) throw new SecretError("Paste the API key.");
		let slot = this.byUser.get(uid);
		if (!slot) {
			slot = new Map();
			this.byUser.set(uid, slot);
		}
		slot.set(provider, key);
		return provider;
	}

	/** For a later model proxy. Never send this back to the client. */
	get(uid: string, provider: UserKeyProvider): string | undefined {
		return this.byUser.get(uid)?.get(provider);
	}

	saved(uid: string): Record<UserKeyProvider, boolean> {
		const slot = this.byUser.get(uid);
		return Object.fromEntries(USER_KEY_PROVIDERS.map((p) => [p, !!slot?.has(p)])) as Record<UserKeyProvider, boolean>;
	}
}

export class SecretError extends Error {}
