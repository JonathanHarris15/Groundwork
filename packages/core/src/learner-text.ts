/** Shown when a reply is only an internal fixture id. */
export const LOST_REPLY = "I lost that reply. Ask me to continue.";

const CANARY = /\btest_tutor_prevention_\d+\b/g;
const ONLY_FIXTURE = /^\s*test_[a-z0-9_]{3,}\s*$/i;

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
