import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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

function shotFigure(spec: { base: string; alt: string; width: number; height: number; eager?: boolean }): string {
	const srcset = (ext: string) => SHOT_WIDTHS.map((width) => `${spec.base}-${width}.${ext} ${width}w`).join(", ");
	const priority = spec.eager ? ` fetchpriority="high"` : ` loading="lazy"`;
	return `<figure class="mkt-shot">
		<picture>
			<source type="image/avif" srcset="${srcset("avif")}" sizes="(max-width: 800px) 92vw, 720px" />
			<source type="image/webp" srcset="${srcset("webp")}" sizes="(max-width: 800px) 92vw, 720px" />
			<img src="${spec.base}-768.webp" width="${spec.width}" height="${spec.height}" alt="${escapeAttr(spec.alt)}"${priority} />
		</picture>
	</figure>`;
}

function section(title: string, paragraphs: string[], extra = ""): string {
	const body = paragraphs.map((p) => `<p>${p}</p>`).join("");
	return `<section class="mkt-section"><h2>${title}</h2>${body}${extra}</section>`;
}

function nav(current: string): string {
	const link = (href: string, label: string, sign = false) => {
		const currentAttr = href === current ? ` aria-current="page"` : "";
		const cls = sign ? ` class="sign-link"` : "";
		return `<a href="${href}"${cls}${currentAttr}>${label}</a>`;
	};
	const wide = (href: string, label: string) => {
		const currentAttr = href === current ? ` aria-current="page"` : "";
		return `<a class="nav-wide" href="${href}"${currentAttr}>${label}</a>`;
	};
	const item = (href: string, label: string) => {
		const currentAttr = href === current ? ` aria-current="page"` : "";
		return `<a href="${href}"${currentAttr}>${label}</a>`;
	};
	return `<nav class="bar-nav" aria-label="Site">${wide("/pricing", "Pricing")}${wide("/get-started", "Get started")}<details class="nav-more"><summary>Menu</summary><div class="nav-menu">${item("/pricing", "Pricing")}${item("/get-started", "Get started")}</div></details>${link("/#signin", "Sign in", true)}</nav>`;
}

function footer(): string {
	return `<footer class="foot">
		<a class="logo" href="/" aria-label="Groundwork home">${LOGO}</a>
		<nav class="foot-links" aria-label="Footer">
			<a href="/privacy">Privacy</a>
			<a href="/terms">Terms</a>
			<a href="mailto:${EMAIL}" data-contact-email>${EMAIL}</a>
			<button type="button" class="foot-button" data-consent-open>Cookies</button>
		</nav>
	</footer>`;
}

function page(spec: { path: string; title: string; description: string; main: string; map?: boolean }): string {
	const url = `${ORIGIN}${spec.path}`;
	const mapScript = spec.map
		? `<script type="module" src="/force-graph.js?v=4"></script>
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
		<meta name="twitter:card" content="summary" />
		<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
		<link rel="preconnect" href="https://fonts.googleapis.com" />
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
		<link rel="preload" href="https://fonts.gstatic.com/s/jost/v20/92zatBhPNqw73oTd4jQmfxI.woff2" as="font" type="font/woff2" crossorigin />
		<link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap" rel="stylesheet" />
		<link rel="stylesheet" href="/styles.css?v=11" />
		<script src="/tracking.js?v=3"></script>
	</head>
	<body>
		<div class="page mkt">
			<a class="skip" href="#content">Skip to content</a>
			<header class="bar">
				<a class="logo" href="/" aria-label="Groundwork home">${LOGO}</a>
				${nav(spec.path)}
			</header>
			<main id="content" class="mkt-main">
				${spec.main}
			</main>
			${footer()}
		</div>
		${mapScript}
	</body>
</html>
`;
}

