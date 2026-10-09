import { contextRequest, freeResponseRequest, includedPieceIds, judgmentFromAnswers, type ContextPiece, type FreeResponseJudgment, type FreeResponseToGrade } from "@groundwork/core";
import { TypeSafeClient } from "@typesafe-ai/sdk";

let client: TypeSafeClient | null = null;

/** The TypeSafe client reads TYPESAFE_API_KEY from the environment and nothing else. */
export function jevConfigured(): boolean {
	return !!process.env.TYPESAFE_API_KEY?.trim();
}

function jevClient(): TypeSafeClient {
	if (!jevConfigured()) throw new Error("TYPESAFE_API_KEY is not set on the Groundwork server.");
	client ??= new TypeSafeClient();
	return client;
}

export async function selectContextWithJev(message: string, pieces: ContextPiece[], signal?: AbortSignal): Promise<string[]> {
	const request = contextRequest(message, pieces);
	if (!Object.keys(request.questions).length) return [];
	const result = await jevClient().systemOne(request as never, { signal });
	return includedPieceIds(pieces, result.answers);
}

export async function gradeWithJev(items: FreeResponseToGrade[], signal?: AbortSignal): Promise<Array<FreeResponseJudgment | null>> {
	const request = freeResponseRequest(items);
	const result = await jevClient().systemOne(request as never, { signal });
	return items.map((_, i) => judgmentFromAnswers(i, result.answers as Record<string, { type?: string; choice?: string; confidence?: number; noul?: number }>));
}
