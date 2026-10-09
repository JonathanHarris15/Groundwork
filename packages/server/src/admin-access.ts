/**
 * Who may open /admin/usage.
 *
 * There is no separate admin role. The allowlist is the Firebase Google
 * sign-in support address in firebase.json (`auth.providers.googleSignIn.supportEmail`).
 * That is the Google account on this Firebase project.
 *
 * `GROUNDWORK_E2E_ADMIN_EMAIL` adds one address for Playwright. It is ignored
 * on Cloud Run (`K_SERVICE`), so a test address cannot become an admin in production.
 */
export const USAGE_ADMIN_EMAILS = ["jono591737@gmail.com"] as const;

export function normalizeAdminEmail(email: string | undefined): string {
	return email?.trim().toLowerCase() ?? "";
}

export function usageAdminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
	const emails = USAGE_ADMIN_EMAILS.map((email) => normalizeAdminEmail(email));
	if (env.GROUNDWORK_E2E === "1" && !env.K_SERVICE?.trim()) {
		const extra = normalizeAdminEmail(env.GROUNDWORK_E2E_ADMIN_EMAIL);
		if (extra && !emails.includes(extra)) emails.push(extra);
	}
	return emails;
}

export function isUsageAdmin(
	identity: { email?: string; emailVerified?: boolean },
	opts: { localDev: boolean; emails?: readonly string[] },
): boolean {
	const email = normalizeAdminEmail(identity.email);
	const allowed = (opts.emails ?? usageAdminEmails()).some((admin) => admin === email);
	if (allowed) return identity.emailVerified !== false;
	// Local mode has one shared user and no Firebase email. Production always has an email.
	return opts.localDev && !email;
}
