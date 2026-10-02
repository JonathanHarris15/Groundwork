const TOKEN_KEY = "groundwork.accountToken";
const STATUSES = [
	["solid", "Solid", "#1f8a5b"],
	["shaky", "Shaky", "#b8860b"],
	["learning", "Learning", "#c45c26"],
	["rusty", "Rusty", "#6b46c1"],
	["unassessed", "Not assessed", "#8d877e"],
];

const view = document.querySelector("#view");
const authLink = document.querySelector("#auth-link");
let poll = 0;

document.addEventListener("click", (event) => {
	const link = event.target.closest("a[data-nav]");
	if (!link) return;
	const url = new URL(link.href, location.origin);
	if (url.origin !== location.origin) return;
	event.preventDefault();
	if (url.pathname === location.pathname && url.hash) {
		show(url.pathname);
		const target = document.querySelector(url.hash);
		if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
		return;
	}
	history.pushState({}, "", url.pathname + url.hash);
	show(url.pathname);
});
window.addEventListener("popstate", () => show(location.pathname));

function token() {
	return localStorage.getItem(TOKEN_KEY) || "";
}
function setToken(value) {
	if (value) localStorage.setItem(TOKEN_KEY, value);
	else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
	const headers = { Accept: "application/json", ...(options.headers || {}) };
	if (options.body) headers["Content-Type"] = "application/json";
	if (token()) headers.Authorization = `Bearer ${token()}`;
	const response = await fetch(path, { ...options, headers });
	const payload = await response.json().catch(() => ({}));
	if (response.status === 401) setToken("");
	if (!response.ok) throw new Error(payload.error || "Request failed.");
	return payload;
}

function show(pathname) {
	window.clearInterval(poll);
	poll = 0;
	paintAuth();
	if (pathname === "/profile") return mountProfile("/api/me/profile", true);
	const pub = pathname.match(/^\/u\/([^/]+)\/?$/);
	if (pub) return mountProfile(`/api/profiles/${pub[1]}`, false);
	if (pathname === "/signin" || pathname === "/join") return mountAuth(pathname === "/join");
	mountHome();
	if (location.hash) {
		const target = document.querySelector(location.hash);
		if (target) target.scrollIntoView();
	}
}

function paintAuth() {
	if (!authLink) return;
	if (token()) {
		authLink.textContent = "Sign out";
		authLink.href = "/signout";
		authLink.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			setToken("");
			history.pushState({}, "", "/");
			show("/");
		};
	} else {
		authLink.textContent = "Sign in";
		authLink.href = "/signin";
		authLink.onclick = null;
	}
}

function mountHome() {
	const home = document.querySelector("#home-template");
	view.replaceChildren(home.content.cloneNode(true));
}

function mountAuth(joining) {
	view.replaceChildren();
	const form = el("form", "panel auth");
	form.append(el("h1", null, joining ? "Create your account" : "Sign in"));
	form.append(el("p", "lede", joining ? "The profile map appears here once Obsidian has saved tutor memory to this account." : "Your concept map is stored with your account."));
	const fields = joining
		? [
				["displayName", "Name", "text"],
				["email", "Email", "email"],
				["password", "Password", "password"],
			]
		: [
				["email", "Email", "email"],
				["password", "Password", "password"],
			];
	const inputs = {};
	for (const [name, label, type] of fields) {
		form.append(el("label", null, label));
		const input = document.createElement("input");
		input.name = name;
		input.type = type;
		input.required = true;
		input.autocomplete = name === "password" ? (joining ? "new-password" : "current-password") : name;
		if (name === "password") input.minLength = 8;
		form.append(input);
		inputs[name] = input;
	}
	const error = el("p", "form-error");
	const submit = el("button", "btn", joining ? "Create account" : "Sign in");
	submit.type = "submit";
	const actions = el("div", "row-actions");
	actions.style.margin = "16px 0";
	actions.append(submit);
	form.append(error, actions);
	const swap = el("p");
	const swapLink = el("a", null, joining ? "Already have an account? Sign in" : "Need an account? Create one");
	swapLink.href = joining ? "/signin" : "/join";
	swapLink.dataset.nav = "";
	swap.append(swapLink);
	form.append(swap);
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		error.textContent = "";
		submit.disabled = true;
		try {
			const body = { email: inputs.email.value, password: inputs.password.value };
			if (joining) body.displayName = inputs.displayName.value;
			const session = await api(joining ? "/api/register" : "/api/login", { method: "POST", body: JSON.stringify(body) });
			setToken(session.token);
			history.pushState({}, "", "/profile");
			show("/profile");
		} catch (e) {
			error.textContent = e.message;
			submit.disabled = false;
		}
	});
	view.append(form);
}

