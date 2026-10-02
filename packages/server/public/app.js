const app = document.querySelector("#app");
const chip = document.querySelector("#account-chip");

const params = new URLSearchParams(location.search);
const billingNote = params.get("billing") === "success"
	? "Payment started. Your plan updates as soon as Stripe confirms it."
	: params.get("billing") === "cancel"
		? "Checkout was canceled. Your plan is unchanged."
		: "";

let config = { firebase: null, billing: false };
let plans = [];
let account = null;
let providers = null;
let user = null;
let auth = null;
let firebaseAuth = null;

boot().catch((err) => show(`<p class="banner">${escapeHtml(err.message)}</p>`));

async function boot() {
	const [web, planList] = await Promise.all([get("/v1/web-config"), get("/v1/plans")]);
	config = web;
	plans = planList.plans;
	if (!config.firebase) {
		renderSignedOut("Google sign-in needs the Firebase web config on this server (FIREBASE_WEB_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID).");
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
			renderSignedOut();
			return;
		}
		try {
			await refresh();
			renderSignedIn();
		} catch (err) {
			renderSignedOut(err.message);
		}
	});
}

async function refresh() {
	const token = await user.getIdToken();
	account = await get("/v1/account", token);
	providers = (await get("/v1/secrets", token)).providers;
}

function renderSignedOut(problem) {
	chip.hidden = true;
	show(`
		<h1>Sign in to study.</h1>
		<p class="lede">Your plan, billing, and model keys live here. The tutor in Obsidian uses this account.</p>
		${problem ? `<p class="banner">${escapeHtml(problem)}</p>` : ""}
		${billingNote ? `<p class="banner">${escapeHtml(billingNote)}</p>` : ""}
		<p class="stack"><button id="google" class="green" ${config.firebase ? "" : "disabled"}>Sign in with Google</button></p>
		${planGrid(false)}
	`);
	document.querySelector("#google")?.addEventListener("click", () => signIn());
}

function renderSignedIn() {
	chip.hidden = false;
	chip.innerHTML = `${user.photoURL ? `<img alt="" src="${escapeAttr(user.photoURL)}" />` : ""}<span>${escapeHtml(account.displayName || user.displayName || user.email || "Signed in")}</span> <button id="sign-out" class="quiet">Sign out</button>`;
	document.querySelector("#sign-out").addEventListener("click", () => firebaseAuth.signOut(auth));
	const credit = account.needsPlan
		? "Choose a plan to start."
		: account.ownModel
			? "This plan uses your model. Groundwork does not meter it."
			: `$${account.remainingUsd.toFixed(2)} of $${account.creditUsd.toFixed(0)} model credit left this month.`;
	show(`
		<h1>${escapeHtml(account.displayName || user.displayName || "Your account")}</h1>
		<p class="lede">${escapeHtml(user.email || "")}</p>
		${billingNote ? `<p class="banner">${escapeHtml(billingNote)}</p>` : ""}
		${!config.billing ? `<p class="banner">Stripe is not connected on this server yet, so a paid plan cannot be purchased.</p>` : ""}
		<p class="note">${escapeHtml(credit)}</p>
		${planGrid(true)}
		<section class="panel">
			<h2>Profile</h2>
			<p>This name is what Groundwork shows for you. Your Google account stays the sign-in.</p>
			<form id="profile" class="stack">
				<label>Display name <input name="displayName" value="${escapeAttr(account.displayName || user.displayName || "")}" maxlength="80" /></label>
				<button type="submit">Save</button>
			</form>
		</section>
		<section class="panel">
			<h2>Billing</h2>
			<p>${account.hasBilling ? "Update the card, see invoices, or cancel in Stripe." : "A paid plan opens Stripe checkout. You can change the card later from here."}</p>
			<button id="portal" class="quiet" ${account.hasBilling && config.billing ? "" : "disabled"}>Manage billing</button>
		</section>
		<section class="panel">
			<h2>Your model keys</h2>
			<p>Bring-your-own-model uses a key you already have. Jev stays on our server and is not a key you paste.</p>
			<ul class="keys">${keyList()}</ul>
			<form id="key" class="stack">
				<select name="provider">
					${Object.keys(providers).map((name) => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join("")}
				</select>
				<input name="apiKey" type="password" placeholder="Paste a key" autocomplete="off" />
				<button type="submit">Save key</button>
			</form>
		</section>
	`);
	for (const button of document.querySelectorAll("[data-plan]")) {
		button.addEventListener("click", () => choose(button.dataset.plan));
	}
	document.querySelector("#profile").addEventListener("submit", saveProfile);
	document.querySelector("#key").addEventListener("submit", saveKey);
	document.querySelector("#portal").addEventListener("click", openPortal);
}

function planGrid(signedIn) {
	return `<div class="plans">${plans.map((plan) => {
		const current = signedIn && account?.plan === plan.id;
		const price = plan.priceUsdPerMonth === 0 ? "Free" : `$${plan.priceUsdPerMonth} / month`;
		const action = !signedIn
			? ""
			: `<button data-plan="${escapeAttr(plan.id)}" class="${current ? "quiet" : "green"}"${current ? " disabled" : ""}>${current ? "Current plan" : plan.priceUsdPerMonth === 0 ? "Use free" : "Continue to payment"}</button>`;
		return `<article class="plan${current ? " is-current" : ""}"><h2>${escapeHtml(plan.name)}</h2><p class="price">${price}</p><p>${escapeHtml(plan.summary)}</p>${action}</article>`;
	}).join("")}</div>`;
}

function keyList() {
	return Object.entries(providers).map(([name, saved]) => `<li>${escapeHtml(name)}: ${saved ? "saved" : "not saved"}</li>`).join("");
}

async function signIn() {
	const { GoogleAuthProvider, signInWithPopup } = await import("https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js");
	const provider = new GoogleAuthProvider();
	try {
		await signInWithPopup(auth, provider);
	} catch (err) {
		renderSignedOut(err.message);
	}
}

async function choose(plan) {
	const token = await user.getIdToken();
	try {
		if (plan === "free") {
			await send("/v1/account/plan", { plan }, token);
			await refresh();
			renderSignedIn();
			return;
		}
		const { url } = await send("/v1/billing/checkout", { plan }, token);
		location.href = url;
	} catch (err) {
		alert(err.message);
	}
}

async function saveProfile(event) {
	event.preventDefault();
	const token = await user.getIdToken();
	await send("/v1/account/profile", { displayName: new FormData(event.target).get("displayName") }, token);
	await refresh();
	renderSignedIn();
}

async function saveKey(event) {
	event.preventDefault();
	const data = new FormData(event.target);
	const token = await user.getIdToken();
	try {
		providers = (await send("/v1/secrets", { provider: data.get("provider"), apiKey: data.get("apiKey") }, token)).providers;
		event.target.reset();
		renderSignedIn();
	} catch (err) {
		alert(err.message);
	}
}

async function openPortal() {
	const token = await user.getIdToken();
	try {
		const { url } = await send("/v1/billing/portal", {}, token);
		location.href = url;
	} catch (err) {
		alert(err.message);
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
