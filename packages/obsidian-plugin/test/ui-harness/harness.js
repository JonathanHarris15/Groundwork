const root = document.getElementById("root");
const toolbar = document.getElementById("toolbar");

const states = [
  ["learn-empty", { screen: "learn", theme: "dark", body: "start" }],
  ["learn-chat", { screen: "learn", theme: "dark", body: "chat" }],
  ["map", { screen: "map", theme: "dark", body: "map" }],
  ["goals", { screen: "goals", theme: "dark", body: "goals" }],
  ["library", { screen: "library", theme: "dark", body: "library" }],
  ["settings-signed-out", { screen: "settings", theme: "dark", body: "settings-out" }],
  ["flashcards", { screen: "flashcards", theme: "dark", body: "flash" }],
  ["learn-light", { screen: "learn", theme: "light", body: "chat" }],
  ["learn-obsidian", { screen: "learn", theme: "obsidian", body: "chat" }],
  ["tones-dark", { screen: "learn", theme: "dark", body: "tones" }],
  ["tones-light", { screen: "learn", theme: "light", body: "tones" }],
  ["tones-obsidian-dark", { screen: "learn", theme: "obsidian", body: "tones" }],
  ["tones-obsidian-light", { screen: "learn", theme: "obsidian", obsidianLight: true, body: "tones" }],
];

const TABS = [
  ["learn", "Learn"],
  ["map", "Map"],
  ["goals", "Goals"],
  ["flashcards", "Flashcards"],
];
const TONES = [
  ["solid", "Solid"],
  ["shaky", "Shaky"],
  ["learning", "Learning"],
  ["rusty", "Rusty"],
  ["unstarted", "Not started"],
];

function applyFlags({ screen }) {
  root.classList.remove("is-map", "is-goals", "is-library", "is-settings", "is-flashcards");
  if (screen !== "learn") root.classList.add(`is-${screen}`);
}

function shell(screen) {
  const tabs = TABS.map(
    ([id, label]) =>
      `<button type="button" class="gw-view${id === screen ? " is-on" : ""}" role="tab" aria-selected="${id === screen}" data-testid="gw-${id}-tab"><span class="gw-view-icon"></span><span class="gw-view-label">${label}</span></button>`,
  ).join("");
  root.innerHTML = `
    <div class="gw-header">
      <div class="gw-brand"><span class="gw-brand-name">GROUNDWORK</span></div>
      <div class="gw-views" role="tablist">${tabs}</div>
      <div class="gw-actions"><div class="gw-actions-tools">
        <button type="button" class="gw-icon-btn${screen === "library" ? " is-active" : ""}" aria-label="Library" aria-pressed="${screen === "library"}">Library</button>
        <button type="button" class="gw-icon-btn${screen === "settings" ? " is-active" : ""}" aria-label="Settings" aria-pressed="${screen === "settings"}">Settings</button>
      </div></div>
    </div>
    <div class="gw-messages"></div>
    <div class="gw-screen gw-map"></div>
    <div class="gw-screen gw-goals"><div class="gw-goals-row"><div class="gw-goal-hero"><h2>Exam prep</h2></div></div></div>
    <div class="gw-library"></div>
    <div class="gw-settings"></div>
    <div class="gw-flash"><div class="gw-fc-loading">Loading cards…</div></div>
    <div class="gw-composer"><div class="gw-box"><textarea class="gw-input" rows="1" placeholder="Answer, ask a question…"></textarea><div class="gw-box-row"><div class="gw-box-tools"><span class="gw-chip">Groundwork</span></div><button type="button" class="mod-cta gw-send" aria-label="Send">↑</button></div></div></div>
  `;
}

const pill = (tone, text) => `<span class="gw-status" data-tone="${tone}">${text}</span>`;
const dot = (tone, extra = "") => `<i class="gw-tone-dot${extra}" data-tone="${tone}"></i>`;

function legend(pinned) {
  const tones = TONES.map(([tone, label]) => `<span class="gw-key-item">${dot(tone)}${label}</span>`).join("");
  if (!pinned) return `<div class="gw-map-key">${tones}</div>`;
  return `<div class="gw-map-key">${tones}<span class="gw-key-item">${dot("goal")}Goal</span><span class="gw-key-item"><i class="gw-key-next"></i>Next</span><span class="gw-key-item">${dot("learning", " is-faded")}Off the path</span><span class="gw-key-edge">Prerequisite → concept</span><span class="gw-key-edge is-dashed">Outside the path</span></div>`;
}

