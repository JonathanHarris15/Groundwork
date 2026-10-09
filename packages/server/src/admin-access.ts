/**
 * Who may open /admin/usage.
 *
 * There is no separate admin role. The allowlist is the Firebase Google
 * sign-in support address in firebase.json (`auth.providers.googleSignIn.supportEmail`).
 * That is the Google account on this Firebase project.
 */
export const USAGE_ADMIN_EMAILS = ["jono591737@gmail.com"] as const;

export function isUsageAdmin(identity: { email?: string }, opts: { localDev: boolean }): boolean {
	const email = identity.email?.trim().toLowerCase();
	if (email && USAGE_ADMIN_EMAILS.some((admin) => admin === email)) return true;
	// Local mode has one shared user and no Firebase email. Production always has an email.
	return opts.localDev && !email;
}
