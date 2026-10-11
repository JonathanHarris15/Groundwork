/** Unambiguous letters and digits. No 0, O, 1, or I. */
export const CONNECT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const CONNECT_CODE_LENGTH = 10;

/** About ten minutes. The code is single-use and holds no long-lived secret. */
export const CONNECT_CODE_TTL_MS = 10 * 60 * 1000;

/** Compact form, or null when the text is not a setup code. */
export function normalizeConnectCode(raw: string): string | null {
	const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (compact.length !== CONNECT_CODE_LENGTH) return null;
	for (const ch of compact) {
		if (!CONNECT_CODE_ALPHABET.includes(ch)) return null;
	}
	return compact;
}

/** `ABCDEFGHJK` → `ABCDE-FGHJK`. */
export function formatConnectCode(compact: string): string {
	return `${compact.slice(0, 5)}-${compact.slice(5)}`;
}
