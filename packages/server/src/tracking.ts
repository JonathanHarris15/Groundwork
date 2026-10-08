import type { StoredAttribution } from "@groundwork/core";

/** Shown when CONTACT_EMAIL is unset. Override with the env var. */
export const CONTACT_EMAIL_DEFAULT = "methoddev1505@gmail.com";

const FIELD_MAX = 120;
const HEADER_MAX = 1024;

const SNAKE_TO_CAMEL = {
	utm_source: "utmSource",
	utm_medium: "utmMedium",
	utm_campaign: "utmCampaign",
	utm_term: "utmTerm",
	utm_content: "utmContent",
	gclid: "gclid",
} as const;

type SnakeKey = keyof typeof SNAKE_TO_CAMEL;
type CamelKey = (typeof SNAKE_TO_CAMEL)[SnakeKey];

export interface Attribution {
	utm_source?: string;
	utm_medium?: string;
	utm_campaign?: string;
	utm_term?: string;
	utm_content?: string;
	gclid?: string;
}

export type ConsentChoice = "granted" | "denied";

export interface ConsentCommand {
	ad_storage: ConsentChoice;
	ad_user_data: ConsentChoice;
	ad_personalization: ConsentChoice;
	analytics_storage: ConsentChoice;
	region?: string[];
}

const DENIED: ConsentCommand = {
	ad_storage: "denied",
	ad_user_data: "denied",
	ad_personalization: "denied",
	analytics_storage: "denied",
};

const GRANTED: ConsentCommand = {
	ad_storage: "granted",
	ad_user_data: "granted",
	ad_personalization: "granted",
	analytics_storage: "granted",
};

export function resolveContactEmail(envValue: string | undefined): string {
	const trimmed = envValue?.trim();
	return trimmed || CONTACT_EMAIL_DEFAULT;
}

/** Production measurement id. Cloud Run uses this when GA4_MEASUREMENT_ID is unset. */
export const PRODUCTION_GA4_MEASUREMENT_ID = "G-F4236HGZSM";

/** GA4 ids look like G-ABC123. Ads ids look like AW-123. Anything else is ignored. */
export function measurementIds(ga4: string | undefined, ads: string | undefined): { ga4: string | null; ads: string | null } {
	const g = ga4?.trim() ?? "";
	const a = ads?.trim() ?? "";
	return {
		ga4: /^G-[A-Z0-9]+$/i.test(g) ? g : null,
		ads: /^AW-\d+$/i.test(a) ? a : null,
	};
}

/**
 * GA4 is on in production even when the env var is empty. An explicit env value
 * wins, including a blank override only when it is unset. Ads stays off until
 * GOOGLE_ADS_ID is a real AW- id. Conversion labels are not required.
 */
export function resolveMeasurementIds(input: { ga4: string | undefined; ads: string | undefined; production: boolean }): { ga4: string | null; ads: string | null } {
	const parsed = measurementIds(input.ga4, input.ads);
	const explicit = input.ga4?.trim() ?? "";
	const ga4 = explicit ? parsed.ga4 : input.production ? PRODUCTION_GA4_MEASUREMENT_ID : null;
	return { ga4, ads: parsed.ads };
}

