const landing = document.querySelector("#landing");
const site = document.querySelector("#site");
const app = document.querySelector("#app");
const chip = document.querySelector("#account-chip");
const dotfield = document.querySelector(".dotfield");

const params = new URLSearchParams(location.search);
const billingFlag = params.get("billing");
const billingNote = billingFlag === "success"
	? "Payment started. Your plan updates as soon as Stripe confirms it."
	: billingFlag === "cancel"
		? "Checkout was canceled. Your plan is unchanged."
		: "";

const NODE = { free: "green", byom: "blue", included: "orange" };
const PROVIDER_LABEL = { anthropic: "Anthropic", openrouter: "OpenRouter", google: "Google", xai: "xAI", openai: "OpenAI" };

let config = { firebase: null, billing: false };
let plans = [];
let account = null;
let providers = null;
let tutor = null;
let groundwork = emptyGroundwork();
let groundworkTimer = 0;
let user = null;
let auth = null;
let firebaseAuth = null;
let problem = "";
let actionError = "";

boot().catch((err) => {
	problem = err.message;
	paint();
});

window.addEventListener("hashchange", () => paint());
bindParallax();
bindReveal();

async function boot() {
	const [web, planList] = await Promise.all([get("/v1/web-config"), get("/v1/plans")]);
	config = web;
	plans = planList.plans;
	if (!config.firebase) {
		problem = "Google sign-in needs the Firebase web config on this server (FIREBASE_WEB_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID).";
		paint();
		return;
	}
	const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js");
	firebaseAuth = await import("https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js");
	initializeApp(config.firebase);
	auth = firebaseAuth.getAuth();
	firebaseAuth.onAuthStateChanged(auth, async (next) => {
		user = next;
		if (!user) {
			account = null;
			providers = null;
			groundwork = emptyGroundwork();
			paint();
			return;
		}
		try {
			await refresh();
			problem = "";
			paint();
		} catch (err) {
			user = null;
			problem = err.message;
			paint();
		}
	});
}

async function refresh() {
	const token = await user.getIdToken();
	const [nextAccount, secrets, nextGroundwork, nextTutor] = await Promise.all([
		get("/v1/account", token),
		get("/v1/secrets", token),
		get("/v1/groundwork", token).catch(() => emptyGroundwork()),
		get("/v1/tutor", token),
	]);
	account = nextAccount;
	providers = secrets.providers;
	groundwork = nextGroundwork;
	tutor = nextTutor;
}

function emptyGroundwork() {
	return { updatedAt: null, concepts: [], goals: [], graph: { width: 0, height: 0, nodes: [], edges: [], legend: [] } };
}

function paint() {
	stopGroundworkWatch();
	if (!user || !account) {
		chip.hidden = true;
		if (location.hash === "#signin" || problem) showSignIn();
		else showLanding();
		return;
	}
	if (location.hash === "#signin") history.replaceState(null, "", location.pathname + location.search);
	showApp();
	renderChip();
	if (account.needsPlan || location.hash === "#plans") showPlans();
	else showAccount();
}

function showLanding() {
	landing.hidden = false;
	site.hidden = true;
	site.classList.remove("is-study");
}

function showApp() {
	landing.hidden = true;
	site.hidden = false;
}

function showSignIn() {
	showApp();
	site.classList.add("is-study");
	dotfield.hidden = false;
	show(`
		<div class="hero">
			<div>
				<h1>Sign in to study.</h1>
				<p class="lede">Your plan, billing, and model keys live here. The tutor in Obsidian uses this account.</p>
				${notice(false)}
				<div class="signin"><button class="btn btn-ink" id="google" type="button" ${config.firebase ? "" : "disabled"}>Sign in with Google</button></div>
			</div>
			${heroMark()}
		</div>
	`);
	document.querySelector("#google")?.addEventListener("click", () => signIn());
}

function showPlans() {
	site.classList.remove("is-study");
	dotfield.hidden = true;
	const credit = account.needsPlan
		? "Choose a plan to start."
		: account.ownModel
			? "This plan uses your model. Groundwork does not meter it."
			: "You can change plans below.";
	show(`
		${notice(true)}
		<h1>Choose a plan.</h1>
		<p class="credit">${escapeHtml(credit)}</p>
		${planGrid(true)}
	`);
	for (const button of document.querySelectorAll("[data-plan]")) {
		button.addEventListener("click", () => choose(button.dataset.plan));
	}
}