function pricingPage(): string {
	return page({
		path: "/pricing",
		title: "Groundwork pricing: Free, $4/mo, or $15/mo",
		description: "Start free on Groundwork’s smaller model. Bring your own model for $4/mo, or let Groundwork run the models for $15/mo. Billed through Stripe.",
		main: `
			<h1>Plans</h1>
			<p class="mkt-sub">All three plans run in Obsidian desktop. They differ in which model runs the tutor. The study tools are the same on each plan. Free uses Groundwork’s smaller model and has a monthly limit on tutor use.</p>
			${cta("/#signin", "Start free")}
			<p class="fine">Billing is handled by Stripe.</p>
			<ul class="plan-cards">
				<li class="plan-card">
					<h2>Free</h2>
					<p class="price">$0</p>
					<p>Uses Groundwork’s smaller model. A good way to set up a goal, see your concept map, and try a few quiz cards before deciding. Tutor use has a monthly limit. Your account shows the share of that month you’ve used.</p>
					<a class="cta" href="/#signin">Start free${ARROW}</a>
				</li>
				<li class="plan-card">
					<h2>Bring your own model</h2>
					<p class="price">$4<span>/month</span></p>
					<p>Use a model you already pay for. Connect the Claude subscription on your computer, or paste a key from OpenRouter, Anthropic, Google, xAI, or OpenAI. Model use on that subscription or key is billed by the provider, not by Groundwork. The $4 covers Groundwork.</p>
					<a class="cta" href="/?plan=byom#signin">Choose $4 plan${ARROW}</a>
				</li>
				<li class="plan-card">
					<h2>Groundwork</h2>
					<p class="price">$15<span>/month</span></p>
					<p>We run the models for you. No keys to manage.</p>
					<a class="cta" href="/?plan=included#signin">Choose $15 plan${ARROW}</a>
				</li>
			</ul>
			<section class="mkt-section">
				<h2>Questions</h2>
				<h3>Do I need Obsidian?</h3>
				<p>Yes. Groundwork is a plugin for Obsidian desktop.</p>
				<h3>Does it work on my phone?</h3>
				<p>No. Groundwork is desktop only. You can sign up on your phone and install on your computer later.</p>
				<h3>What does “bring your own model” mean?</h3>
				<p>Groundwork uses your Claude subscription or your API key instead of ours, which is why the plan costs less.</p>
				<h3>How am I billed?</h3>
				<p>Through Stripe, monthly.</p>
				<h3>Can I change plans later?</h3>
				<p>Yes. Pick another plan on your account page. To change or cancel a paid plan, open Manage billing. That goes to Stripe.</p>
				<h3>Does my progress carry over between plans?</h3>
				<p>Yes. Your goals, concept map, and quiz history stay on your account when you change plans. Progress syncs across your computers either way.</p>
			</section>
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
				width: 1808,
				height: 806,
				eager: true,
				alt: "Tutor chat after attaching MATH-151-practice-exam.md. Groundwork saved the goal Prepare for MATH 151 practice, due in just over three weeks, with 4 of 14 concepts solid.",
			})}
			${section("Bring what you have", ["Lecture slides, a couple of homework sets, a study guide, or a practice exam. Drop them onto the tutor in Obsidian. Groundwork reads each file to work out what it covers. It only reads vault folders you allow in settings."])}
			${section("Get an exam goal with a due date", ["Groundwork pulls out the topics and the level of depth the exam seems to expect, and turns them into an exam goal with your exam date attached. The Goals tab shows how far along you are."])}
			${section("Foundations first, then the exam", ["The plan is built from first principles: the concepts the exam material depends on come first, and the exam topics sit at the top of your concept map in red. You can see which topics are solid and which are still shaky."], shotFigure({
				base: "/shots/exam-map",
				width: 2168,
				height: 1678,
				alt: "Concept map for a calculus exam. Chain rule, derivative of sine, derivative of cosine, and quotient rule are goals in red. Foundations such as functions and slope of a line sit below, marked solid, shaky, learning, rusty, or not started.",
			}))}
			${section("Quiz until the gaps show up", ["Diagnostic quiz cards test each topic at levels 1 to 5. A careless slip isn’t counted as a gap, and misconceptions are tracked, so you find the real weak spots before the exam does."])}
			${section("Math and diagrams included", ["The tutor renders LaTeX math and can explain with callouts and diagrams. Attach a slide or an image of a problem when you get stuck."])}
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
				width: 2168,
				height: 1678,
				eager: true,
				alt: "Concept map for Derivatives for Calc I. Chain rule is the goal in red at the top, and the concepts below are marked solid, shaky, learning, rusty, not started, or next.",
			})}
			${section("A pyramid, not a hairball", ["Foundations sit at the bottom and your goal sits at the top in red. The path between them is highlighted, and concepts that aren’t on the path fade back, so the map stays readable."])}
			${section("Five states for every concept", ["Each concept is marked <strong>solid</strong>, <strong>shaky</strong>, <strong>learning</strong>, <strong>rusty</strong>, or <strong>not started</strong>. The marks come from how you do on quiz cards, not from a checklist you tick yourself. Flashcard ratings do not set these marks."])}
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
				width: 1808,
				height: 1436,
				eager: true,
				alt: "Quiz card for the power rule at level 3 of 5. The question is the derivative of x cubed. 3x squared is marked correct, and 3x is marked wrong as a misconception that drops the exponent too far.",
			})}
			${section("Quiz yourself on your own notes and lecture slides", ["Quiz cards can come straight from the notes and lecture slides already in your vault. Groundwork only reads the folders you allow in settings."])}
			${section("Diagnostic, levels 1 to 5", ["Each quiz card targets a concept at a level from 1 to 5. The point is to find where your understanding stops, which is the edge worth working on."])}
			${section("A slip isn’t a gap", ["Everyone mistypes or rushes sometimes. A careless slip isn’t counted as a gap in what you know, so one bad answer doesn’t knock a solid concept back to shaky."])}
			${section("Misconceptions get tracked", ["When an answer shows a wrong idea rather than a missing one, Groundwork tracks it as a misconception, separately from a simple gap."])}
			${section("Flashcard decks", ["Study decks with Again, Hard, Good, and Easy. Use them for terms, formulas, and anything you want at your fingertips."], shotFigure({
				base: "/shots/flashcards",
				width: 1404,
				height: 754,
				alt: "Flashcard for the power rule, asking for the derivative of x to the n. The answer is n x to the n minus 1, with Again, Hard, Good, and Easy.",
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
				width: 2024,
				height: 480,
				eager: true,
				alt: "Goal Derivatives for Calc I, due Tuesday, October 27, with 21 days left and marked on pace. The bar shows study days up to the exam, and 4 of 14 concepts are solid.",
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
		title: "Get started with Groundwork in Obsidian",
		description: "Install Groundwork from Obsidian’s community plugins, sign in with Google at groundworklearn.com, and start your first goal. Desktop only.",
		main: `
			<h1>Get set up in a few minutes.</h1>
			<p class="mkt-sub">You need Obsidian on a desktop computer and a Google account. That’s it.</p>
			<p class="req">Obsidian desktop · Google account · Desktop only, no mobile.</p>
			${cta("/#signin", "Start free")}
			<ol class="setup-steps">
				<li>
					<h2>Install the plugin in Obsidian</h2>
					<p>Open Obsidian on your computer and go to <strong>Settings → Community plugins</strong>. If community plugins are off, turn them on. Choose <strong>Browse</strong>, search for <strong>Groundwork</strong>, then select <strong>Install</strong> and <strong>Enable</strong>.</p>
					<p class="open-obsidian"><a class="btn btn-line" href="obsidian://show-plugin?id=groundwork">Open in Obsidian</a></p>
					<p class="fine">Or install from the <a href="https://community.obsidian.md/plugins/groundwork">community plugin page</a>. You can also download Obsidian from <a href="https://obsidian.md/download">obsidian.md/download</a>.</p>
				</li>
				<li>
					<h2>Sign in at groundworklearn.com</h2>
					<p>Select <strong>Start free</strong> and sign in with Google. This creates your Groundwork account, which holds your plan and keeps your progress in sync across computers.</p>
				</li>
				<li>
					<h2>Connect Obsidian to your account</h2>
					<p>On your account page, choose <strong>Open Obsidian</strong>. Obsidian opens and links this sign-in to the plugin. If Groundwork isn’t installed yet, the site opens the community plugin page so you can install it. Once connected, the tutor is ready in Obsidian.</p>
				</li>
				<li>
					<h2>Pick how the tutor runs</h2>
					<p>Stay on Free with Groundwork’s smaller model, bring your own model for $4/month (your Claude subscription or a key from OpenRouter, Anthropic, Google, xAI, or OpenAI), or let Groundwork run the models for $15/month. See <a href="/pricing">Plans</a>.</p>
				</li>
				<li>
					<h2>Start a goal</h2>
					<p>Set a goal with a due date, or drop in exam material to build an exam goal. Your concept map appears as you go.</p>
				</li>
			</ol>
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
			${section("Your study record", ["The account holds tutor memory: concept notes, goals, quiz answers, flashcards, chats, and a short profile of how you learn. That record is what lets the same progress show up on each computer where you sign in.", "The account page on this site draws your concept map: titles, how concepts connect, and whether each one is solid, shaky, learning, rusty, or not started. It does not show the text of your notes or your quiz answers.", "When the tutor answers, your message and any files you attach are sent to the model that runs it: Groundwork’s model provider on Free and the $15 plan, or the provider you connect on Bring your own model."])}
			${section("Obsidian", ["Groundwork is a plugin for Obsidian desktop. Your vault stays on your computer. The tutor reads only the vault folders you allow in settings, and it writes a file only in folders you mark for that. You can attach a slide, a PDF, or an image from those folders."])}
			${section("Keys you paste", ["On the Bring your own model plan you can save a key for OpenRouter, Anthropic, Google, xAI, or OpenAI. The key is stored on your account and used only on Groundwork’s server to call that provider. The plugin does not send the key.", "Claude on your computer is separate. If you use a Claude subscription, Claude Code runs on your machine. That login stays there. Groundwork does not receive it."])}
			${section("Billing", ["Paid plans are billed by Stripe. Stripe gets what it needs to charge the card and send receipts. Groundwork stores the Stripe customer id and which plan you’re on."])}
			${section("Cookies, ads, and analytics", ["We use Google Analytics and Google Ads to see which ads bring people here, and whether they create an account, connect Obsidian, or start a paid plan. Google may also use these cookies to personalize the ads you see. You can change that at <a href='https://adssettings.google.com'>adssettings.google.com</a>.", "If you’re in the United States, those cookies are on unless you opt out. Everywhere else they stay off. OK closes the notice and leaves that as it is. Opt out turns them off in this browser. Cookies in the footer opens the notice again."])}
			${section("Deletion and questions", [`Email <a href="mailto:${EMAIL}" data-contact-email>${EMAIL}</a> to ask for a copy of your account data or to delete it. Deleting the account removes the study record, saved keys, and the billing link we store. It does not delete files in your Obsidian vault. Cancel a paid plan from Manage billing on your account page, or ask us to cancel it when you write.`])}
			<p class="fine">See also the <a href="/terms">terms</a>.</p>
		`,
	});
}

function termsPage(): string {
	return page({
		path: "/terms",
		title: "Terms · Groundwork",
		description: "Terms for Groundwork: the Free plan, Bring your own model at $4/month, and Groundwork at $15/month, billed through Stripe.",
		main: `
			<h1>Terms</h1>
			<p class="mkt-sub">These terms cover the Groundwork website and the Groundwork plugin for Obsidian desktop.</p>
			${section("The product", ["Groundwork is a tutor that runs inside Obsidian on a desktop computer. It does not run on a phone. You need an account. You sign in with Google at groundworklearn.com."])}
			${section("Plans", ["Free is $0. It uses Groundwork’s smaller model and has a monthly limit on tutor use. Your account shows the share of that month you’ve used.", "Bring your own model is $4 per month. You use the Claude subscription on your computer, or a key you paste. Model use on that subscription or key is billed by the provider, not by Groundwork. The $4 is for Groundwork.", "Groundwork is $15 per month. We run the models.", "The study tools are the same on each plan. What changes is which model answers, and who pays for that use. Prices are listed on <a href=\"/pricing\">Plans</a>."])}
			${section("Billing and cancellation", ["Paid plans are billed monthly by Stripe. You can switch plans on your account page. To change or cancel a paid plan, open Manage billing, which takes you to Stripe. Canceling stops the next charge. It does not delete your study record.", "Stripe may add tax where it has to."])}
			${section("Your notes", ["Your vault is yours. Groundwork reads and writes only the folders you allow. You’re responsible for the files you attach and for having the right to use them."])}
			${section("The service", ["We can suspend an account that abuses the service or tries to break it. If these terms change, the new page is the one that applies."])}
			${section("Contact", [`Questions: <a href="mailto:${EMAIL}" data-contact-email>${EMAIL}</a>. The <a href="/privacy">privacy page</a> says what we store and how to ask for deletion.`])}
		`,
	});
}

const PAGES: Array<{ path: string; file: string; html: () => string }> = [
	{ path: "/pricing", file: "pricing/index.html", html: pricingPage },
	{ path: "/exam-prep", file: "exam-prep/index.html", html: examPage },
	{ path: "/concept-map", file: "concept-map/index.html", html: conceptPage },
	{ path: "/quizzes-flashcards", file: "quizzes-flashcards/index.html", html: quizzesPage },
	{ path: "/goals", file: "goals/index.html", html: goalsPage },
	{ path: "/get-started", file: "get-started/index.html", html: startPage },
	{ path: "/privacy", file: "privacy/index.html", html: privacyPage },
	{ path: "/terms", file: "terms/index.html", html: termsPage },
];

export function publicPagePaths(): string[] {
	return ["/", ...PAGES.map((page) => page.path)];
}

export function sitemapXml(): string {
	const urls = publicPagePaths().map((href) => `  <url><loc>${ORIGIN}${href === "/" ? "/" : href}</loc></url>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(): string {
	return `User-agent: *\nAllow: /\nDisallow: /v1/\nDisallow: /graph-harness.html\nDisallow: /graph-account-preview.html\n\nSitemap: ${ORIGIN}/sitemap.xml\n`;
}

export function renderSite(urlPath: string): { body: string; type: string } | null {
	const hit = PAGES.find((item) => item.path === urlPath);
	if (hit) return { body: hit.html(), type: "text/html; charset=utf-8" };
	if (urlPath === "/sitemap.xml") return { body: sitemapXml(), type: "application/xml; charset=utf-8" };
	if (urlPath === "/robots.txt") return { body: robotsTxt(), type: "text/plain; charset=utf-8" };
	return null;
}

export function siteFiles(): SiteFile[] {
	return [
		...PAGES.map((item) => ({ path: item.path, file: item.file, body: item.html(), type: "text/html; charset=utf-8" })),
		{ path: "/sitemap.xml", file: "sitemap.xml", body: sitemapXml(), type: "application/xml; charset=utf-8" },
		{ path: "/robots.txt", file: "robots.txt", body: robotsTxt(), type: "text/plain; charset=utf-8" },
	];
}

export function writePublicFiles(dir: string): void {
	for (const file of siteFiles()) {
		const full = path.join(dir, file.file);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, file.body);
	}
}
