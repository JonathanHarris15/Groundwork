import { shouldFireObsidianConnected, shouldFireSignUp, type Attribution } from "./tracking";

export type GtagFn = (...args: unknown[]) => void;

export interface Ga4EventClient {
	gtag: GtagFn;
	attribution(): Attribution;
	signUpAlreadyFired(): boolean;
	markSignUpFired(): void;
}

export function emitSignUp(client: Ga4EventClient, created: boolean, method: string): boolean {
	if (!shouldFireSignUp(created, client.signUpAlreadyFired())) return false;
	client.markSignUpFired();
	client.gtag("event", "sign_up", { ...client.attribution(), method });
	return true;
}

export function emitObsidianConnected(client: Ga4EventClient, first: boolean): boolean {
	if (!shouldFireObsidianConnected(first)) return false;
	client.gtag("event", "obsidian_connected", { ...client.attribution() });
	return true;
}

/** Configures GA4, and the Ads tag only when an AW- id is set. No conversion labels are sent. */
export function configureMeasurementTags(
	gtag: GtagFn,
	ids: { ga4: string | null; ads: string | null },
	campaign: Record<string, string>,
): void {
	if (ids.ga4) gtag("config", ids.ga4, campaign);
	if (ids.ads) gtag("config", ids.ads, campaign);
}
