import { shouldFireObsidianConnected, shouldFireSignUp, type Attribution } from "./tracking";

export type GtagFn = (...args: unknown[]) => void;

export interface Ga4EventClient {
	gtag: GtagFn;
	attribution(): Attribution;
	signUpAlreadyFired(): boolean;
	markSignUpFired(): void;
	/** Ads conversion `send_to`, read after the tag config is known. Null when Ads is off or is another account. */
	signUpConversionSendTo(): string | null;
}

export function emitSignUp(client: Ga4EventClient, created: boolean, method: string): boolean {
	if (!shouldFireSignUp(created, client.signUpAlreadyFired())) return false;
	client.markSignUpFired();
	const attribution = client.attribution();
	client.gtag("event", "sign_up", { ...attribution, method });
	const sendTo = client.signUpConversionSendTo();
	if (sendTo) client.gtag("event", "conversion", { ...attribution, send_to: sendTo });
	return true;
}

export function emitSetupLinkSent(client: Ga4EventClient, method: string): void {
	const channel = method === "share" ? "share" : "copy";
	client.gtag("event", "setup_link_sent", { ...client.attribution(), method: channel });
}

export function emitObsidianConnected(client: Ga4EventClient, first: boolean): boolean {
	if (!shouldFireObsidianConnected(first)) return false;
	client.gtag("event", "obsidian_connected", { ...client.attribution() });
	return true;
}

/**
 * Configures GA4, and the Ads tag when an AW- id is set.
 * Omitting `send_page_view` leaves the automatic page_view on.
 */
export function configureMeasurementTags(
	gtag: GtagFn,
	ids: { ga4: string | null; ads: string | null },
	campaign: Record<string, string>,
): void {
	if (ids.ga4) gtag("config", ids.ga4, campaign);
	if (ids.ads) gtag("config", ids.ads, campaign);
}