function showAccount() {
	site.classList.remove("is-study");
	dotfield.hidden = true;
	const name = account.displayName || user.displayName || "there";
	show(`
		${notice(true)}
		<h1>Welcome back, ${escapeHtml(name)}.</h1>
		<p class="welcome-sub">Here is everything you have built so far.</p>
		${board()}
		<div class="open-obsidian">
			<button class="btn btn-ink" id="open-obsidian" type="button">Open Obsidian</button>
		</div>
		<section class="section">
			<h2><span class="node red"></span>Profile</h2>
			<p>This name is what Groundwork shows for you. Your Google account stays the sign-in.</p>
			<form id="profile">
				<div class="row">
					<div class="field grow">
						<label for="displayName">Display name</label>
						<input class="input" type="text" id="displayName" name="displayName" maxlength="80" value="${escapeAttr(account.displayName || user.displayName || "")}" />
						<span class="hint">Up to 80 characters.</span>
					</div>
					<button class="btn btn-ink" type="submit">Save</button>
				</div>
			</form>
		</section>
		<section class="section">
			<h2><span class="node orange"></span>Billing</h2>
			<p>${account.hasBilling ? "Update the card, see invoices, or cancel in Stripe." : "A paid plan opens Stripe checkout. You can change the card later from here."}</p>
			<div class="actions"><button class="btn ${account.hasBilling && config.billing ? "btn-line" : ""}" id="portal" type="button" ${account.hasBilling && config.billing ? "" : "disabled"}>Manage billing</button></div>
		</section>
		${account.ownModel ? keysSection() : hostedTutorSection()}
		<div class="plan-foot">
			<p>Your plan: <strong>${escapeHtml(planLabel())}</strong></p>
			<button class="btn btn-line btn-sm" id="change-plan" type="button">Change plan</button>
		</div>
	`);
	document.querySelector("#profile").addEventListener("submit", saveProfile);
	document.querySelector("#open-obsidian").addEventListener("click", () => openObsidian());
	document.querySelector("#key")?.addEventListener("submit", saveKey);
	document.querySelector("#tutor-setup")?.addEventListener("submit", saveTutor);
	document.querySelector("#portal").addEventListener("click", openPortal);
	document.querySelector("#change-plan").addEventListener("click", () => {
		location.hash = "#plans";
	});
	watchGroundwork();
}

function stopGroundworkWatch() {
	if (!groundworkTimer) return;
	window.clearInterval(groundworkTimer);
	groundworkTimer = 0;
}

function watchGroundwork() {
	stopGroundworkWatch();
	groundworkTimer = window.setInterval(() => {
		void pullGroundwork();
	}, 5000);
}

async function pullGroundwork() {
	if (!user || !account || account.needsPlan || location.hash === "#plans") return;
	try {
		const token = await user.getIdToken();
		const next = await get("/v1/groundwork", token);
		if (JSON.stringify(next?.concepts ?? []) === JSON.stringify(groundwork?.concepts ?? []) && JSON.stringify(next?.goals ?? []) === JSON.stringify(groundwork?.goals ?? [])) return;
		groundwork = next;
		const current = document.querySelector(".board");
		if (!current) return;
		const holder = document.createElement("div");
		holder.innerHTML = board();
		const nextBoard = holder.querySelector(".board");
		if (nextBoard) current.replaceWith(nextBoard);
	} catch {
		// Keep the stats already on screen.
	}
}

function renderChip() {
	chip.hidden = false;
	const name = account.displayName || user.displayName || user.email || "Signed in";
	const email = user.email || account.email || "";
	const letter = escapeHtml(String(name).slice(0, 1).toUpperCase() || "?");
	const photo = user.photoURL ? `<img alt="" src="${escapeAttr(user.photoURL)}" />` : letter;
	chip.innerHTML = `<span class="avatar">${photo}</span><span class="who"><span class="who-name">${escapeHtml(name)}</span><span class="who-email">${escapeHtml(email)}</span></span><button class="link-btn" id="sign-out" type="button">Sign out</button>`;
	chip.querySelector("#sign-out").addEventListener("click", () => firebaseAuth.signOut(auth));
}

function notice(signedIn) {
	const bits = [];
	if (problem && !signedIn) bits.push(banner("red", problem));
	if (actionError) bits.push(banner("red", actionError));
	if (billingNote) bits.push(banner(billingFlag === "success" ? "green" : "hollow", billingNote));
	if (signedIn && !config.billing) bits.push(banner("red", "Stripe is not connected on this server yet, so a paid plan cannot be purchased."));
	return bits.join("");
}

