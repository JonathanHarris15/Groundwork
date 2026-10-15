import { visibleAsk } from "./intent";

/** They want the tutor to continue a conversation that may live in an earlier chat. */
export function asksToResumeConversation(text: string): boolean {
	const visible = visibleAsk(text);
	if (!visible) return false;
	return (
		(/\bpick up\b/i.test(visible) && /\bconversation\b/i.test(visible)) ||
		/\bwhere we left off\b/i.test(visible) ||
		/\bwe were just having\b/i.test(visible) ||
		/\bcontinue (?:the |our )?(?:conversation|chat)\b/i.test(visible)
	);
}

/** Put the saved transcript in front of this message so a new chat can continue it. */
export function resumePrompt(message: string, prior: string | undefined): string {
	const transcript = prior?.trim().slice(-40_000) ?? "";
	if (!transcript || message.includes("<previous_conversation>")) return message;
	return [
		"Here is our conversation so far, from an earlier session:",
		"",
		"<previous_conversation>",
		transcript,
		"</previous_conversation>",
		"",
		"Continue from there. My new message:",
		"",
		message,
	].join("\n");
}