const STEPS = [
  { tone: "goal", title: "Spectral theorem", label: "Goal", mark: "⚑" },
  { tone: "unstarted", title: "Diagonalization", label: "Next", next: true, mark: "3" },
  { tone: "learning", title: "Eigenvalues", label: "Learning" },
  { tone: "shaky", title: "Determinants", label: "Shaky" },
  { tone: "rusty", title: "Row reduction", label: "Rusty" },
  { tone: "solid", title: "Matrix multiplication", label: "Solid", mark: "✓" },
  { tone: "learning", title: "Complex numbers", label: "Learning", off: true },
];

function steps() {
  return STEPS.map(
    (s) =>
      `<button type="button" class="gw-step${s.next ? " is-next" : ""}${s.off ? " is-off" : ""}" data-tone="${s.tone}"><span class="gw-step-n${s.next ? " is-next" : ""}" data-tone="${s.tone}">${s.mark ?? ""}</span><span class="gw-step-name">${s.title}</span><span class="gw-step-meta">${s.label}</span></button>`,
  ).join("");
}

const ROWS = [
  { tone: "solid", title: "Matrix multiplication", state: "Solid", action: '<button type="button" class="gw-row-action is-known">✓ Known</button>', pct: 100 },
  { tone: "shaky", title: "Determinants", state: "Shaky", action: '<button type="button" class="gw-row-action">Quiz me</button>', pct: 70 },
  { tone: "learning", title: "Eigenvalues", state: "Learning", action: '<button type="button" class="gw-row-action">Learn</button>', pct: 40 },
  { tone: "rusty", title: "Row reduction", state: "Rusty", action: '<button type="button" class="gw-row-action">Quiz me</button>', pct: 60 },
  { tone: "unstarted", title: "Diagonalization", state: "Next", action: '<button type="button" class="gw-row-action is-primary">Start →</button>', pct: 0, next: true },
];

function conceptRows() {
  return ROWS.map(
    (r) =>
      `<div class="gw-concept-row${r.next ? " is-next" : ""}"><span class="gw-concept-name${r.tone === "unstarted" ? " is-unstarted" : ""}">${dot(r.tone)}${r.title}</span><label class="gw-weight"><input type="number" value="20" aria-label="Weight" />%</label><span class="gw-complete"><span class="gw-complete-bar"><span data-tone="${r.tone}" style="width:${r.pct}%"></span></span><em>${r.pct}%</em></span><span class="gw-state">${pill(r.tone, r.state)}</span>${r.action}</div>`,
  ).join("");
}

function tones() {
  return `
    <div class="gw-harness-tones" style="display:flex;flex-direction:column;gap:18px;max-width:var(--gw-column);margin:0 auto;width:100%">
      <section><h3 class="gw-suggestions-kicker">Pills</h3><div style="display:flex;gap:8px;flex-wrap:wrap">${TONES.map(([t, l]) => pill(t, l)).join("")}${pill("goal", "Goal")}</div></section>
      <section><h3 class="gw-suggestions-kicker">Map key</h3><div style="position:relative;height:84px">${legend(true)}</div></section>
      <section style="display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px">
        <div class="gw-concept-list"><div class="gw-concept-head"><span>Concept</span><span>Weight</span><span>Complete</span><span>State</span><span>Work on it</span></div>${conceptRows()}</div>
        <aside class="gw-side" style="width:auto;border:1px solid var(--gw-line);border-radius:12px"><div class="gw-side-head">Path to your goal</div><div class="gw-path"><div class="gw-steps">${steps()}</div></div></aside>
      </section>
    </div>`;
}