function mountProfile(path, mine) {
	view.replaceChildren();
	const head = el("div", "profile-head");
	const titles = el("div");
	const name = el("h1", null, "Profile");
	const handle = el("p", "handle");
	titles.append(name, handle);
	const live = el("p", "live");
	live.append(el("span", "pulse"), document.createTextNode(" Live"));
	const when = document.createElement("span");
	live.append(when);
	head.append(titles, live);
	const counts = el("div", "counts");
	const frame = el("div", "map-frame");
	const legend = el("div", "legend");
	for (const [id, label, color] of STATUSES) {
		const item = el("span");
		const swatch = el("i", "swatch");
		swatch.style.background = color;
		item.append(swatch, document.createTextNode(label));
		legend.append(item);
	}
	const goalsPanel = el("section", "panel");
	goalsPanel.append(el("h2", null, "Goals"));
	const goals = el("ul", "goals");
	goalsPanel.append(goals);
	const missing = el("p");
	if (mine) {
		missing.append(document.createTextNode("No account on this browser. "), link("/signin", "Sign in"), document.createTextNode(" to see your map."));
	}
	view.append(head, counts, frame, legend, goalsPanel);
	if (!mine || token()) missing.remove();
	else view.append(missing);

	const pull = async () => {
		if (mine && !token()) {
			frame.replaceChildren(el("div", "empty-map", "Sign in to read your concept map."));
			return;
		}
		try {
			const profile = await api(path);
			name.textContent = shown(profile.user.displayName) || "Profile";
			handle.textContent = profile.user.handle ? `@${shown(profile.user.handle)}` : "";
			when.textContent = profile.updatedAt ? ` · updated ${formatWhen(profile.updatedAt)}` : " · waiting for Obsidian to save";
			paintCounts(counts, profile.counts);
			paintMap(frame, profile.map);
			paintGoals(goals, profile.goals);
		} catch (e) {
			frame.replaceChildren(el("div", "empty-map", e.message));
		}
	};
	void pull();
	poll = window.setInterval(() => void pull(), 3000);
}

function paintCounts(host, counts) {
	host.replaceChildren();
	for (const [id, label] of STATUSES) {
		const n = counts?.[id] ?? 0;
		if (!n) continue;
		const pill = el("span", "count");
		const dot = document.createElement("i");
		dot.style.background = STATUSES.find((s) => s[0] === id)[2];
		dot.style.display = "inline-block";
		dot.style.width = "8px";
		dot.style.height = "8px";
		dot.style.borderRadius = "50%";
		dot.style.marginRight = "6px";
		pill.append(dot, document.createTextNode(`${n} ${label.toLowerCase()}`));
		host.append(pill);
	}
}

function paintMap(host, map) {
	host.replaceChildren();
	if (!map?.nodes?.length) {
		host.append(el("div", "empty-map", "No concepts yet. Sign in from Obsidian and study; the map is saved with your account."));
		return;
	}
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", `0 0 ${map.width} ${map.height}`);
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", "Concept map");
	const byId = new Map(map.nodes.map((node) => [node.id, node]));
	for (const edge of map.edges) {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (!from || !to) continue;
		const path = document.createElementNS(svg.namespaceURI, "path");
		const r = 20;
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const len = Math.hypot(dx, dy) || 1;
		const x1 = from.x + (dx / len) * r;
		const y1 = from.y + (dy / len) * r;
		const x2 = to.x - (dx / len) * r;
		const y2 = to.y - (dy / len) * r;
		const mid = (y1 + y2) / 2;
		path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`);
		path.setAttribute("class", "edge");
		svg.append(path);
	}
	for (const node of map.nodes) {
		const group = document.createElementNS(svg.namespaceURI, "g");
		group.setAttribute("class", `node is-${node.status}`);
		const title = document.createElementNS(svg.namespaceURI, "title");
		title.textContent = `${shown(node.title)} · ${statusWord(node.status)}`;
		const circle = document.createElementNS(svg.namespaceURI, "circle");
		circle.setAttribute("cx", node.x);
		circle.setAttribute("cy", node.y);
		circle.setAttribute("r", "18");
		const label = document.createElementNS(svg.namespaceURI, "text");
		label.setAttribute("x", String(Number(node.x) + 26));
		label.setAttribute("y", String(Number(node.y) + 4));
		label.setAttribute("text-anchor", "start");
		const name = shown(node.title);
		label.textContent = name.length > 28 ? `${name.slice(0, 27)}…` : name;
		group.append(title, circle, label);
		svg.append(group);
	}
	host.append(svg);
}

function paintGoals(host, goals) {
	host.replaceChildren();
	if (!goals?.length) {
		host.append(el("li", null, "No goals published."));
		return;
	}
	for (const goal of goals) {
		const li = document.createElement("li");
		li.append(el("span", null, shown(goal.title)));
		li.append(el("span", "meta", statusWord(goal.status)));
		host.append(li);
	}
}

function formatWhen(iso) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
}

function link(href, text) {
	const a = el("a", null, text);
	a.href = href;
	a.dataset.nav = "";
	return a;
}

const GOAL_STATUS = { active: "Active", paused: "Paused", done: "Done" };
const CONCEPT_STATUS = { solid: "Solid", shaky: "Shaky", learning: "Learning", rusty: "Rusty", unassessed: "Not assessed" };

/** The page never prints a dollar sign, even when a name or title contains one. */
function shown(text) {
	return String(text ?? "").replaceAll("$", "").replace(/ {2,}/g, " ").trim();
}

function statusWord(status) {
	return GOAL_STATUS[status] || CONCEPT_STATUS[status] || shown(status);
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text) node.textContent = text;
	return node;
}

show(location.pathname);
