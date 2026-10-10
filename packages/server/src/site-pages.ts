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

function nav(current: string): string {
	return siteNav(current);
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
		<nav class="foot-features" aria-label="Features">
			<a href="/practice-tests">Practice tests</a>
			<a href="/exam-prep">Exam prep</a>
			<a href="/concept-map">Concept map</a>
			<a href="/quizzes-flashcards">Quizzes &amp; flashcards</a>
			<a href="/goals">Goals</a>
		</nav>
	</footer>`;
}

function page(spec: { path: string; title: string; description: string; main: string; map?: boolean; noindex?: boolean; wide?: boolean }): string {
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
		<link rel="stylesheet" href="/styles.css?v=18" />
		<script src="/tracking.js?v=6"></script>
	</head>
	<body>
		<div class="page mkt">
			<a class="skip" href="#content">Skip to content</a>
			<header class="bar">
				<a class="logo" href="/" aria-label="Groundwork home">${LOGO}</a>
				${nav(spec.path)}
			</header>
			<main id="content" class="mkt-main${spec.wide ? " usage-main" : ""}">
				${spec.main}
			</main>
			${footer()}
		</div>
		<script src="/site-session.js?v=2"></script>
		${mapScript}
	</body>
</html>
`;
}

function pricingPage(): string {
	return page({
		path: "/pricing",
		title: "Groundwork pricing: Free, $6/mo, or $20/mo",
		description: "Start free on Groundwork’s smaller model. Bring your own model for $6/mo, or let Groundwork run the models for $20/mo. Billed through Stripe.",
		main: `
			<h1>Plans</h1>
			<p class="mkt-sub">All three plans run in Obsidian desktop. They differ in which model runs the tutor. The study tools are the same on each plan. Free uses Groundwork’s smaller model and has a monthly limit on tutor use.</p>
			${cta("/#signin", "Start free")}
			<ul class="plan-cards">
				<li class="plan-card">
					<h2>Free</h2>
					<p class="price">$0</p>
					<p>Uses Groundwork’s smaller model. A good way to set up a goal, see your concept map, and try a few quiz cards before deciding. Tutor use has a monthly limit. Your account shows the share of that month you’ve used.</p>
					<a class="cta" href="/#signin">Start free${ARROW}</a>
				</li>
				<li class="plan-card">
					<h2>Bring your own model</h2>
					<p class="price">$6<span>/month</span></p>
					<p>Use a model you already pay for. Connect the Claude subscription on your computer, or paste a key from OpenRouter, Anthropic, Google, xAI, or OpenAI. Model use on that subscription or key is billed by the provider, not by Groundwork. The $6 covers Groundwork.</p>
					<a class="cta" href="/?plan=byom#signin">Choose $6${ARROW}</a>
				</li>
				<li class="plan-card">
					<h2>Groundwork</h2>
					<p class="price">$20<span>/month</span></p>
					<p>We run the models for you. No keys to manage. Light by default.</p>
					<a class="cta" href="/?plan=included#signin">Choose $20${ARROW}</a>
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

function practicePage(): string {
	return page({
		path: "/practice-tests",
		title: "Practice tests for college exams, in Obsidian | Groundwork",
		description: "Practice questions and practice tests for calculus, statistics, and chemistry exams. See which concept broke, with explanations after each question.",
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
			${section("Questions", [], `
				<h3>Who is Groundwork for?</h3>
				<p>College students and adult learners, 18 and older. It isn’t built for high-school students.</p>
				<h3>Which subjects?</h3>
				<p>Any course you can name. Calculus, statistics, and chemistry work well because math renders in LaTeX.</p>
				<h3>Do I need to upload anything?</h3>
				<p>No. A topic is enough. Slides, notes, or a practice exam make the questions closer to your course.</p>
				<h3>Are these real exam questions?</h3>
				<p>No. Groundwork writes new practice questions. It doesn’t have your professor’s exam.</p>
				<h3>Does it run on a Chromebook, phone, or tablet?</h3>
				<p>No. It’s a plugin for Obsidian on a Windows, Mac, or Linux computer.</p>
				<h3>Is it free?</h3>
				<p>Yes. Free uses Groundwork’s smaller model and has a monthly limit. Bring your own model is $6 a month. Groundwork running the models is $20 a month.</p>
			`)}
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
				width: 2700,
				height: 1914,
				eager: true,
				phone: { base: "/hero/concept-map-phone" },
				alt: "Concept map for Derivatives for Calc I. Goals are dark circles with a red flag. The concepts below are marked solid, shaky, learning, rusty, or not started. The next concept to study is ringed.",
			})}
			${section("A pyramid, not a hairball", ["Foundations sit at the bottom and your goal sits at the top in red. The path between them is highlighted, and concepts that aren’t on the path fade back, so the map stays readable."])}
			${section("Five states for every concept", ["Each concept is marked <strong>solid</strong>, <strong>shaky</strong>, <strong>learning</strong>, <strong>rusty</strong>, or <strong>not started</strong>. The marks come from how you do on quiz cards, not from a checklist you tick yourself. Flashcard reviews count only a little; quiz cards set the marks."])}
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
			${section("Flashcard decks", ["Use flashcard decks for terms, formulas, and anything you want at your fingertips. Flashcard reviews count a little toward a concept; quiz cards set the marks. You can export a deck to your vault as plain Markdown."], shotFigure({
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
					<p>Stay on Free with Groundwork’s smaller model, bring your own model for $6/month (your Claude subscription or a key from OpenRouter, Anthropic, Google, xAI, or OpenAI), or let Groundwork run the models for $20/month. See <a href="/pricing">Plans</a>.</p>
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
			${section("Your study record", ["The account holds tutor memory: concept notes, goals, quiz answers, flashcards, chats, and a short profile of how you learn. That record is what lets the same progress show up on each computer where you sign in.", "The account page on this site draws your concept map: titles, how concepts connect, and whether each one is solid, shaky, learning, rusty, or not started. It does not show the text of your notes or your quiz answers.", "Groundwork records aggregate usage counts and costs per account to run and price the service, never note or chat content.", "When the tutor answers, your message and any files you attach are sent to the model that runs it: Groundwork’s model provider on Free and the $20 plan, or the provider you connect on Bring your own model."])}
			${section("Obsidian", ["Groundwork is a plugin for Obsidian desktop. Your vault stays on your computer. The tutor reads only the vault folders you allow in settings, and it writes a file only in folders you mark for that. You can attach a slide, a PDF, or an image from those folders."])}
			${section("Keys you paste", ["On the Bring your own model plan you can save a key for OpenRouter, Anthropic, Google, xAI, or OpenAI. The key is stored on your account and used only on Groundwork’s server to call that provider. The plugin does not send the key.", "Claude on your computer is separate. If you use a Claude subscription, Claude Code runs on your machine. That login stays there. Groundwork does not receive it."])}
			${section("Billing", ["Paid plans are billed by Stripe. Stripe gets what it needs to charge the card and send receipts. Groundwork stores the Stripe customer id and which plan you’re on."])}
			${section("Cookies, ads, and analytics", ["We use Google Analytics and Google Ads to see which ads bring people here, and whether they create an account, connect Obsidian, or start a paid plan. When checkout completes, the server reports that purchase to Google Analytics with the amount Stripe charged. Google may also use these cookies to personalize the ads you see. You can change that at <a href='https://adssettings.google.com'>adssettings.google.com</a>.", "If you’re in the United States, those cookies are on unless you opt out. Everywhere else they stay off. OK closes the notice and leaves that as it is. Opt out turns them off in this browser. Cookies in the footer opens the notice again."])}
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
			${section("Plans", ["Free is $0. It uses Groundwork’s smaller model and has a monthly limit on tutor use. Your account shows the share of that month you’ve used.", "Bring your own model is $6 per month. You use the Claude subscription on your computer, or a key you paste. Model use on that subscription or key is billed by the provider, not by Groundwork. The $6 is for Groundwork.", "Groundwork is $20 per month. We run the models. Light by default.", "The study tools are the same on each plan. What changes is which model answers, and who pays for that use. Prices are listed on <a href=\"/pricing\">Plans</a>."])}
			${section("Billing and cancellation", ["Paid plans are billed monthly by Stripe. You can switch plans on your account page. To change or cancel a paid plan, open Manage billing, which takes you to Stripe. Canceling stops the next charge. It does not delete your study record.", "Stripe may add tax where it has to."])}
			${section("Your notes", ["Your vault is yours. Groundwork reads and writes only the folders you allow. You’re responsible for the files you attach and for having the right to use them."])}
			${section("The service", ["We can suspend an account that abuses the service or tries to break it. If these terms change, the new page is the one that applies."])}
			${section("Contact", [`Questions: <a href="mailto:${EMAIL}" data-contact-email>${EMAIL}</a>. The <a href="/privacy">privacy page</a> says what we store and how to ask for deletion.`])}
		`,
	});
}

const PAGES: Array<{ path: string; file: string; html: () => string }> = [
	{ path: "/pricing", file: "pricing/index.html", html: pricingPage },
	{ path: "/practice-tests", file: "practice-tests/index.html", html: practicePage },
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
	return null;
}

export function siteFiles(): SiteFile[] {
	return [
		...PAGES.map((item) => ({ path: item.path, file: item.file, body: item.html(), type: "text/html; charset=utf-8" })),
		{ path: "/admin/usage", file: "admin/usage/index.html", body: adminUsageShell(), type: "text/html; charset=utf-8" },
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
