import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PLANS, USER_KEY_PROVIDERS, type PlanId, type UserKeyProvider } from "../../core/src/account/plans.ts";
import { CLAUDE_SETUP, PROVIDER_LABEL } from "../../core/src/account/tutor.ts";
import { CONTACT_EMAIL_DEFAULT } from "./tracking";

const ORIGIN = "https://groundworklearn.com";
const EMAIL = CONTACT_EMAIL_DEFAULT;

const LOGO = `GROUND<svg viewBox="-4 0 128 110" aria-hidden="true"><polyline points="10,14 36,98 60,38 84,98 110,14" fill="none" stroke="#F7F7F5" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"></polyline><circle cx="10" cy="14" r="11" fill="#F0565B"></circle><circle cx="60" cy="38" r="11" fill="#F7A93E"></circle><circle cx="110" cy="14" r="11" fill="#45A9F0"></circle><circle cx="36" cy="98" r="11" fill="#3CC56F"></circle><circle cx="84" cy="98" r="11" fill="#3CC56F"></circle></svg>ORK`;

const ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>`;

const SHOT_WIDTHS = [480, 768, 1200];

export interface SiteFile {
	path: string;
	file: string;
	body: string;
	type: string;
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function cta(href: string, label: string): string {
	return `<div class="cta-block">
		<div class="cta-row">
			<a class="cta" href="${href}">${label}${ARROW}</a>
			<p class="cta-note"><span class="note-wide">Requires Obsidian desktop</span><span class="note-phone">Requires Obsidian desktop. Sign up here, install on your computer.</span></p>
		</div>
	</div>`;
}

function shotFigure(spec: {
	base: string;
	alt: string;
	width: number;
	height: number;
	eager?: boolean;
	phone?: { base: string };
}): string {
	const srcset = (base: string, ext: string) => SHOT_WIDTHS.map((width) => `${base}-${width}.${ext} ${width}w`).join(", ");
	const priority = spec.eager ? ` fetchpriority="high"` : ` loading="lazy"`;
	const phone = spec.phone
		? `<source media="(max-width: 800px)" type="image/avif" srcset="${srcset(spec.phone.base, "avif")}" sizes="92vw" />
			<source media="(max-width: 800px)" type="image/webp" srcset="${srcset(spec.phone.base, "webp")}" sizes="92vw" />`
		: "";
	const figureClass = spec.phone ? "mkt-shot has-phone" : "mkt-shot";
	return `<figure class="${figureClass}">
		<picture>
			${phone}
			<source type="image/avif" srcset="${srcset(spec.base, "avif")}" sizes="(max-width: 800px) 92vw, 720px" />
			<source type="image/webp" srcset="${srcset(spec.base, "webp")}" sizes="(max-width: 800px) 92vw, 720px" />
			<img src="${spec.base}-768.webp" width="${spec.width}" height="${spec.height}" alt="${escapeAttr(spec.alt)}"${priority} />
		</picture>
	</figure>`;
}

function section(title: string, paragraphs: string[], extra = ""): string {
	const body = paragraphs.map((p) => `<p>${p}</p>`).join("");
	return `<section class="mkt-section"><h2>${title}</h2>${body}${extra}</section>`;
}

const NAV_LINKS: Array<[string, string]> = [
	["/pricing", "Pricing"],
	["/get-started", "Get started"],
	["/practice-tests", "Practice tests"],
	["/exam-prep", "Exam prep"],
	["/concept-map", "Concept map"],
	["/quizzes-flashcards", "Quizzes &amp; flashcards"],
	["/goals", "Goals"],
];

/** Wide links stay in the bar on a desktop. The menu is the same list, plus Admin and the session action. */
export function siteNav(current: string, signHref = "/#signin"): string {
	const currentAttr = (href: string) => (href === current ? ` aria-current="page"` : "");
	const wide = NAV_LINKS.slice(0, 2)
		.map(([href, label]) => `<a class="nav-wide" href="${href}"${currentAttr(href)}>${label}</a>`)
		.join("");
	const menu = NAV_LINKS.map(([href, label]) => `<a href="${href}"${currentAttr(href)}>${label}</a>`).join("");
	return `<div class="bar-end"><span class="bar-avatar" hidden></span><nav class="bar-nav" aria-label="Site">${wide}<a class="nav-wide" href="/admin/usage" data-admin-link hidden>Admin</a><details class="nav-more"><summary>Menu</summary><div class="nav-menu">${menu}<a href="/admin/usage" data-admin-link hidden>Admin</a><a class="nav-session" data-sign-in href="${signHref}">Sign in</a><button class="nav-session" data-sign-out type="button" hidden>Sign out</button></div></details><a class="sign-link" href="${signHref}">Sign in</a></nav></div>`;
}

function nav(current: string, signHref?: string): string {
	return siteNav(current, signHref);
}

function footer(): string {
	return `<footer class="foot">
		<a class="logo" href="/" aria-label="Groundwork home">${LOGO}</a>
		<nav class="foot-links" aria-label="Footer">
			<a href="/privacy">Privacy</a>
			<a href="/terms">Terms</a>
			<a href="/changelog">Changelog</a>
			<a href="mailto:${EMAIL}" data-contact-email>${EMAIL}</a>
			<button type="button" class="foot-button" data-consent-open>Cookies</button>
		</nav>
		<nav class="foot-features" aria-label="Features">
			<a href="/practice-tests">Practice tests</a>
			<a href="/exam-prep">Exam prep</a>
			<a href="/concept-map">Concept map</a>
			<a href="/quizzes-flashcards">Quizzes &amp; flashcards</a>
			<a href="/goals">Goals</a>
		</nav>
	</footer>`;
}

function page(spec: { path: string; title: string; description: string; main: string; map?: boolean; noindex?: boolean; wide?: boolean; scripts?: string; jsonLd?: string; signHref?: string; kind?: string }): string {
	const url = `${ORIGIN}${spec.path}`;
	const mapScript = spec.map
		? `<script type="module" src="/force-graph.js?v=5"></script>
		<script type="module">
			for (const host of document.querySelectorAll("[data-concept-map]")) {
				window.GroundworkGraph?.mountMarketing?.(host);
			}
		</script>`
		: "";
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escapeAttr(spec.title)}</title>
		<meta name="description" content="${escapeAttr(spec.description)}" />
		<link rel="canonical" href="${url}" />
		<meta property="og:title" content="${escapeAttr(spec.title)}" />
		<meta property="og:description" content="${escapeAttr(spec.description)}" />
		<meta property="og:url" content="${url}" />
		<meta property="og:type" content="website" />
		<meta property="og:image" content="https://groundworklearn.com/og.png" />
		<meta property="og:image:width" content="1200" />
		<meta property="og:image:height" content="630" />
		<meta name="twitter:card" content="summary_large_image" />
		<meta name="twitter:image" content="https://groundworklearn.com/og.png" />
		<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
		<link rel="preconnect" href="https://fonts.googleapis.com" />
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
		<link rel="preload" href="https://fonts.gstatic.com/s/jost/v20/92zatBhPNqw73oTd4jQmfxI.woff2" as="font" type="font/woff2" crossorigin />
		<link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap" rel="stylesheet" />
		${spec.noindex ? `<meta name="robots" content="noindex" />` : ""}
		<link rel="stylesheet" href="/styles.css?v=24" />
		${spec.jsonLd ?? ""}
		<script src="/tracking.js?v=9"></script>
	</head>
	<body>
		<div class="page mkt">
			<a class="skip" href="#content">Skip to content</a>
			<header class="bar">
				<a class="logo" href="/" aria-label="Groundwork home">${LOGO}</a>
				${nav(spec.path, spec.signHref)}
			</header>
			<main id="content" class="mkt-main${spec.wide ? " usage-main" : ""}${spec.kind ? ` ${spec.kind}` : ""}">
				${spec.main}
			</main>
			${footer()}
		</div>
		<script src="/site-session.js?v=2"></script>
		${spec.scripts ?? ""}
		${mapScript}
	</body>
</html>
`;
}

