/** Public values the account site needs. Nothing in here is a secret. */
export interface WebConfig {
	firebase: { apiKey: string; authDomain: string; projectId: string } | null;
	billing: boolean;
}

export function webConfig(billing: boolean): WebConfig {
	const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim();
	const authDomain = process.env.FIREBASE_AUTH_DOMAIN?.trim();
	const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
	const firebase = apiKey && authDomain && projectId ? { apiKey, authDomain, projectId } : null;
	return { firebase, billing };
}