function fill(cfg) {
  const messages = root.querySelector(".gw-messages");
  const library = root.querySelector(".gw-library");
  const settings = root.querySelector(".gw-settings");
  const flash = root.querySelector(".gw-flash");
  const map = root.querySelector(".gw-map");
  const body = cfg.body;
  if (body === "start") {
    messages.innerHTML = `<div class="gw-empty"><div class="gw-start"><h2 class="gw-start-title">Sign in to start.</h2><div class="gw-start-detail"><p>Open the Groundwork website, sign in, and choose Open Obsidian.</p></div><div class="gw-start-actions"><button type="button" class="mod-cta gw-start-primary">Sign in</button></div></div><div class="gw-suggestions is-deferred"><h3 class="gw-suggestions-kicker">After you are connected</h3></div></div>`;
  }
  if (body === "chat") {
    messages.innerHTML = `
      <div class="gw-msg-row is-me"><div class="gw-avatar is-me">J</div><div class="gw-msg-body"><div class="gw-msg gw-user">Explain eigenvalues with a short example and a code snippet.</div></div></div>
      <div class="gw-tool"><span class="gw-tool-icon" aria-hidden="true">✓</span><span>Loaded memory: 45 concepts, 0 active goals, 10 due reviews</span></div>
      <div class="gw-msg-row"><div class="gw-avatar"></div><div class="gw-msg-body gw-assistant markdown-rendered"><p>An eigenvalue λ satisfies Av = λv.</p><pre><code>import numpy as np\nprint(np.linalg.eig([[2,1],[1,2]]))</code></pre><p>See <a href="#">linear maps</a> for intuition.</p></div></div>
      <div class="gw-tool"><span class="gw-tool-icon" aria-hidden="true">✓</span><span>Saved a flashcard on Eigenvalues and eigenvectors</span></div>`;
  }
  if (body === "tones") messages.innerHTML = tones();
  if (body === "map") {
    map.innerHTML = `<div class="gw-map-row"><div class="gw-mapwrap"><div class="gw-map-toolbar"><p class="gw-map-click-hint">Foundations at the bottom, your goal on top. Click a concept to study it.</p></div>${legend(true)}</div><aside class="gw-side"><div class="gw-side-head">Path to your goal</div><div class="gw-path"><div class="gw-kicker">Working toward</div><div class="gw-path-title">Spectral theorem</div><div class="gw-steps">${steps()}</div></div></aside></div>`;
  }
  if (body === "library") {
    library.innerHTML = `<div class="gw-library-top"><div class="gw-library-head"><div class="gw-library-titles"><h2 class="gw-library-title">Library</h2><div class="gw-library-sub">Goals, concepts, flashcards, and past chats.</div></div></div><div class="gw-lib-tabs" role="tablist"><button type="button" class="gw-lib-tab" role="tab">Goals <span class="gw-lib-count">1</span></button><button type="button" class="gw-lib-tab is-active" role="tab">Concepts <span class="gw-lib-count">3</span></button><button type="button" class="gw-lib-tab" role="tab">Chats <span class="gw-lib-count">2</span></button><button type="button" class="gw-lib-tab" role="tab">Flashcards <span class="gw-lib-count">12</span></button></div></div><div class="gw-library-scroll"><div class="gw-lib-section"><div class="gw-lib-list gw-lib-list-concepts">${["solid", "learning", "rusty"].map((t, i) => `<div class="gw-lib-row"><div class="gw-lib-main"><div class="gw-lib-name">${["Limits", "Eigenvalues", "Row reduction"][i]}</div><div class="gw-lib-meta">${pill(t, TONES.find((x) => x[0] === t)[1])}</div></div><div class="gw-lib-actions"><button type="button" class="gw-lib-btn">Quiz</button><button type="button" class="gw-lib-btn">Delete</button></div></div>`).join("")}</div></div></div>`;
  }
  if (body === "settings-out") {
    settings.innerHTML = `<div class="gw-library-top"><div class="gw-library-head"><div class="gw-library-titles"><h2 class="gw-library-title">Settings</h2><div class="gw-library-sub">Vault folders, the tutor, and your account.</div></div></div></div><div class="gw-library-scroll"><div class="gw-lib-section"><h3>Account</h3><p class="gw-lib-help">Open the website, sign in, and choose Open Obsidian.</p></div></div>`;
  }
  if (body === "flash") {
    flash.innerHTML = `<div class="gw-fc-body"><div class="gw-fc-main"><div class="gw-fcard"><div class="gw-fcard-front">What is the determinant?</div></div></div></div>`;
  }
}

function render(id) {
  const cfg = states.find((s) => s[0] === id)?.[1];
  if (!cfg) return;
  root.dataset.harnessState = id;
  root.classList.remove("gw-theme-dark", "gw-theme-light", "gw-theme-obsidian");
  root.classList.add(`gw-theme-${cfg.theme}`);
  document.body.classList.toggle("theme-light", !!cfg.obsidianLight);
  document.body.classList.toggle("theme-dark", !cfg.obsidianLight);
  shell(cfg.screen);
  applyFlags(cfg);
  fill(cfg);
}

for (const [id] of states) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = id;
  b.addEventListener("click", () => render(id));
  toolbar.appendChild(b);
}

window.harness = { render, states: states.map((s) => s[0]) };
render("learn-chat");
