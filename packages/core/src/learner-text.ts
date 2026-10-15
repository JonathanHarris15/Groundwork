/** Shown when a reply is only an internal fixture id. */
export const LOST_REPLY = "I lost that reply. Ask me to continue.";

const CANARY = /\btest_tutor_prevention_\d+\b/g;
const ONLY_FIXTURE = /^\s*test_[a-z0-9_]{3,}\s*$/i;
const FIXTURE_PREFIX = "test_";

/** True when this buffer could still grow into nothing but an internal test id. */
export function holdsFixturePrefix(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	if (trimmed.length > 80) return false;
	return ONLY_FIXTURE.test(trimmed) || /^test_[a-z0-9_]*$/i.test(trimmed) || FIXTURE_PREFIX.startsWith(trimmed.toLowerCase());
}

/** A final reply that is blank, or only an internal test id. The turn should continue. */
export function isGarbageReply(text: string): boolean {
	return !text.trim() || ONLY_FIXTURE.test(text);
}

/**
 * Learner-visible text. A reply that is only an internal test id is replaced.
 * The same id inside a real sentence is removed. Ordinary prose that merely
 * says "test" is left as written.
 */
export function scrubLearnerText(text: string): string {
	if (ONLY_FIXTURE.test(text)) return LOST_REPLY;
	if (!CANARY.test(text)) return text;
	CANARY.lastIndex = 0;
	const cleaned = text
		.replace(CANARY, "")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return cleaned || LOST_REPLY;
}
