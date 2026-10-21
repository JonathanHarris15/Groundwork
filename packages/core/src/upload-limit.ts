/**
 * Cloud Run refuses an HTTP/1 request above 32 MiB. The JSON tutor body
 * has to stay under that, with room for headers. A normal screenshot is
 * nowhere near it; this only trips for a file we could not shrink.
 */
export const JSON_BODY_LIMIT_BYTES = 30 * 1024 * 1024;

export function uploadTooLargeError(limit = JSON_BODY_LIMIT_BYTES): string {
	const mb = Math.round(limit / (1024 * 1024));
	return `That upload is too large. The limit is ${mb} MB.`;
}