const PLAN_ORDER: PlanId[] = ["free", "byom", "included"];

/** Public names, in the order the pricing card already uses. */
const KEY_LABEL: Record<(typeof USER_KEY_PROVIDERS)[number], string> = {
	anthropic: "Anthropic",
	openrouter: "OpenRouter",
	google: "Google",
	xai: "xAI",
	openai: "OpenAI",
};

const KEY_ORDER: Array<(typeof USER_KEY_PROVIDERS)[number]> = ["openrouter", "anthropic", "google", "xai", "openai"];

function providerList(): string {
	const missing = USER_KEY_PROVIDERS.filter((id) => !KEY_ORDER.includes(id));
	if (missing.length) throw new Error(`Name every provider key: ${missing.join(", ")}`);
	const labels = KEY_ORDER.map((id) => KEY_LABEL[id]);
	const last = labels[labels.length - 1] ?? "";
	return `${labels.slice(0, -1).join(", ")}, or ${last}`;
}

function priceBit(id: PlanId): string {
	const price = PLANS[id].priceUsdPerMonth;
	return price === 0 ? "$0" : `$${price}/month`;
}

/**
 * Cells follow the plan record and the paid-plan gates.
 * Light is the hosted model (`ownModel` is false). Hosted Heavy is the Groundwork plan only.
 * Bring your own model does not use those hosted models. Its Light and Heavy cells say so.
 * New flashcards are refused on Free; reviewing a deck you already have is not.
 * A hosted plan shows the share of the month used. The dollar allowance stays off the page.
 * Sync is the account record, on every plan.
 */
export function planComparison(): Array<{ feature: string; cells: Record<PlanId, string> }> {
	const monthly = (id: PlanId) =>
		PLANS[id].ownModel || PLANS[id].hostedCreditUsd <= 0
			? "Not metered here. Model use is billed by the provider, not by Groundwork."
			: "Your account shows the share of that month you’ve used.";
	const heavy = (id: PlanId) => {
		if (id === "included" && !PLANS.included.ownModel) return "Yes";
		if (PLANS[id].ownModel) return "Your own model";
		return "No";
	};
	const light = (id: PlanId) => (PLANS[id].ownModel ? "Your own model" : "Yes");
	const own = (id: PlanId) => {
		if (PLANS[id].ownModel) return `Claude on this computer, or a key from ${providerList()}.`;
		return id === "included" ? "No. We run the models." : "No";
	};
	return [
		{ feature: "Light model", cells: { free: light("free"), byom: light("byom"), included: light("included") } },
		{ feature: "Heavy model", cells: { free: heavy("free"), byom: heavy("byom"), included: heavy("included") } },
		{ feature: "Monthly limit", cells: { free: monthly("free"), byom: monthly("byom"), included: monthly("included") } },
		{ feature: "New flashcards", cells: { free: "No", byom: "Yes", included: "Yes" } },
		{ feature: "Review existing decks", cells: { free: "Yes", byom: "Yes", included: "Yes" } },
		{ feature: "Your own model or key", cells: { free: own("free"), byom: own("byom"), included: own("included") } },
		{ feature: "Sync across computers", cells: { free: "Yes", byom: "Yes", included: "Yes" } },
	];
}

function comparisonTable(): string {
	const head = PLAN_ORDER.map((id) => {
		const badge = id === "included" ? `<span class="plan-col-note">Recommended</span>` : "";
		return `<th scope="col">${PLANS[id].name}${badge}<span class="plan-price">${priceBit(id)}</span></th>`;
	}).join("");
	const rows = planComparison()
		.map((row) => {
			const cells = PLAN_ORDER.map((id) => `<td data-plan="${PLANS[id].name}">${row.cells[id]}</td>`).join("");
			return `<tr><th scope="row">${row.feature}</th>${cells}</tr>`;
		})
		.join("");
	return `<section class="mkt-section" aria-labelledby="compare-title">
		<h2 id="compare-title">Compare plans</h2>
		<p class="compare-hint">Scroll sideways to see every plan.</p>
		<div class="compare-scroll" tabindex="0" aria-label="Compare plans">
			<table class="plan-compare">
				<thead><tr><th scope="col">Feature</th>${head}</tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
	</section>`;
}

interface FaqItem {
	q: string;
	a: string;
}

function pricingFaq(): FaqItem[] {
	const byom = PLANS.byom.priceUsdPerMonth;
	const included = PLANS.included.priceUsdPerMonth;
	return [
		{ q: "Do I need Obsidian?", a: "Yes. Groundwork is a plugin for Obsidian desktop." },
		{ q: "Does it work on my phone?", a: "No. Groundwork is desktop only. You can sign up on your phone and install on your computer later." },
		{ q: "What does “bring your own model” mean?", a: "Groundwork uses your Claude subscription or your API key instead of ours, which is why the plan costs less." },
		{ q: "How am I billed?", a: "Through Stripe, monthly." },
		{ q: "Can I change plans later?", a: "Yes. Pick another plan on your account page. To change or cancel a paid plan, open Manage billing. That goes to Stripe." },
		{
			q: "What is Heavy?",
			a: `Free stays on Light, with a monthly limit. Heavy is on the paid plans. Groundwork is $${included} a month and includes Heavy. Bring your own model is $${byom} a month and uses your own model and key.`,
		},
		{
			q: "Are flashcards free?",
			a: `Reviewing decks you already have is free. Making new flashcards is on the paid plans, Groundwork at $${included} a month or bring your own model at $${byom}.`,
		},
		{ q: "Does my progress carry over between plans?", a: "Yes. Your goals, concept map, quiz history, and decks stay on your account when you change plans. Progress syncs across your computers either way." },
	];
}

