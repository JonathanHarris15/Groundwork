import { configureMeasurementTags, emitObsidianConnected, emitSignUp, type Ga4EventClient } from "./ga4-events";
import {
	attributionFromSearch,
	cleanGaClientId,
	cleanGaSessionId,
	consentDefaults,
	gaClientIdFromCookie,
	gaSessionIdFromCookie,
	hasClientAttribution,
	mergeAttribution,
	shouldLoadMeasurementTag,
	tagScriptUrl,
	type Attribution,
	type ConsentChoice,
} from "./tracking";

const ATTR_KEY = "gw-attribution";
const CONSENT_KEY = "gw-consent";
const CONSENT_HIDE_KEY = "gw-consent-hide";
const SIGNUP_KEY = "gw-sign-up";

declare global {
	interface Window {
		dataLayer?: unknown[];
		GroundworkTracking?: {
			event: (name: string, params?: Record<string, unknown>) => void;
			noteSignUp: (created: boolean, method: string) => void;
			noteObsidian: (body: { first?: boolean } | null) => void;
			checkoutContext: () => Promise<{ gaClientId: string | null; gaSessionId: string | null; gclid: string | null; consent: ConsentChoice | null }>;
			attributionHeader: () => string;
			openConsent: () => void;
		};
	}
}

function webConfigFrom(value: unknown): { ga4MeasurementId?: string | null; googleAdsId?: string | null; contactEmail?: string } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	return {
		ga4MeasurementId: typeof row.ga4MeasurementId === "string" || row.ga4MeasurementId === null ? row.ga4MeasurementId : undefined,
		googleAdsId: typeof row.googleAdsId === "string" || row.googleAdsId === null ? row.googleAdsId : undefined,
		contactEmail: typeof row.contactEmail === "string" ? row.contactEmail : undefined,
	};
}

function gtag(..._args: unknown[]): void {
	window.dataLayer = window.dataLayer || [];
	// gtag.js only reads Arguments objects; a plain array is ignored.
	// eslint-disable-next-line prefer-rest-params -- gtag.js reads the Arguments object, not a rest array
	window.dataLayer.push(arguments);
}

