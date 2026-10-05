const root = document.getElementById("root");
const toolbar = document.getElementById("toolbar");

const states = [
  ["learn-empty", { screen: "learn", overlay: null, theme: "dark", body: "start" }],
  ["learn-chat", { screen: "learn", overlay: null, theme: "dark", body: "chat" }],
  ["map", { screen: "map", overlay: null, theme: "dark", body: "map" }],
  ["goals", { screen: "goals", overlay: null, theme: "dark", body: "goals" }],
  ["library", { screen: "learn", overlay: "library", theme: "dark", body: "library" }],
  ["settings-signed-out", { screen: "learn", overlay: "settings", theme: "dark", body: "settings-out" }],
  ["flashcards", { screen: "learn", overlay: "flashcards", theme: "dark", body: "flash" }],
  ["learn-light", { screen: "learn", overlay: null, theme: "light", body: "chat" }],
  ["learn-obsidian", { screen: "learn", overlay: null, theme: "obsidian", body: "chat" }],
];

function applyFlags({ screen, overlay }) {
  root.classList.remove("is-map", "is-goals", "is-library", "is-settings", "is-flashcards", "is-overlay");
  if (screen === "map") root.classList.add("is-map");
  if (screen === "goals") root.classList.add("is-goals");
  if (overlay === "library") root.classList.add("is-library", "is-overlay");
  if (overlay === "settings") root.classList.add("is-settings", "is-overlay");
  if (overlay === "flashcards") root.classList.add("is-flashcards", "is-overlay");
}

function shell() {
  root.innerHTML = `
    <div class="gw-header">
      <div class="gw-brand"><span class="gw-brand-name">GROUNDWORK</span></div>
      <div class="gw-views" role="tablist">
        <button type="button" class="gw-view is-on" role="tab"><span class="gw-view-icon"></span><span class="gw-view-label">Learn</span></button>
        <button type="button" class="gw-view" role="tab"><span class="gw-view-icon"></span><span class="gw-view-label">Concept map</span></button>
        <button type="button" class="gw-view" role="tab"><span class="gw-view-icon"></span><span class="gw-view-label">Goals</span></button>
      </div>
      <div class="gw-actions"><div class="gw-goalchip"><span class="gw-goalchip-days">12d</span></div></div>
    </div>
    <div class="gw-messages"></div>
    <div class="gw-screen gw-map"><div class="gw-map-row"><div class="gw-mapwrap"><div class="gw-concept-map">Map pane</div></div></div></div>
    <div class="gw-screen gw-goals"><div class="gw-goals-row"><div class="gw-goal-hero"><h2>Exam prep</h2></div></div></div>
    <div class="gw-library"></div>
    <div class="gw-settings"></div>
    <div class="gw-flash"><div class="gw-fc-loading">Loading cards…</div></div>
    <div class="gw-composer"><div class="gw-box"><textarea class="gw-input" rows="1" placeholder="Answer, ask a question…"></textarea></div></div>
  `;
}

function fill(body) {
  const messages = root.querySelector(".gw-messages");
  const library = root.querySelector(".gw-library");
  const settings = root.querySelector(".gw-settings");
  const flash = root.querySelector(".gw-flash");
  messages.innerHTML = "";
  library.innerHTML = "";
  settings.innerHTML = "";
  flash.innerHTML = '<div class="gw-fc-loading">Loading cards…</div>';
  if (body === "start") {
    messages.innerHTML = `<div class="gw-empty"><div class="gw-start"><h2 class="gw-start-title">Sign in to start.</h2><div class="gw-start-detail"><p>Open the Groundwork website, sign in, and choose Open Obsidian.</p></div><div class="gw-start-actions"><button type="button" class="mod-cta gw-start-primary">Sign in</button></div></div><div class="gw-suggestions is-deferred"><h3 class="gw-suggestions-kicker">After you are connected</h3></div></div>`;
  }
  if (body === "chat") {
    messages.innerHTML = `
      <div class="gw-msg-row is-me"><div class="gw-avatar is-me">J</div><div class="gw-msg-body"><div class="gw-msg gw-user">Explain eigenvalues with a short example and a code snippet.</div></div></div>
      <div class="gw-msg-row"><div class="gw-avatar"></div><div class="gw-msg-body gw-assistant markdown-rendered"><p>An eigenvalue λ satisfies Av = λv.</p><pre><code>import numpy as np\nprint(np.linalg.eig([[2,1],[1,2]]))</code></pre><p>See <a href="#">linear maps</a> for intuition.</p></div></div>`;
  }
  if (body === "library") {
    library.innerHTML = `<div class="gw-library-top"><div class="gw-library-head"><h2 class="gw-library-title">Library</h2></div></div><div class="gw-library-scroll"><div class="gw-lib-section"><h3>Goals</h3><div class="gw-lib-row"><div class="gw-lib-main"><div class="gw-lib-name">Exam prep</div></div></div></div></div>`;
  }
  if (body === "settings-out") {
    settings.innerHTML = `<div class="gw-library-top"><h2 class="gw-library-title">Settings</h2></div><div class="gw-library-scroll"><div class="gw-lib-section"><h3>Account</h3><p class="gw-lib-help">Open the website, sign in, and choose Open Obsidian.</p></div></div>`;
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
  shell();
  applyFlags(cfg);
  fill(cfg.body);
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