function banner(node, text) {
	return `<div class="banner" role="status"><span class="node ${node}"></span>${escapeHtml(text)}</div>`;
}

function planLabel() {
	if (!account.plan || account.priceUsdPerMonth === 0) return account.name || "Free";
	return `${account.name}, $${account.priceUsdPerMonth} / month`;
}

const GRAPH_COLORS = ["#2db560", "#2e9be6", "#f59e2b", "#e5484d"];

function learnedConcepts() {
	return Array.isArray(groundwork?.concepts) ? groundwork.concepts : [];
}

function reachedGoals() {
	return Array.isArray(groundwork?.goals) ? groundwork.goals : [];
}

function conceptGraph() {
	return groundwork?.graph && Array.isArray(groundwork.graph.nodes) ? groundwork.graph : emptyGroundwork().graph;
}

function board() {
	const concepts = learnedConcepts();
	const goals = reachedGoals();
	const waiting = concepts.some((concept) => concept.status === "unassessed");
	const usage = account.ownModel ? `
			<span class="big">Your model</span>
			<span class="tile-label">Plan usage</span>
			<p class="tile-note">This plan uses your model. Groundwork does not meter it.</p>` : usageTile();
	return `
		<section class="board" aria-labelledby="board-title">
			<div class="blobs"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="blob b4"></div></div>
			<div class="spot"></div>
			<div class="eyebrow" id="board-title"><span class="live"></span>Your groundwork</div>
			<div class="stats">
				<div class="tile">
					<span class="big">${goals.length}</span>
					<span class="tile-label">Goals reached</span>
					<div class="spark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
				</div>
				<div class="tile" style="animation-delay: .12s">
					<span class="big">${concepts.length}</span>
					<span class="tile-label">${waiting ? "Concepts" : "Concepts learned"}</span>
					<p class="tile-note">${escapeHtml(conceptNote(concepts))}</p>
				</div>
				<div class="tile" style="animation-delay: .24s">${usage}</div>
			</div>
			<div class="sky">
				<div class="sky-head">
					<span class="sky-title">${waiting ? "Concepts" : "Concepts you have learned"}</span>
					${graphLegend(conceptGraph())}
				</div>
				${conceptGraphSvg(conceptGraph())}
			</div>
			<div class="goals">
				<h3 class="goals-title">Goals reached</h3>
				${goalList(goals)}
			</div>
		</section>`;
}

function graphLegend(graph) {
	const items = Array.isArray(graph?.legend) ? graph.legend : [];
	if (!items.length) return "";
	return `<ul class="sky-legend">${items.map((item) => `<li><i style="background:${safeColor(item.color)}"></i>${escapeHtml(item.domain)}</li>`).join("")}</ul>`;
}

function conceptNote(concepts) {
	const checked = concepts.filter((concept) => concept.status !== "unassessed").length;
	if (!concepts.length || checked === concepts.length) return "Each one checked with a quiz before it counted.";
	if (!checked) return "Your tutor has these. A quiz has not counted one yet.";
	return checked === 1 ? "1 was checked with a quiz." : `${checked} were checked with a quiz.`;
}

