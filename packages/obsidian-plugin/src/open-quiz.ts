import type { PreparedQuiz } from "@groundwork/core";

/** A chat row the plugin can scan without loading the whole view. */
export interface QuizHistoryRow {
	kind?: string;
	quiz?: { id?: string };
}

/**
 * The quiz still waiting for an answer, or null once it has been answered or the saved value is unusable.
 * Closing Obsidian writes this onto the chat; reopening reads it back.
 */
export function pendingQuiz(record: { openQuiz?: unknown; items?: unknown }): PreparedQuiz | null {
	const quiz = asQuiz(record.openQuiz);
	if (!quiz) return null;
	if (answered(record.items, quiz.id)) return null;
	return quiz;
}

function answered(items: unknown, id: string): boolean {
	if (!Array.isArray(items)) return false;
	return items.some((item) => {
		if (!item || typeof item !== "object") return false;
		const row = item as QuizHistoryRow;
		return row.kind === "quiz" && row.quiz?.id === id;
	});
}

function asQuiz(value: unknown): PreparedQuiz | null {
	if (!value || typeof value !== "object") return null;
	const quiz = value as PreparedQuiz;
	if (typeof quiz.id !== "string" || !quiz.id.trim()) return null;
	if (typeof quiz.question !== "string" || !quiz.question.trim()) return null;
	if (typeof quiz.concept !== "string" || !quiz.concept.trim()) return null;
	if (quiz.format !== "choice" && quiz.format !== "free") return null;
	if (!Array.isArray(quiz.options)) return null;
	return quiz;
}