function practiceFaq(): FaqItem[] {
	const byom = PLANS.byom.priceUsdPerMonth;
	const included = PLANS.included.priceUsdPerMonth;
	return [
		{ q: "Who is Groundwork for?", a: "College students and adult learners, 18 and older. It isn’t built for high-school students." },
		{ q: "Which subjects?", a: "Any course you can name. Calculus, statistics, and chemistry work well because math renders in LaTeX." },
		{ q: "Do I need to upload anything?", a: "No. A topic is enough. Slides, notes, or a practice exam make the questions closer to your course." },
		{ q: "Are these real exam questions?", a: "No. Groundwork writes new practice questions. It doesn’t have your professor’s exam." },
		{ q: "Does it run on a Chromebook, phone, or tablet?", a: "No. It’s a plugin for Obsidian on a Windows, Mac, or Linux computer." },
		{ q: "Is it free?", a: `Yes. Free is the Light model, with a monthly limit. Heavy and new flashcards are paid. Bring your own model is $${byom} a month. Groundwork is $${included} a month.` },
	];
}

function faqHtml(items: FaqItem[]): string {
	return items.map((item) => `<h3>${item.q}</h3>\n\t\t\t\t<p>${item.a}</p>`).join("\n");
}

function jsonLdScript(nodes: unknown[]): string {
	const json = JSON.stringify({ "@context": "https://schema.org", "@graph": nodes }).replace(/</g, "\\u003c");
	return `<script type="application/ld+json">${json}</script>`;
}

function organizationNode(): Record<string, unknown> {
	return {
		"@type": "Organization",
		name: "Groundwork",
		url: ORIGIN,
		logo: `${ORIGIN}/og.png`,
	};
}

function softwareApplicationNode(): Record<string, unknown> {
	return {
		"@type": "SoftwareApplication",
		name: "Groundwork",
		url: `${ORIGIN}/`,
		applicationCategory: "EducationalApplication",
		operatingSystem: "Windows, Mac, or Linux",
		description: "A tutor plugin for Obsidian desktop. It maps what you know from foundations up to your goal, quizzes you at the edge, and plans exam prep.",
		offers: PLAN_ORDER.map((id) => {
			const price = String(PLANS[id].priceUsdPerMonth);
			return {
				"@type": "Offer",
				name: PLANS[id].name,
				price,
				priceCurrency: "USD",
				url: `${ORIGIN}/pricing`,
				priceSpecification: {
					"@type": "UnitPriceSpecification",
					price,
					priceCurrency: "USD",
					billingDuration: "P1M",
					unitText: "month",
					unitCode: "MON",
				},
			};
		}),
	};
}

function faqNode(items: FaqItem[]): Record<string, unknown> {
	return {
		"@type": "FAQPage",
		mainEntity: items.map((item) => ({
			"@type": "Question",
			name: item.q,
			acceptedAnswer: { "@type": "Answer", text: item.a },
		})),
	};
}

export function homeJsonLdScript(): string {
	return jsonLdScript([organizationNode(), softwareApplicationNode()]);
}