export function tagScriptUrl(ids: { ga4: string | null; ads: string | null }): string | null {
	const id = ids.ga4 || ids.ads;
	if (!id) return null;
	return `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
}

/**
 * No stored choice: denied everywhere, granted for visitors Google places in the US.
 * A stored Opt out (or an older Allow) replaces that for every region.
 */
export function consentDefaults(stored: ConsentChoice | null): ConsentCommand[] {
	if (stored === "granted") return [{ ...GRANTED }];
	if (stored === "denied") return [{ ...DENIED }];
	return [{ ...DENIED }, { ...GRANTED, region: ["US"] }];
}

export function attributionFromSearch(search: string): Attribution {
	const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
	const out: Attribution = {};
	for (const key of Object.keys(SNAKE_TO_CAMEL) as SnakeKey[]) {
		const clean = cleanField(params.get(key));
		if (clean) out[key] = clean;
	}
	return out;
}

/** First touch wins. A later landing does not replace a click we already stored. */
export function mergeAttribution(stored: Attribution | null, fresh: Attribution): Attribution | null {
	if (hasClientAttribution(stored)) return stored;
	if (!hasClientAttribution(fresh)) return stored;
	return fresh;
}

export function hasClientAttribution(value: Attribution | null | undefined): boolean {
	if (!value) return false;
	return Object.values(value).some((item) => typeof item === "string" && item.length > 0);
}

export function attributionFromHeader(value: string | undefined): StoredAttribution | null {
	if (!value) return null;
	let decoded = value;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return null;
	}
	if (decoded.length > HEADER_MAX) return null;
	try {
		return attributionFromUnknown(JSON.parse(decoded));
	} catch {
		return null;
	}
}

export function attributionFromUnknown(value: unknown): StoredAttribution | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const out: StoredAttribution = {};
	for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL) as Array<[SnakeKey, CamelKey]>) {
		const picked = raw[snake] ?? raw[camel];
		const clean = typeof picked === "string" ? cleanField(picked) : undefined;
		if (clean) out[camel] = clean;
	}
	return Object.keys(out).length ? out : null;
}

export function clientAttribution(stored: StoredAttribution | null | undefined): Attribution {
	if (!stored) return {};
	const out: Attribution = {};
	for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL) as Array<[SnakeKey, CamelKey]>) {
		const value = stored[camel];
		if (value) out[snake] = value;
	}
	return out;
}

/**
 * List price of a plan, in dollars. Display only.
 * A GA4 purchase uses the Checkout Session `amount_total`, never this number.
 */
export function purchaseValue(plan: string | null | undefined): 6 | 20 | null {
	if (plan === "byom") return 6;
	if (plan === "included") return 20;
	return null;
}

const PRODUCTION_HOSTS = new Set(["groundworklearn.com", "www.groundworklearn.com"]);

/**
 * The production tag loads only for a real visitor on the live site.
 * Local servers, Playwright (`navigator.webdriver`), and headless agents must not hit G-F4236HGZSM.
 */
export function shouldLoadMeasurementTag(input: { hostname: string; webdriver: boolean; userAgent?: string }): boolean {
	if (input.webdriver) return false;
	if (/HeadlessChrome|PhantomJS|Playwright/i.test(input.userAgent ?? "")) return false;
	const host = input.hostname.trim().toLowerCase().replace(/\.$/, "");
	return PRODUCTION_HOSTS.has(host);
}

/** GA4 client id, the `123.456` pair from the `_ga` cookie or `gtag('get', …, 'client_id')`. */
export function cleanGaClientId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const id = value.trim();
	return /^\d{1,20}\.\d{1,20}$/.test(id) ? id : null;
}

/** GA4 session id is a decimal string. */
export function cleanGaSessionId(value: unknown): string | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const id = String(value).trim();
	return /^\d{1,20}$/.test(id) ? id : null;
}

/** Google click id stored on the Checkout Session so a server purchase can join the ad click. */
export function cleanGclid(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const id = value.trim();
	return /^[A-Za-z0-9._-]{10,250}$/.test(id) ? id : null;
}

/** Last two dot-separated numbers of a `_ga` cookie. */
export function gaClientIdFromCookie(cookie: string): string | null {
	const match = /(?:^|; )_ga=GA\d+\.\d+\.(\d+\.\d+)(?:;|$)/.exec(cookie);
	return cleanGaClientId(match?.[1] ?? null);
}

/** Session id from a GA4 `_ga_<stream>` cookie (GS1 or GS2). */
export function gaSessionIdFromCookie(cookie: string): string | null {
	for (const part of cookie.split(";")) {
		const trimmed = part.trim();
		const split = trimmed.indexOf("=");
		if (split < 0 || !trimmed.slice(0, split).startsWith("_ga_")) continue;
		const value = trimmed.slice(split + 1);
		const gs2 = /^GS2\.\d+\.s(\d+)(?:\$|$)/.exec(value);
		if (gs2) return cleanGaSessionId(gs2[1]);
		const gs1 = /^GS1\.\d+\.(\d+)\./.exec(value);
		if (gs1) return cleanGaSessionId(gs1[1]);
	}
	return null;
}

export function cleanTransactionId(value: string | null | undefined): string | null {
	if (!value) return null;
	const id = value.trim();
	if (!id || id.length > 200 || id.includes("{") || id.includes("}")) return null;
	if (!/^[A-Za-z0-9_]+$/.test(id)) return null;
	return id;
}

export function shouldRecordPurchase(sessionId: string | null, already: readonly string[]): boolean {
	const id = cleanTransactionId(sessionId);
	if (!id) return false;
	return !already.includes(id);
}

export function shouldFireSignUp(created: boolean, alreadyFired: boolean): boolean {
	return created === true && !alreadyFired;
}

export function shouldFireObsidianConnected(first: boolean): boolean {
	return first === true;
}

function cleanField(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	let cleaned = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 32 && code !== 127) cleaned += ch;
	}
	cleaned = cleaned.trim().slice(0, FIELD_MAX);
	return cleaned || undefined;
}
