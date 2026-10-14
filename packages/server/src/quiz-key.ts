import {
	askFreeKeyModel,
	askQuizKeyModel,
	parseFreeKeySubject,
	parseQuizKeySubject,
	type FreeKeyModelResult,
	type HttpClient,
	type HttpResponse,
	type QuizKeyModelResult,
} from "@groundwork/core";
import type { FetchLike } from "./platform-fetch";

/** The OpenRouter key stays on the server. The plugin only sends the question. */
export async function checkQuizKey(fetchImpl: FetchLike, apiKey: string, body: unknown): Promise<QuizKeyModelResult | FreeKeyModelResult> {
	const free = parseFreeKeySubject(body);
	if (free) return askFreeKeyModel(asHttp(fetchImpl), apiKey, free);
	const subject = parseQuizKeySubject(body);
	if (!subject) throw Object.assign(new Error("Send the question, the options, and the keyed option."), { status: 400 });
	return askQuizKeyModel(asHttp(fetchImpl), apiKey, subject);
}

function asHttp(fetchImpl: FetchLike): HttpClient {
	return async (url, init) => {
		const res = await fetchImpl(url, {
			method: init?.method,
			headers: init?.headers,
			body: init?.body,
			signal: init?.signal,
		});
		return toHttp(res);
	};
}

function toHttp(res: Response): HttpResponse {
	return {
		ok: res.ok,
		status: res.status,
		statusText: res.statusText,
		headers: { get: (name) => res.headers.get(name) },
		text: () => res.text(),
		json: () => res.json(),
		arrayBuffer: () => res.arrayBuffer(),
		body: null,
	};
}