/** Tagged plugin releases, newest first. Wording is the shipped change, not the boilerplate release note. */
const RELEASES: Array<{ version: string; date: string; body: string }> = [
	{
		version: "0.2.22",
		date: "2026-10-27",
		body: "Quiz cards refuse broken LaTeX before they appear. The tutor must fix delimiters and call quiz again instead of showing mangled math in options.",
	},
	{
		version: "0.2.21",
		date: "2026-10-27",
		body: "Closing a margin or hint side chat clears the passage highlight. The main chat stays quiet about side-thread activity unless you ask there.",
	},
	{
		version: "0.2.20",
		date: "2026-10-25",
		body: "Linking Claude Code is three steps: install, sign in, then Check connection in Obsidian. Each command can be copied. A paid plan stays on the account, and paying people stay on the admin user list.",
	},
	{
		version: "0.2.17",
		date: "2026-10-22",
		body: "A concept keeps a few verbatim quotes from your lectures and the method your professor prefers. Quizzes and teaching use that method. The quotes stay after you delete the file.",
	},
	{
		version: "0.2.16",
		date: "2026-10-22",
		body: "Saying yes to a goal saves it on that turn, including the due date, even when you are not quizzing tonight. A tool error is repeated as it happened.",
	},
	{
		version: "0.2.15",
		date: "2026-10-21",
		body: "A long stack of lectures still becomes one goal. Groundwork reads the documents a few at a time, so a large import finishes through the website.",
	},
	{
		version: "0.2.14",
		date: "2026-10-21",
		body: "A stack of lecture and homework files becomes one goal. Groundwork reads them in parallel and builds a single concept map.",
	},
	{
		version: "0.2.4",
		date: "2026-10-12",
		body: "If you say you already know a concept, Groundwork marks it known. The connect link from before 0.2.3 still works.",
	},
	{
		version: "0.2.3",
		date: "2026-10-11",
		body: "Start free puts you on the Free plan and opens a checklist: get Obsidian, add Groundwork, connect your account. On a phone, the page can copy, share, or show a QR code so you finish on a computer.",
	},
	{
		version: "0.2.2",
		date: "2026-10-11",
		body: "Heavy and new flashcards stay on the paid plans. Free stays on Light, and decks you already have stay readable. The site header fits a phone.",
	},
	{
		version: "0.2.1",
		date: "2026-10-09",
		body: "An admin page records free-plan tutor usage.",
	},
	{
		version: "0.2.0",
		date: "2026-10-09",
		body: "The tutor chooses which notes to read for a turn. A concept map in chat stays inside its pane.",
	},
	{
		version: "0.1.17",
		date: "2026-10-08",
		body: "A long tutor turn ends with an answer. The tutor reads a document before summarizing it. Code in a tutor reply is styled.",
	},
	{
		version: "0.1.16",
		date: "2026-10-08",
		body: "The tutor answers the question first. Practice-test results show the score and what broke. The site has a practice tests page, and it says Groundwork is for college students and adult learners, 18 and older.",
	},
	{
		version: "0.1.15",
		date: "2026-10-08",
		body: "Attaching a file without a read folder says where to add one.",
	},
	{
		version: "0.1.14",
		date: "2026-10-07",
		body: "Fixes for the Obsidian community plugin scan. The Free plan’s monthly tutor limit is lower.",
	},
	{
		version: "0.1.13",
		date: "2026-10-06",
		body: "You can study a whole flashcard deck in one sitting. The tutor has Light and Heavy. Plans are Free, Bring your own model at $6 a month, and Groundwork at $20 a month.",
	},
	{
		version: "0.1.12",
		date: "2026-10-06",
		body: "You can delete and rename flashcard decks in the Library. The site has privacy and terms pages.",
	},
	{
		version: "0.1.11",
		date: "2026-10-06",
		body: "Goal concepts on the map are drawn with a ring and a red flag.",
	},
	{
		version: "0.1.10",
		date: "2026-10-06",
		body: "A figure opens full screen and runs in the tutor window. Flashcard ratings sit on the card. A missed quiz does not raise how ready a concept looks. Checkout accepts a promo code.",
	},
	{
		version: "0.1.9",
		date: "2026-10-06",
		body: "The tutor can draw a figure beside the lesson. An open quiz is still there after you close Obsidian.",
	},
	{
		version: "0.1.8",
		date: "2026-10-05",
		body: "The concept map scrolls more smoothly. Flashcard decks can be named. The account card shows the share of the month’s tutor budget you’ve used.",
	},
	{
		version: "0.1.7",
		date: "2026-10-05",
		body: "Concepts are marked solid, shaky, learning, rusty, or not started, in the plugin and on the site. Library, Settings, and Flashcards use the same screen as Learn, Map, and Goals.",
	},
	{
		version: "0.1.6",
		date: "2026-10-05",
		body: "Learn opens on a hub. You can pin the goal you’re working on. Flashcards follow that goal.",
	},
	{
		version: "0.1.5",
		date: "2026-10-05",
		body: "The concept map is a pyramid and shows every concept. Concepts that aren’t on the path fade back.",
	},
	{
		version: "0.1.4",
		date: "2026-10-05",
		body: "Signing out on the site ends the session. A past-due subscription stays on the paid plan.",
	},
	{
		version: "0.1.3",
		date: "2026-10-05",
		body: "The plugin description no longer says “Obsidian”, so the community listing can accept it.",
	},
	{
		version: "0.1.2",
		date: "2026-10-05",
		body: "The account page has an interactive concept map. The study record stays on the account. Open Obsidian points at the community plugin.",
	},
	{
		version: "0.1.1",
		date: "2026-10-03",
		body: "Fixes so the Obsidian community plugin scan can read the release.",
	},
	{
		version: "0.1.0",
		date: "2026-10-02",
		body: "First tagged release for Obsidian’s community plugins. The plugin manifest is at the root of the repository so the listing can find it.",
	},
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function longDate(iso: string): string {
	const [year, month, day] = iso.split("-").map(Number);
	return `${MONTHS[(month ?? 1) - 1]} ${day}, ${year}`;
}

function changelogPage(): string {
	const entries = RELEASES.map(
		(release) => `<article class="release">
			<h2><a href="https://github.com/JonathanHarris15/Groundwork/releases/tag/${release.version}">${release.version}</a></h2>
			<p class="release-date"><time datetime="${release.date}">${longDate(release.date)}</time></p>
			<p>${release.body}</p>
		</article>`,
	).join("");
	return page({
		path: "/changelog",
		title: "Changelog · Groundwork",
		description: "What shipped in Groundwork, from the tagged plugin releases.",
		main: `
			<h1>Changelog</h1>
			<p class="mkt-sub">Dated notes from the tagged releases, 0.1.0 through ${RELEASES[0]?.version}. Each version links to its GitHub release.</p>
			${entries}
		`,
	});
}

export function llmsTxt(): string {
	const free = PLANS.free.priceUsdPerMonth;
	const byom = PLANS.byom.priceUsdPerMonth;
	const included = PLANS.included.priceUsdPerMonth;
	return `# Groundwork

> A tutor plugin for Obsidian desktop, built for college students and adult learners, 18 and older, prepping quantitative exams. It maps the concepts you’re learning, marks how well you know each one, and plans the next step toward your exam date.

Groundwork runs on a Windows, Mac, or Linux computer. It does not run on a phone, tablet, or Chromebook. It is listed in Obsidian’s community plugins.

## Pricing

- [Free](${ORIGIN}/pricing): $${free} per month. Light model, with a monthly limit. Your account shows the share of that month you’ve used.
- [Bring your own model](${ORIGIN}/pricing): $${byom} per month. You use the Claude subscription on your computer, or a key you paste. New flashcards are included. Hosted Heavy is not included.
- [Groundwork](${ORIGIN}/pricing): $${included} per month. Recommended. Light or Heavy. We run the models. New flashcards are included.

## Pages

- [Home](${ORIGIN}/)
- [Pricing](${ORIGIN}/pricing)
- [Bring your own model](${ORIGIN}/byom)
- [Get started](${ORIGIN}/get-started)
- [Practice tests](${ORIGIN}/practice-tests)
- [Exam prep](${ORIGIN}/exam-prep)
- [Concept map](${ORIGIN}/concept-map)
- [Quizzes and flashcards](${ORIGIN}/quizzes-flashcards)
- [Goals](${ORIGIN}/goals)
- [Changelog](${ORIGIN}/changelog)
- [Privacy](${ORIGIN}/privacy)
- [Terms](${ORIGIN}/terms)
- [Listed in Obsidian’s community plugins](https://community.obsidian.md/plugins/groundwork)
`;
}

const BYOM_SIGN_UP = "/?plan=byom#signin";

/** Same providers a learner can paste, in the order this landing page names them. */
const BYOM_KEY_ORDER: UserKeyProvider[] = ["anthropic", "openrouter", "openai", "google", "xai"];

function byomKeyList(): string {
	const missing = USER_KEY_PROVIDERS.filter((id) => !BYOM_KEY_ORDER.includes(id));
	if (missing.length || BYOM_KEY_ORDER.length !== USER_KEY_PROVIDERS.length) throw new Error(`Name every provider key: ${missing.join(", ")}`);
	const labels = BYOM_KEY_ORDER.map((id) => PROVIDER_LABEL[id]);
	const last = labels.at(-1) ?? "";
	return `${labels.slice(0, -1).join(", ")}, or ${last}`;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function commandHtml(command: string): string {
	return `<pre class="cmd" translate="no"><code>${escapeHtml(command)}</code></pre>`;
}

function commandBlocks(commands: readonly { label: string; command: string }[] | undefined): string {
	return (commands ?? []).map((item) => `<p class="cmd-label">${escapeHtml(item.label)}</p>${commandHtml(item.command)}`).join("");
}

function signInHtml(detail: string): string {
	for (const token of ["claude", "/login"]) {
		if (!detail.includes(token)) throw new Error(`CLAUDE_SETUP sign-in step is missing ${token}.`);
	}
	let html = escapeHtml(detail);
	for (const token of ["/login", "claude"]) html = html.split(escapeHtml(token)).join(`<code translate="no">${escapeHtml(token)}</code>`);
	return html;
}

function byomFaq(): FaqItem[] {
	if (PLANS.byom.hostedCreditUsd !== 0 || !PLANS.byom.ownModel) throw new Error("BYOM landing copy no longer matches the plan.");
	return [
		{
			q: "Does usage count against my Claude plan?",
			a: "Yes. Tutor turns on your Claude subscription count against that plan’s limits.",
		},
		{
			q: "Does Groundwork see my Claude login?",
			a: "No. You sign in through Anthropic’s own login, on your computer. Groundwork never sees or stores that login.",
		},
		{
			q: "Is Groundwork affiliated with Anthropic?",
			a: "No. Groundwork is not affiliated with or endorsed by Anthropic.",
		},
		{
			q: "Does Bring your own model include hosted credit?",
			a: "No. Bring your own model includes no hosted credit.",
		},
		{
			q: "Who can use Groundwork?",
			a: "People 18 and older. Groundwork isn’t for anyone under 18.",
		},
	];
}

function byomSteps(): string {
	const [install, signIn, check] = CLAUDE_SETUP;
	if (!install || !signIn || !check || CLAUDE_SETUP.length !== 3) throw new Error("CLAUDE_SETUP no longer has three steps.");
	if ((install.commands?.length ?? 0) < 2) throw new Error("CLAUDE_SETUP install step needs a Mac and a Windows command.");
	return `<ol class="setup-steps">
			<li>
				<h2>${escapeHtml(install.title)}</h2>
				<p>${escapeHtml(install.detail)}</p>
				${commandBlocks(install.commands)}
			</li>
			<li>
				<h2>${escapeHtml(signIn.title)}</h2>
				<p>${signInHtml(signIn.detail)}</p>
				${commandBlocks(signIn.commands)}
			</li>
			<li>
				<h2>${escapeHtml(check.title)}</h2>
				<p>${escapeHtml(check.detail)}</p>
			</li>
		</ol>
		<p class="req">Requires Obsidian desktop</p>`;
}

function byomPage(): string {
	const price = PLANS.byom.priceUsdPerMonth;
	const faq = byomFaq();
	return page({
		path: "/byom",
		kind: "byom",
		signHref: BYOM_SIGN_UP,
		title: "Use the Claude subscription you already have | Groundwork",
		description: `Groundwork for $${price}/mo. Connect the Claude subscription on your computer, or paste a provider key. Requires Obsidian desktop. 18 and older.`,
		jsonLd: jsonLdScript([faqNode(faq)]),
		main: `
			<h1>Use the Claude subscription you already have</h1>
			<p class="mkt-sub">Groundwork for $${price}/mo</p>
			${cta(BYOM_SIGN_UP, "Sign up")}
			${byomSteps()}
			${section("Or paste an API key", [`Paste a key from ${byomKeyList()}. That provider bills you per token.`])}
			<section class="mkt-section">
				<h2>Questions</h2>
				${faqHtml(faq)}
			</section>
			${cta(BYOM_SIGN_UP, "Sign up")}
		`,
	});
}

function pricingPage(): string {
	const faq = pricingFaq();
	return page({
		path: "/pricing",
		kind: "pricing",
		title: "Groundwork pricing: Free, $6/mo, or $20/mo",
		description: "Start free on the Light model. Heavy and new flashcards are on Bring your own model ($6/mo) or Groundwork ($20/mo). Billed through Stripe.",
		jsonLd: jsonLdScript([organizationNode(), softwareApplicationNode(), faqNode(faq)]),
		main: `
			<h1>Plans</h1>
			<p class="mkt-sub">All three plans run in Obsidian desktop. Free is the Light model, with a monthly limit. Heavy and new flashcards are on Bring your own model ($6/month) and Groundwork ($20/month).</p>
			${cta("/#signin", "Start free")}
			<ul class="plan-cards">
				<li class="plan-card">
					<h2>Free</h2>
					<p class="price">$0</p>
					<p>Light model, with a monthly limit. Quiz cards, your concept map, and decks you already have. New flashcards and Heavy are on the paid plans. Your account shows the share of that month you’ve used.</p>
					<a class="cta" href="/#signin">Start free${ARROW}</a>
				</li>
				<li class="plan-card">
					<h2>Bring your own model</h2>
					<p class="price">$6<span>/month</span></p>
					<p>Use a model you already pay for. Connect the Claude subscription on your computer, or paste a key from OpenRouter, Anthropic, Google, xAI, or OpenAI. Heavy uses that model and key. Flashcards are included. Model use on that subscription or key is billed by the provider, not by Groundwork. The $6 covers Groundwork.</p>
					<a class="hero-quiet" href="/byom">Use the Claude subscription you already have</a>
					<a class="cta" href="/?plan=byom#signin">Choose $6${ARROW}</a>
				</li>
				<li class="plan-card plan-card-recommended">
					<span class="plan-badge">Recommended</span>
					<h2>Groundwork</h2>
					<p class="price">$20<span>/month</span></p>
					<p>Light or Heavy. We run the models. Flashcards are included. No keys to manage.</p>
					<a class="cta" href="/?plan=included#signin">Choose $20${ARROW}</a>
				</li>
			</ul>
			${comparisonTable()}
			<section class="mkt-section">
				<h2>Questions</h2>
				${faqHtml(faq)}
			</section>
			${cta("/#signin", "Start free")}
		`,
	});
}

function practicePage(): string {
	const faq = practiceFaq();
	return page({
		path: "/practice-tests",
		title: "Practice tests for college exams, in Obsidian | Groundwork",
		description: "Practice questions and practice tests for calculus, statistics, and chemistry exams. See which concept broke, with explanations after each question.",
		jsonLd: jsonLdScript([faqNode(faq)]),
		main: `
			<h1>Practice tests that show what broke.</h1>
			<p class="mkt-sub">Name a topic, or add your slides, notes, or a practice exam. Groundwork writes practice questions and practice tests for your midterm or final, then shows which concept broke. Requires Obsidian desktop.</p>
			${cta("/#signin", "Start free")}
			${shotFigure({
				base: "/shots/practice-chat",
				width: 1656,
				height: 634,
				eager: true,
				alt: "Chat asking for a practice test on a Calc 1 final, with the practice test card opened.",
			})}
			${section("Start from a topic", ["Name the exam. Calc 1 final, Stats midterm: hypothesis tests, or Gen chem: stoichiometry. Adding slides, notes, or a practice exam is optional, and it makes the questions closer to your course. Groundwork only reads the vault folders you allow."])}
			${section("Take a practice test", ["Multiple choice and written answers. Math is typed live in LaTeX. You can turn on a countdown. It does not cut the test off, and there is no feedback until you submit."], shotFigure({
				base: "/shots/practice-mid",
				width: 1656,
				height: 1028,
				alt: "A practice test card in progress, with a countdown and no feedback yet.",
			}))}
			${section("See what broke", ["You get a score, the points you earned, and how the answers split between correct, partial, and wrong. Concepts are listed weakest first, with the beliefs to fix. Each question includes an explanation. A written answer also shows a model answer. A multiple-choice question marks the correct choice. The results are saved as a note in your vault."], shotFigure({
				base: "/shots/practice-results",
				width: 1656,
				height: 1136,
				alt: "Practice test results for Calc 1 final, Practice 1, with the score, concepts weakest first, and beliefs to fix.",
			}))}
			${section("Practice questions that explain themselves", ["An explanation follows each question. A wrong pick can show the likely mistake behind it. On a written answer, partial credit counts, equivalent forms are accepted, and a careless slip is not counted as a gap. There is a hint button when you are stuck."], shotFigure({
				base: "/shots/practice-quiz",
				width: 1656,
				height: 934,
				alt: "A chain rule quiz answered wrong, with the likely belief and an explanation.",
			}))}
			${section("Every answer updates your map", ["Answers are recorded on your concept map, so you can see which concepts are solid and which are shaky before the exam. Set the exam date as the goal’s due date."], `${shotFigure({
				base: "/shots/practice-goals",
				width: 2696,
				height: 1862,
				alt: "Goals tab for Calc 1 final, with the exam date on the goal.",
			})}${shotFigure({
				base: "/shots/practice-map",
				width: 2744,
				height: 2764,
				alt: "Concept map for Calc 1 final, with the goal concepts and the foundations under them.",
			})}`)}
			${section("Questions", [], faqHtml(faq))}
			${cta("/#signin", "Start free")}
		`,
	});
}

function examPage(): string {
	return page({
		path: "/exam-prep",
		title: "Exam prep from your slides, in Obsidian | Groundwork",
		description: "Drop in lecture slides, homework, a study guide, or a practice exam. Groundwork pulls out the topics and depth and builds an exam goal with a due date.",
		main: `
			<h1>Turn your slides into an exam plan.</h1>
			<p class="mkt-sub">Drop in what your class gave you for a midterm or final. Groundwork works out what the exam covers and how deep it goes, then plans in Obsidian from the foundations up to the exam date.</p>
			${cta("/#signin", "Start free")}
			${shotFigure({
				base: "/shots/exam-chat",
				width: 1553,
				height: 1260,
				eager: true,
				alt: "Tutor chat after attaching MATH-151-practice-exam.md. Groundwork saved the goal Prepare for MATH 151 practice, due in just over three weeks, with 4 of 14 concepts solid.",
			})}
			${section("Bring what you have", ["Lecture slides, a couple of homework sets, a study guide, or a practice exam. Drop them onto the tutor in Obsidian. Groundwork reads each file to work out what it covers. It only reads vault folders you allow in settings."])}
			${section("Get an exam goal with a due date", ["Groundwork pulls out the topics and the level of depth the exam seems to expect, and turns them into an exam goal with your exam date attached. The Goals tab shows how far along you are."])}
			${section("Foundations first, then the exam", ["The plan is built from first principles: the concepts the exam material depends on come first, and the exam topics sit at the top of your concept map as red flags. You can see which topics are solid and which are still shaky."], shotFigure({
				base: "/shots/exam-map",
				width: 2700,
				height: 1914,
				alt: "Concept map for a calculus exam. Derivative of cosine, derivative of sine, quotient rule, and chain rule are goals, drawn as dark circles with a red flag. The concepts below are marked solid, shaky, learning, rusty, or not started. The next concept to study is ringed.",
			}))}
			${section("Quiz until the gaps show up", ["Diagnostic quiz cards test each topic at levels 1 to 5. A careless slip isn’t counted as a gap, and misconceptions are tracked, so you find the real weak spots before the exam does."])}
			${section("Math and diagrams included", ["The tutor renders LaTeX math and can explain with callouts and diagrams. Attach a slide or an image of a problem when you get stuck.", "Free stays on the Light model, with a monthly limit. Heavy is on the paid plans."])}
			${cta("/#signin", "Start free")}
		`,
	});
}

function conceptPage(): string {
	return page({
		path: "/concept-map",
		title: "Concept map for what you’re learning | Groundwork",
		description: "See every concept from the foundations up to your goal, each marked solid, shaky, learning, rusty, or not started. A tutor plugin for Obsidian desktop.",
		main: `
			<h1>See what you know, from the foundations up.</h1>
			<p class="mkt-sub">Every goal in Groundwork has a concept map. It shows what the goal depends on and how well you know each piece.</p>
			${cta("/#signin", "Start free")}
			${shotFigure({
				base: "/hero/concept-map",
				width: 2700,
				height: 1914,
				eager: true,
				phone: { base: "/hero/concept-map-phone" },
				alt: "Concept map for Derivatives for Calc I. Goals are dark circles with a red flag. The concepts below are marked solid, shaky, learning, rusty, or not started. The next concept to study is ringed.",
			})}
			${section("A pyramid, not a hairball", ["Foundations sit at the bottom and your goal sits at the top in red. The path between them is highlighted, and concepts that aren’t on the path fade back, so the map stays readable."])}
			${section("Five states for every concept", ["Each concept is marked <strong>solid</strong>, <strong>shaky</strong>, <strong>learning</strong>, <strong>rusty</strong>, or <strong>not started</strong>. The marks come from how you do on quiz cards, not from a checklist you tick yourself. Flashcard reviews count only a little; quiz cards set the marks. Making new flashcards is on the paid plans."])}
			${section("Rusty is a real state", ["Mastery fades over time. When a concept you once knew goes rusty, it comes back for review instead of staying green forever."])}
			${section("Planned from first principles", ["When you set a goal, Groundwork plans it from the foundations up to the goal. New lessons build on the map instead of starting over each session."])}
			${section("The same map on each computer", ["Progress syncs across your computers. Sign in on the site and the map is there."])}
			${cta("/#signin", "Start free")}
		`,
	});
}

function quizzesPage(): string {
	return page({
		path: "/quizzes-flashcards",
		title: "Quiz cards and flashcards in Obsidian | Groundwork",
		description: "Diagnostic quiz cards at levels 1 to 5 find the edge of what you know. Flashcard decks for quick review. A plugin for Obsidian desktop.",
		main: `
			<h1>Quiz cards that find the edge of what you know.</h1>
			<p class="mkt-sub">Quiz yourself in Obsidian on your own notes and lecture slides. Quiz cards test understanding, not just recognition, and flashcard decks sit alongside them for quick review.</p>
			${cta("/#signin", "Start free")}
			${shotFigure({
				base: "/shots/quiz",
				width: 1852,
				height: 1949,
				eager: true,
				alt: "Quiz card for the power rule at level 3 of 5. The question is the derivative of x cubed. 3x squared is marked correct, and 3x is marked wrong as a misconception that drops the exponent too far.",
			})}
			${section("Quiz yourself on your own notes and lecture slides", ["Quiz cards can come straight from the notes and lecture slides already in your vault. Groundwork only reads the folders you allow in settings."])}
			${section("Diagnostic, levels 1 to 5", ["Each quiz card targets a concept at a level from 1 to 5. The point is to find where your understanding stops, which is the edge worth working on."])}
			${section("A slip isn’t a gap", ["Everyone mistypes or rushes sometimes. A careless slip isn’t counted as a gap in what you know, so one bad answer doesn’t knock a solid concept back to shaky."])}
			${section("Misconceptions get tracked", ["When an answer shows a wrong idea rather than a missing one, Groundwork tracks it as a misconception, separately from a simple gap."])}
			${section("Flashcard decks", ["New flashcards are on the paid plans. Decks you already have stay available to review. Use them for terms, formulas, and anything you want at your fingertips. Flashcard reviews count a little toward a concept; quiz cards set the marks. You can export a deck to your vault as plain Markdown."], shotFigure({
				base: "/shots/flashcards",
				width: 2343,
				height: 1756,
				alt: "Flashcard for the power rule, asking for the derivative of x to the n. The answer is n x to the n minus 1.",
			}))}
			${section("More than a flashcard app", ["Quiz results feed your concept map, so you can see which concepts are solid, shaky, or rusty. Math renders in LaTeX on cards and in tutor chat."])}
			${cta("/#signin", "Start free")}
		`,
	});
}

function goalsPage(): string {
	return page({
		path: "/goals",
		title: "Learning goals with due dates, in Obsidian | Groundwork",
		description: "Set a learning goal with a due date. Groundwork plans it from the foundations up and shows your progress in the Goals tab. For Obsidian desktop.",
		main: `
			<h1>Set a goal. Give it a date.</h1>
			<p class="mkt-sub">Groundwork plans each goal from first principles and keeps the due date in view.</p>
			${cta("/#signin", "Start free")}
			${shotFigure({
				base: "/shots/goals",
				width: 2450,
				height: 2195,
				eager: true,
				alt: "Goal Derivatives for Calc I, due Tuesday, December 8, with 15 days left and marked on pace. The bar shows study days up to the exam, and 4 of 14 concepts are solid.",
			})}
			${section("Planned from the foundations up", ["Tell Groundwork what you want to learn. It works out the concepts the goal depends on and orders them so the foundations come first."])}
			${section("Every goal has a due date", ["Attach a date to each goal, whether it’s an exam, a project, or a self-imposed deadline. If you don’t name a date, a new goal is due in 14 days. The Goals tab shows each goal, its date, and how far along you are."])}
			${section("Built for exams too", ["For a class, start from exam prep: drop in slides, homework, a study guide, or a practice exam and Groundwork builds the exam goal for you. See <a href=\"/exam-prep\">exam prep</a>."])}
			${section("Progress you can trust", ["Progress comes from quiz cards, and mastery fades over time, so rusty concepts come back for review."])}
			${cta("/#signin", "Start free")}
		`,
	});
}

function startPage(): string {
	return page({
		path: "/get-started",
		title: "Get Groundwork running in Obsidian",
		description: "Download Obsidian, add the Groundwork plugin, and connect your free account. Desktop only. Sign up on a phone, finish on a computer.",
		scripts: `<script src="/setup.js?v=2"></script>`,
		main: `
			<h1>Get Groundwork running</h1>
			<p class="mkt-sub">Three steps on your computer. Free is ready when you connect.</p>
			<div data-setup data-signed-in="0"></div>
			${cta("/#signin", "Start free")}
		`,
	});
}

function privacyPage(): string {
	return page({
		path: "/privacy",
		title: "Privacy · Groundwork",
		description: "What Groundwork stores: Google sign-in, tutor memory on your account, keys you paste, Stripe billing, and ad measurement cookies.",
		main: `
			<h1>Privacy</h1>
			<p class="mkt-sub">What Groundwork stores, and who else sees it. This covers groundworklearn.com and the Groundwork plugin.</p>
			${section("Google sign-in", ["You sign in with Google. We receive the name and email on that Google account, and a sign-in token that proves it’s you. We use them to open your Groundwork account. We don’t get your Google password."])}
			${section("Your study record", ["The account holds tutor memory: concept notes, goals, quiz answers, flashcards, chats, and a short profile of how you learn. That record is what lets the same progress show up on each computer where you sign in.", "The account page on this site draws your concept map: titles, how concepts connect, and whether each one is solid, shaky, learning, rusty, or not started. It does not show the text of your notes or your quiz answers.", "Groundwork records aggregate usage counts and costs per account to run and price the service, never note or chat content.", "When the tutor answers, your message and any files you attach are sent to the model that runs it: Groundwork’s model provider on Free and the $20 plan, or the provider you connect on Bring your own model."])}
			${section("Obsidian", ["Groundwork is a plugin for Obsidian desktop. Your vault stays on your computer. The tutor reads only the vault folders you allow in settings, and it writes a file only in folders you mark for that. You can attach a slide, a PDF, or an image from those folders.", "Connecting Obsidian uses a one-time code from this site. Connect Groundwork opens that code. The code expires in about 10 minutes, works once, and is stored only as a hash. That link does not contain your sign-in. Plugins from before 0.2.3 can use the older link on the checklist. The older link carries the same sign-in handoff this site used before, and only after you choose it.", "The plugin sends a random install id the first time it runs, so we can count installs. That ping does not include your notes, chats, or vault."])}
			${section("Finishing setup on a computer", ["Groundwork does not run on a phone. If you sign up on one, this site can copy or share a link to the setup page, and it can show a QR code of that same address. We don’t email the link."])}
			${section("Keys you paste", ["On the Bring your own model plan you can save a key for OpenRouter, Anthropic, Google, xAI, or OpenAI. The key is stored on your account and used only on Groundwork’s server to call that provider. The plugin does not send the key.", "Claude on your computer is separate. If you use a Claude subscription, Claude Code runs on your machine. That login stays there. Groundwork does not receive it."])}
			${section("Billing", ["Paid plans are billed by Stripe. Stripe gets what it needs to charge the card and send receipts. Groundwork stores the Stripe customer id and which plan you’re on."])}
			${section("Cookies, ads, and analytics", ["We use Google Analytics and Google Ads to see which ads bring people here, and whether they create an account, connect Obsidian, or start a paid plan. When checkout completes, Groundwork reports that purchase to Google Analytics with the amount Stripe charged. Google may also use these cookies to personalize the ads you see. You can change that at <a href='https://adssettings.google.com'>adssettings.google.com</a>.", "If you’re in the United States, those cookies are on unless you opt out. Everywhere else they stay off. OK closes the notice and leaves that as it is. Opt out turns them off in this browser. Cookies in the footer opens the notice again."])}
			${section("Children", [`We don’t knowingly collect personal information from anyone under 18, including children under 13. If we learn that we have, we delete it. Email <a href="mailto:${EMAIL}" data-contact-email>${EMAIL}</a>.`])}
			${section("Deletion and questions", [`Email <a href="mailto:${EMAIL}" data-contact-email>${EMAIL}</a> to ask for a copy of your account data or to delete it. Deleting the account removes the study record, saved keys, and the billing link we store. It does not delete files in your Obsidian vault. Cancel a paid plan from Manage billing on your account page, or ask us to cancel it when you write.`])}
			<p class="fine">See also the <a href="/terms">terms</a>.</p>
		`,
	});
}

function termsPage(): string {
	return page({
		path: "/terms",
		title: "Terms · Groundwork",
		description: "Terms for Groundwork: the Free plan, Bring your own model at $6/month, and Groundwork at $20/month, billed through Stripe.",
		main: `
			<h1>Terms</h1>
			<p class="mkt-sub">These terms cover the Groundwork website and the Groundwork plugin for Obsidian desktop.</p>
			${section("The product", ["Groundwork is a tutor that runs inside Obsidian on a desktop computer. It does not run on a phone. You need an account. You sign in with Google at groundworklearn.com."])}
			${section("Age", ["You must be 18 or older to use Groundwork. You must be at least 18 to create an account or use Groundwork. Groundwork isn’t directed to anyone under 18, and we close accounts we learn belong to someone under 18."])}
			${section("Plans", ["Free is $0. It stays on the Light model and has a monthly limit on tutor use. Your account shows the share of that month you’ve used. Decks you already have stay available to review.", "Bring your own model is $6 per month. You use the Claude subscription on your computer, or a key you paste. Heavy uses that model and key. Flashcards are included. Model use on that subscription or key is billed by the provider, not by Groundwork. The $6 is for Groundwork.", "Groundwork is $20 per month. We run the models, Light or Heavy. Flashcards are included.", "Heavy and new flashcards are on the paid plans. Prices are listed on <a href=\"/pricing\">Plans</a>."])}
			${section("Billing and cancellation", ["Paid plans are billed monthly by Stripe. You can switch plans on your account page. To change or cancel a paid plan, open Manage billing, which takes you to Stripe. Canceling stops the next charge. It does not delete your study record.", "Stripe may add tax where it has to."])}
			${section("Your notes", ["Your vault is yours. Groundwork reads and writes only the folders you allow. You’re responsible for the files you attach and for having the right to use them."])}
			${section("The service", ["We can suspend an account that abuses the service or tries to break it. If these terms change, the new page is the one that applies."])}
			${section("Contact", [`Questions: <a href="mailto:${EMAIL}" data-contact-email>${EMAIL}</a>. The <a href="/privacy">privacy page</a> says what we store and how to ask for deletion.`])}
		`,
	});
}

const PAGES: Array<{ path: string; file: string; html: () => string }> = [
	{ path: "/pricing", file: "pricing/index.html", html: pricingPage },
	{ path: "/byom", file: "byom/index.html", html: byomPage },
	{ path: "/practice-tests", file: "practice-tests/index.html", html: practicePage },
	{ path: "/exam-prep", file: "exam-prep/index.html", html: examPage },
	{ path: "/concept-map", file: "concept-map/index.html", html: conceptPage },
	{ path: "/quizzes-flashcards", file: "quizzes-flashcards/index.html", html: quizzesPage },
	{ path: "/goals", file: "goals/index.html", html: goalsPage },
	{ path: "/get-started", file: "get-started/index.html", html: startPage },
	{ path: "/privacy", file: "privacy/index.html", html: privacyPage },
	{ path: "/terms", file: "terms/index.html", html: termsPage },
	{ path: "/changelog", file: "changelog/index.html", html: changelogPage },
];

export function publicPagePaths(): string[] {
	return ["/", ...PAGES.map((page) => page.path)];
}

export function sitemapXml(): string {
	// /llms.txt is a model card, not an HTML page, so it stays out of the sitemap.
	const urls = publicPagePaths().map((href) => `  <url><loc>${ORIGIN}${href === "/" ? "/" : href}</loc></url>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(): string {
	return `User-agent: *\nAllow: /\nDisallow: /v1/\nDisallow: /api/\nDisallow: /admin/\nDisallow: /graph-harness.html\nDisallow: /graph-account-preview.html\n\nSitemap: ${ORIGIN}/sitemap.xml\n`;
}

function adminUsageShell(): string {
	return page({
		path: "/admin/usage",
		title: "Usage · Groundwork",
		description: "Free plan usage for Groundwork.",
		noindex: true,
		wide: true,
		main: `<div id="usage-root"><p class="loading">Loading…</p></div>`,
	});
}

export function renderSite(urlPath: string): { body: string; type: string } | null {
	if (urlPath === "/admin/usage") return { body: adminUsageShell(), type: "text/html; charset=utf-8" };
	const hit = PAGES.find((item) => item.path === urlPath);
	if (hit) return { body: hit.html(), type: "text/html; charset=utf-8" };
	if (urlPath === "/sitemap.xml") return { body: sitemapXml(), type: "application/xml; charset=utf-8" };
	if (urlPath === "/robots.txt") return { body: robotsTxt(), type: "text/plain; charset=utf-8" };
	if (urlPath === "/llms.txt") return { body: llmsTxt(), type: "text/plain; charset=utf-8" };
	return null;
}

export function siteFiles(): SiteFile[] {
	return [
		...PAGES.map((item) => ({ path: item.path, file: item.file, body: item.html(), type: "text/html; charset=utf-8" })),
		{ path: "/admin/usage", file: "admin/usage/index.html", body: adminUsageShell(), type: "text/html; charset=utf-8" },
		{ path: "/sitemap.xml", file: "sitemap.xml", body: sitemapXml(), type: "application/xml; charset=utf-8" },
		{ path: "/robots.txt", file: "robots.txt", body: robotsTxt(), type: "text/plain; charset=utf-8" },
		{ path: "/llms.txt", file: "llms.txt", body: llmsTxt(), type: "text/plain; charset=utf-8" },
	];
}

export function writePublicFiles(dir: string): void {
	for (const file of siteFiles()) {
		const full = path.join(dir, file.file);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, file.body);
	}
}