function conceptGraphSvg(graph) {
	const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
	if (!nodes.length) return `<p class="sky-empty">They show up here after a quiz counts them.</p>`;
	const statusOf = new Map(learnedConcepts().map((concept) => [concept.id, concept.status]));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const width = Number.isFinite(graph.width) ? graph.width : 640;
	const height = Number.isFinite(graph.height) ? graph.height : 220;
	const edges = (Array.isArray(graph.edges) ? graph.edges : []).flatMap((edge) => {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (!from || !to) return [];
		const color = edge.bridge ? "rgba(255,255,255,.38)" : safeColor(from.color);
		const dash = edge.bridge ? ` stroke-dasharray="4 5"` : "";
		return [`<line class="graph-edge${edge.bridge ? " is-bridge" : ""}" x1="${num(from.x)}" y1="${num(from.y)}" x2="${num(to.x)}" y2="${num(to.y)}" stroke="${color}"${dash}></line>`];
	});
	const dots = nodes.map((node) => {
		const color = safeColor(node.color);
		const open = statusOf.get(node.id) === "unassessed";
		const anchor = node.labelAnchor === "start" || node.labelAnchor === "end" ? node.labelAnchor : "middle";
		const label = node.label ? `<text class="graph-label" x="${num(node.labelX ?? node.x)}" y="${num(node.labelY ?? node.y + 18)}" text-anchor="${anchor}">${escapeHtml(shortTitle(node.title))}</text>` : "";
		const dot = open
			? `fill="none" stroke="${color}" stroke-width="1.75"`
			: `fill="${color}"`;
		const halo = open ? `fill="none" stroke="${color}" stroke-width="1.25"` : `fill="${color}"`;
		const name = open ? `${node.title} (not quizzed yet)` : node.title;
		return `<g class="graph-node${open ? " is-open" : ""}"><title>${escapeHtml(name)}</title><circle class="graph-halo" cx="${num(node.x)}" cy="${num(node.y)}" r="9" ${halo}></circle><circle class="graph-dot" cx="${num(node.x)}" cy="${num(node.y)}" r="4.5" ${dot}></circle>${label}</g>`;
	});
	return `<svg class="graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Concept graph">${edges.join("")}${dots.join("")}</svg>`;
}

function goalList(goals) {
	if (!goals.length) return `<p class="sky-empty">Goals you finish in Obsidian show up here.</p>`;
	const legend = new Map((conceptGraph().legend || []).map((item) => [item.domain, safeColor(item.color)]));
	return goals.map((goal, index) => {
		const color = legend.get(goal.domain) || GRAPH_COLORS[index % GRAPH_COLORS.length];
		const count = conceptCount(goal.concepts);
		return `
				<div class="goal">
					<span class="goal-dot" style="background:${color}" aria-hidden="true"></span>
					<div class="goal-body"><span class="goal-name">${escapeHtml(goal.title)}</span>${count ? `<span class="goal-meta">${escapeHtml(count)}</span>` : ""}</div>
					<span class="check">Reached</span>
				</div>`;
	}).join("");
}

function conceptCount(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return "";
	return n === 1 ? "1 concept" : `${n} concepts`;
}

function shortTitle(title) {
	const text = String(title ?? "");
	return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

function safeColor(value) {
	return /^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? value : GRAPH_COLORS[0];
}

function num(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function usageTile() {
	const used = Math.min(1, Math.max(0, Number(account.budgetUsed) || 0));
	const pct = Math.round(used * 100);
	const radius = 54;
	const circ = 2 * Math.PI * radius;
	const dash = (used * circ).toFixed(1);
	return `
			<div class="usage">
				<svg class="gauge" viewBox="0 0 120 120" aria-hidden="true">
					<circle cx="60" cy="60" r="${radius}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="8"></circle>
					<circle class="gauge-arc" cx="60" cy="60" r="${radius}" fill="none" stroke="#45A9F0" stroke-width="8" stroke-linecap="round" stroke-dasharray="${dash} ${circ.toFixed(1)}" transform="rotate(-90 60 60)"></circle>
				</svg>
				<div>
					<div class="usage-amt">${pct}%</div>
					<div class="tile-label">of this month's budget used</div>
				</div>
			</div>
			<p class="tile-note" style="margin-top: 10px">Resets at the end of the month.</p>`;
}

function hostedTutorSection() {
	return `
		<section class="section">
			<h2><span class="node green"></span>Tutor</h2>
			<p>Obsidian calls Groundwork, and Groundwork calls the smaller model. One key covers every account on this plan. You do not paste one. This month's budget is what limits the tutor. Written answers are graded with Jev, on our key, and that does not use the tutor budget.</p>
		</section>`;
}

function keysSection() {
	const steps = Array.isArray(tutor?.claude) ? tutor.claude : [];
	const savedNames = Object.entries(providers).filter(([, on]) => on).map(([name]) => name);
	const via = account.tutorVia === "key" && savedNames.length ? "key" : "claude";
	return `
		<section class="section">
			<h2><span class="node blue"></span>Your model</h2>
			<p>This plan uses a model you already pay for. Groundwork does not meter it.</p>
			<h3>Claude subscription</h3>
			<p>The simplest path. The login stays on this computer. Groundwork never stores it.</p>
			<ol class="setup-list">${steps.map((step) => `<li><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.detail)}</p></li>`).join("")}</ol>
			<form id="tutor-setup">
				<fieldset class="choices">
					<legend>How the tutor should run</legend>
					<label><input type="radio" name="via" value="claude" ${via === "claude" ? "checked" : ""} /> Claude subscription on this computer</label>
					<label><input type="radio" name="via" value="key" ${via === "key" ? "checked" : ""} ${savedNames.length ? "" : "disabled"} /> A saved provider key</label>
				</fieldset>
				${savedNames.length ? `<div class="field tutor-provider"><label for="tutorProvider">Provider</label><select class="input" id="tutorProvider" name="provider">${savedNames.map((name) => `<option value="${escapeAttr(name)}" ${account.tutorProvider === name ? "selected" : ""}>${escapeHtml(PROVIDER_LABEL[name] || name)}</option>`).join("")}</select></div>` : `<p class="hint">Paste a key below before the tutor can use one.</p>`}
				<div class="actions"><button class="btn btn-ink" type="submit">Save tutor</button></div>
			</form>
			<h3>Or paste a provider key</h3>
			<p>The key stays on this account. The tutor calls that provider through Groundwork, so it is not written into the vault. Jev stays on our server and is not a key you paste.</p>
			<ul class="keys" aria-label="Saved keys">${keyList()}</ul>
			<form id="key" autocomplete="off">
				<div class="row">
					<div class="field narrow">
						<label for="provider">Provider</label>
						<select class="input" id="provider" name="provider">
							${Object.keys(providers).map((name) => `<option value="${escapeAttr(name)}">${escapeHtml(PROVIDER_LABEL[name] || name)}</option>`).join("")}
						</select>
					</div>
					<div class="field grow">
						<label for="apiKey">Paste a key</label>
						<input class="input" type="password" id="apiKey" name="apiKey" autocomplete="off" spellcheck="false" placeholder="sk-…" />
					</div>
					<button class="btn btn-ink" type="submit">Save key</button>
				</div>
			</form>
		</section>`;
}

