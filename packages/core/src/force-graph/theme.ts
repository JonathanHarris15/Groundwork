export interface GraphPaintTheme {
	label: string;
	labelHalo: string;
	labelMuted: string;
	link: string;
	linkBridge: string;
	nodeRing: string;
	accent: string;
	warn: string;
	tipBg: string;
	tipBorder: string;
	tipText: string;
}

const FALLBACK: GraphPaintTheme = {
	label: "rgba(230, 232, 236, 0.96)",
	labelHalo: "rgba(22, 24, 29, 0.82)",
	labelMuted: "rgba(168, 173, 182, 0.9)",
	link: "rgba(127, 132, 142, 0.72)",
	linkBridge: "rgba(127, 132, 142, 0.4)",
	nodeRing: "rgba(255, 255, 255, 0.85)",
	accent: "rgba(69, 169, 240, 0.85)",
	warn: "rgba(247, 169, 62, 0.75)",
	tipBg: "rgba(22, 24, 29, 0.92)",
	tipBorder: "rgba(255, 255, 255, 0.1)",
	tipText: "#e8eaee",
};

function pick(cs: CSSStyleDeclaration, name: string, fallback: string): string {
	const raw = cs.getPropertyValue(name).trim();
	return raw || fallback;
}

/** Read Obsidian (or site) CSS variables at paint time. */
export function readGraphTheme(host: HTMLElement): GraphPaintTheme {
	const mapHost = host.closest(".gw-mapwrap") ?? host.closest(".graph-host") ?? host.closest(".graph-shell");
	const root =
		mapHost ??
		host.closest(".app-container") ??
		host.closest(".theme-dark") ??
		host.closest(".theme-light") ??
		document.body;
	const cs = getComputedStyle(root);
	const text = pick(cs, "--gw-map-label", pick(cs, "--text-normal", "#e6e8ec"));
	const muted = pick(cs, "--text-muted", "#8b909a");
	const faint = pick(cs, "--text-faint", muted);
	const border = pick(cs, "--background-modifier-border", "rgba(127, 132, 142, 0.45)");
	const accent = pick(cs, "--interactive-accent", "#45a9f0");
	const orange = pick(cs, "--color-orange", "#f7a93e");
	const paper = pick(cs, "--gw-map", pick(cs, "--background-primary", "#16181d"));
	const onPaper = pick(cs, "--text-on-accent", text);
	const lightPaper = paper.toLowerCase().includes("#efe") || paper.toLowerCase().includes("#f5") || paper.toLowerCase().includes("#fff");
	const label = lightPaper ? pick(cs, "--gw-map-label", "#1c1c1c") : text;
	const labelHalo = lightPaper ? "rgba(255, 255, 255, 0.92)" : "rgba(22, 24, 29, 0.82)";

	return {
		label,
		labelHalo,
		labelMuted: muted,
		link: faint || border,
		linkBridge: border,
		nodeRing: onPaper === paper ? text : onPaper,
		accent,
		warn: orange,
		tipBg: `color-mix(in srgb, ${paper} 92%, transparent)`,
		tipBorder: border,
		tipText: text,
	};
}

export function withAlpha(color: string, alpha: number): string {
	const c = color.trim();
	if (c.startsWith("rgba(")) return c;
	if (c.startsWith("rgb(")) {
		const inner = c.slice(4, -1);
		return `rgba(${inner}, ${alpha})`;
	}
	if (c.startsWith("#") && c.length === 7) {
		const r = Number.parseInt(c.slice(1, 3), 16);
		const g = Number.parseInt(c.slice(3, 5), 16);
		const b = Number.parseInt(c.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}
	return c;
}

export { FALLBACK as graphThemeFallback };
