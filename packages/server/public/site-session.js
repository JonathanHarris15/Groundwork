const E2E_USER = "gw-e2e-user";
const E2E_EMAIL = "gw-e2e-email";

boot().catch(() => {
	const root = document.querySelector("#usage-root");
	if (root) root.textContent = "Usage could not be loaded.";
});

async function boot() {
	const sign = document.querySelector(".bar-nav .sign-link");
	const root = document.querySelector("#usage-root");
	const config = await fetch("/v1/web-config").then((res) => res.json());
	if (config.firebase) {
		await bootFirebase(config, sign, root);
		return;
	}
	if (config.localDev) {
		await bootLocal(config, sign, root);
		return;
	}
	if (root) showSignIn(root, config, null);
}

async function bootFirebase(config, sign, root) {
	const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js");
	const firebaseAuth = await import("https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js");
	initializeApp(config.firebase);
	const auth = firebaseAuth.getAuth();
	firebaseAuth.onAuthStateChanged(auth, async (user) => {
		if (!user) {
			resetSign(sign);
			if (root) showSignIn(root, config, () => signIn(firebaseAuth, auth));
			return;
		}
		const token = await user.getIdToken();
		await paintSession(sign, root, token);
	});
}

async function bootLocal(config, sign, root) {
	const email = localStorage.getItem(E2E_USER);
	if (!email) {
		resetSign(sign);
		if (root) {
			showSignIn(root, config, () => {
				const chosen = localStorage.getItem(E2E_EMAIL) || "local";
				localStorage.setItem(E2E_USER, chosen);
				void bootLocal(config, sign, root);
			});
		}
		return;
	}
	const token = email === "local" ? undefined : `e2e:${email}`;
	await paintSession(sign, root, token);
}

async function paintSession(sign, root, token) {
	const accountRes = await fetch("/v1/account", { headers: authHeaders(token) });
	if (accountRes.ok) applyAccount(sign, await accountRes.json());
	else resetSign(sign);
	if (!root) return;
	const res = await fetch("/api/admin/usage", { headers: authHeaders(token) });
	if (res.status === 404) {
		showNotFound(root);
		return;
	}
	if (!res.ok) {
		root.className = "";
		root.innerHTML = `<p class="mkt-sub">Usage could not be loaded.</p>`;
		return;
	}
	const data = await res.json();
	root.className = "usage-dash";
	root.innerHTML = typeof data.html === "string" ? data.html : "";
	document.title = "Usage · Groundwork";
	root.querySelector("#download-csv")?.addEventListener("click", () => {
		void downloadCsv(token);
	});
}

function authHeaders(token) {
	return token ? { authorization: `Bearer ${token}` } : {};
}

function applyAccount(sign, account) {
	if (!sign || !account) return;
	const label = account.displayName || account.email || "Account";
	sign.textContent = label;
	sign.setAttribute("href", "/");
	sign.setAttribute("aria-label", `Signed in as ${label}`);
	for (const link of document.querySelectorAll("[data-admin-link]")) link.hidden = !account.isAdmin;
}

function resetSign(sign) {
	if (!sign) return;
	sign.textContent = "Sign in";
	const onHome = location.pathname === "/";
	sign.setAttribute("href", onHome ? "#signin" : "/#signin");
	sign.removeAttribute("aria-label");
	for (const link of document.querySelectorAll("[data-admin-link]")) link.hidden = true;
}

function showSignIn(root, config, onLocal) {
	root.className = "";
	const google = config.firebase ? `<button class="cta" id="usage-google" type="button">Sign in with Google</button>` : "";
	const local = config.localDev ? `<button class="cta" id="usage-local" type="button">Continue on this device</button>` : "";
	root.innerHTML = `<h1>Sign in or start free.</h1>
		<p class="mkt-sub">Create your free account or sign in with Google. Then choose <strong>Open Obsidian</strong> on the account page to link the plugin on this computer. Requires Obsidian desktop.</p>
		<div class="cta-row">${google}${local}</div>
		<p class="fine">By continuing you confirm you're 18 or older and agree to the <a href="/terms">Terms</a>.</p>
		${config.localDev ? `<p class="fine">Local-only sign-in. Use Google on the live site.</p>` : ""}`;
	document.querySelector("#usage-google")?.addEventListener("click", () => onLocal?.());
	document.querySelector("#usage-local")?.addEventListener("click", () => onLocal?.());
}

async function signIn(firebaseAuth, auth) {
	const { GoogleAuthProvider, signInWithPopup } = firebaseAuth;
	const provider = new GoogleAuthProvider();
	try {
		await signInWithPopup(auth, provider);
	} catch (err) {
		const root = document.querySelector("#usage-root");
		if (root) {
			const note = document.createElement("p");
			note.className = "mkt-sub";
			note.textContent = err instanceof Error ? err.message : "Sign-in failed.";
			root.append(note);
		}
	}
}

function showNotFound(root) {
	root.className = "";
	root.innerHTML = `<h1>Page not found.</h1>
		<p class="mkt-sub">That link does not match anything on this site.</p>
		<div class="cta-row"><a class="cta" href="/">Home</a></div>`;
}

async function downloadCsv(token) {
	const res = await fetch("/api/admin/usage.csv", { headers: authHeaders(token) });
	if (!res.ok) return;
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = "groundwork-usage.csv";
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}