function planGrid(signedIn) {
	return `<div class="plans">${plans.map((plan) => {
		const current = signedIn && account?.plan === plan.id;
		const paid = plan.priceUsdPerMonth > 0;
		const blocked = signedIn && paid && !current && !config.billing;
		const price = paid ? `$${plan.priceUsdPerMonth}` : "Free";
		const per = paid ? "<span>/ month</span>" : "";
		const cta = paid ? "Continue to payment" : "Use free";
		let action = "";
		if (signedIn && current) {
			action = `<button class="btn" type="button" data-plan="${escapeAttr(plan.id)}" disabled>Current plan</button>`;
		} else if (blocked) {
			action = `<button class="btn" type="button" disabled>${cta}</button><p class="why">Payment cannot start until Stripe is connected.</p>`;
		} else if (signedIn) {
			action = `<button class="${paid ? "btn btn-ink" : "btn btn-line"}" type="button" data-plan="${escapeAttr(plan.id)}">${cta}</button>`;
		}
		return `<article class="plan${current ? " is-current" : ""}">
			<div class="plan-top"><div class="plan-name"><span class="node ${NODE[plan.id] || "green"}"></span><h3>${escapeHtml(plan.name)}</h3></div>${current ? `<span class="tag">Current</span>` : ""}</div>
			<p class="price">${price}${per}</p>
			<p class="desc">${escapeHtml(plan.summary)}</p>
			${action}
		</article>`;
	}).join("")}</div>`;
}

function keyList() {
	return Object.entries(providers).map(([name, saved]) => `<li><span>${escapeHtml(PROVIDER_LABEL[name] || name)}</span><span class="${saved ? "status saved" : "status"}"><span class="node ${saved ? "green" : "hollow"}" style="width:10px;height:10px"></span>${saved ? "saved" : "not saved"}</span></li>`).join("");
}

function heroMark() {
	return `<div class="mark-wrap" aria-hidden="true">
		<div class="mark-glow"><span class="g1"></span><span class="g2"></span><span class="g3"></span><span class="g4"></span></div>
		<svg class="hero-mark" viewBox="-4 0 128 110">
			<polyline points="10,14 36,98 60,38 84,98 110,14" fill="none" stroke="#16181D" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"></polyline>
			<circle class="halo" cx="10" cy="14" r="10" stroke="#E5484D" style="animation-delay:1s"></circle>
			<circle class="halo" cx="60" cy="38" r="10" stroke="#F59E2B" style="animation-delay:4s"></circle>
			<circle class="halo" cx="110" cy="14" r="10" stroke="#2E9BE6" style="animation-delay:7s"></circle>
			<circle class="halo" cx="36" cy="98" r="10" stroke="#2DB560" style="animation-delay:10s"></circle>
			<circle class="halo" cx="84" cy="98" r="10" stroke="#2DB560" style="animation-delay:13s"></circle>
			<circle cx="10" cy="14" r="10" fill="#E5484D"></circle>
			<circle cx="60" cy="38" r="10" fill="#F59E2B"></circle>
			<circle cx="110" cy="14" r="10" fill="#2E9BE6"></circle>
			<circle cx="36" cy="98" r="10" fill="#2DB560"></circle>
			<circle cx="84" cy="98" r="10" fill="#2DB560"></circle>
		</svg>
	</div>`;
}