function readJson<T>(key: string): T | null {
	try {
		const raw = browserStorage().getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown): void {
	try {
		browserStorage().setItem(key, JSON.stringify(value));
	} catch {
		/* private mode */
	}
}

function readChoice(): ConsentChoice | null {
	try {
		const value = browserStorage().getItem(CONSENT_KEY);
		return value === "granted" || value === "denied" ? value : null;
	} catch {
		return null;
	}
}

function readAttribution(): Attribution | null {
	const fromStorage = readJson<Attribution>(ATTR_KEY);
	if (hasClientAttribution(fromStorage)) return fromStorage;
	const match = document.cookie.match(/(?:^|; )gw_attr=([^;]*)/);
	if (!match) return null;
	try {
		const parsed = JSON.parse(decodeURIComponent(match[1])) as Attribution;
		return hasClientAttribution(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function writeAttribution(value: Attribution): void {
	writeJson(ATTR_KEY, value);
	const secure = location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `gw_attr=${encodeURIComponent(JSON.stringify(value))}; Path=/; Max-Age=7776000; SameSite=Lax${secure}`;
}

function eventParams(extra?: Record<string, unknown>): Record<string, unknown> {
	return { ...(readAttribution() ?? {}), ...extra };
}

function event(name: string, params?: Record<string, unknown>): void {
	if (name === "purchase") return;
	const payload = eventParams(params);
	void tagReady.then(() => gtag("event", name, payload));
}

function applyConsent(choice: ConsentChoice): void {
	const [command] = consentDefaults(choice);
	gtag("consent", "update", command);
	try {
		browserStorage().setItem(CONSENT_KEY, choice);
	} catch {
		/* ignore */
	}
	hideBanner();
}

function hideBanner(): void {
	document.querySelector(".consent")?.remove();
	document.body.classList.remove("has-consent");
	try {
		browserStorage().setItem(CONSENT_HIDE_KEY, "1");
	} catch {
		/* ignore */
	}
}

function browserStorage(): Storage {
	const bag: unknown = window["localStorage"];
	if (!bag || typeof bag !== "object" || !("getItem" in bag)) throw new Error("Storage is unavailable.");
	return bag as Storage;
}

function makeEl(tag: string): HTMLElement {
	const dom = document as unknown as Record<string, (name: string) => unknown>;
	const node = dom["createElement"](tag);
	if (!node || typeof node !== "object" || !("setAttribute" in node)) throw new Error("Could not create an element.");
	return node as HTMLElement;
}

function openConsent(): void {
	if (document.querySelector(".consent")) return;
	const bar = makeEl("div");
	bar.className = "consent";
	bar.setAttribute("role", "dialog");
	bar.setAttribute("aria-label", "Cookies");
	const copy = makeEl("p");
	copy.textContent = "Cookies measure ads. They stay on unless you opt out.";
	const actions = makeEl("div");
	actions.className = "consent-actions";
	for (const [label, consent] of [["OK", "dismiss"], ["Opt out", "denied"]] as const) {
		const button = makeEl("button");
		button.setAttribute("type", "button");
		button.textContent = label;
		button.setAttribute("data-consent", consent);
		actions.append(button);
	}
	bar.append(copy, actions);
	bar.addEventListener("click", (click) => {
		const target = click.target;
		if (!target || typeof target !== "object" || !("closest" in target)) return;
		const action = (target as Element).closest("button")?.getAttribute("data-consent");
		if (action === "granted" || action === "denied") applyConsent(action);
		else if (action === "dismiss") hideBanner();
	});
	document.body.appendChild(bar);
	document.body.classList.add("has-consent");
}

function bootConsent(): void {
	for (const command of consentDefaults(readChoice())) gtag("consent", "default", command);
}

function capture(): void {
	const next = mergeAttribution(readAttribution(), attributionFromSearch(location.search));
	if (next && hasClientAttribution(next)) writeAttribution(next);
}

/** Resolves once `js` + `config` are queued (or there is no tag). gtag.js drops events queued before `config`. */
let markTagReady: () => void = () => {};
const tagReady = new Promise<void>((resolve) => {
	markTagReady = resolve;
});

/** Set only after gtag.js has loaded on the live site. Checkout reads the client id from it. */
let loadedMeasurementId: string | null = null;

async function bootTag(): Promise<void> {
	try {
		await loadTag();
	} finally {
		markTagReady();
	}
}

async function loadTag(): Promise<void> {
	let config: { ga4MeasurementId?: string | null; googleAdsId?: string | null; contactEmail?: string } | null = null;
	try {
		const res = await window["fetch"]("/v1/web-config");
		if (res.ok) config = webConfigFrom(await res.json());
	} catch {
		config = null;
	}
	const email = config?.contactEmail?.trim();
	if (email) {
		for (const el of document.querySelectorAll("[data-contact-email]")) {
			el.textContent = email;
			if (el.tagName === "A") el.setAttribute("href", `mailto:${email}`);
		}
	}
	const ids = { ga4: config?.ga4MeasurementId ?? null, ads: config?.googleAdsId ?? null };
	const src = tagScriptUrl(ids);
	const nav = window["navigator"] as Navigator | undefined;
	const allowed = shouldLoadMeasurementTag({
		hostname: location.hostname,
		webdriver: nav?.webdriver === true,
		userAgent: nav?.userAgent ?? "",
	});
	if (!src || !allowed) return;
	let loaded = false;
	await new Promise<void>((resolve) => {
		const script = makeEl("script") as HTMLScriptElement;
		script.async = true;
		script.src = src;
		script.onload = () => {
			loaded = true;
			resolve();
		};
		script.onerror = () => resolve();
		document.head.appendChild(script);
	});
	if (!loaded) return;
	gtag("js", new Date());
	const attr = readAttribution() ?? {};
	const campaign: Record<string, string> = {};
	if (attr.utm_source) campaign.campaign_source = attr.utm_source;
	if (attr.utm_medium) campaign.campaign_medium = attr.utm_medium;
	if (attr.utm_campaign) campaign.campaign_name = attr.utm_campaign;
	if (attr.utm_term) campaign.campaign_term = attr.utm_term;
	if (attr.utm_content) campaign.campaign_content = attr.utm_content;
	if (attr.gclid) campaign.gclid = attr.gclid;
	configureMeasurementTags(gtag, ids, campaign);
	loadedMeasurementId = ids.ga4;
}

const ga4Client: Ga4EventClient = {
	gtag: (...args: unknown[]) => {
		void tagReady.then(() => {
			gtag(...args);
		});
	},
	attribution: () => readAttribution() ?? {},
	signUpAlreadyFired() {
		try {
			return sessionStorage.getItem(SIGNUP_KEY) === "1";
		} catch {
			return false;
		}
	},
	markSignUpFired() {
		try {
			sessionStorage.setItem(SIGNUP_KEY, "1");
		} catch {
			/* ignore */
		}
	},
};

function noteSignUp(created: boolean, method: string): void {
	emitSignUp(ga4Client, created, method);
}

function noteObsidian(body: { first?: boolean } | null): void {
	emitObsidianConnected(ga4Client, body?.first === true);
}

bootConsent();
capture();

function readGaField(field: "client_id" | "session_id"): Promise<string | null> {
	const id = loadedMeasurementId;
	if (!id) return Promise.resolve(null);
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: string | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		window.setTimeout(() => done(null), 400);
		gtag("get", id, field, (value: unknown) => {
			if (typeof value === "number" && Number.isFinite(value)) done(String(Math.trunc(value)));
			else if (typeof value === "string") done(value);
			else done(null);
		});
	});
}

async function checkoutContext(): Promise<{ gaClientId: string | null; gaSessionId: string | null; gclid: string | null; consent: ConsentChoice | null }> {
	const [gotClient, gotSession] = await Promise.all([readGaField("client_id"), readGaField("session_id")]);
	return {
		gaClientId: cleanGaClientId(gotClient) ?? gaClientIdFromCookie(document.cookie),
		gaSessionId: cleanGaSessionId(gotSession) ?? gaSessionIdFromCookie(document.cookie),
		gclid: readAttribution()?.gclid ?? null,
		consent: readChoice(),
	};
}

window.GroundworkTracking = {
	event,
	noteSignUp,
	noteObsidian,
	checkoutContext,
	attributionHeader() {
		const stored = readAttribution();
		if (!hasClientAttribution(stored)) return "";
		return encodeURIComponent(JSON.stringify(stored));
	},
	openConsent,
};

document.addEventListener("click", (click) => {
	const target = click.target;
	if (!(target instanceof Element)) return;
	if (target.closest("[data-consent-open]")) openConsent();
});

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", () => {
		if (!readChoice()) {
			let hidden = false;
			try {
				hidden = browserStorage().getItem(CONSENT_HIDE_KEY) === "1";
			} catch {
				hidden = false;
			}
			if (!hidden) openConsent();
		}
		void bootTag();
	});
} else {
	if (!readChoice()) {
		let hidden = false;
		try {
			hidden = browserStorage().getItem(CONSENT_HIDE_KEY) === "1";
		} catch {
			hidden = false;
		}
		if (!hidden) openConsent();
	}
	void bootTag();
}
