import type { FetchLike } from "./platform-fetch";

/** Flag the admin page when the OpenRouter wallet falls under this. */
export const OPENROUTER_LOW_BALANCE_USD = 3;

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

export interface OpenRouterBalance {
	remainingUsd: number;
	low: boolean;
}

/** Remaining OpenRouter wallet, from `GET /api/v1/credits`. Low when remaining is under $3. */
export async function readOpenRouterBalance(apiKey: string, fetchImpl: FetchLike): Promise<OpenRouterBalance> {
	const response = await fetchImpl(CREDITS_URL, {
		method: "GET",
		headers: { authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) throw new Error(`OpenRouter credits returned ${response.status}.`);
	const body: unknown = await response.json();
	const record = asRecord(body);
	const data = asRecord(record?.data) ?? record;
	const totalCredits = finiteNumber(data?.total_credits);
	const totalUsage = finiteNumber(data?.total_usage);
	if (totalCredits == null || totalUsage == null) throw new Error("OpenRouter credits response was missing totals.");
	const remainingUsd = totalCredits - totalUsage;
	return { remainingUsd, low: remainingUsd < OPENROUTER_LOW_BALANCE_USD };
}

export function formatUsd(value: number): string {
	const text = Math.abs(value).toFixed(2);
	return value < 0 ? `-$${text}` : `$${text}`;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