async function signIn() {
	const { GoogleAuthProvider, signInWithPopup } = await import("https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js");
	const provider = new GoogleAuthProvider();
	try {
		problem = "";
		await signInWithPopup(auth, provider);
	} catch (err) {
		problem = err.message;
		paint();
	}
}

async function choose(plan) {
	const token = await user.getIdToken();
	try {
		actionError = "";
		if (plan === "free") {
			await send("/v1/account/plan", { plan }, token);
			await refresh();
			history.replaceState(null, "", location.pathname + location.search);
			paint();
			return;
		}
		const { url } = await send("/v1/billing/checkout", { plan }, token);
		location.href = url;
	} catch (err) {
		actionError = err.message;
		paint();
	}
}

async function saveProfile(event) {
	event.preventDefault();
	const token = await user.getIdToken();
	try {
		actionError = "";
		await send("/v1/account/profile", { displayName: new FormData(event.target).get("displayName") }, token);
		await refresh();
		paint();
	} catch (err) {
		actionError = err.message;
		paint();
	}
}

async function saveTutor(event) {
	event.preventDefault();
	const data = new FormData(event.target);
	const token = await user.getIdToken();
	try {
		actionError = "";
		await send("/v1/tutor/setup", { via: data.get("via"), provider: data.get("provider") }, token);
		await refresh();
		paint();
	} catch (err) {
		actionError = err.message;
		paint();
	}
}

async function saveKey(event) {
	event.preventDefault();
	const data = new FormData(event.target);
	const token = await user.getIdToken();
	try {
		actionError = "";
		providers = (await send("/v1/secrets", { provider: data.get("provider"), apiKey: data.get("apiKey") }, token)).providers;
		await refresh();
		paint();
	} catch (err) {
		actionError = err.message;
		paint();
	}
}

const OBSIDIAN_DOWNLOAD = "https://obsidian.md/download";
const OBSIDIAN_INSTALL = "obsidian://show-plugin?id=groundwork";

// The groundwork link is the fast path: an installed plugin connects, syncs, and reloads.
// If the page never leaves, Obsidian is not installed. If Obsidian opens and the plugin never answers, open the community installer.
function openObsidian() {
	const refresh = user && user.refreshToken;
	if (!refresh) {
		actionError = "Sign in again, then open Obsidian.";
		paint();
		return;
	}
	const button = document.querySelector("#open-obsidian");
	if (button) {
		button.disabled = true;
		button.textContent = "Opening Obsidian…";
	}
	const nonce = crypto.randomUUID();
	const signal = `${location.origin}/v1/obsidian-opened/${nonce}/signal`;
	const handoff = `obsidian://groundwork?refresh=${encodeURIComponent(refresh)}&opened=${encodeURIComponent(signal)}`;
	let sawApp = false;
	let askedInstall = false;
	let settled = false;
	const mark = () => {
		sawApp = true;
	};
	const onVis = () => {
		if (document.hidden) mark();
	};
	window.addEventListener("blur", mark);
	document.addEventListener("visibilitychange", onVis);
	const started = performance.now();
	const stop = () => {
		if (settled) return;
		settled = true;
		window.clearInterval(timer);
		window.removeEventListener("blur", mark);
		document.removeEventListener("visibilitychange", onVis);
	};
	openProtocol(handoff);
	const timer = window.setInterval(async () => {
		if (settled) return;
		const elapsed = performance.now() - started;
		if (document.hidden || document.visibilityState === "hidden") mark();
		let opened = false;
		try {
			const res = await fetch(`/v1/obsidian-opened/${nonce}`, { cache: "no-store", signal: AbortSignal.timeout(800) });
			if (res.ok) opened = Boolean((await res.json()).opened);
		} catch {
			opened = false;
		}
		if (settled) return;
		if (opened) {
			stop();
			if (button && button.isConnected) {
				button.disabled = false;
				button.textContent = "Open Obsidian";
			}
			return;
		}
		// Obsidian stayed in front and Groundwork never answered, so ask it to install the plugin.
		if (sawApp && !document.hasFocus() && elapsed > 1600 && !askedInstall) {
			askedInstall = true;
			openProtocol(OBSIDIAN_INSTALL);
		}
		// The page is focused again, so the app did not stay open. A long silence means the same.
		if ((document.hasFocus() && elapsed > 1500) || elapsed > 8000) {
			stop();
			window.location.assign(OBSIDIAN_DOWNLOAD);
		}
	}, 400);
}

