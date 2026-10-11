/* Shared setup checklist for /get-started and the account page. */
(function () {
	const PROGRESS_KEY = "gw-setup-progress";
	const PLUGIN_URL = "obsidian://show-plugin?id=groundwork";
	const COMMUNITY_URL = "https://community.obsidian.md/plugins/groundwork";
	const OS = [
		{ id: "windows", label: "Download for Windows" },
		{ id: "mac", label: "Download for macOS" },
		{ id: "linux", label: "Download for Linux" },
	];

	const FIGURE = {
		download: `<svg viewBox="0 0 72 72" aria-hidden="true"><rect x="14" y="10" width="44" height="32" rx="4" fill="none" stroke="currentColor" stroke-width="2"></rect><path d="M22 50h28M36 42v16M28 52l8 8 8-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`,
		plugin: `<svg viewBox="0 0 72 72" aria-hidden="true"><rect x="16" y="22" width="40" height="28" rx="4" fill="none" stroke="currentColor" stroke-width="2"></rect><path d="M28 22v-6h16v6M30 36h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>`,
		connect: `<svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="26" cy="36" r="10" fill="none" stroke="currentColor" stroke-width="2"></circle><circle cx="46" cy="36" r="10" fill="none" stroke="currentColor" stroke-width="2"></circle><path d="M32 36h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>`,
	};

	function detectOs() {
		const ua = navigator.userAgent || "";
		const platform = navigator.platform || "";
		if (/Android|iPhone|iPad|iPod/i.test(ua)) return null;
		if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
		if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "mac";
		if (/Linux/i.test(platform) || /Linux/i.test(ua)) return "linux";
		return null;
	}

	function isPhone() {
		return /iPhone|iPad|Android/i.test(navigator.userAgent || "");
	}

	function readProgress() {
		try {
			const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}

	function markProgress(step) {
		const next = readProgress();
		next[step] = true;
		try {
			localStorage.setItem(PROGRESS_KEY, JSON.stringify(next));
		} catch {
			/* This browser can still finish the step. */
		}
	}

	function setupUrl() {
		return `${location.origin}/get-started`;
	}

	function bearer(token) {
		if (!token) return {};
		return { authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` };
	}

	async function readBody(res) {
		const text = await res.text();
		try {
			return text ? JSON.parse(text) : {};
		} catch {
			return {};
		}
	}

	function downloadLinks(os) {
		const primary = OS.find((item) => item.id === os);
		const rest = OS.filter((item) => item.id !== os);
		const button = (item, primaryButton) =>
			`<a class="${primaryButton ? "guide-go" : "guide-quiet"}" data-os="${item.id}" href="/v1/setup/obsidian-download?os=${item.id}">${item.label}</a>`;
		if (!primary) return `<div class="guide-actions">${OS.map((item) => button(item, true)).join("")}</div>`;
		return `<div class="guide-actions">${button(primary, true)}</div><p class="guide-links">${rest.map((item) => button(item, false)).join("")}</p>`;
	}

	function step(id, title, body, figure) {
		return `<li class="guide-step" data-step="${id}">
			<div class="guide-figure">${figure}</div>
			<div>
				<div class="guide-step-head"><h2>${title}</h2><span class="guide-done">Done</span></div>
				${body}
			</div>
		</li>`;
	}

	function phoneBlock() {
		return `<section class="guide-phone" data-setup-phone hidden>
			<h2>Groundwork runs on your computer.</h2>
			<p>Obsidian doesn’t run on a phone. Open this page on your computer and do the three steps there.</p>
			<div class="guide-actions">
				<button class="guide-go" type="button" data-copy-link>Copy link</button>
				<button class="guide-go guide-go-line" type="button" data-share hidden>Share</button>
			</div>
			<p class="guide-status" data-copy-status role="status" aria-live="polite"></p>
			<img class="guide-qr" src="/v1/setup/qr.svg" width="168" height="168" alt="QR code that opens the setup page on a computer" />
		</section>`;
	}

	function connectBlock(signedIn) {
		if (!signedIn) {
			return `<p>Sign in, then connect this computer.</p><div class="guide-actions"><a class="guide-go" href="/#signin">Sign in to connect</a></div>`;
		}
		return `<p>This opens Obsidian and links it to your account.</p>
			<div class="guide-actions"><button class="guide-go" type="button" data-connect>Connect Groundwork</button></div>
			<p class="guide-legacy" data-legacy-wrap hidden><button class="guide-quiet" type="button" data-legacy-connect>Not connecting? Use the older link</button></p>
			<p class="guide-status" data-connect-status role="status" aria-live="polite"></p>`;
	}

	function markup(root) {
		const signedIn = root.dataset.signedIn === "1";
		const os = detectOs();
		return `${phoneBlock()}
			<ol class="guide-steps">
				${step("download", "Get Obsidian", `<p>Download the app for this computer, install it, and create a vault.</p>${downloadLinks(os)}`, FIGURE.download)}
				${step(
					"plugin",
					"Add Groundwork",
					`<p>Turn on community plugins and trust this vault once. Then install Groundwork and enable it.</p>
					<div class="guide-actions"><a class="guide-go" data-add-plugin href="${PLUGIN_URL}">Add Groundwork</a></div>
					<p class="guide-fallback" data-plugin-fallback hidden>Obsidian didn’t open. Finish step 1, open your vault, then try again. You can also install it from the <a href="${COMMUNITY_URL}">community plugin page</a>.</p>`,
					FIGURE.plugin,
				)}
				${step("connect", "Connect your account", connectBlock(signedIn), FIGURE.connect)}
			</ol>`;
	}

	function paintDone(root) {
		const progress = readProgress();
		const connected = root.dataset.connected === "1";
		const flags = { download: progress.download === true, plugin: progress.plugin === true, connect: connected };
		for (const stepEl of root.querySelectorAll("[data-step]")) {
			const id = stepEl.getAttribute("data-step");
			const done = flags[id] === true;
			stepEl.classList.toggle("is-done", done);
		}
	}

	function showPhone(root) {
		const phone = root.querySelector("[data-setup-phone]");
		if (!phone) return;
		if (!isPhone()) return;
		phone.hidden = false;
		const share = root.querySelector("[data-share]");
		if (share && typeof navigator.share === "function") share.hidden = false;
	}

	async function noteLink(method) {
		try {
			window.GroundworkTracking?.noteSetupLink?.(method);
		} catch {
			/* The link still copies when analytics is blocked. */
		}
	}

	function setStatus(el, text) {
		if (el) el.textContent = text;
	}

	async function copyLink(root) {
		const status = root.querySelector("[data-copy-status]");
		const url = setupUrl();
		try {
			await navigator.clipboard.writeText(url);
			setStatus(status, "Link copied.");
			void noteLink("copy");
		} catch {
			setStatus(status, url);
		}
	}

	async function shareLink(root) {
		const status = root.querySelector("[data-copy-status]");
		const url = setupUrl();
		try {
			await navigator.share({ title: "Get Groundwork running", url });
			setStatus(status, "Link shared.");
			void noteLink("share");
		} catch (err) {
			if (err && err.name === "AbortError") return;
			setStatus(status, "Couldn’t share from this browser. Copy the link instead.");
		}
	}

	async function onDownload(event, root, getToken) {
		const link = event.currentTarget;
		if (!(link instanceof HTMLAnchorElement)) return;
		markProgress("download");
		paintDone(root);
		if (root.dataset.signedIn !== "1") return;
		event.preventDefault();
		const os = link.getAttribute("data-os");
		try {
			const token = await getToken?.();
			const res = await fetch("/v1/setup/obsidian-download", {
				method: "POST",
				headers: { "content-type": "application/json", ...bearer(token) },
				body: JSON.stringify({ os }),
			});
			const data = await readBody(res);
			location.assign(typeof data.url === "string" ? data.url : link.href);
		} catch {
			location.assign(link.href);
		}
	}

	function onPlugin(event, root) {
		event.preventDefault();
		markProgress("plugin");
		paintDone(root);
		const href = event.currentTarget instanceof HTMLAnchorElement ? event.currentTarget.href : PLUGIN_URL;
		const fallback = root.querySelector("[data-plugin-fallback]");
		let left = false;
		const mark = () => {
			left = true;
		};
		window.addEventListener("blur", mark);
		document.addEventListener("visibilitychange", mark);
		const link = document.createElement("a");
		link.href = href;
		link.hidden = true;
		document.body.appendChild(link);
		link.click();
		link.remove();
		window.setTimeout(() => {
			window.removeEventListener("blur", mark);
			document.removeEventListener("visibilitychange", mark);
			if (!left && fallback) fallback.hidden = false;
		}, 1500);
	}

	function openProtocol(href) {
		const link = document.createElement("a");
		link.href = href;
		link.hidden = true;
		document.body.appendChild(link);
		link.click();
		link.remove();
	}

	function connectStatus(button) {
		const root = button?.closest?.("[data-setup]");
		return root?.querySelector("[data-connect-status]") || document.querySelector("[data-connect-status]");
	}

	function watchOpened(nonce, getToken, root, status, button, label) {
		const started = performance.now();
		const timer = window.setInterval(async () => {
			let opened = false;
			try {
				const res = await fetch(`/v1/obsidian-opened/${nonce}`, { cache: "no-store" });
				if (res.ok) opened = Boolean((await res.json()).opened);
			} catch {
				opened = false;
			}
			if (!opened && performance.now() - started < 8000) return;
			window.clearInterval(timer);
			if (button) {
				button.disabled = false;
				if (label) button.textContent = label;
			}
			if (!opened) return;
			try {
				const linked = await fetch("/v1/account/obsidian-connected", {
					method: "POST",
					headers: { "content-type": "application/json", ...bearer(await getToken?.()) },
					body: "{}",
				});
				const body = await readBody(linked);
				window.GroundworkTracking?.noteObsidian?.(body);
			} catch {
				/* The plugin can still finish the link. */
			}
			if (root) {
				root.dataset.connected = "1";
				paintDone(root);
			}
			setStatus(status, "Connected.");
		}, 400);
	}

	let legacyPromise = null;
	let legacyOptions = null;

	function legacyEnabled() {
		if (!legacyPromise) {
			legacyPromise = fetch("/v1/setup/legacy-connect", { cache: "no-store" })
				.then(async (res) => {
					const data = await readBody(res);
					if (!res.ok || typeof data.legacy !== "boolean") return true;
					return data.legacy;
				})
				.catch(() => true);
		}
		return legacyPromise;
	}

	function ensureLegacyControl(anchor) {
		if (!anchor?.parentElement || anchor.parentElement.querySelector("[data-legacy-connect]")) return;
		const wrap = document.createElement("p");
		wrap.className = "guide-legacy";
		wrap.dataset.legacyWrap = "";
		wrap.hidden = true;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "guide-quiet";
		button.dataset.legacyConnect = "";
		button.textContent = "Not connecting? Use the older link";
		wrap.append(button);
		anchor.insertAdjacentElement("afterend", wrap);
	}

	async function refreshLegacy() {
		for (const anchor of document.querySelectorAll("#open-obsidian")) ensureLegacyControl(anchor);
		const show = await legacyEnabled();
		if (!show) return;
		for (const wrap of document.querySelectorAll("[data-legacy-wrap]")) wrap.hidden = false;
		for (const button of document.querySelectorAll("[data-legacy-connect]")) {
			if (button.dataset.legacyBound === "1") continue;
			button.dataset.legacyBound = "1";
			button.addEventListener("click", () => {
				void legacyConnect(button);
			});
		}
	}

	async function legacyConnect(button) {
		const options = legacyOptions;
		const root = button?.closest?.("[data-setup]") || document.querySelector("[data-setup]");
		const status = connectStatus(button);
		const refresh = String((await options?.getRefresh?.()) ?? "").trim();
		if (!refresh) {
			setStatus(status, "The older link needs Google sign-in on this browser.");
			return;
		}
		if (button) button.disabled = true;
		const nonce = crypto.randomUUID();
		const signal = `${location.origin}/v1/obsidian-opened/${nonce}/signal`;
		const href = `obsidian://groundwork?refresh=${encodeURIComponent(refresh)}&opened=${encodeURIComponent(signal)}`;
		setStatus(status, "Opening Obsidian…");
		openProtocol(href);
		watchOpened(nonce, options?.getToken, root, status, button, "");
	}

	async function connect(getToken, button) {
		const root = button?.closest?.("[data-setup]") || document.querySelector("[data-setup]");
		const status = root?.querySelector("[data-connect-status]") || document.querySelector("[data-connect-status]");
		if (button) {
			button.disabled = true;
			button.textContent = "Opening Obsidian…";
		}
		try {
			const token = await getToken?.();
			const issued = await fetch("/v1/connect/code", {
				method: "POST",
				headers: { "content-type": "application/json", ...bearer(token) },
				body: "{}",
			});
			const data = await readBody(issued);
			if (!issued.ok || typeof data.code !== "string") {
				setStatus(status, typeof data.error === "string" ? data.error : "Couldn’t create a code. Try again in a minute.");
				if (button) {
					button.disabled = false;
					button.textContent = "Connect Groundwork";
				}
				return;
			}
			const nonce = crypto.randomUUID();
			const signal = `${location.origin}/v1/obsidian-opened/${nonce}/signal`;
			const href = `obsidian://groundwork?code=${encodeURIComponent(data.code)}&ack=${encodeURIComponent(signal)}`;
			setStatus(status, `If Obsidian doesn’t connect, paste this code in Groundwork: ${data.code}`);
			openProtocol(href);
			watchOpened(nonce, getToken, root, status, button, "Connect Groundwork");
		} catch {
			setStatus(status, "Couldn’t create a code. Try again in a minute.");
			if (button) {
				button.disabled = false;
				button.textContent = "Connect Groundwork";
			}
		}
	}

	function bind(root, getToken) {
		showPhone(root);
		paintDone(root);
		for (const link of root.querySelectorAll("[data-os]")) {
			link.addEventListener("click", (event) => {
				void onDownload(event, root, getToken);
			});
		}
		root.querySelector("[data-add-plugin]")?.addEventListener("click", (event) => onPlugin(event, root));
		root.querySelector("[data-copy-link]")?.addEventListener("click", () => {
			void copyLink(root);
		});
		root.querySelector("[data-share]")?.addEventListener("click", () => {
			void shareLink(root);
		});
		root.querySelector("[data-connect]")?.addEventListener("click", (event) => {
			void connect(getToken, event.currentTarget);
		});
	}

	function mount(root, options) {
		if (!root || root.dataset.setupReady === "1") {
			if (root) paintDone(root);
			return;
		}
		root.dataset.setupReady = "1";
		root.classList.add("guide");
		root.innerHTML = markup(root);
		bind(root, options?.getToken);
	}

	function mountAll(options) {
		if (options) legacyOptions = options;
		for (const root of document.querySelectorAll("[data-setup]")) mount(root, options);
		void refreshLegacy();
	}

	window.GroundworkSetup = { mount, mountAll, connect, detectOs, isPhone };

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mountAll());
	else mountAll();
})();
