import { asRecord } from "../unknown";
import type { ChatMessage } from "../agent/types";

/**
 * What a hosted call was for.
 * Older plugins omit the tag. Those calls still count, as `unknown`.
 */
export const USAGE_FEATURES = [
	"tutor_chat",
	"quiz",
	"practice_test",
	"flashcards",
	"exam_prep",
	"diagnose",
	"grading",
	"other",
	"unknown",
] as const;

export type UsageFeature = (typeof USAGE_FEATURES)[number];

export const USAGE_FEATURE_LABEL: Record<UsageFeature, string> = {
	tutor_chat: "Tutor chat",
	quiz: "Quiz",
	practice_test: "Practice test",
	flashcards: "Flashcards",
	exam_prep: "Exam prep",
	diagnose: "Diagnose",
	grading: "Grading",
	other: "Other",
	unknown: "Unknown",
};

const TOOL_FEATURE: Record<string, UsageFeature> = {
	grade_answer: "grading",
	grade_practice_test: "grading",
	practice_test: "practice_test",
	save_flashcard: "flashcards",
	list_flashcards: "flashcards",
	get_due_reviews: "flashcards",
	ingest_exam_materials: "exam_prep",
	get_exam_plan: "exam_prep",
};

export function isUsageFeature(value: unknown): value is UsageFeature {
	return typeof value === "string" && (USAGE_FEATURES as readonly string[]).includes(value);
}

/**
 * Tag sent by the plugin. A missing or unrecognized value is `unknown`,
 * so a 0.1.17 client still counts.
 */
export function usageFeatureFromClient(value: unknown): UsageFeature {
	if (value == null || value === "") return "unknown";
	return isUsageFeature(value) ? value : "unknown";
}

/**
 * Feature for the tutor call the plugin is about to send.
 * Tool names and a quiz `kind` choose it. The text of the chat is not stored.
 */
export function usageFeatureFromThread(messages: ChatMessage[]): UsageFeature {
	for (let i = messages.length - 1; i >= 0; i--) {
		const content = messages[i]?.content;
		if (!Array.isArray(content)) continue;
		for (let j = content.length - 1; j >= 0; j--) {
			const block = content[j];
			if (!block || block.type !== "tool_use" || typeof block.name !== "string") continue;
			if (block.name === "quiz") return toolKind(block.input) === "probe" ? "diagnose" : "quiz";
			const mapped = TOOL_FEATURE[block.name];
			if (mapped) return mapped;
		}
	}
	const text = lastUserText(messages);
	if (/\bpractice test\b|\bmock exam\b|\btest me\b/i.test(text)) return "practice_test";
	if (/\bflashcards?\b/i.test(text)) return "flashcards";
	if (/\bdiagnos/i.test(text)) return "diagnose";
	if (/\bexam\b|\bmidterm\b|\bfinal\b/i.test(text)) return "exam_prep";
	if (/\bquiz/i.test(text)) return "quiz";
	if (text.trim()) return "tutor_chat";
	return "other";
}

function toolKind(input: unknown): string | undefined {
	const record = asRecord(input);
	const kind = record?.kind;
	return typeof kind === "string" ? kind : undefined;
}

function lastUserText(messages: ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const parts: string[] = [];
		for (const block of message.content) {
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
		if (parts.length) return parts.join(" ");
	}
	return "";
}
