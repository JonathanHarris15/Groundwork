import type { FirebaseSession } from "@groundwork/core";

export interface RedeemPayload {
	customToken?: unknown;
	token?: unknown;
	email?: unknown;
	displayName?: unknown;
	error?: unknown;
}

/** Session the plugin stores after the website redeems a setup code. The code itself is not a secret we keep. */
export async function sessionFromRedeem(
	body: RedeemPayload,
	exchange: (customToken: string) => Promise<Pick<FirebaseSession, "refreshToken">>,
): Promise<{ refreshToken: string; label: string }> {
	let refreshToken = "";
	if (typeof body.customToken === "string" && body.customToken) {
		refreshToken = (await exchange(body.customToken)).refreshToken;
	} else if (typeof body.token === "string" && body.token) {
		refreshToken = body.token;
	} else {
		const message = typeof body.error === "string" && body.error ? body.error : "That code doesn't work. Create a new one on the website.";
		throw new Error(message);
	}
	const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
	const email = typeof body.email === "string" ? body.email.trim() : "";
	return { refreshToken, label: displayName || email };
}