function openProtocol(href) {
	const link = document.createElement("a");
	link.href = href;
	link.hidden = true;
	document.body.appendChild(link);
	link.click();
	link.remove();
}

async function openPortal() {
	const token = await user.getIdToken();
	try {
		const { url } = await send("/v1/billing/portal", {}, token);
		location.href = url;
	} catch (err) {
		actionError = err.message;
		paint();
	}
}

async function get(path, token) {
	const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
	return readJson(res);
}

async function send(path, json, token) {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(json),
	});
	return readJson(res);
}

async function readJson(res) {
	const text = await res.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		throw new Error("The account server did not answer.");
	}
	if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
	return body;
}

function show(html) {
	app.innerHTML = html;
}

function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function escapeAttr(value) {
	return escapeHtml(value);
}

function bindReveal() {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const nodes = [...landing.querySelectorAll(".rv")];
	if (!nodes.length) return;
	landing.classList.add("reveal-ready");
	const observer = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			entry.target.classList.add("is-in");
			observer.unobserve(entry.target);
		}
	}, { threshold: 0.2, rootMargin: "0px 0px -8% 0px" });
	for (const node of nodes) observer.observe(node);
}

function bindParallax() {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	let raf = 0;
	let tx = 0;
	let ty = 0;
	let cx = 0;
	let cy = 0;
	const step = () => {
		cx += (tx - cx) * 0.05;
		cy += (ty - cy) * 0.05;
		landing.style.setProperty("--nx", `${cx.toFixed(2)}px`);
		landing.style.setProperty("--ny", `${cy.toFixed(2)}px`);
		const moving = Math.abs(tx - cx) > 0.02 || Math.abs(ty - cy) > 0.02;
		raf = moving ? requestAnimationFrame(step) : 0;
	};
	landing.addEventListener("mousemove", (ev) => {
		const r = landing.getBoundingClientRect();
		tx = -((ev.clientX - r.left) / r.width - 0.5) * 18;
		ty = -((ev.clientY - r.top) / r.height - 0.5) * 12;
		if (!raf) raf = requestAnimationFrame(step);
	});
	landing.addEventListener("mouseleave", () => {
		tx = 0;
		ty = 0;
		if (!raf) raf = requestAnimationFrame(step);
	});
	site.addEventListener("mousemove", (ev) => {
		const board = ev.target.closest?.(".board");
		for (const item of site.querySelectorAll(".board")) {
			if (item !== board) item.classList.remove("is-hover");
		}
		if (board) {
			const r = board.getBoundingClientRect();
			board.style.setProperty("--mx", ((ev.clientX - r.left) / r.width).toFixed(3));
			board.style.setProperty("--my", ((ev.clientY - r.top) / r.height).toFixed(3));
			board.classList.add("is-hover");
			return;
		}
		if (!site.classList.contains("is-study")) return;
		const r = site.getBoundingClientRect();
		site.style.setProperty("--px", `${(ev.clientX - r.left).toFixed(0)}px`);
		site.style.setProperty("--py", `${(ev.clientY - r.top).toFixed(0)}px`);
		site.style.setProperty("--mx", Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)).toFixed(3));
		site.style.setProperty("--my", Math.min(1, Math.max(0, (ev.clientY - r.top) / Math.min(r.height, 700))).toFixed(3));
	});
	site.addEventListener("mouseleave", () => {
		site.style.setProperty("--px", "-999px");
		site.style.setProperty("--py", "-999px");
		site.style.setProperty("--mx", ".5");
		site.style.setProperty("--my", ".5");
		for (const item of site.querySelectorAll(".board")) item.classList.remove("is-hover");
	});
}
