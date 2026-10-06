import {
	attributionFromSearch,
	cleanTransactionId,
	consentDefaults,
	hasClientAttribution,
	mergeAttribution,
	purchaseValue,
	shouldFireObsidianConnected,
	shouldFireSignUp,
	shouldRecordPurchase,
	tagScriptUrl,
	type Attribution,
	type ConsentChoice,
} from "./tracking";

const ATTR_KEY = "gw-attribution";
const CONSENT_KEY = "gw-consent";
const CONSENT_HIDE_KEY = "gw-consent-hide";
const SIGNUP_KEY = "gw-sign-up";
const PURCHASE_KEY = "gw-purchases";

declare global {
	interface Window {
		dataLayer?: unknown[];
		GroundworkTracking?: {
			event: (name: string, params?: Record<string, unknown>) => void;
			noteSignUp: (created: boolean, method: string) => void;
			noteObsidian: (body: { first?: boolean } | null) => void;
			notePurchase: (sessionId: string | null, plan: string | null) => boolean;
			attributionHeader: () => string;
			openConsent: () => void;
		};
	}
}

function gtag(...args: unknown[]): void {
	window.dataLayer = window.dataLayer || [];
	window.dataLayer.push(args);
}

function readJson<T>(key: string): T | null {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* private mode */
	}
}

function readChoice(): ConsentChoice | null {
	try {
		const value = localStorage.getItem(CONSENT_KEY);
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
	gtag("event", name, eventParams(params));
}

function applyConsent(choice: ConsentChoice): void {
	const [command] = consentDefaults(choice);
	gtag("consent", "update", command);
	try {
		localStorage.setItem(CONSENT_KEY, choice);
	} catch {
		/* ignore */
	}
	hideBanner();
}

function hideBanner(): void {
	document.querySelector(".consent")?.remove();
	document.body.classList.remove("has-consent");
	try {
		localStorage.setItem(CONSENT_HIDE_KEY, "1");
	} catch {
		/* ignore */
	}
}

function openConsent(): void {
	if (document.querySelector(".consent")) return;
	const bar = document.createElement("div");
	bar.className = "consent";
	bar.setAttribute("role", "dialog");
	bar.setAttribute("aria-label", "Cookies");
	bar.innerHTML = `
		<p>We use cookies to measure ads. In the US this is on unless you opt out. Everywhere else it stays off until you allow it.</p>
		<div class="consent-actions">
			<button type="button" data-consent="granted">Allow</button>
			<button type="button" data-consent="denied">Opt out</button>
			<button type="button" data-consent="dismiss">OK</button>
		</div>`;
	bar.addEventListener("click", (click) => {
		const target = click.target;
		if (!(target instanceof HTMLElement)) return;
		const action = target.closest("button")?.getAttribute("data-consent");
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

async function bootTag(): Promise<void> {
	let config: { ga4MeasurementId?: string | null; googleAdsId?: string | null; contactEmail?: string } | null = null;
	try {
		const res = await fetch("/v1/web-config");
		if (res.ok) config = await res.json();
	} catch {
		config = null;
	}
	const email = config?.contactEmail?.trim();
	if (email) {
		for (const el of document.querySelectorAll("[data-contact-email]")) {
			el.textContent = email;
			if (el instanceof HTMLAnchorElement) el.href = `mailto:${email}`;
		}
	}
	const ids = { ga4: config?.ga4MeasurementId ?? null, ads: config?.googleAdsId ?? null };
	const src = tagScriptUrl(ids);
	if (!src) return;
	await new Promise<void>((resolve) => {
		const script = document.createElement("script");
		script.async = true;
		script.src = src;
		script.onload = () => resolve();
		script.onerror = () => resolve();
		document.head.appendChild(script);
	});
	gtag("js", new Date());
	const attr = readAttribution() ?? {};
	const campaign: Record<string, string> = {};
	if (attr.utm_source) campaign.campaign_source = attr.utm_source;
	if (attr.utm_medium) campaign.campaign_medium = attr.utm_medium;
	if (attr.utm_campaign) campaign.campaign_name = attr.utm_campaign;
	if (attr.utm_term) campaign.campaign_term = attr.utm_term;
	if (attr.utm_content) campaign.campaign_content = attr.utm_content;
	if (attr.gclid) campaign.gclid = attr.gclid;
	for (const id of [ids.ga4, ids.ads]) {
		if (id) gtag("config", id, campaign);
	}
}

function noteSignUp(created: boolean, method: string): void {
	let already = false;
	try {
		already = sessionStorage.getItem(SIGNUP_KEY) === "1";
	} catch {
		already = false;
	}
	if (!shouldFireSignUp(created, already)) return;
	try {
		sessionStorage.setItem(SIGNUP_KEY, "1");
	} catch {
		/* ignore */
	}
	event("sign_up", { method });
}

function notePurchase(sessionId: string | null, plan: string | null): boolean {
	const id = cleanTransactionId(sessionId);
	const value = purchaseValue(plan);
	if (!id || value == null) return false;
	const already = readJson<string[]>(PURCHASE_KEY) ?? [];
	if (!shouldRecordPurchase(id, already)) return false;
	writeJson(PURCHASE_KEY, [...already, id].slice(-50));
	event("purchase", { transaction_id: id, value, currency: "USD" });
	return true;
}

function noteObsidian(body: { first?: boolean } | null): void {
	if (!shouldFireObsidianConnected(body?.first === true)) return;
	event("obsidian_connected");
}

bootConsent();
capture();

window.GroundworkTracking = {
	event,
	noteSignUp,
	noteObsidian,
	notePurchase,
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
				hidden = localStorage.getItem(CONSENT_HIDE_KEY) === "1";
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
			hidden = localStorage.getItem(CONSENT_HIDE_KEY) === "1";
		} catch {
			hidden = false;
		}
		if (!hidden) openConsent();
	}
	void bootTag();
}
