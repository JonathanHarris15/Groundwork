// ../core/src/access.ts
var DEFAULT_READ_FOLDERS = ["resources"];
var DEFAULT_WRITE_FOLDERS = ["submissions"];
function defaultFolderAccess() {
  return { readFolders: [...DEFAULT_READ_FOLDERS], writeFolders: [...DEFAULT_WRITE_FOLDERS] };
}
function normalizeVaultPath(raw) {
  let s = String(raw ?? "").trim().replace(/\\/g, "/");
  s = s.replace(/^\/+/, "");
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  if (!s || s.includes("\0")) return null;
  const parts = s.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || /[:*?"<>|]/.test(part))) return null;
  return parts.join("/");
}
function cleanFolderList(raw) {
  const out = [];
  for (const item of raw ?? []) {
    const folder = normalizeVaultPath(item);
    if (folder && !out.includes(folder)) out.push(folder);
  }
  return out;
}
function accessFromContext(ctx) {
  if (!ctx?.access) return defaultFolderAccess();
  return {
    readFolders: cleanFolderList(ctx.access.readFolders),
    writeFolders: cleanFolderList(ctx.access.writeFolders)
  };
}
function pathInsideFolder(path, folder) {
  const file = normalizeVaultPath(path);
  const root = normalizeVaultPath(folder);
  if (!file || !root) return false;
  return file === root || file.startsWith(`${root}/`);
}
function pathInsideAny(path, folders) {
  return folders.some((folder) => pathInsideFolder(path, folder));
}

// ../core/src/groundwork-graph.ts
var GROUNDWORK_COLORS = ["#2db560", "#2e9be6", "#f59e2b", "#e5484d"];

// ../core/src/force-graph/colors.ts
var STATUS_COLORS = {
  solid: "#3CC56F",
  shaky: "#F7A93E",
  learning: "#45A9F0",
  rusty: "#9d8cf0",
  unassessed: "#6b6f76"
};

// ../core/src/force-graph/simulation.ts
var hash = (value) => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
};
function seedPositions(nodes, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const ring = Math.min(width, height) * 0.32;
  nodes.forEach((node, i) => {
    const turn = hash(node.id) % 100 / 100 * 0.6;
    const angle = i / Math.max(1, nodes.length) * Math.PI * 2 + turn;
    node.x = cx + Math.cos(angle) * ring * (0.65 + hash(node.title) % 17 / 40);
    node.y = cy + Math.sin(angle) * ring * (0.65 + hash(node.cluster) % 13 / 40);
    node.vx = 0;
    node.vy = 0;
  });
}
function clusterCentroids(nodes) {
  const out = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    const row = out.get(node.cluster) ?? { x: 0, y: 0, n: 0 };
    row.x += node.x;
    row.y += node.y;
    row.n += 1;
    out.set(node.cluster, row);
  }
  for (const [key, row] of out) {
    if (row.n > 0) out.set(key, { x: row.x / row.n, y: row.y / row.n, n: row.n });
  }
  return out;
}
function createSimulationState() {
  return { alpha: 1, tick: 0 };
}
function simulationTick(nodes, links, state, opts) {
  const { width, height } = opts;
  const alphaMin = opts.alphaMin ?? 0.02;
  if (state.alpha < alphaMin) return false;
  const n = nodes.length;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const centroids = clusterCentroids(nodes);
  const cx = width / 2;
  const cy = height / 2;
  for (const node of nodes) {
    node.vx = 0;
    node.vy = 0;
  }
  const stride = n > 120 ? 2 : 1;
  for (let i = 0; i < n; i += stride) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j += stride) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const dist2 = dx * dx + dy * dy || 0.01;
      const dist = Math.sqrt(dist2);
      dx /= dist;
      dy /= dist;
      const repulse = 520 * state.alpha / dist2;
      if (!a.fixed) {
        a.vx += dx * repulse;
        a.vy += dy * repulse;
      }
      if (!b.fixed) {
        b.vx -= dx * repulse;
        b.vy -= dy * repulse;
      }
    }
  }
  for (const link of links) {
    const a = byId.get(link.from);
    const b = byId.get(link.to);
    if (!a || !b) continue;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 0.01;
    dx /= dist;
    dy /= dist;
    const want = link.bridge ? 72 : 52;
    const pull = (dist - want) * 0.045 * state.alpha / (link.bridge ? 1.4 : 1);
    if (!a.fixed) {
      a.vx += dx * pull;
      a.vy += dy * pull;
    }
    if (!b.fixed) {
      b.vx -= dx * pull;
      b.vy -= dy * pull;
    }
  }
  for (const node of nodes) {
    if (node.fixed) continue;
    const c = centroids.get(node.cluster);
    if (c && c.n > 1) {
      node.vx += (c.x - node.x) * 4e-3 * state.alpha;
      node.vy += (c.y - node.y) * 4e-3 * state.alpha;
    }
    node.vx += (cx - node.x) * 12e-4 * state.alpha;
    node.vy += (cy - node.y) * 12e-4 * state.alpha;
  }
  for (const node of nodes) {
    if (node.fixed) continue;
    node.vx *= 0.6;
    node.vy *= 0.6;
    node.x += node.vx * 0.22;
    node.y += node.vy * 0.22;
  }
  separate(nodes, 22 + state.alpha * 6);
  state.tick += 1;
  state.alpha *= 0.985;
  return state.alpha >= alphaMin;
}
function separate(nodes, minDist) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const need = minDist + a.radius + b.radius - 8;
        if (dist >= need) continue;
        dx /= dist;
        dy /= dist;
        const shift = (need - dist) / 2;
        if (!a.fixed) {
          a.x -= dx * shift;
          a.y -= dy * shift;
        }
        if (!b.fixed) {
          b.x += dx * shift;
          b.y += dy * shift;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}
function runSimulation(nodes, links, opts, maxTicks = 240) {
  const state = createSimulationState();
  seedPositions(nodes, opts.width, opts.height);
  let ticks = 0;
  while (ticks < maxTicks && simulationTick(nodes, links, state, opts)) ticks += 1;
  return ticks;
}

// ../core/src/force-graph/build.ts
function buildFromGroundwork(concepts, graph) {
  const statusOf = new Map(concepts.map((c) => [c.id, c.status]));
  const degree = /* @__PURE__ */ new Map();
  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const nodes = graph.nodes.map((node) => {
    const status = statusOf.get(node.id) ?? "unassessed";
    const deg = degree.get(node.id) ?? 0;
    const open = status === "unassessed";
    const attention = status === "unassessed" || status === "shaky" || status === "rusty";
    const hint = status === "unassessed" ? "Not quizzed yet \u2014 find it in the list below" : status === "shaky" || status === "rusty" ? "Needs review \u2014 find it in the list below" : status === "learning" ? "Still building \u2014 see the list below" : "Solid \u2014 see the list below";
    return {
      id: node.id,
      title: node.title,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 5 + Math.min(12, Math.sqrt(deg + 1) * 2.4),
      color: open ? node.color : STATUS_COLORS[status],
      cluster: node.domain,
      status,
      open,
      label: deg >= 2 || graph.nodes.length <= 8 || attention,
      needsAttention: attention,
      actionHint: hint
    };
  });
  const links = graph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    bridge: edge.bridge
  }));
  const legend = [
    ...(graph.legend ?? []).map((item) => ({ key: item.domain, label: item.domain, color: item.color })),
    { key: "status-solid", label: "Solid", color: STATUS_COLORS.solid },
    { key: "status-open", label: "Not quizzed", color: STATUS_COLORS.unassessed }
  ];
  return { nodes, links, legend };
}
function buildSyntheticGraph(count, density = 3) {
  const domains = ["Calculus", "Linear algebra", "Probability", "Physics"];
  const nodes = [];
  const links = [];
  for (let i = 0; i < count; i++) {
    const domain = domains[i % domains.length];
    nodes.push({
      id: `c${i}`,
      title: `Concept ${i + 1}`,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 5 + i % 5,
      color: GROUNDWORK_COLORS[i % GROUNDWORK_COLORS.length],
      cluster: domain,
      status: ["solid", "learning", "shaky", "unassessed"][i % 4],
      label: i % 7 === 0
    });
  }
  for (let i = 1; i < count; i++) {
    for (let j = 0; j < density; j++) {
      const from = `c${(i * 7 + j * 13) % i}`;
      links.push({ from, to: `c${i}`, bridge: nodes.find((n) => n.id === from)?.cluster !== nodes[i].cluster });
    }
  }
  const legend = domains.map((domain, i) => ({ key: domain, label: domain, color: GROUNDWORK_COLORS[i % GROUNDWORK_COLORS.length] }));
  return { nodes, links, legend };
}

// ../core/src/force-graph/canvas.ts
var MIN_SCALE = 0.12;
var MAX_SCALE = 6;
function mountForceGraph(host, data, options = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = options.className ?? "gw-force-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Interactive concept graph");
  host.replaceChildren(canvas);
  const tip = document.createElement("div");
  tip.className = "gw-force-tip";
  tip.hidden = true;
  host.append(tip);
  let nodes = data.nodes.map(cloneNode);
  let links = data.links.map((link) => ({ ...link }));
  const sim = createSimulationState();
  let width = options.width ?? (host.clientWidth || 640);
  let height = options.height ?? (host.clientHeight || 360);
  const camera = { scale: 1, tx: 0, ty: 0 };
  let hovered = null;
  let dragged = null;
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let raf = 0;
  let alive = true;
  let labelZoom = 0.85;
  const neighborMap = () => {
    const out = /* @__PURE__ */ new Map();
    for (const link of links) {
      const a = out.get(link.from) ?? /* @__PURE__ */ new Set();
      a.add(link.to);
      out.set(link.from, a);
      const b = out.get(link.to) ?? /* @__PURE__ */ new Set();
      b.add(link.from);
      out.set(link.to, b);
    }
    return out;
  };
  const resize = () => {
    const rect = host.getBoundingClientRect();
    width = Math.max(120, Math.floor(rect.width));
    height = Math.max(120, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const worldToScreen = (x, y) => ({
    x: x * camera.scale + camera.tx,
    y: y * camera.scale + camera.ty
  });
  const screenToWorld = (x, y) => ({
    x: (x - camera.tx) / camera.scale,
    y: (y - camera.ty) / camera.scale
  });
  const fit = () => {
    if (!nodes.length) {
      camera.scale = 1;
      camera.tx = width / 2;
      camera.ty = height / 2;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x - node.radius - 8);
      maxX = Math.max(maxX, node.x + node.radius + 8);
      minY = Math.min(minY, node.y - node.radius - 8);
      maxY = Math.max(maxY, node.y + node.radius + 8);
    }
    const pad = 28;
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const scale = Math.min((width - pad * 2) / bw, (height - pad * 2) / bh, MAX_SCALE);
    camera.scale = Math.max(MIN_SCALE, scale);
    camera.tx = (width - (minX + maxX) * camera.scale) / 2;
    camera.ty = (height - (minY + maxY) * camera.scale) / 2;
  };
  const pick = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const w = screenToWorld(clientX - rect.left, clientY - rect.top);
    let best = null;
    let bestD = Infinity;
    for (const node of nodes) {
      const d = Math.hypot(node.x - w.x, node.y - w.y);
      const hit = node.radius + 6 / camera.scale;
      if (d <= hit && d < bestD) {
        bestD = d;
        best = node.id;
      }
    }
    return best;
  };
  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const neighbors = hovered ? neighborMap().get(hovered) : null;
    const fade = hovered != null;
    ctx.save();
    ctx.translate(camera.tx, camera.ty);
    ctx.scale(camera.scale, camera.scale);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const link of links) {
      const a = byId.get(link.from);
      const b = byId.get(link.to);
      if (!a || !b) continue;
      const dim = fade && hovered !== link.from && hovered !== link.to && !neighbors?.has(link.from) && !neighbors?.has(link.to);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const start = { x: a.x + ux * (a.radius + 2), y: a.y + uy * (a.radius + 2) };
      const end = { x: b.x - ux * (b.radius + 4), y: b.y - uy * (b.radius + 4) };
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.strokeStyle = link.bridge ? "rgba(127,132,142,0.45)" : "rgba(127,132,142,0.7)";
      ctx.lineWidth = (link.bridge ? 1.2 : 1.6) / camera.scale;
      ctx.globalAlpha = dim ? 0.12 : 1;
      if (link.bridge) ctx.setLineDash([5 / camera.scale, 4 / camera.scale]);
      else ctx.setLineDash([]);
      ctx.stroke();
      ctx.setLineDash([]);
      const head = 5 / camera.scale;
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - ux * head - uy * head * 0.6, end.y - uy * head + ux * head * 0.6);
      ctx.lineTo(end.x - ux * head + uy * head * 0.6, end.y - uy * head - ux * head * 0.6);
      ctx.closePath();
      ctx.fillStyle = link.bridge ? "rgba(127,132,142,0.45)" : "rgba(127,132,142,0.7)";
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const showLabels = camera.scale >= labelZoom;
    for (const node of nodes) {
      const dim = fade && node.id !== hovered && !neighbors?.has(node.id);
      ctx.globalAlpha = dim ? 0.18 : 1;
      const r = node.radius;
      if (node.isNext) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(69, 169, 240, 0.85)";
        ctx.lineWidth = 2 / camera.scale;
        ctx.stroke();
      } else if (node.needsAttention) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(247, 169, 62, 0.75)";
        ctx.lineWidth = 1.5 / camera.scale;
        ctx.setLineDash([4 / camera.scale, 3 / camera.scale]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (node.open) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = node.color;
        ctx.lineWidth = 1.6 / camera.scale;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = node.color;
        ctx.globalAlpha = dim ? 0.1 : 0.2;
        ctx.fill();
        ctx.globalAlpha = dim ? 0.22 : 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = node.color;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1.1 / camera.scale;
        ctx.stroke();
      }
      if (node.isTarget && !node.isBuiltTarget) {
        ctx.beginPath();
        ctx.moveTo(node.x, node.y - r - 5);
        ctx.lineTo(node.x + r + 4, node.y);
        ctx.lineTo(node.x, node.y + r + 5);
        ctx.lineTo(node.x - r - 4, node.y);
        ctx.closePath();
        ctx.strokeStyle = node.color;
        ctx.lineWidth = 1.8 / camera.scale;
        ctx.stroke();
      }
      if (showLabels && (node.label || node.id === hovered)) {
        ctx.font = `${12 / camera.scale}px Jost, system-ui, sans-serif`;
        ctx.fillStyle = "rgba(230,232,236,0.95)";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const title = node.title.length > 32 ? `${node.title.slice(0, 31)}\u2026` : node.title;
        ctx.fillText(title, node.x, node.y + r + 6 / camera.scale);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  };
  const tick = () => {
    if (!alive) return;
    if (nodes.length && sim.alpha > 0.02 && !dragged) {
      simulationTick(nodes, links, sim, { width, height });
    }
    draw();
    raf = window.requestAnimationFrame(tick);
  };
  const relayout = () => {
    sim.alpha = 1;
    runSimulation(nodes, links, { width, height }, 180);
    if (options.fit !== false) fit();
  };
  const setData = (next) => {
    nodes = next.nodes.map(cloneNode);
    links = next.links.map((link) => ({ ...link }));
    relayout();
  };
  resize();
  relayout();
  raf = window.requestAnimationFrame(tick);
  const ro = new ResizeObserver(() => {
    resize();
    if (options.fit !== false) fit();
  });
  ro.observe(host);
  const onWheel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
  };
  const zoomBy = (factor, cx, cy) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));
    if (next === camera.scale) return;
    const before = screenToWorld(cx, cy);
    camera.scale = next;
    const after = screenToWorld(cx, cy);
    camera.tx += (after.x - before.x) * camera.scale;
    camera.ty += (after.y - before.y) * camera.scale;
  };
  const setHover = (id) => {
    if (hovered === id) return;
    hovered = id;
    options.onNodeHover?.(id);
    if (id) {
      const node = nodes.find((n) => n.id === id);
      if (node) {
        const lines = [node.title];
        if (node.status) lines.push(statusLabel(node.status));
        if (node.actionHint) lines.push(node.actionHint);
        tip.textContent = lines.join(" \xB7 ");
      } else tip.textContent = "";
      tip.hidden = false;
    } else tip.hidden = true;
  };
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const id = pick(e.clientX, e.clientY);
    lastX = e.clientX;
    lastY = e.clientY;
    downX = e.clientX;
    downY = e.clientY;
    if (id) {
      dragged = id;
      const node = nodes.find((n) => n.id === id);
      if (node) node.fixed = true;
      canvas.setPointerCapture(e.pointerId);
      host.classList.add("is-dragging-node");
    } else {
      panning = true;
      canvas.setPointerCapture(e.pointerId);
      host.classList.add("is-panning");
    }
  };
  const onPointerMove = (e) => {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dragged) {
      const node = nodes.find((n) => n.id === dragged);
      if (node) {
        const rect = canvas.getBoundingClientRect();
        const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        node.x = w.x;
        node.y = w.y;
        node.vx = 0;
        node.vy = 0;
        sim.alpha = 0.35;
      }
      return;
    }
    if (panning) {
      camera.tx += dx;
      camera.ty += dy;
      return;
    }
    setHover(pick(e.clientX, e.clientY));
  };
  const endPointer = (e) => {
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (dragged) {
      const node = nodes.find((n) => n.id === dragged);
      if (node) node.fixed = false;
      if (moved < 6) options.onNodeClick?.(dragged);
      dragged = null;
    }
    panning = false;
    host.classList.remove("is-dragging-node", "is-panning");
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => setHover(null));
  return {
    fit,
    zoomBy,
    setData,
    dispose: () => {
      alive = false;
      window.cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      host.replaceChildren();
    }
  };
}
function cloneNode(node) {
  return { ...node, vx: 0, vy: 0, fixed: false };
}
function statusLabel(status) {
  if (status === "solid") return "Solid";
  if (status === "learning") return "Learning";
  if (status === "shaky") return "Shaky";
  if (status === "rusty") return "Rusty";
  return "Not quizzed";
}

// ../core/src/io.ts
async function ensureDir(io, path) {
  if (!await io.exists(path)) await io.mkdir(path);
}

// ../core/src/files.ts
var RESOURCES_DIR = "resources";
var LIMITS = { image: 5 * 1024 * 1024, pdf: 20 * 1024 * 1024, textChars: 15e4 };
var IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
var TEXT_EXTENSIONS = new Set(
  "md markdown txt text csv tsv json jsonl yaml yml toml xml html htm css tex bib rst org log ini cfg sql py ipynb r jl m js mjs cjs ts tsx jsx java kt c h cc cpp hpp cs go rs rb php swift scala hs ml lua sh bash zsh ps1 bat".split(" ")
);
function extensionOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function fileKind(path) {
  const ext = extensionOf(path);
  if (IMAGE_TYPES[ext]) return { kind: "image", mediaType: IMAGE_TYPES[ext] };
  if (ext === "pdf") return { kind: "pdf", mediaType: "application/pdf" };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "text", mediaType: ext === "md" ? "text/markdown" : "text/plain" };
  return { kind: "other", mediaType: "application/octet-stream" };
}
async function loadVaultFile(io, path) {
  const { kind, mediaType } = fileKind(path);
  const base = { path, kind, mediaType };
  try {
    if (kind === "text") {
      const raw = await io.read(path);
      const truncated = raw.length > LIMITS.textChars;
      return { ...base, size: raw.length, text: truncated ? raw.slice(0, LIMITS.textChars) : raw, truncated };
    }
    if (kind === "other") {
      return { ...base, size: 0, skipped: `.${extensionOf(path) || "?"} files can't be read. Export it as PDF, an image, or text.` };
    }
    const bytes = await io.readBinary(path);
    const limit = kind === "image" ? LIMITS.image : LIMITS.pdf;
    if (bytes.byteLength > limit) {
      return { ...base, size: bytes.byteLength, skipped: `It is ${mb(bytes.byteLength)}, over the ${mb(limit)} limit for ${kind === "image" ? "images" : "PDFs"}.`, tooLarge: true };
    }
    return { ...base, size: bytes.byteLength, data: toBase64(bytes) };
  } catch (err) {
    return { ...base, size: 0, skipped: `Couldn't read it (${err instanceof Error ? err.message : String(err)}).` };
  }
}
async function listVaultFiles(io, folder, limit = 500) {
  const out = [];
  const walk = async (dir) => {
    if (out.length >= limit) return;
    const { files, folders } = await io.list(dir);
    for (const f of files.sort()) {
      if (out.length >= limit) return;
      if (!isHidden(f)) out.push(f);
    }
    for (const d of folders.sort()) if (!isHidden(d)) await walk(d);
  };
  if (folder === "" || await io.exists(folder)) await walk(folder);
  return out;
}
async function isFile(io, path) {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (parent && !await io.exists(parent)) return false;
  try {
    return (await io.list(parent)).files.includes(path);
  } catch {
    return false;
  }
}
function isHidden(path) {
  return path.split("/").some((part) => part.startsWith("."));
}
async function resolveVaultFile(io, ref, within) {
  const clean = ref.trim().replace(/^!?\[\[|\]\]$/g, "").split("|")[0].replace(/^\/+/, "");
  if (!clean || clean.split("/").includes("..") || isHidden(clean)) return null;
  const allowed = (p) => within ? pathInsideAny(p, within) : !isHidden(p);
  const candidates = [clean, ...(within ?? [RESOURCES_DIR]).map((folder) => `${folder}/${clean}`)];
  for (const candidate of candidates) {
    if (allowed(candidate) && await isFile(io, candidate)) return candidate;
  }
  const name = basename(clean).toLowerCase();
  for (const root of within ?? [""]) {
    const all = await listVaultFiles(io, root, 2e4);
    const hit = all.find((p) => allowed(p) && basename(p).toLowerCase() === name) ?? all.find((p) => allowed(p) && basename(p).toLowerCase().startsWith(`${name}.`));
    if (hit) return hit;
  }
  return null;
}
function resolveSubmissionPath(raw, writeFolders) {
  const folders = cleanFolderList(writeFolders);
  const where = folders.length ? folders.map((folder) => `${folder}/`).join(" or ") : "a write folder";
  if (!folders.length) return { error: `No write folders are set. Pick one in Settings \u2192 Groundwork, then save the file in ${where}.` };
  const input = raw.trim().replace(/^!?\[\[|\]\]$/g, "").split("|")[0].trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!input || input.split("/").includes("..") || input.split("/").some((part) => !part || part.startsWith("."))) {
    return { error: `"${raw}" isn't a path Groundwork can write. Put the file in ${where}.` };
  }
  const rooted = pathInsideAny(input, folders);
  if (!rooted && input.includes("/")) return { error: `Write that file inside ${where}.` };
  let path = rooted ? input.replace(/\/+$/, "") : `${folders[0]}/${input}`;
  if (folders.includes(path)) return { error: "Name the file to submit, not only the folder." };
  if (!extensionOf(path)) path = `${path}.md`;
  if (!pathInsideAny(path, folders) || fileKind(path).kind !== "text") {
    return { error: `Files to submit are text or markdown, inside ${where}.` };
  }
  return { path };
}
function toBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const B = globalThis.Buffer;
  if (B) return B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ../../node_modules/yaml/browser/dist/nodes/identity.js
var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
function isCollection(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case MAP:
      case SEQ:
        return true;
    }
  return false;
}
function isNode(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case ALIAS:
      case MAP:
      case SCALAR:
      case SEQ:
        return true;
    }
  return false;
}
var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;

// ../../node_modules/yaml/browser/dist/visit.js
var BREAK = /* @__PURE__ */ Symbol("break visit");
var SKIP = /* @__PURE__ */ Symbol("skip children");
var REMOVE = /* @__PURE__ */ Symbol("remove node");
function visit(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    visit_(null, node, visitor_, Object.freeze([]));
}
visit.BREAK = BREAK;
visit.SKIP = SKIP;
visit.REMOVE = REMOVE;
function visit_(key, node, visitor, path) {
  const ctrl = callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visit_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = visit_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = visit_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = visit_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
async function visitAsync(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    await visitAsync_(null, node, visitor_, Object.freeze([]));
}
visitAsync.BREAK = BREAK;
visitAsync.SKIP = SKIP;
visitAsync.REMOVE = REMOVE;
async function visitAsync_(key, node, visitor, path) {
  const ctrl = await callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visitAsync_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = await visitAsync_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = await visitAsync_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = await visitAsync_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
function initVisitor(visitor) {
  if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
    return Object.assign({
      Alias: visitor.Node,
      Map: visitor.Node,
      Scalar: visitor.Node,
      Seq: visitor.Node
    }, visitor.Value && {
      Map: visitor.Value,
      Scalar: visitor.Value,
      Seq: visitor.Value
    }, visitor.Collection && {
      Map: visitor.Collection,
      Seq: visitor.Collection
    }, visitor);
  }
  return visitor;
}
function callVisitor(key, node, visitor, path) {
  if (typeof visitor === "function")
    return visitor(key, node, path);
  if (isMap(node))
    return visitor.Map?.(key, node, path);
  if (isSeq(node))
    return visitor.Seq?.(key, node, path);
  if (isPair(node))
    return visitor.Pair?.(key, node, path);
  if (isScalar(node))
    return visitor.Scalar?.(key, node, path);
  if (isAlias(node))
    return visitor.Alias?.(key, node, path);
  return void 0;
}
function replaceNode(key, path, node) {
  const parent = path[path.length - 1];
  if (isCollection(parent)) {
    parent.items[key] = node;
  } else if (isPair(parent)) {
    if (key === "key")
      parent.key = node;
    else
      parent.value = node;
  } else if (isDocument(parent)) {
    parent.contents = node;
  } else {
    const pt = isAlias(parent) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${pt} parent`);
  }
}

// ../../node_modules/yaml/browser/dist/doc/directives.js
var escapeChars = {
  "!": "%21",
  ",": "%2C",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D"
};
var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
var Directives = class _Directives {
  constructor(yaml, tags) {
    this.docStart = null;
    this.docEnd = false;
    this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
    this.tags = Object.assign({}, _Directives.defaultTags, tags);
  }
  clone() {
    const copy = new _Directives(this.yaml, this.tags);
    copy.docStart = this.docStart;
    return copy;
  }
  /**
   * During parsing, get a Directives instance for the current document and
   * update the stream state according to the current version's spec.
   */
  atDocument() {
    const res = new _Directives(this.yaml, this.tags);
    switch (this.yaml.version) {
      case "1.1":
        this.atNextDocument = true;
        break;
      case "1.2":
        this.atNextDocument = false;
        this.yaml = {
          explicit: _Directives.defaultYaml.explicit,
          version: "1.2"
        };
        this.tags = Object.assign({}, _Directives.defaultTags);
        break;
    }
    return res;
  }
  /**
   * @param onError - May be called even if the action was successful
   * @returns `true` on success
   */
  add(line, onError) {
    if (this.atNextDocument) {
      this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
      this.tags = Object.assign({}, _Directives.defaultTags);
      this.atNextDocument = false;
    }
    const parts = line.trim().split(/[ \t]+/);
    const name = parts.shift();
    switch (name) {
      case "%TAG": {
        if (parts.length !== 2) {
          onError(0, "%TAG directive should contain exactly two parts");
          if (parts.length < 2)
            return false;
        }
        const [handle, prefix] = parts;
        this.tags[handle] = prefix;
        return true;
      }
      case "%YAML": {
        this.yaml.explicit = true;
        if (parts.length !== 1) {
          onError(0, "%YAML directive should contain exactly one part");
          return false;
        }
        const [version] = parts;
        if (version === "1.1" || version === "1.2") {
          this.yaml.version = version;
          return true;
        } else {
          const isValid = /^\d+\.\d+$/.test(version);
          onError(6, `Unsupported YAML version ${version}`, isValid);
          return false;
        }
      }
      default:
        onError(0, `Unknown directive ${name}`, true);
        return false;
    }
  }
  /**
   * Resolves a tag, matching handles to those defined in %TAG directives.
   *
   * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
   *   `'!local'` tag, or `null` if unresolvable.
   */
  tagName(source, onError) {
    if (source === "!")
      return "!";
    if (source[0] !== "!") {
      onError(`Not a valid tag: ${source}`);
      return null;
    }
    if (source[1] === "<") {
      const verbatim = source.slice(2, -1);
      if (verbatim === "!" || verbatim === "!!") {
        onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
        return null;
      }
      if (source[source.length - 1] !== ">")
        onError("Verbatim tags must end with a >");
      return verbatim;
    }
    const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
    if (!suffix)
      onError(`The ${source} tag has no suffix`);
    const prefix = this.tags[handle];
    if (prefix) {
      try {
        return prefix + decodeURIComponent(suffix);
      } catch (error) {
        onError(String(error));
        return null;
      }
    }
    if (handle === "!")
      return source;
    onError(`Could not resolve tag: ${source}`);
    return null;
  }
  /**
   * Given a fully resolved tag, returns its printable string form,
   * taking into account current tag prefixes and defaults.
   */
  tagString(tag) {
    for (const [handle, prefix] of Object.entries(this.tags)) {
      if (tag.startsWith(prefix))
        return handle + escapeTagName(tag.substring(prefix.length));
    }
    return tag[0] === "!" ? tag : `!<${tag}>`;
  }
  toString(doc) {
    const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
    const tagEntries = Object.entries(this.tags);
    let tagNames;
    if (doc && tagEntries.length > 0 && isNode(doc.contents)) {
      const tags = {};
      visit(doc.contents, (_key, node) => {
        if (isNode(node) && node.tag)
          tags[node.tag] = true;
      });
      tagNames = Object.keys(tags);
    } else
      tagNames = [];
    for (const [handle, prefix] of tagEntries) {
      if (handle === "!!" && prefix === "tag:yaml.org,2002:")
        continue;
      if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
        lines.push(`%TAG ${handle} ${prefix}`);
    }
    return lines.join("\n");
  }
};
Directives.defaultYaml = { explicit: false, version: "1.2" };
Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };

// ../../node_modules/yaml/browser/dist/doc/anchors.js
function anchorIsValid(anchor) {
  if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
    const sa = JSON.stringify(anchor);
    const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
    throw new Error(msg);
  }
  return true;
}
function anchorNames(root) {
  const anchors = /* @__PURE__ */ new Set();
  visit(root, {
    Value(_key, node) {
      if (node.anchor)
        anchors.add(node.anchor);
    }
  });
  return anchors;
}
function findNewAnchor(prefix, exclude) {
  for (let i = 1; true; ++i) {
    const name = `${prefix}${i}`;
    if (!exclude.has(name))
      return name;
  }
}
function createNodeAnchors(doc, prefix) {
  const aliasObjects = [];
  const sourceObjects = /* @__PURE__ */ new Map();
  let prevAnchors = null;
  return {
    onAnchor: (source) => {
      aliasObjects.push(source);
      prevAnchors ?? (prevAnchors = anchorNames(doc));
      const anchor = findNewAnchor(prefix, prevAnchors);
      prevAnchors.add(anchor);
      return anchor;
    },
    /**
     * With circular references, the source node is only resolved after all
     * of its child nodes are. This is why anchors are set only after all of
     * the nodes have been created.
     */
    setAnchors: () => {
      for (const source of aliasObjects) {
        const ref = sourceObjects.get(source);
        if (typeof ref === "object" && ref.anchor && (isScalar(ref.node) || isCollection(ref.node))) {
          ref.node.anchor = ref.anchor;
        } else {
          const error = new Error("Failed to resolve repeated object (this should not happen)");
          error.source = source;
          throw error;
        }
      }
    },
    sourceObjects
  };
}

// ../../node_modules/yaml/browser/dist/doc/applyReviver.js
function applyReviver(reviver, obj, key, val) {
  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      for (let i = 0, len = val.length; i < len; ++i) {
        const v0 = val[i];
        const v1 = applyReviver(reviver, val, String(i), v0);
        if (v1 === void 0)
          delete val[i];
        else if (v1 !== v0)
          val[i] = v1;
      }
    } else if (val instanceof Map) {
      for (const k of Array.from(val.keys())) {
        const v0 = val.get(k);
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          val.delete(k);
        else if (v1 !== v0)
          val.set(k, v1);
      }
    } else if (val instanceof Set) {
      for (const v0 of Array.from(val)) {
        const v1 = applyReviver(reviver, val, v0, v0);
        if (v1 === void 0)
          val.delete(v0);
        else if (v1 !== v0) {
          val.delete(v0);
          val.add(v1);
        }
      }
    } else {
      for (const [k, v0] of Object.entries(val)) {
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          delete val[k];
        else if (v1 !== v0)
          val[k] = v1;
      }
    }
  }
  return reviver.call(obj, key, val);
}

// ../../node_modules/yaml/browser/dist/nodes/toJS.js
function toJS(value, arg, ctx) {
  if (Array.isArray(value))
    return value.map((v, i) => toJS(v, String(i), ctx));
  if (value && typeof value.toJSON === "function") {
    if (!ctx || !hasAnchor(value))
      return value.toJSON(arg, ctx);
    const data = { aliasCount: 0, count: 1, res: void 0 };
    ctx.anchors.set(value, data);
    ctx.onCreate = (res2) => {
      data.res = res2;
      delete ctx.onCreate;
    };
    const res = value.toJSON(arg, ctx);
    if (ctx.onCreate)
      ctx.onCreate(res);
    return res;
  }
  if (typeof value === "bigint" && !ctx?.keep)
    return Number(value);
  return value;
}

// ../../node_modules/yaml/browser/dist/nodes/Node.js
var NodeBase = class {
  constructor(type) {
    Object.defineProperty(this, NODE_TYPE, { value: type });
  }
  /** Create a copy of this node.  */
  clone() {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** A plain JavaScript representation of this node. */
  toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    if (!isDocument(doc))
      throw new TypeError("A document argument is required");
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc,
      keep: true,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this, "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
};

// ../../node_modules/yaml/browser/dist/nodes/Alias.js
var Alias = class extends NodeBase {
  constructor(source) {
    super(ALIAS);
    this.source = source;
    Object.defineProperty(this, "tag", {
      set() {
        throw new Error("Alias nodes cannot have tags");
      }
    });
  }
  /**
   * Resolve the value of this alias within `doc`, finding the last
   * instance of the `source` anchor before this node.
   */
  resolve(doc, ctx) {
    if (ctx?.maxAliasCount === 0)
      throw new ReferenceError("Alias resolution is disabled");
    let nodes;
    if (ctx?.aliasResolveCache) {
      nodes = ctx.aliasResolveCache;
    } else {
      nodes = [];
      visit(doc, {
        Node: (_key, node) => {
          if (isAlias(node) || hasAnchor(node))
            nodes.push(node);
        }
      });
      if (ctx)
        ctx.aliasResolveCache = nodes;
    }
    let found = void 0;
    for (const node of nodes) {
      if (node === this)
        break;
      if (node.anchor === this.source)
        found = node;
    }
    if (found && ctx) {
      const { anchors, doc: doc2, maxAliasCount } = ctx;
      let data = anchors.get(found);
      if (!data) {
        toJS(found, null, ctx);
        data = anchors.get(found);
      }
      if (data?.res === void 0) {
        const msg = "This should not happen: Alias anchor was not resolved?";
        throw new ReferenceError(msg);
      }
      if (maxAliasCount >= 0) {
        data.count += 1;
        if (data.aliasCount === 0)
          data.aliasCount = getAliasCount(doc2, found, anchors);
        if (data.count * data.aliasCount > maxAliasCount) {
          const msg = "Excessive alias count indicates a resource exhaustion attack";
          throw new ReferenceError(msg);
        }
      }
    }
    return found;
  }
  toJSON(_arg, ctx) {
    if (!ctx)
      return { source: this.source };
    const source = this.resolve(ctx.doc, ctx);
    if (!source) {
      const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
      throw new ReferenceError(msg);
    }
    return ctx.anchors.get(source).res;
  }
  toString(ctx, _onComment, _onChompKeep) {
    const src = `*${this.source}`;
    if (ctx) {
      anchorIsValid(this.source);
      if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new Error(msg);
      }
      if (ctx.implicitKey)
        return `${src} `;
    }
    return src;
  }
};
function getAliasCount(doc, node, anchors) {
  if (isAlias(node)) {
    const source = node.resolve(doc);
    const anchor = anchors && source && anchors.get(source);
    return anchor ? anchor.count * anchor.aliasCount : 0;
  } else if (isCollection(node)) {
    let count = 0;
    for (const item of node.items) {
      const c = getAliasCount(doc, item, anchors);
      if (c > count)
        count = c;
    }
    return count;
  } else if (isPair(node)) {
    const kc = getAliasCount(doc, node.key, anchors);
    const vc = getAliasCount(doc, node.value, anchors);
    return Math.max(kc, vc);
  }
  return 1;
}

// ../../node_modules/yaml/browser/dist/nodes/Scalar.js
var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
var Scalar = class extends NodeBase {
  constructor(value) {
    super(SCALAR);
    this.value = value;
  }
  toJSON(arg, ctx) {
    return ctx?.keep ? this.value : toJS(this.value, arg, ctx);
  }
  toString() {
    return String(this.value);
  }
};
Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
Scalar.PLAIN = "PLAIN";
Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";

// ../../node_modules/yaml/browser/dist/doc/createNode.js
var defaultTagPrefix = "tag:yaml.org,2002:";
function findTagObject(value, tagName, tags) {
  if (tagName) {
    const match = tags.filter((t) => t.tag === tagName);
    const tagObj = match.find((t) => !t.format) ?? match[0];
    if (!tagObj)
      throw new Error(`Tag ${tagName} not found`);
    return tagObj;
  }
  return tags.find((t) => t.identify?.(value) && !t.format);
}
function createNode(value, tagName, ctx) {
  if (isDocument(value))
    value = value.contents;
  if (isNode(value))
    return value;
  if (isPair(value)) {
    const map2 = ctx.schema[MAP].createNode?.(ctx.schema, null, ctx);
    map2.items.push(value);
    return map2;
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
    value = value.valueOf();
  }
  const { aliasDuplicateObjects, onAnchor, onTagObj, schema: schema4, sourceObjects } = ctx;
  let ref = void 0;
  if (aliasDuplicateObjects && value && typeof value === "object") {
    ref = sourceObjects.get(value);
    if (ref) {
      ref.anchor ?? (ref.anchor = onAnchor(value));
      return new Alias(ref.anchor);
    } else {
      ref = { anchor: null, node: null };
      sourceObjects.set(value, ref);
    }
  }
  if (tagName?.startsWith("!!"))
    tagName = defaultTagPrefix + tagName.slice(2);
  let tagObj = findTagObject(value, tagName, schema4.tags);
  if (!tagObj) {
    if (value && typeof value.toJSON === "function") {
      value = value.toJSON();
    }
    if (!value || typeof value !== "object") {
      const node2 = new Scalar(value);
      if (ref)
        ref.node = node2;
      return node2;
    }
    tagObj = value instanceof Map ? schema4[MAP] : Symbol.iterator in Object(value) ? schema4[SEQ] : schema4[MAP];
  }
  if (onTagObj) {
    onTagObj(tagObj);
    delete ctx.onTagObj;
  }
  const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar(value);
  if (tagName)
    node.tag = tagName;
  else if (!tagObj.default)
    node.tag = tagObj.tag;
  if (ref)
    ref.node = node;
  return node;
}

// ../../node_modules/yaml/browser/dist/nodes/Collection.js
function collectionFromPath(schema4, path, value) {
  let v = value;
  for (let i = path.length - 1; i >= 0; --i) {
    const k = path[i];
    if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
      const a = [];
      a[k] = v;
      v = a;
    } else {
      v = /* @__PURE__ */ new Map([[k, v]]);
    }
  }
  return createNode(v, void 0, {
    aliasDuplicateObjects: false,
    keepUndefined: false,
    onAnchor: () => {
      throw new Error("This should not happen, please report a bug.");
    },
    schema: schema4,
    sourceObjects: /* @__PURE__ */ new Map()
  });
}
var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
var Collection = class extends NodeBase {
  constructor(type, schema4) {
    super(type);
    Object.defineProperty(this, "schema", {
      value: schema4,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  /**
   * Create a copy of this collection.
   *
   * @param schema - If defined, overwrites the original's schema
   */
  clone(schema4) {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (schema4)
      copy.schema = schema4;
    copy.items = copy.items.map((it) => isNode(it) || isPair(it) ? it.clone(schema4) : it);
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /**
   * Adds a value to the collection. For `!!map` and `!!omap` the value must
   * be a Pair instance or a `{ key, value }` object, which may not have a key
   * that already exists in the map.
   */
  addIn(path, value) {
    if (isEmptyPath(path))
      this.add(value);
    else {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (isCollection(node))
        node.addIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
  /**
   * Removes a value from the collection.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.delete(key);
    const node = this.get(key, true);
    if (isCollection(node))
      return node.deleteIn(rest);
    else
      throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    const [key, ...rest] = path;
    const node = this.get(key, true);
    if (rest.length === 0)
      return !keepScalar && isScalar(node) ? node.value : node;
    else
      return isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
  }
  hasAllNullValues(allowScalar) {
    return this.items.every((node) => {
      if (!isPair(node))
        return false;
      const n = node.value;
      return n == null || allowScalar && isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
    });
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   */
  hasIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.has(key);
    const node = this.get(key, true);
    return isCollection(node) ? node.hasIn(rest) : false;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    const [key, ...rest] = path;
    if (rest.length === 0) {
      this.set(key, value);
    } else {
      const node = this.get(key, true);
      if (isCollection(node))
        node.setIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
};

// ../../node_modules/yaml/browser/dist/stringify/stringifyComment.js
var stringifyComment = (str2) => str2.replace(/^(?!$)(?: $)?/gm, "#");
function indentComment(comment, indent) {
  if (/^\n+$/.test(comment))
    return comment.substring(1);
  return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
}
var lineComment = (str2, indent, comment) => str2.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str2.endsWith(" ") ? "" : " ") + comment;

// ../../node_modules/yaml/browser/dist/stringify/foldFlowLines.js
var FOLD_FLOW = "flow";
var FOLD_BLOCK = "block";
var FOLD_QUOTED = "quoted";
function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
  if (!lineWidth || lineWidth < 0)
    return text;
  if (lineWidth < minContentWidth)
    minContentWidth = 0;
  const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
  if (text.length <= endStep)
    return text;
  const folds = [];
  const escapedFolds = {};
  let end = lineWidth - indent.length;
  if (typeof indentAtStart === "number") {
    if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
      folds.push(0);
    else
      end = lineWidth - indentAtStart;
  }
  let split = void 0;
  let prev = void 0;
  let overflow = false;
  let i = -1;
  let escStart = -1;
  let escEnd = -1;
  if (mode === FOLD_BLOCK) {
    i = consumeMoreIndentedLines(text, i, indent.length);
    if (i !== -1)
      end = i + endStep;
  }
  for (let ch; ch = text[i += 1]; ) {
    if (mode === FOLD_QUOTED && ch === "\\") {
      escStart = i;
      switch (text[i + 1]) {
        case "x":
          i += 3;
          break;
        case "u":
          i += 5;
          break;
        case "U":
          i += 9;
          break;
        default:
          i += 1;
      }
      escEnd = i;
    }
    if (ch === "\n") {
      if (mode === FOLD_BLOCK)
        i = consumeMoreIndentedLines(text, i, indent.length);
      end = i + indent.length + endStep;
      split = void 0;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
        const next = text[i + 1];
        if (next && next !== " " && next !== "\n" && next !== "	")
          split = i;
      }
      if (i >= end) {
        if (split) {
          folds.push(split);
          end = split + endStep;
          split = void 0;
        } else if (mode === FOLD_QUOTED) {
          while (prev === " " || prev === "	") {
            prev = ch;
            ch = text[i += 1];
            overflow = true;
          }
          const j = i > escEnd + 1 ? i - 2 : escStart - 1;
          if (escapedFolds[j])
            return text;
          folds.push(j);
          escapedFolds[j] = true;
          end = j + endStep;
          split = void 0;
        } else {
          overflow = true;
        }
      }
    }
    prev = ch;
  }
  if (overflow && onOverflow)
    onOverflow();
  if (folds.length === 0)
    return text;
  if (onFold)
    onFold();
  let res = text.slice(0, folds[0]);
  for (let i2 = 0; i2 < folds.length; ++i2) {
    const fold = folds[i2];
    const end2 = folds[i2 + 1] || text.length;
    if (fold === 0)
      res = `
${indent}${text.slice(0, end2)}`;
    else {
      if (mode === FOLD_QUOTED && escapedFolds[fold])
        res += `${text[fold]}\\`;
      res += `
${indent}${text.slice(fold + 1, end2)}`;
    }
  }
  return res;
}
function consumeMoreIndentedLines(text, i, indent) {
  let end = i;
  let start = i + 1;
  let ch = text[start];
  while (ch === " " || ch === "	") {
    if (i < start + indent) {
      ch = text[++i];
    } else {
      do {
        ch = text[++i];
      } while (ch && ch !== "\n");
      end = i;
      start = i + 1;
      ch = text[start];
    }
  }
  return end;
}

// ../../node_modules/yaml/browser/dist/stringify/stringifyString.js
var getFoldOptions = (ctx, isBlock) => ({
  indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
  lineWidth: ctx.options.lineWidth,
  minContentWidth: ctx.options.minContentWidth
});
var containsDocumentMarker = (str2) => /^(%|---|\.\.\.)/m.test(str2);
function lineLengthOverLimit(str2, lineWidth, indentLength) {
  if (!lineWidth || lineWidth < 0)
    return false;
  const limit = lineWidth - indentLength;
  const strLen = str2.length;
  if (strLen <= limit)
    return false;
  for (let i = 0, start = 0; i < strLen; ++i) {
    if (str2[i] === "\n") {
      if (i - start > limit)
        return true;
      start = i + 1;
      if (strLen - start <= limit)
        return false;
    }
  }
  return true;
}
function doubleQuotedString(value, ctx) {
  const json2 = JSON.stringify(value);
  if (ctx.options.doubleQuotedAsJSON)
    return json2;
  const { implicitKey } = ctx;
  const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  let str2 = "";
  let start = 0;
  for (let i = 0, ch = json2[i]; ch; ch = json2[++i]) {
    if (ch === " " && json2[i + 1] === "\\" && json2[i + 2] === "n") {
      str2 += json2.slice(start, i) + "\\ ";
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json2[i + 1]) {
        case "u":
          {
            str2 += json2.slice(start, i);
            const code = json2.substr(i + 2, 4);
            switch (code) {
              case "0000":
                str2 += "\\0";
                break;
              case "0007":
                str2 += "\\a";
                break;
              case "000b":
                str2 += "\\v";
                break;
              case "001b":
                str2 += "\\e";
                break;
              case "0085":
                str2 += "\\N";
                break;
              case "00a0":
                str2 += "\\_";
                break;
              case "2028":
                str2 += "\\L";
                break;
              case "2029":
                str2 += "\\P";
                break;
              default:
                if (code.substr(0, 2) === "00")
                  str2 += "\\x" + code.substr(2);
                else
                  str2 += json2.substr(i, 6);
            }
            i += 5;
            start = i + 1;
          }
          break;
        case "n":
          if (implicitKey || json2[i + 2] === '"' || json2.length < minMultiLineLength) {
            i += 1;
          } else {
            str2 += json2.slice(start, i) + "\n\n";
            while (json2[i + 2] === "\\" && json2[i + 3] === "n" && json2[i + 4] !== '"') {
              str2 += "\n";
              i += 2;
            }
            str2 += indent;
            if (json2[i + 2] === " ")
              str2 += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str2 = start ? str2 + json2.slice(start) : json2;
  return implicitKey ? str2 : foldFlowLines(str2, indent, FOLD_QUOTED, getFoldOptions(ctx, false));
}
function singleQuotedString(value, ctx) {
  if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
    return doubleQuotedString(value, ctx);
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
  return ctx.implicitKey ? res : foldFlowLines(res, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function quotedString(value, ctx) {
  const { singleQuote } = ctx.options;
  let qs;
  if (singleQuote === false)
    qs = doubleQuotedString;
  else {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && !hasSingle)
      qs = singleQuotedString;
    else if (hasSingle && !hasDouble)
      qs = doubleQuotedString;
    else
      qs = singleQuote ? singleQuotedString : doubleQuotedString;
  }
  return qs(value, ctx);
}
var blockEndNewlines;
try {
  blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
} catch {
  blockEndNewlines = /\n+(?!\n|$)/g;
}
function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
  const { blockQuote, commentString, lineWidth } = ctx.options;
  if (!blockQuote || /\n[\t ]+$/.test(value)) {
    return quotedString(value, ctx);
  }
  const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
  const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.BLOCK_FOLDED ? false : type === Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
  if (!value)
    return literal ? "|\n" : ">\n";
  let chomp;
  let endStart;
  for (endStart = value.length; endStart > 0; --endStart) {
    const ch = value[endStart - 1];
    if (ch !== "\n" && ch !== "	" && ch !== " ")
      break;
  }
  let end = value.substring(endStart);
  const endNlPos = end.indexOf("\n");
  if (endNlPos === -1) {
    chomp = "-";
  } else if (value === end || endNlPos !== end.length - 1) {
    chomp = "+";
    if (onChompKeep)
      onChompKeep();
  } else {
    chomp = "";
  }
  if (end) {
    value = value.slice(0, -end.length);
    if (end[end.length - 1] === "\n")
      end = end.slice(0, -1);
    end = end.replace(blockEndNewlines, `$&${indent}`);
  }
  let startWithSpace = false;
  let startEnd;
  let startNlPos = -1;
  for (startEnd = 0; startEnd < value.length; ++startEnd) {
    const ch = value[startEnd];
    if (ch === " ")
      startWithSpace = true;
    else if (ch === "\n")
      startNlPos = startEnd;
    else
      break;
  }
  let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
  if (start) {
    value = value.substring(start.length);
    start = start.replace(/\n+/g, `$&${indent}`);
  }
  const indentSize = indent ? "2" : "1";
  let header = (startWithSpace ? indentSize : "") + chomp;
  if (comment) {
    header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
    if (onComment)
      onComment();
  }
  if (!literal) {
    const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
    let literalFallback = false;
    const foldOptions = getFoldOptions(ctx, true);
    if (blockQuote !== "folded" && type !== Scalar.BLOCK_FOLDED) {
      foldOptions.onOverflow = () => {
        literalFallback = true;
      };
    }
    const body = foldFlowLines(`${start}${foldedValue}${end}`, indent, FOLD_BLOCK, foldOptions);
    if (!literalFallback)
      return `>${header}
${indent}${body}`;
  }
  value = value.replace(/\n+/g, `$&${indent}`);
  return `|${header}
${indent}${start}${value}${end}`;
}
function plainString(item, ctx, onComment, onChompKeep) {
  const { type, value } = item;
  const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
  if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
    return quotedString(value, ctx);
  }
  if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
    return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
  }
  if (!implicitKey && !inFlow && type !== Scalar.PLAIN && value.includes("\n")) {
    return blockString(item, ctx, onComment, onChompKeep);
  }
  if (containsDocumentMarker(value)) {
    if (indent === "") {
      ctx.forceBlockIndent = true;
      return blockString(item, ctx, onComment, onChompKeep);
    } else if (implicitKey && indent === indentStep) {
      return quotedString(value, ctx);
    }
  }
  const str2 = value.replace(/\n+/g, `$&
${indent}`);
  if (actualString) {
    const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str2);
    const { compat, tags } = ctx.doc.schema;
    if (tags.some(test) || compat?.some(test))
      return quotedString(value, ctx);
  }
  return implicitKey ? str2 : foldFlowLines(str2, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function stringifyString(item, ctx, onComment, onChompKeep) {
  const { implicitKey, inFlow } = ctx;
  const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
  let { type } = item;
  if (type !== Scalar.QUOTE_DOUBLE) {
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
      type = Scalar.QUOTE_DOUBLE;
  }
  const _stringify = (_type) => {
    switch (_type) {
      case Scalar.BLOCK_FOLDED:
      case Scalar.BLOCK_LITERAL:
        return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
      case Scalar.QUOTE_DOUBLE:
        return doubleQuotedString(ss.value, ctx);
      case Scalar.QUOTE_SINGLE:
        return singleQuotedString(ss.value, ctx);
      case Scalar.PLAIN:
        return plainString(ss, ctx, onComment, onChompKeep);
      default:
        return null;
    }
  };
  let res = _stringify(type);
  if (res === null) {
    const { defaultKeyType, defaultStringType } = ctx.options;
    const t = implicitKey && defaultKeyType || defaultStringType;
    res = _stringify(t);
    if (res === null)
      throw new Error(`Unsupported default string type ${t}`);
  }
  return res;
}

// ../../node_modules/yaml/browser/dist/stringify/stringify.js
function createStringifyContext(doc, options) {
  const opt = Object.assign({
    blockQuote: true,
    commentString: stringifyComment,
    defaultKeyType: null,
    defaultStringType: "PLAIN",
    directives: null,
    doubleQuotedAsJSON: false,
    doubleQuotedMinMultiLineLength: 40,
    falseStr: "false",
    flowCollectionPadding: true,
    indentSeq: true,
    lineWidth: 80,
    minContentWidth: 20,
    nullStr: "null",
    simpleKeys: false,
    singleQuote: null,
    trailingComma: false,
    trueStr: "true",
    verifyAliasOrder: true
  }, doc.schema.toStringOptions, options);
  let inFlow;
  switch (opt.collectionStyle) {
    case "block":
      inFlow = false;
      break;
    case "flow":
      inFlow = true;
      break;
    default:
      inFlow = null;
  }
  return {
    anchors: /* @__PURE__ */ new Set(),
    doc,
    flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
    indent: "",
    indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
    inFlow,
    options: opt
  };
}
function getTagObject(tags, item) {
  if (item.tag) {
    const match = tags.filter((t) => t.tag === item.tag);
    if (match.length > 0)
      return match.find((t) => t.format === item.format) ?? match[0];
  }
  let tagObj = void 0;
  let obj;
  if (isScalar(item)) {
    obj = item.value;
    let match = tags.filter((t) => t.identify?.(obj));
    if (match.length > 1) {
      const testMatch = match.filter((t) => t.test);
      if (testMatch.length > 0)
        match = testMatch;
    }
    tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
  } else {
    obj = item;
    tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
  }
  if (!tagObj) {
    const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
    throw new Error(`Tag not resolved for ${name} value`);
  }
  return tagObj;
}
function stringifyProps(node, tagObj, { anchors, doc }) {
  if (!doc.directives)
    return "";
  const props = [];
  const anchor = (isScalar(node) || isCollection(node)) && node.anchor;
  if (anchor && anchorIsValid(anchor)) {
    anchors.add(anchor);
    props.push(`&${anchor}`);
  }
  const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
  if (tag)
    props.push(doc.directives.tagString(tag));
  return props.join(" ");
}
function stringify(item, ctx, onComment, onChompKeep) {
  if (isPair(item))
    return item.toString(ctx, onComment, onChompKeep);
  if (isAlias(item)) {
    if (ctx.doc.directives)
      return item.toString(ctx);
    if (ctx.resolvedAliases?.has(item)) {
      throw new TypeError(`Cannot stringify circular structure without alias nodes`);
    } else {
      if (ctx.resolvedAliases)
        ctx.resolvedAliases.add(item);
      else
        ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
      item = item.resolve(ctx.doc);
    }
  }
  let tagObj = void 0;
  const node = isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
  tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
  const props = stringifyProps(node, tagObj, ctx);
  if (props.length > 0)
    ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
  const str2 = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : isScalar(node) ? stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
  if (!props)
    return str2;
  return isScalar(node) || str2[0] === "{" || str2[0] === "[" ? `${props} ${str2}` : `${props}
${ctx.indent}${str2}`;
}

// ../../node_modules/yaml/browser/dist/stringify/stringifyPair.js
function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
  const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
  let keyComment = isNode(key) && key.comment || null;
  if (simpleKeys) {
    if (keyComment) {
      throw new Error("With simple keys, key nodes cannot have comments");
    }
    if (isCollection(key) || !isNode(key) && typeof key === "object") {
      const msg = "With simple keys, collection cannot be used as a key value";
      throw new Error(msg);
    }
  }
  let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || isCollection(key) || (isScalar(key) ? key.type === Scalar.BLOCK_FOLDED || key.type === Scalar.BLOCK_LITERAL : typeof key === "object"));
  ctx = Object.assign({}, ctx, {
    allNullValues: false,
    implicitKey: !explicitKey && (simpleKeys || !allNullValues),
    indent: indent + indentStep
  });
  let keyCommentDone = false;
  let chompKeep = false;
  let str2 = stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
  if (!explicitKey && !ctx.inFlow && str2.length > 1024) {
    if (simpleKeys)
      throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
    explicitKey = true;
  }
  if (ctx.inFlow) {
    if (allNullValues || value == null) {
      if (keyCommentDone && onComment)
        onComment();
      return str2 === "" ? "?" : explicitKey ? `? ${str2}` : str2;
    }
  } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
    str2 = `? ${str2}`;
    if (keyComment && !keyCommentDone) {
      str2 += lineComment(str2, ctx.indent, commentString(keyComment));
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str2;
  }
  if (keyCommentDone)
    keyComment = null;
  if (explicitKey) {
    if (keyComment)
      str2 += lineComment(str2, ctx.indent, commentString(keyComment));
    str2 = `? ${str2}
${indent}:`;
  } else {
    str2 = `${str2}:`;
    if (keyComment)
      str2 += lineComment(str2, ctx.indent, commentString(keyComment));
  }
  let vsb, vcb, valueComment;
  if (isNode(value)) {
    vsb = !!value.spaceBefore;
    vcb = value.commentBefore;
    valueComment = value.comment;
  } else {
    vsb = false;
    vcb = null;
    valueComment = null;
    if (value && typeof value === "object")
      value = doc.createNode(value);
  }
  ctx.implicitKey = false;
  if (!explicitKey && !keyComment && isScalar(value))
    ctx.indentAtStart = str2.length + 1;
  chompKeep = false;
  if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && isSeq(value) && !value.flow && !value.tag && !value.anchor) {
    ctx.indent = ctx.indent.substring(2);
  }
  let valueCommentDone = false;
  const valueStr = stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
  let ws = " ";
  if (keyComment || vsb || vcb) {
    ws = vsb ? "\n" : "";
    if (vcb) {
      const cs = commentString(vcb);
      ws += `
${indentComment(cs, ctx.indent)}`;
    }
    if (valueStr === "" && !ctx.inFlow) {
      if (ws === "\n" && valueComment)
        ws = "\n\n";
    } else {
      ws += `
${ctx.indent}`;
    }
  } else if (!explicitKey && isCollection(value)) {
    const vs0 = valueStr[0];
    const nl0 = valueStr.indexOf("\n");
    const hasNewline = nl0 !== -1;
    const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
    if (hasNewline || !flow) {
      let hasPropsLine = false;
      if (hasNewline && (vs0 === "&" || vs0 === "!")) {
        let sp0 = valueStr.indexOf(" ");
        if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
          sp0 = valueStr.indexOf(" ", sp0 + 1);
        }
        if (sp0 === -1 || nl0 < sp0)
          hasPropsLine = true;
      }
      if (!hasPropsLine)
        ws = `
${ctx.indent}`;
    }
  } else if (valueStr === "" || valueStr[0] === "\n") {
    ws = "";
  }
  str2 += ws + valueStr;
  if (ctx.inFlow) {
    if (valueCommentDone && onComment)
      onComment();
  } else if (valueComment && !valueCommentDone) {
    str2 += lineComment(str2, ctx.indent, commentString(valueComment));
  } else if (chompKeep && onChompKeep) {
    onChompKeep();
  }
  return str2;
}

// ../../node_modules/yaml/browser/dist/log.js
function warn(logLevel, warning) {
  if (logLevel === "debug" || logLevel === "warn") {
    console.warn(warning);
  }
}

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/merge.js
var MERGE_KEY = "<<";
var merge = {
  identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
  default: "key",
  tag: "tag:yaml.org,2002:merge",
  test: /^<<$/,
  resolve: () => Object.assign(new Scalar(Symbol(MERGE_KEY)), {
    addToJSMap: addMergeToJSMap
  }),
  stringify: () => MERGE_KEY
};
var isMergeKey = (ctx, key) => (merge.identify(key) || isScalar(key) && (!key.type || key.type === Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
function addMergeToJSMap(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (isSeq(source))
    for (const it of source.items)
      mergeValue(ctx, map2, it);
  else if (Array.isArray(source))
    for (const it of source)
      mergeValue(ctx, map2, it);
  else
    mergeValue(ctx, map2, source);
}
function mergeValue(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (!isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  const srcMap = source.toJSON(null, ctx, Map);
  for (const [key, value2] of srcMap) {
    if (map2 instanceof Map) {
      if (!map2.has(key))
        map2.set(key, value2);
    } else if (map2 instanceof Set) {
      map2.add(key);
    } else if (!Object.prototype.hasOwnProperty.call(map2, key)) {
      Object.defineProperty(map2, key, {
        value: value2,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return map2;
}
function resolveAliasValue(ctx, value) {
  return ctx && isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
}

// ../../node_modules/yaml/browser/dist/nodes/addPairToJSMap.js
function addPairToJSMap(ctx, map2, { key, value }) {
  if (isNode(key) && key.addToJSMap)
    key.addToJSMap(ctx, map2, value);
  else if (isMergeKey(ctx, key))
    addMergeToJSMap(ctx, map2, value);
  else {
    const jsKey = toJS(key, "", ctx);
    if (map2 instanceof Map) {
      map2.set(jsKey, toJS(value, jsKey, ctx));
    } else if (map2 instanceof Set) {
      map2.add(jsKey);
    } else {
      const stringKey = stringifyKey(key, jsKey, ctx);
      const jsValue = toJS(value, stringKey, ctx);
      if (stringKey in map2)
        Object.defineProperty(map2, stringKey, {
          value: jsValue,
          writable: true,
          enumerable: true,
          configurable: true
        });
      else
        map2[stringKey] = jsValue;
    }
  }
  return map2;
}
function stringifyKey(key, jsKey, ctx) {
  if (jsKey === null)
    return "";
  if (typeof jsKey !== "object")
    return String(jsKey);
  if (isNode(key) && ctx?.doc) {
    const strCtx = createStringifyContext(ctx.doc, {});
    strCtx.anchors = /* @__PURE__ */ new Set();
    for (const node of ctx.anchors.keys())
      strCtx.anchors.add(node.anchor);
    strCtx.inFlow = true;
    strCtx.inStringifyKey = true;
    const strKey = key.toString(strCtx);
    if (!ctx.mapKeyWarned) {
      let jsonStr = JSON.stringify(strKey);
      if (jsonStr.length > 40)
        jsonStr = jsonStr.substring(0, 36) + '..."';
      warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
      ctx.mapKeyWarned = true;
    }
    return strKey;
  }
  return JSON.stringify(jsKey);
}

// ../../node_modules/yaml/browser/dist/nodes/Pair.js
function createPair(key, value, ctx) {
  const k = createNode(key, void 0, ctx);
  const v = createNode(value, void 0, ctx);
  return new Pair(k, v);
}
var Pair = class _Pair {
  constructor(key, value = null) {
    Object.defineProperty(this, NODE_TYPE, { value: PAIR });
    this.key = key;
    this.value = value;
  }
  clone(schema4) {
    let { key, value } = this;
    if (isNode(key))
      key = key.clone(schema4);
    if (isNode(value))
      value = value.clone(schema4);
    return new _Pair(key, value);
  }
  toJSON(_, ctx) {
    const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    return addPairToJSMap(ctx, pair, this);
  }
  toString(ctx, onComment, onChompKeep) {
    return ctx?.doc ? stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
  }
};

// ../../node_modules/yaml/browser/dist/stringify/stringifyCollection.js
function stringifyCollection(collection, ctx, options) {
  const flow = ctx.inFlow ?? collection.flow;
  const stringify4 = flow ? stringifyFlowCollection : stringifyBlockCollection;
  return stringify4(collection, ctx, options);
}
function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
  const { indent, options: { commentString } } = ctx;
  const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
  let chompKeep = false;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment2 = null;
    if (isNode(item)) {
      if (!chompKeep && item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
      if (item.comment)
        comment2 = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (!chompKeep && ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
      }
    }
    chompKeep = false;
    let str3 = stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
    if (comment2)
      str3 += lineComment(str3, itemIndent, commentString(comment2));
    if (chompKeep && comment2)
      chompKeep = false;
    lines.push(blockItemPrefix + str3);
  }
  let str2;
  if (lines.length === 0) {
    str2 = flowChars.start + flowChars.end;
  } else {
    str2 = lines[0];
    for (let i = 1; i < lines.length; ++i) {
      const line = lines[i];
      str2 += line ? `
${indent}${line}` : "\n";
    }
  }
  if (comment) {
    str2 += "\n" + indentComment(commentString(comment), indent);
    if (onComment)
      onComment();
  } else if (chompKeep && onChompKeep)
    onChompKeep();
  return str2;
}
function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
  const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
  itemIndent += indentStep;
  const itemCtx = Object.assign({}, ctx, {
    indent: itemIndent,
    inFlow: true,
    type: null
  });
  let reqNewline = false;
  let linesAtValue = 0;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item = items[i];
    let comment = null;
    if (isNode(item)) {
      if (item.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item.commentBefore, false);
      if (item.comment)
        comment = item.comment;
    } else if (isPair(item)) {
      const ik = isNode(item.key) ? item.key : null;
      if (ik) {
        if (ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, false);
        if (ik.comment)
          reqNewline = true;
      }
      const iv = isNode(item.value) ? item.value : null;
      if (iv) {
        if (iv.comment)
          comment = iv.comment;
        if (iv.commentBefore)
          reqNewline = true;
      } else if (item.value == null && ik?.comment) {
        comment = ik.comment;
      }
    }
    if (comment)
      reqNewline = true;
    let str2 = stringify(item, itemCtx, () => comment = null);
    reqNewline || (reqNewline = lines.length > linesAtValue || str2.includes("\n"));
    if (i < items.length - 1) {
      str2 += ",";
    } else if (ctx.options.trailingComma) {
      if (ctx.options.lineWidth > 0) {
        reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str2.length + 2) > ctx.options.lineWidth);
      }
      if (reqNewline) {
        str2 += ",";
      }
    }
    if (comment)
      str2 += lineComment(str2, itemIndent, commentString(comment));
    lines.push(str2);
    linesAtValue = lines.length;
  }
  const { start, end } = flowChars;
  if (lines.length === 0) {
    return start + end;
  } else {
    if (!reqNewline) {
      const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
      reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
    }
    if (reqNewline) {
      let str2 = start;
      for (const line of lines)
        str2 += line ? `
${indentStep}${indent}${line}` : "\n";
      return `${str2}
${indent}${end}`;
    } else {
      return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
    }
  }
}
function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
  if (comment && chompKeep)
    comment = comment.replace(/^\n+/, "");
  if (comment) {
    const ic = indentComment(commentString(comment), indent);
    lines.push(ic.trimStart());
  }
}

// ../../node_modules/yaml/browser/dist/nodes/YAMLMap.js
function findPair(items, key) {
  const k = isScalar(key) ? key.value : key;
  for (const it of items) {
    if (isPair(it)) {
      if (it.key === key || it.key === k)
        return it;
      if (isScalar(it.key) && it.key.value === k)
        return it;
    }
  }
  return void 0;
}
var YAMLMap = class extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:map";
  }
  constructor(schema4) {
    super(MAP, schema4);
    this.items = [];
  }
  /**
   * A generic collection parsing method that can be extended
   * to other node classes that inherit from YAMLMap
   */
  static from(schema4, obj, ctx) {
    const { keepUndefined, replacer } = ctx;
    const map2 = new this(schema4);
    const add = (key, value) => {
      if (typeof replacer === "function")
        value = replacer.call(obj, key, value);
      else if (Array.isArray(replacer) && !replacer.includes(key))
        return;
      if (value !== void 0 || keepUndefined)
        map2.items.push(createPair(key, value, ctx));
    };
    if (obj instanceof Map) {
      for (const [key, value] of obj)
        add(key, value);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj))
        add(key, obj[key]);
    }
    if (typeof schema4.sortMapEntries === "function") {
      map2.items.sort(schema4.sortMapEntries);
    }
    return map2;
  }
  /**
   * Adds a value to the collection.
   *
   * @param overwrite - If not set `true`, using a key that is already in the
   *   collection will throw. Otherwise, overwrites the previous value.
   */
  add(pair, overwrite) {
    let _pair;
    if (isPair(pair))
      _pair = pair;
    else if (!pair || typeof pair !== "object" || !("key" in pair)) {
      _pair = new Pair(pair, pair?.value);
    } else
      _pair = new Pair(pair.key, pair.value);
    const prev = findPair(this.items, _pair.key);
    const sortEntries = this.schema?.sortMapEntries;
    if (prev) {
      if (!overwrite)
        throw new Error(`Key ${_pair.key} already set`);
      if (isScalar(prev.value) && isScalarValue(_pair.value))
        prev.value.value = _pair.value;
      else
        prev.value = _pair.value;
    } else if (sortEntries) {
      const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
      if (i === -1)
        this.items.push(_pair);
      else
        this.items.splice(i, 0, _pair);
    } else {
      this.items.push(_pair);
    }
  }
  delete(key) {
    const it = findPair(this.items, key);
    if (!it)
      return false;
    const del = this.items.splice(this.items.indexOf(it), 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const it = findPair(this.items, key);
    const node = it?.value;
    return (!keepScalar && isScalar(node) ? node.value : node) ?? void 0;
  }
  has(key) {
    return !!findPair(this.items, key);
  }
  set(key, value) {
    this.add(new Pair(key, value), true);
  }
  /**
   * @param ctx - Conversion context, originally set in Document#toJS()
   * @param {Class} Type - If set, forces the returned collection type
   * @returns Instance of Type, Map, or Object
   */
  toJSON(_, ctx, Type) {
    const map2 = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const item of this.items)
      addPairToJSMap(ctx, map2, item);
    return map2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    for (const item of this.items) {
      if (!isPair(item))
        throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
    }
    if (!ctx.allNullValues && this.hasAllNullValues(false))
      ctx = Object.assign({}, ctx, { allNullValues: true });
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "",
      flowChars: { start: "{", end: "}" },
      itemIndent: ctx.indent || "",
      onChompKeep,
      onComment
    });
  }
};

// ../../node_modules/yaml/browser/dist/schema/common/map.js
var map = {
  collection: "map",
  default: true,
  nodeClass: YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map2, onError) {
    if (!isMap(map2))
      onError("Expected a mapping for this tag");
    return map2;
  },
  createNode: (schema4, obj, ctx) => YAMLMap.from(schema4, obj, ctx)
};

// ../../node_modules/yaml/browser/dist/nodes/YAMLSeq.js
var YAMLSeq = class extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:seq";
  }
  constructor(schema4) {
    super(SEQ, schema4);
    this.items = [];
  }
  add(value) {
    this.items.push(value);
  }
  /**
   * Removes a value from the collection.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   *
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return false;
    const del = this.items.splice(idx, 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return void 0;
    const it = this.items[idx];
    return !keepScalar && isScalar(it) ? it.value : it;
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   */
  has(key) {
    const idx = asItemIndex(key);
    return typeof idx === "number" && idx < this.items.length;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   *
   * If `key` does not contain a representation of an integer, this will throw.
   * It may be wrapped in a `Scalar`.
   */
  set(key, value) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      throw new Error(`Expected a valid index, not ${key}.`);
    const prev = this.items[idx];
    if (isScalar(prev) && isScalarValue(value))
      prev.value = value;
    else
      this.items[idx] = value;
  }
  toJSON(_, ctx) {
    const seq2 = [];
    if (ctx?.onCreate)
      ctx.onCreate(seq2);
    let i = 0;
    for (const item of this.items)
      seq2.push(toJS(item, String(i++), ctx));
    return seq2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "- ",
      flowChars: { start: "[", end: "]" },
      itemIndent: (ctx.indent || "") + "  ",
      onChompKeep,
      onComment
    });
  }
  static from(schema4, obj, ctx) {
    const { replacer } = ctx;
    const seq2 = new this(schema4);
    if (obj && Symbol.iterator in Object(obj)) {
      let i = 0;
      for (let it of obj) {
        if (typeof replacer === "function") {
          const key = obj instanceof Set ? it : String(i++);
          it = replacer.call(obj, key, it);
        }
        seq2.items.push(createNode(it, void 0, ctx));
      }
    }
    return seq2;
  }
};
function asItemIndex(key) {
  let idx = isScalar(key) ? key.value : key;
  if (idx && typeof idx === "string")
    idx = Number(idx);
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

// ../../node_modules/yaml/browser/dist/schema/common/seq.js
var seq = {
  collection: "seq",
  default: true,
  nodeClass: YAMLSeq,
  tag: "tag:yaml.org,2002:seq",
  resolve(seq2, onError) {
    if (!isSeq(seq2))
      onError("Expected a sequence for this tag");
    return seq2;
  },
  createNode: (schema4, obj, ctx) => YAMLSeq.from(schema4, obj, ctx)
};

// ../../node_modules/yaml/browser/dist/schema/common/string.js
var string = {
  identify: (value) => typeof value === "string",
  default: true,
  tag: "tag:yaml.org,2002:str",
  resolve: (str2) => str2,
  stringify(item, ctx, onComment, onChompKeep) {
    ctx = Object.assign({ actualString: true }, ctx);
    return stringifyString(item, ctx, onComment, onChompKeep);
  }
};

// ../../node_modules/yaml/browser/dist/schema/common/null.js
var nullTag = {
  identify: (value) => value == null,
  createNode: () => new Scalar(null),
  default: true,
  tag: "tag:yaml.org,2002:null",
  test: /^(?:~|[Nn]ull|NULL)?$/,
  resolve: () => new Scalar(null),
  stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
};

// ../../node_modules/yaml/browser/dist/schema/core/bool.js
var boolTag = {
  identify: (value) => typeof value === "boolean",
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  resolve: (str2) => new Scalar(str2[0] === "t" || str2[0] === "T"),
  stringify({ source, value }, ctx) {
    if (source && boolTag.test.test(source)) {
      const sv = source[0] === "t" || source[0] === "T";
      if (value === sv)
        return source;
    }
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
};

// ../../node_modules/yaml/browser/dist/stringify/stringifyNumber.js
function stringifyNumber({ format, minFractionDigits, tag, value }) {
  if (typeof value === "bigint")
    return String(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num))
    return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
  let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
  if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
    let i = n.indexOf(".");
    if (i < 0) {
      i = n.length;
      n += ".";
    }
    let d = minFractionDigits - (n.length - i - 1);
    while (d-- > 0)
      n += "0";
  }
  return n;
}

// ../../node_modules/yaml/browser/dist/schema/core/float.js
var floatNaN = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str2) => str2.slice(-3).toLowerCase() === "nan" ? NaN : str2[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  resolve: (str2) => parseFloat(str2),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
  resolve(str2) {
    const node = new Scalar(parseFloat(str2));
    const dot = str2.indexOf(".");
    if (dot !== -1 && str2[str2.length - 1] === "0")
      node.minFractionDigits = str2.length - dot - 1;
    return node;
  },
  stringify: stringifyNumber
};

// ../../node_modules/yaml/browser/dist/schema/core/int.js
var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
var intResolve = (str2, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str2) : parseInt(str2.substring(offset), radix);
function intStringify(node, radix, prefix) {
  const { value } = node;
  if (intIdentify(value) && value >= 0)
    return prefix + value.toString(radix);
  return stringifyNumber(node);
}
var intOct = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^0o[0-7]+$/,
  resolve: (str2, _onError, opt) => intResolve(str2, 2, 8, opt),
  stringify: (node) => intStringify(node, 8, "0o")
};
var int = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9]+$/,
  resolve: (str2, _onError, opt) => intResolve(str2, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^0x[0-9a-fA-F]+$/,
  resolve: (str2, _onError, opt) => intResolve(str2, 2, 16, opt),
  stringify: (node) => intStringify(node, 16, "0x")
};

// ../../node_modules/yaml/browser/dist/schema/core/schema.js
var schema = [
  map,
  seq,
  string,
  nullTag,
  boolTag,
  intOct,
  int,
  intHex,
  floatNaN,
  floatExp,
  float
];

// ../../node_modules/yaml/browser/dist/schema/json/schema.js
function intIdentify2(value) {
  return typeof value === "bigint" || Number.isInteger(value);
}
var stringifyJSON = ({ value }) => JSON.stringify(value);
var jsonScalars = [
  {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str2) => str2,
    stringify: stringifyJSON
  },
  {
    identify: (value) => value == null,
    createNode: () => new Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^null$/,
    resolve: () => null,
    stringify: stringifyJSON
  },
  {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^true$|^false$/,
    resolve: (str2) => str2 === "true",
    stringify: stringifyJSON
  },
  {
    identify: intIdentify2,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^-?(?:0|[1-9][0-9]*)$/,
    resolve: (str2, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str2) : parseInt(str2, 10),
    stringify: ({ value }) => intIdentify2(value) ? value.toString() : JSON.stringify(value)
  },
  {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
    resolve: (str2) => parseFloat(str2),
    stringify: stringifyJSON
  }
];
var jsonError = {
  default: true,
  tag: "",
  test: /^/,
  resolve(str2, onError) {
    onError(`Unresolved plain scalar ${JSON.stringify(str2)}`);
    return str2;
  }
};
var schema2 = [map, seq].concat(jsonScalars, jsonError);

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/binary.js
var binary = {
  identify: (value) => value instanceof Uint8Array,
  // Buffer inherits from Uint8Array
  default: false,
  tag: "tag:yaml.org,2002:binary",
  /**
   * Returns a Buffer in node and an Uint8Array in browsers
   *
   * To use the resulting buffer as an image, you'll want to do something like:
   *
   *   const blob = new Blob([buffer], { type: 'image/jpeg' })
   *   document.querySelector('#photo').src = URL.createObjectURL(blob)
   */
  resolve(src, onError) {
    if (typeof atob === "function") {
      const str2 = atob(src.replace(/[\n\r]/g, ""));
      const buffer = new Uint8Array(str2.length);
      for (let i = 0; i < str2.length; ++i)
        buffer[i] = str2.charCodeAt(i);
      return buffer;
    } else {
      onError("This environment does not support reading binary tags; either Buffer or atob is required");
      return src;
    }
  },
  stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
    if (!value)
      return "";
    const buf = value;
    let str2;
    if (typeof btoa === "function") {
      let s = "";
      for (let i = 0; i < buf.length; ++i)
        s += String.fromCharCode(buf[i]);
      str2 = btoa(s);
    } else {
      throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
    }
    type ?? (type = Scalar.BLOCK_LITERAL);
    if (type !== Scalar.QUOTE_DOUBLE) {
      const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
      const n = Math.ceil(str2.length / lineWidth);
      const lines = new Array(n);
      for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
        lines[i] = str2.substr(o, lineWidth);
      }
      str2 = lines.join(type === Scalar.BLOCK_LITERAL ? "\n" : " ");
    }
    return stringifyString({ comment, type, value: str2 }, ctx, onComment, onChompKeep);
  }
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/pairs.js
function resolvePairs(seq2, onError) {
  if (isSeq(seq2)) {
    for (let i = 0; i < seq2.items.length; ++i) {
      let item = seq2.items[i];
      if (isPair(item))
        continue;
      else if (isMap(item)) {
        if (item.items.length > 1)
          onError("Each pair must have its own sequence indicator");
        const pair = item.items[0] || new Pair(new Scalar(null));
        if (item.commentBefore)
          pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
        if (item.comment) {
          const cn = pair.value ?? pair.key;
          cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
        }
        item = pair;
      }
      seq2.items[i] = isPair(item) ? item : new Pair(item);
    }
  } else
    onError("Expected a sequence for this tag");
  return seq2;
}
function createPairs(schema4, iterable, ctx) {
  const { replacer } = ctx;
  const pairs2 = new YAMLSeq(schema4);
  pairs2.tag = "tag:yaml.org,2002:pairs";
  let i = 0;
  if (iterable && Symbol.iterator in Object(iterable))
    for (let it of iterable) {
      if (typeof replacer === "function")
        it = replacer.call(iterable, String(i++), it);
      let key, value;
      if (Array.isArray(it)) {
        if (it.length === 2) {
          key = it[0];
          value = it[1];
        } else
          throw new TypeError(`Expected [key, value] tuple: ${it}`);
      } else if (it && it instanceof Object) {
        const keys = Object.keys(it);
        if (keys.length === 1) {
          key = keys[0];
          value = it[key];
        } else {
          throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
        }
      } else {
        key = it;
      }
      pairs2.items.push(createPair(key, value, ctx));
    }
  return pairs2;
}
var pairs = {
  collection: "seq",
  default: false,
  tag: "tag:yaml.org,2002:pairs",
  resolve: resolvePairs,
  createNode: createPairs
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/omap.js
var YAMLOMap = class _YAMLOMap extends YAMLSeq {
  constructor() {
    super();
    this.add = YAMLMap.prototype.add.bind(this);
    this.delete = YAMLMap.prototype.delete.bind(this);
    this.get = YAMLMap.prototype.get.bind(this);
    this.has = YAMLMap.prototype.has.bind(this);
    this.set = YAMLMap.prototype.set.bind(this);
    this.tag = _YAMLOMap.tag;
  }
  /**
   * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
   * but TypeScript won't allow widening the signature of a child method.
   */
  toJSON(_, ctx) {
    if (!ctx)
      return super.toJSON(_);
    const map2 = /* @__PURE__ */ new Map();
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const pair of this.items) {
      let key, value;
      if (isPair(pair)) {
        key = toJS(pair.key, "", ctx);
        value = toJS(pair.value, key, ctx);
      } else {
        key = toJS(pair, "", ctx);
      }
      if (map2.has(key))
        throw new Error("Ordered maps must not include duplicate keys");
      map2.set(key, value);
    }
    return map2;
  }
  static from(schema4, iterable, ctx) {
    const pairs2 = createPairs(schema4, iterable, ctx);
    const omap2 = new this();
    omap2.items = pairs2.items;
    return omap2;
  }
};
YAMLOMap.tag = "tag:yaml.org,2002:omap";
var omap = {
  collection: "seq",
  identify: (value) => value instanceof Map,
  nodeClass: YAMLOMap,
  default: false,
  tag: "tag:yaml.org,2002:omap",
  resolve(seq2, onError) {
    const pairs2 = resolvePairs(seq2, onError);
    const seenKeys = [];
    for (const { key } of pairs2.items) {
      if (isScalar(key)) {
        if (seenKeys.includes(key.value)) {
          onError(`Ordered maps must not include duplicate keys: ${key.value}`);
        } else {
          seenKeys.push(key.value);
        }
      }
    }
    return Object.assign(new YAMLOMap(), pairs2);
  },
  createNode: (schema4, iterable, ctx) => YAMLOMap.from(schema4, iterable, ctx)
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/bool.js
function boolStringify({ value, source }, ctx) {
  const boolObj = value ? trueTag : falseTag;
  if (source && boolObj.test.test(source))
    return source;
  return value ? ctx.options.trueStr : ctx.options.falseStr;
}
var trueTag = {
  identify: (value) => value === true,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: () => new Scalar(true),
  stringify: boolStringify
};
var falseTag = {
  identify: (value) => value === false,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: () => new Scalar(false),
  stringify: boolStringify
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/float.js
var floatNaN2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str2) => str2.slice(-3).toLowerCase() === "nan" ? NaN : str2[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  resolve: (str2) => parseFloat(str2.replace(/_/g, "")),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
  resolve(str2) {
    const node = new Scalar(parseFloat(str2.replace(/_/g, "")));
    const dot = str2.indexOf(".");
    if (dot !== -1) {
      const f = str2.substring(dot + 1).replace(/_/g, "");
      if (f[f.length - 1] === "0")
        node.minFractionDigits = f.length;
    }
    return node;
  },
  stringify: stringifyNumber
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/int.js
var intIdentify3 = (value) => typeof value === "bigint" || Number.isInteger(value);
function intResolve2(str2, offset, radix, { intAsBigInt }) {
  const sign = str2[0];
  if (sign === "-" || sign === "+")
    offset += 1;
  str2 = str2.substring(offset).replace(/_/g, "");
  if (intAsBigInt) {
    switch (radix) {
      case 2:
        str2 = `0b${str2}`;
        break;
      case 8:
        str2 = `0o${str2}`;
        break;
      case 16:
        str2 = `0x${str2}`;
        break;
    }
    const n2 = BigInt(str2);
    return sign === "-" ? BigInt(-1) * n2 : n2;
  }
  const n = parseInt(str2, radix);
  return sign === "-" ? -1 * n : n;
}
function intStringify2(node, radix, prefix) {
  const { value } = node;
  if (intIdentify3(value)) {
    const str2 = value.toString(radix);
    return value < 0 ? "-" + prefix + str2.substr(1) : prefix + str2;
  }
  return stringifyNumber(node);
}
var intBin = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "BIN",
  test: /^[-+]?0b[0-1_]+$/,
  resolve: (str2, _onError, opt) => intResolve2(str2, 2, 2, opt),
  stringify: (node) => intStringify2(node, 2, "0b")
};
var intOct2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^[-+]?0[0-7_]+$/,
  resolve: (str2, _onError, opt) => intResolve2(str2, 1, 8, opt),
  stringify: (node) => intStringify2(node, 8, "0")
};
var int2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9][0-9_]*$/,
  resolve: (str2, _onError, opt) => intResolve2(str2, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^[-+]?0x[0-9a-fA-F_]+$/,
  resolve: (str2, _onError, opt) => intResolve2(str2, 2, 16, opt),
  stringify: (node) => intStringify2(node, 16, "0x")
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/set.js
var YAMLSet = class _YAMLSet extends YAMLMap {
  constructor(schema4) {
    super(schema4);
    this.tag = _YAMLSet.tag;
  }
  add(key) {
    let pair;
    if (isPair(key))
      pair = key;
    else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
      pair = new Pair(key.key, null);
    else
      pair = new Pair(key, null);
    const prev = findPair(this.items, pair.key);
    if (!prev)
      this.items.push(pair);
  }
  /**
   * If `keepPair` is `true`, returns the Pair matching `key`.
   * Otherwise, returns the value of that Pair's key.
   */
  get(key, keepPair) {
    const pair = findPair(this.items, key);
    return !keepPair && isPair(pair) ? isScalar(pair.key) ? pair.key.value : pair.key : pair;
  }
  set(key, value) {
    if (typeof value !== "boolean")
      throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
    const prev = findPair(this.items, key);
    if (prev && !value) {
      this.items.splice(this.items.indexOf(prev), 1);
    } else if (!prev && value) {
      this.items.push(new Pair(key));
    }
  }
  toJSON(_, ctx) {
    return super.toJSON(_, ctx, Set);
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    if (this.hasAllNullValues(true))
      return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
    else
      throw new Error("Set items must all have null values");
  }
  static from(schema4, iterable, ctx) {
    const { replacer } = ctx;
    const set2 = new this(schema4);
    if (iterable && Symbol.iterator in Object(iterable))
      for (let value of iterable) {
        if (typeof replacer === "function")
          value = replacer.call(iterable, value, value);
        set2.items.push(createPair(value, null, ctx));
      }
    return set2;
  }
};
YAMLSet.tag = "tag:yaml.org,2002:set";
var set = {
  collection: "map",
  identify: (value) => value instanceof Set,
  nodeClass: YAMLSet,
  default: false,
  tag: "tag:yaml.org,2002:set",
  createNode: (schema4, iterable, ctx) => YAMLSet.from(schema4, iterable, ctx),
  resolve(map2, onError) {
    if (isMap(map2)) {
      if (map2.hasAllNullValues(true))
        return Object.assign(new YAMLSet(), map2);
      else
        onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map2;
  }
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/timestamp.js
function parseSexagesimal(str2, asBigInt) {
  const sign = str2[0];
  const parts = sign === "-" || sign === "+" ? str2.substring(1) : str2;
  const num = (n) => asBigInt ? BigInt(n) : Number(n);
  const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
  return sign === "-" ? num(-1) * res : res;
}
function stringifySexagesimal(node) {
  let { value } = node;
  let num = (n) => n;
  if (typeof value === "bigint")
    num = (n) => BigInt(n);
  else if (isNaN(value) || !isFinite(value))
    return stringifyNumber(node);
  let sign = "";
  if (value < 0) {
    sign = "-";
    value *= num(-1);
  }
  const _60 = num(60);
  const parts = [value % _60];
  if (value < 60) {
    parts.unshift(0);
  } else {
    value = (value - parts[0]) / _60;
    parts.unshift(value % _60);
    if (value >= 60) {
      value = (value - parts[0]) / _60;
      parts.unshift(value);
    }
  }
  return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
}
var intTime = {
  identify: (value) => typeof value === "bigint" || Number.isInteger(value),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
  resolve: (str2, _onError, { intAsBigInt }) => parseSexagesimal(str2, intAsBigInt),
  stringify: stringifySexagesimal
};
var floatTime = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
  resolve: (str2) => parseSexagesimal(str2, false),
  stringify: stringifySexagesimal
};
var timestamp = {
  identify: (value) => value instanceof Date,
  default: true,
  tag: "tag:yaml.org,2002:timestamp",
  // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
  // may be omitted altogether, resulting in a date format. In such a case, the time part is
  // assumed to be 00:00:00Z (start of day, UTC).
  test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
  resolve(str2) {
    const match = str2.match(timestamp.test);
    if (!match)
      throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
    let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
    const tz = match[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, false);
      if (Math.abs(d) < 30)
        d *= 60;
      date -= 6e4 * d;
    }
    return new Date(date);
  },
  stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
};

// ../../node_modules/yaml/browser/dist/schema/yaml-1.1/schema.js
var schema3 = [
  map,
  seq,
  string,
  nullTag,
  trueTag,
  falseTag,
  intBin,
  intOct2,
  int2,
  intHex2,
  floatNaN2,
  floatExp2,
  float2,
  binary,
  merge,
  omap,
  pairs,
  set,
  intTime,
  floatTime,
  timestamp
];

// ../../node_modules/yaml/browser/dist/schema/tags.js
var schemas = /* @__PURE__ */ new Map([
  ["core", schema],
  ["failsafe", [map, seq, string]],
  ["json", schema2],
  ["yaml11", schema3],
  ["yaml-1.1", schema3]
]);
var tagsByName = {
  binary,
  bool: boolTag,
  float,
  floatExp,
  floatNaN,
  floatTime,
  int,
  intHex,
  intOct,
  intTime,
  map,
  merge,
  null: nullTag,
  omap,
  pairs,
  seq,
  set,
  timestamp
};
var coreKnownTags = {
  "tag:yaml.org,2002:binary": binary,
  "tag:yaml.org,2002:merge": merge,
  "tag:yaml.org,2002:omap": omap,
  "tag:yaml.org,2002:pairs": pairs,
  "tag:yaml.org,2002:set": set,
  "tag:yaml.org,2002:timestamp": timestamp
};
function getTags(customTags, schemaName, addMergeTag) {
  const schemaTags = schemas.get(schemaName);
  if (schemaTags && !customTags) {
    return addMergeTag && !schemaTags.includes(merge) ? schemaTags.concat(merge) : schemaTags.slice();
  }
  let tags = schemaTags;
  if (!tags) {
    if (Array.isArray(customTags))
      tags = [];
    else {
      const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  }
  if (Array.isArray(customTags)) {
    for (const tag of customTags)
      tags = tags.concat(tag);
  } else if (typeof customTags === "function") {
    tags = customTags(tags.slice());
  }
  if (addMergeTag)
    tags = tags.concat(merge);
  return tags.reduce((tags2, tag) => {
    const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      const tagName = JSON.stringify(tag);
      const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    if (!tags2.includes(tagObj))
      tags2.push(tagObj);
    return tags2;
  }, []);
}

// ../../node_modules/yaml/browser/dist/schema/Schema.js
var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
var Schema = class _Schema {
  constructor({ compat, customTags, merge: merge2, resolveKnownTags, schema: schema4, sortMapEntries, toStringDefaults }) {
    this.compat = Array.isArray(compat) ? getTags(compat, "compat") : compat ? getTags(null, compat) : null;
    this.name = typeof schema4 === "string" && schema4 || "core";
    this.knownTags = resolveKnownTags ? coreKnownTags : {};
    this.tags = getTags(customTags, this.name, merge2);
    this.toStringOptions = toStringDefaults ?? null;
    Object.defineProperty(this, MAP, { value: map });
    Object.defineProperty(this, SCALAR, { value: string });
    Object.defineProperty(this, SEQ, { value: seq });
    this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
  }
  clone() {
    const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
    copy.tags = this.tags.slice();
    return copy;
  }
};

// ../../node_modules/yaml/browser/dist/stringify/stringifyDocument.js
function stringifyDocument(doc, options) {
  const lines = [];
  let hasDirectives = options.directives === true;
  if (options.directives !== false && doc.directives) {
    const dir = doc.directives.toString(doc);
    if (dir) {
      lines.push(dir);
      hasDirectives = true;
    } else if (doc.directives.docStart)
      hasDirectives = true;
  }
  if (hasDirectives)
    lines.push("---");
  const ctx = createStringifyContext(doc, options);
  const { commentString } = ctx.options;
  if (doc.commentBefore) {
    if (lines.length !== 1)
      lines.unshift("");
    const cs = commentString(doc.commentBefore);
    lines.unshift(indentComment(cs, ""));
  }
  let chompKeep = false;
  let contentComment = null;
  if (doc.contents) {
    if (isNode(doc.contents)) {
      if (doc.contents.spaceBefore && hasDirectives)
        lines.push("");
      if (doc.contents.commentBefore) {
        const cs = commentString(doc.contents.commentBefore);
        lines.push(indentComment(cs, ""));
      }
      ctx.forceBlockIndent = !!doc.comment;
      contentComment = doc.contents.comment;
    }
    const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
    let body = stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
    if (contentComment)
      body += lineComment(body, "", commentString(contentComment));
    if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
      lines[lines.length - 1] = `--- ${body}`;
    } else
      lines.push(body);
  } else {
    lines.push(stringify(doc.contents, ctx));
  }
  if (doc.directives?.docEnd) {
    if (doc.comment) {
      const cs = commentString(doc.comment);
      if (cs.includes("\n")) {
        lines.push("...");
        lines.push(indentComment(cs, ""));
      } else {
        lines.push(`... ${cs}`);
      }
    } else {
      lines.push("...");
    }
  } else {
    let dc = doc.comment;
    if (dc && chompKeep)
      dc = dc.replace(/^\n+/, "");
    if (dc) {
      if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
        lines.push("");
      lines.push(indentComment(commentString(dc), ""));
    }
  }
  return lines.join("\n") + "\n";
}

// ../../node_modules/yaml/browser/dist/doc/Document.js
var Document = class _Document {
  constructor(value, replacer, options) {
    this.commentBefore = null;
    this.comment = null;
    this.errors = [];
    this.warnings = [];
    Object.defineProperty(this, NODE_TYPE, { value: DOC });
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const opt = Object.assign({
      intAsBigInt: false,
      keepSourceTokens: false,
      logLevel: "warn",
      prettyErrors: true,
      strict: true,
      stringKeys: false,
      uniqueKeys: true,
      version: "1.2"
    }, options);
    this.options = opt;
    let { version } = opt;
    if (options?._directives) {
      this.directives = options._directives.atDocument();
      if (this.directives.yaml.explicit)
        version = this.directives.yaml.version;
    } else
      this.directives = new Directives({ version });
    this.setSchema(version, options);
    this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
  }
  /**
   * Create a deep copy of this Document and its contents.
   *
   * Custom Node values that inherit from `Object` still refer to their original instances.
   */
  clone() {
    const copy = Object.create(_Document.prototype, {
      [NODE_TYPE]: { value: DOC }
    });
    copy.commentBefore = this.commentBefore;
    copy.comment = this.comment;
    copy.errors = this.errors.slice();
    copy.warnings = this.warnings.slice();
    copy.options = Object.assign({}, this.options);
    if (this.directives)
      copy.directives = this.directives.clone();
    copy.schema = this.schema.clone();
    copy.contents = isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** Adds a value to the document. */
  add(value) {
    if (assertCollection(this.contents))
      this.contents.add(value);
  }
  /** Adds a value to the document. */
  addIn(path, value) {
    if (assertCollection(this.contents))
      this.contents.addIn(path, value);
  }
  /**
   * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
   *
   * If `node` already has an anchor, `name` is ignored.
   * Otherwise, the `node.anchor` value will be set to `name`,
   * or if an anchor with that name is already present in the document,
   * `name` will be used as a prefix for a new unique anchor.
   * If `name` is undefined, the generated anchor will use 'a' as a prefix.
   */
  createAlias(node, name) {
    if (!node.anchor) {
      const prev = anchorNames(this);
      node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      !name || prev.has(name) ? findNewAnchor(name || "a", prev) : name;
    }
    return new Alias(node.anchor);
  }
  createNode(value, replacer, options) {
    let _replacer = void 0;
    if (typeof replacer === "function") {
      value = replacer.call({ "": value }, "", value);
      _replacer = replacer;
    } else if (Array.isArray(replacer)) {
      const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
      const asStr = replacer.filter(keyToStr).map(String);
      if (asStr.length > 0)
        replacer = replacer.concat(asStr);
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
    const { onAnchor, setAnchors, sourceObjects } = createNodeAnchors(
      this,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      anchorPrefix || "a"
    );
    const ctx = {
      aliasDuplicateObjects: aliasDuplicateObjects ?? true,
      keepUndefined: keepUndefined ?? false,
      onAnchor,
      onTagObj,
      replacer: _replacer,
      schema: this.schema,
      sourceObjects
    };
    const node = createNode(value, tag, ctx);
    if (flow && isCollection(node))
      node.flow = true;
    setAnchors();
    return node;
  }
  /**
   * Convert a key and a value into a `Pair` using the current schema,
   * recursively wrapping all values as `Scalar` or `Collection` nodes.
   */
  createPair(key, value, options = {}) {
    const k = this.createNode(key, null, options);
    const v = this.createNode(value, null, options);
    return new Pair(k, v);
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    return assertCollection(this.contents) ? this.contents.delete(key) : false;
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    if (isEmptyPath(path)) {
      if (this.contents == null)
        return false;
      this.contents = null;
      return true;
    }
    return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  get(key, keepScalar) {
    return isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
  }
  /**
   * Returns item at `path`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    if (isEmptyPath(path))
      return !keepScalar && isScalar(this.contents) ? this.contents.value : this.contents;
    return isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
  }
  /**
   * Checks if the document includes a value with the key `key`.
   */
  has(key) {
    return isCollection(this.contents) ? this.contents.has(key) : false;
  }
  /**
   * Checks if the document includes a value at `path`.
   */
  hasIn(path) {
    if (isEmptyPath(path))
      return this.contents !== void 0;
    return isCollection(this.contents) ? this.contents.hasIn(path) : false;
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  set(key, value) {
    if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, [key], value);
    } else if (assertCollection(this.contents)) {
      this.contents.set(key, value);
    }
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    if (isEmptyPath(path)) {
      this.contents = value;
    } else if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, Array.from(path), value);
    } else if (assertCollection(this.contents)) {
      this.contents.setIn(path, value);
    }
  }
  /**
   * Change the YAML version and schema used by the document.
   * A `null` version disables support for directives, explicit tags, anchors, and aliases.
   * It also requires the `schema` option to be given as a `Schema` instance value.
   *
   * Overrides all previously set schema options.
   */
  setSchema(version, options = {}) {
    if (typeof version === "number")
      version = String(version);
    let opt;
    switch (version) {
      case "1.1":
        if (this.directives)
          this.directives.yaml.version = "1.1";
        else
          this.directives = new Directives({ version: "1.1" });
        opt = { resolveKnownTags: false, schema: "yaml-1.1" };
        break;
      case "1.2":
      case "next":
        if (this.directives)
          this.directives.yaml.version = version;
        else
          this.directives = new Directives({ version });
        opt = { resolveKnownTags: true, schema: "core" };
        break;
      case null:
        if (this.directives)
          delete this.directives;
        opt = null;
        break;
      default: {
        const sv = JSON.stringify(version);
        throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
      }
    }
    if (options.schema instanceof Object)
      this.schema = options.schema;
    else if (opt)
      this.schema = new Schema(Object.assign(opt, options));
    else
      throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
  }
  // json & jsonArg are only used from toJSON()
  toJS({ json: json2, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc: this,
      keep: !json2,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this.contents, jsonArg ?? "", ctx);
    if (typeof onAnchor === "function")
      for (const { count, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
  /**
   * A JSON representation of the document `contents`.
   *
   * @param jsonArg Used by `JSON.stringify` to indicate the array index or
   *   property name.
   */
  toJSON(jsonArg, onAnchor) {
    return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
  }
  /** A YAML representation of the document. */
  toString(options = {}) {
    if (this.errors.length > 0)
      throw new Error("Document with errors cannot be stringified");
    if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
      const s = JSON.stringify(options.indent);
      throw new Error(`"indent" option must be a positive integer, not ${s}`);
    }
    return stringifyDocument(this, options);
  }
};
function assertCollection(contents) {
  if (isCollection(contents))
    return true;
  throw new Error("Expected a YAML collection as document contents");
}

// ../../node_modules/yaml/browser/dist/parse/cst-visit.js
var BREAK2 = /* @__PURE__ */ Symbol("break visit");
var SKIP2 = /* @__PURE__ */ Symbol("skip children");
var REMOVE2 = /* @__PURE__ */ Symbol("remove item");
function visit2(cst, visitor) {
  if ("type" in cst && cst.type === "document")
    cst = { start: cst.start, value: cst.value };
  _visit(Object.freeze([]), cst, visitor);
}
visit2.BREAK = BREAK2;
visit2.SKIP = SKIP2;
visit2.REMOVE = REMOVE2;
visit2.itemAtPath = (cst, path) => {
  let item = cst;
  for (const [field, index] of path) {
    const tok = item?.[field];
    if (tok && "items" in tok) {
      item = tok.items[index];
    } else
      return void 0;
  }
  return item;
};
visit2.parentCollection = (cst, path) => {
  const parent = visit2.itemAtPath(cst, path.slice(0, -1));
  const field = path[path.length - 1][0];
  const coll = parent?.[field];
  if (coll && "items" in coll)
    return coll;
  throw new Error("Parent collection not found");
};
function _visit(path, item, visitor) {
  let ctrl = visitor(item, path);
  if (typeof ctrl === "symbol")
    return ctrl;
  for (const field of ["key", "value"]) {
    const token = item[field];
    if (token && "items" in token) {
      for (let i = 0; i < token.items.length; ++i) {
        const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK2)
          return BREAK2;
        else if (ci === REMOVE2) {
          token.items.splice(i, 1);
          i -= 1;
        }
      }
      if (typeof ctrl === "function" && field === "key")
        ctrl = ctrl(item, path);
    }
  }
  return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
}

// ../../node_modules/yaml/browser/dist/parse/lexer.js
var hexDigits = new Set("0123456789ABCDEFabcdef");
var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
var flowIndicatorChars = new Set(",[]{}");
var invalidAnchorChars = new Set(" ,[]{}\n\r	");

// ../../node_modules/yaml/browser/dist/public-api.js
function stringify3(value, replacer, options) {
  let _replacer = null;
  if (typeof replacer === "function" || Array.isArray(replacer)) {
    _replacer = replacer;
  } else if (options === void 0 && replacer) {
    options = replacer;
  }
  if (typeof options === "string")
    options = options.length;
  if (typeof options === "number") {
    const indent = Math.round(options);
    options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
  }
  if (value === void 0) {
    const { keepUndefined } = options ?? replacer ?? {};
    if (!keepUndefined)
      return void 0;
  }
  if (isDocument(value) && !_replacer)
    return value.toString(options);
  return new Document(value, _replacer, options).toString(options);
}

// ../core/src/markdown.ts
function serializeNote(frontmatter, body) {
  const clean = {};
  for (const [k, v] of Object.entries(frontmatter)) if (v !== void 0) clean[k] = v;
  const yaml = stringify3(clean, { lineWidth: 0 }).trimEnd();
  return `---
${yaml}
---
${body.startsWith("\n") ? body.slice(1) : body}`;
}
function safeFileName(title) {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}
function slugify(title) {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function wikilink(title) {
  return `[[${title}]]`;
}
function h2Lines(lines) {
  const out = /* @__PURE__ */ new Set();
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    const m = /^(```+|~~~+|\$\$)/.exec(t);
    if (m) {
      if (!(m[1] === "$$" && t.length > 2 && t.endsWith("$$"))) fence = m[1];
      continue;
    }
    if (/^##\s/.test(lines[i])) out.add(i);
  }
  return out;
}
function findSection(lines, heading) {
  const heads = h2Lines(lines);
  const want = `## ${heading}`.toLowerCase();
  const start = [...heads].find((i) => lines[i].trim().toLowerCase() === want);
  if (start === void 0) return null;
  let end = start + 1;
  while (end < lines.length && !heads.has(end)) end++;
  return { start, end };
}
function setSection(body, heading, content, before = []) {
  const lines = body.split("\n");
  const block = [`## ${heading}`, "", content.trim(), ""];
  const s = findSection(lines, heading);
  if (s) {
    lines.splice(s.start, s.end - s.start, ...block);
    return lines.join("\n");
  }
  for (const b of before) {
    const at = findSection(lines, b);
    if (at) {
      lines.splice(at.start, 0, ...block);
      return lines.join("\n");
    }
  }
  return `${body.trimEnd()}

${block.join("\n")}`;
}
function demoteHeadings(md, by = 2) {
  const lines = md.split("\n");
  let fence = null;
  return lines.map((line) => {
    const t = line.trim();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
      return line;
    }
    const m = /^(```+|~~~+|\$\$)/.exec(t);
    if (m) {
      if (!(m[1] === "$$" && t.length > 2 && t.endsWith("$$"))) fence = m[1];
      return line;
    }
    const h = /^(#{1,6})(\s.*)$/.exec(line);
    return h ? `${"#".repeat(Math.min(6, h[1].length + by))}${h[2]}` : line;
  }).join("\n");
}

// ../core/src/exam.ts
var STOP = new Set(
  "a an the of to in on for and or vs via with from into over under using use used how what which that this these those your you we i problem question part pts points pt homework hw lecture chapter section week exam midterm final quiz practice sample compute find evaluate prove show define state name list identify solve apply calculate differentiate integrate simplify given let consider".split(
    " "
  )
);

// ../core/src/graph.ts
function isBuilt(status, floor, requiredLevel) {
  if (status !== "solid") return false;
  if (requiredLevel == null || requiredLevel <= 0) return true;
  return (floor ?? 0) >= requiredLevel;
}

// ../core/src/goal-plan.ts
function daysLeftPhrase(days) {
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  if (days === -1) return "1 day overdue";
  if (days < 0) return `${-days} days overdue`;
  return `${days} days`;
}

// ../../node_modules/@typesafe-ai/sdk/dist/index.mjs
var range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
var DEFAULT_RETRY_POLICY = {
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 5e3,
  backoffJitter: 0.25,
  /** HTTP 408, 429, and 5xx responses. */
  httpStatuses: /* @__PURE__ */ new Set([
    408,
    429,
    ...range(500, 600)
  ]),
  respectRetryAfter: true,
  /** Maximum server retry delay before falling back to backoff. */
  maxRetryAfterMs: 6e4,
  apiConnectionError: true,
  apiTimeoutError: true
};
DEFAULT_RETRY_POLICY.maxRetries;
var TypeSafeError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
};
var score = (instructions, criteria) => {
  if (!Array.isArray(criteria)) throw new TypeSafeError("Score criteria must be a list of descriptions indexed by score from zero, not a map.");
  return {
    type: "score",
    instructions,
    criteria
  };
};
var choice = (instructions, criteria) => {
  if (Array.isArray(criteria)) throw new TypeSafeError("Choice criteria must be a map of labels to descriptions, not a list.");
  return {
    type: "choice",
    instructions,
    criteria
  };
};
var g = globalThis;
var isBrowser = () => typeof g.window !== "undefined" && typeof g.window.document !== "undefined" && typeof g.navigator !== "undefined";
var describeRuntime = () => {
  const platform = g.process?.platform && g.process?.arch ? ` (${g.process.platform}; ${g.process.arch})` : "";
  if (g.Bun?.version) return `bun/${g.Bun.version}${platform}`;
  if (g.Deno?.version?.deno) return `deno/${g.Deno.version.deno}${platform}`;
  if (g.EdgeRuntime !== void 0) return "vercel-edge";
  if (g.navigator?.userAgent === "Cloudflare-Workers") return "cloudflare-workers";
  if (g.process?.versions?.node) return `node/${g.process.versions.node}${platform}`;
  if (isBrowser()) return "browser";
  return "unknown";
};
var RUNTIME = describeRuntime();

// ../core/src/jev.ts
var GRADE_CONFIDENCE = 0.6;
var PICK_CONFIDENCE = 0.45;
function decideGrade(score2, confidence) {
  if (!(confidence >= GRADE_CONFIDENCE)) return null;
  const level = Math.min(3, Math.max(0, Math.round(score2)));
  if (level >= 3) return { outcome: "correct", slip: false };
  if (level === 2) return { outcome: "correct", slip: true };
  if (level === 1) return { outcome: "partial", slip: false };
  return { outcome: "incorrect", slip: false };
}

// ../core/src/judgments.ts
var GRADE_LEVELS = [
  "The approach is wrong or missing.",
  "The key idea is right, but a conceptual piece is missing or wrong.",
  "The method is right. Only a careless non-conceptual error remains: arithmetic, a sign, copying, or a typo.",
  "The answer is right, including an equivalent form."
];
async function judgeUnderstanding(client, input) {
  if (!input.response.trim()) return null;
  try {
    const answers = await client.ask(
      {
        question: input.question.slice(0, 2e3),
        reference: (input.reference ?? "").slice(0, 2e3),
        rubric: (input.rubric ?? "").slice(0, 1e3),
        response: input.response.slice(0, 2e3)
      },
      {
        understanding: score(
          {
            question: "How well does `response` show the understanding `question` asks for?",
            focus: "Judge the idea, not formatting. An equivalent form is right. A careless arithmetic or copying error in otherwise right work is a slip, not a wrong idea.",
            compare: ["`response`", "`reference`", "`rubric`"]
          },
          GRADE_LEVELS
        )
      }
    );
    const answer = answers.understanding;
    if (answer?.score == null || answer.confidence == null) return null;
    return decideGrade(answer.score, answer.confidence);
  } catch {
    return null;
  }
}
async function pickLabel(client, question, state, options) {
  if (options.length < 2) return null;
  try {
    const criteria = {};
    options.forEach((option, i) => {
      criteria[`o${i}`] = option.detail ? `${option.label}. ${option.detail}` : option.label;
    });
    const answers = await client.ask(state, {
      pick: choice(
        {
          question,
          focus: "Choose one of the supplied options. Do not invent another concept."
        },
        criteria
      )
    });
    const chosen = answers.pick?.choice;
    const index = chosen ? Number(chosen.slice(1)) : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= options.length) return null;
    if ((answers.pick?.confidence ?? 0) < PICK_CONFIDENCE) return null;
    return options[index].id;
  } catch {
    return null;
  }
}

// ../core/src/model.ts
var MAX_FAMILIARITY = 3;
var sigmoid = (x) => 1 / (1 + Math.exp(-x));
var clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
function difficultyLocation(difficulty) {
  return clamp(Math.round(difficulty), 1, 5) - 3;
}
function predictCorrect(stats, difficulty) {
  const forgetting = stats.attempts === 0 ? 0 : 2.5 * (1 - stats.retention);
  return sigmoid(stats.ability - forgetting - difficultyLocation(difficulty));
}
function describeEdge(stats) {
  if (stats.attempts === 0) return "no evidence yet";
  const parts = [];
  if (stats.floor !== void 0) parts.push(`answers d${stats.floor} correctly`);
  if (stats.ceiling !== void 0) parts.push(`misses at d${stats.ceiling}`);
  if (stats.ceiling === void 0 && stats.floor !== void 0 && stats.floor < 5) parts.push("ceiling not found yet");
  if (stats.floor === void 0) parts.push("no correct answers yet");
  return parts.join(", ");
}

// ../core/src/store.ts
var PATHS = {
  concepts: "concepts",
  goals: "goals",
  exams: "exams",
  tests: "tests",
  sessions: "sessions",
  learner: "learner.md",
  data: ".groundwork",
  evidence: ".groundwork/evidence",
  chats: ".groundwork/chats",
  focus: ".groundwork/focus.json",
  /** Notes the learner writes in Settings. Not `learner.md`. */
  tutorContext: ".groundwork/tutor-context.md",
  /** Flashcard decks and review schedule. Markdown copies live in each write folder. */
  flashcards: ".groundwork/flashcards.json"
};
function conceptSummary(c) {
  return {
    title: c.title,
    status: c.stats.status,
    now: c.stats.attempts ? `${Math.round(c.stats.current * 100)}%` : "unassessed",
    edge: describeEdge(c.stats),
    lastPracticed: c.stats.lastEvidence?.slice(0, 10),
    nextReview: c.stats.nextReview?.slice(0, 10)
  };
}
function describeGoalProgress(goal) {
  const total = goal.targets.length + goal.built.length;
  if (!total) return "no targets";
  return `${goal.built.length}/${total} targets built`;
}
var DEFAULT_LEARNER_PROFILE = `# Learner profile

The tutor reads this at the start of every session and may append to it. Edit freely.

## Background

(What you already know well, your field, the kinds of math you're comfortable with.)

## How I learn best

- Build from unconditional truths; show me how I could have discovered each step.
- Teach me forward, one concept at a time toward the goal, with a quick check on each new step.
- Mention careless slips, but don't treat them as gaps.

## Observations

`;

// ../core/src/flashcards.ts
var RATINGS = ["again", "hard", "good", "easy"];
var DAY_MINUTES = 24 * 60;
var EASE_START = 2.5;
function emptyFlashcardLibrary(now = /* @__PURE__ */ new Date()) {
  return { updatedAt: now.toISOString(), addFromTeachingNotes: true, decks: [], cards: [] };
}
function flashcardContentKey(concept, front, back) {
  const text = `${concept.trim()}
${front.trim()}
${back.trim()}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h << 5) + h + text.charCodeAt(i) >>> 0;
  return `k${h.toString(36)}`;
}
function newId(prefix) {
  const bytes = new Uint8Array(8);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function makeCard(input) {
  const now = (input.now ?? /* @__PURE__ */ new Date()).toISOString();
  const concept = input.concept.trim();
  const front = input.front.trim();
  const back = input.back.trim();
  return {
    id: input.id || newId("fc_"),
    deckId: input.deckId,
    concept,
    front,
    back,
    source: input.source,
    createdAt: now,
    updatedAt: now,
    state: "new",
    due: now,
    intervalMinutes: 0,
    ease: EASE_START,
    reps: 0,
    lapses: 0,
    contentKey: flashcardContentKey(concept, front, back)
  };
}
function asRating(value) {
  return RATINGS.includes(value) ? value : void 0;
}
function asState(value) {
  return value === "learning" || value === "review" || value === "new" ? value : "new";
}
function parseFlashcardLibrary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Flashcards file is not an object.");
  const raw = value;
  const decksIn = Array.isArray(raw.decks) ? raw.decks : [];
  const cardsIn = Array.isArray(raw.cards) ? raw.cards : [];
  if (decksIn.length > 500 || cardsIn.length > 5e3) throw new Error("Too many flashcards.");
  const decks = [];
  for (const item of decksIn) {
    if (!item || typeof item !== "object") continue;
    const d = item;
    if (typeof d.id !== "string" || !d.id.trim() || typeof d.title !== "string" || !d.title.trim()) continue;
    decks.push({
      id: d.id.trim(),
      title: d.title.trim(),
      goalId: typeof d.goalId === "string" ? d.goalId : void 0,
      fileName: typeof d.fileName === "string" ? d.fileName : void 0
    });
  }
  const cards = [];
  for (const item of cardsIn) {
    if (!item || typeof item !== "object") continue;
    const c = item;
    if (typeof c.id !== "string" || !c.id.trim()) continue;
    if (typeof c.front !== "string" || typeof c.back !== "string" || typeof c.concept !== "string") continue;
    if (!c.front.trim() || !c.back.trim() || !c.concept.trim()) continue;
    if (c.front.length > 8e3 || c.back.length > 8e3) continue;
    const createdAt = typeof c.createdAt === "string" ? c.createdAt : (/* @__PURE__ */ new Date(0)).toISOString();
    cards.push({
      id: c.id.trim(),
      deckId: typeof c.deckId === "string" && c.deckId.trim() ? c.deckId.trim() : "library",
      concept: c.concept.trim(),
      front: c.front.trim(),
      back: c.back.trim(),
      source: typeof c.source === "string" ? c.source : void 0,
      createdAt,
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : createdAt,
      state: asState(c.state),
      due: typeof c.due === "string" ? c.due : createdAt,
      intervalMinutes: typeof c.intervalMinutes === "number" && c.intervalMinutes >= 0 ? c.intervalMinutes : 0,
      ease: typeof c.ease === "number" && c.ease > 0 ? c.ease : EASE_START,
      reps: typeof c.reps === "number" && c.reps >= 0 ? c.reps : 0,
      lapses: typeof c.lapses === "number" && c.lapses >= 0 ? c.lapses : 0,
      lastRating: asRating(c.lastRating),
      lastReviewed: typeof c.lastReviewed === "string" ? c.lastReviewed : void 0,
      fileName: typeof c.fileName === "string" ? c.fileName : void 0,
      contentKey: typeof c.contentKey === "string" ? c.contentKey : void 0
    });
  }
  return {
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    addFromTeachingNotes: raw.addFromTeachingNotes !== false,
    decks,
    cards
  };
}
function serializeFlashcardLibrary(lib) {
  return `${JSON.stringify(lib, null, 2)}
`;
}
async function loadFlashcardLibrary(io) {
  if (!await io.exists(PATHS.flashcards)) return emptyFlashcardLibrary();
  return parseFlashcardLibrary(JSON.parse(await io.read(PATHS.flashcards)));
}
function ensureDeck(lib, id, title, goalId) {
  let deck = lib.decks.find((d) => d.id === id);
  if (!deck) {
    deck = { id, title: title.trim() || "Deck", goalId };
    lib.decks.push(deck);
  } else if (title.trim()) {
    deck.title = title.trim();
    if (goalId) deck.goalId = goalId;
  }
  return deck;
}
function uniqueName(used, base, deck = false) {
  const stem = safeFileName(base) || (deck ? "Deck" : "Card");
  let name = `${stem}.md`;
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  if (deck) {
    name = `${stem} deck.md`;
    let n2 = 2;
    while (used.has(name)) {
      name = `${stem} deck ${n2}.md`;
      n2++;
    }
    used.add(name);
    return name;
  }
  let n = 2;
  while (used.has(name)) {
    name = `${stem} ${n}.md`;
    n++;
  }
  used.add(name);
  return name;
}
function assignFlashcardFiles(lib) {
  const used = /* @__PURE__ */ new Set();
  for (const card of lib.cards) {
    if (card.fileName && !used.has(card.fileName)) {
      used.add(card.fileName);
      continue;
    }
    card.fileName = uniqueName(used, card.concept || "Card");
  }
  for (const deck of lib.decks) {
    if (!lib.cards.some((c) => c.deckId === deck.id)) {
      deck.fileName = void 0;
      continue;
    }
    if (deck.fileName && !used.has(deck.fileName)) {
      used.add(deck.fileName);
      continue;
    }
    deck.fileName = uniqueName(used, deck.title || "Deck", true);
  }
}
function fingerprint(lib) {
  return JSON.stringify({
    addFromTeachingNotes: lib.addFromTeachingNotes,
    decks: lib.decks.map((d) => ({ id: d.id, title: d.title, goalId: d.goalId ?? null, fileName: d.fileName ?? null })),
    cards: lib.cards.map((c) => ({
      id: c.id,
      deckId: c.deckId,
      concept: c.concept,
      front: c.front,
      back: c.back,
      source: c.source ?? null,
      createdAt: c.createdAt,
      state: c.state,
      due: c.due,
      intervalMinutes: c.intervalMinutes,
      ease: c.ease,
      reps: c.reps,
      lapses: c.lapses,
      lastRating: c.lastRating ?? null,
      lastReviewed: c.lastReviewed ?? null,
      fileName: c.fileName ?? null,
      contentKey: c.contentKey ?? null
    }))
  });
}
async function persist(store, lib, now) {
  assignFlashcardFiles(lib);
  for (const card of lib.cards) card.contentKey = flashcardContentKey(card.concept, card.front, card.back);
  let prev = null;
  if (await store.io.exists(PATHS.flashcards)) {
    try {
      prev = await loadFlashcardLibrary(store.io);
    } catch {
      prev = null;
    }
  }
  if (!prev || fingerprint(prev) !== fingerprint(lib)) {
    lib.updatedAt = now.toISOString();
    await store.writeFile(PATHS.flashcards, serializeFlashcardLibrary(lib));
  }
}
function buildStudyQueue(cards, now, opts) {
  const dueAt = now.getTime();
  const due = cards.filter((c) => c.state === "new" || Date.parse(c.due) <= dueAt);
  const sort = (list) => [...list].sort((a, b) => {
    const ra = opts?.rank?.(a.concept) ?? 0;
    const rb = opts?.rank?.(b.concept) ?? 0;
    if (ra !== rb) return ra - rb;
    return a.due.localeCompare(b.due) || a.concept.localeCompare(b.concept) || a.id.localeCompare(b.id);
  });
  const fresh = sort(due.filter((c) => c.state === "new")).slice(0, opts?.limitNew ?? 20);
  return [...sort(due.filter((c) => c.state === "learning")), ...sort(due.filter((c) => c.state === "review")), ...fresh];
}
async function saveFlashcard(store, input, now = /* @__PURE__ */ new Date()) {
  const concept = input.concept.trim();
  const front = input.front.trim();
  const back = input.back.trim();
  if (!concept || !front || !back) throw new Error("A card needs a concept, a front, and a back.");
  const lib = await loadFlashcardLibrary(store.io);
  const wanted = input.deck?.trim() ?? "";
  const goals = await store.goals();
  const goal = wanted ? goals.find((g2) => g2.id === slugify(wanted) || g2.title.toLowerCase() === wanted.toLowerCase()) : void 0;
  const deckId = goal?.id ?? (wanted ? slugify(wanted) || "library" : "library");
  const deckTitle = goal?.title ?? (wanted || "Library");
  ensureDeck(lib, deckId, deckTitle, goal?.id);
  let card = lib.cards.find((c) => c.deckId === deckId && c.concept.toLowerCase() === concept.toLowerCase() && c.front === front);
  if (card) {
    card.back = back;
    card.updatedAt = now.toISOString();
    card.contentKey = flashcardContentKey(concept, front, back);
  } else {
    card = makeCard({ deckId, concept, front, back, now });
    lib.cards.push(card);
  }
  await persist(store, lib, now);
  return { card };
}

// ../core/src/tutor-markdown.ts
var LATEX_NAMED = /* @__PURE__ */ new Set([
  "sin",
  "cos",
  "tan",
  "log",
  "ln",
  "exp",
  "lim",
  "sup",
  "inf",
  "max",
  "min",
  "det",
  "dim",
  "ker",
  "arg",
  "deg",
  "gcd",
  "hom",
  "Pr"
]);
var FENCE_LINE = /^(```+|~~~+)/;
function normalizeTutorMarkdown(md) {
  if (!md) return md;
  const parts = splitFences(unescapeOverEscaped(md));
  return parts.map((p) => p.fence ? p.text : normalizeQuoted(p.text)).join("");
}
var QUOTE_PREFIX = /^((?:[ \t]*>[ \t]?)+)/;
function normalizeQuoted(text) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const depth = quoteDepth(lines[i]);
    let j = i + 1;
    while (j < lines.length && quoteDepth(lines[j]) === depth) j++;
    const run = lines.slice(i, j);
    if (!depth) {
      out.push(normalizeFlow(run.join("\n")));
    } else {
      const prefix = `${QUOTE_PREFIX.exec(run[0])[1].trimEnd()} `;
      const inner = run.map((l) => l.replace(QUOTE_PREFIX, "")).join("\n");
      out.push(
        normalizeQuoted(inner).split("\n").map((l) => l ? prefix + l : prefix.trimEnd()).join("\n")
      );
    }
    i = j;
  }
  return out.join("\n");
}
function quoteDepth(line) {
  const m = QUOTE_PREFIX.exec(line);
  return m ? (m[1].match(/>/g) ?? []).length : 0;
}
function normalizeFlow(text) {
  let s = text;
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner) => `
$$
${inner.trim()}
$$
`);
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner) => `$${inner.trim()}$`);
  s = s.replace(/==([\s\S]+?)==/g, (_, inner) => unwrapHighlight(inner));
  s = rewriteMathSpans(s, true, (inner) => {
    const t = inner.trim();
    return looksLikeProse(t) ? wrapLatexPhrases(t) : `$$
${t}
$$`;
  });
  s = rewriteMathSpans(s, false, (inner) => {
    const t = inner.trim();
    return looksLikeProse(t) ? wrapLatexPhrases(t) : `$${t}$`;
  });
  s = wrapLatexPhrases(s);
  return s;
}
var N_MACRO = /^(nabla|ne|neq|neg|ni|nu|not|notin|newline|newcommand|nolimits|normalsize|nleq|ngeq|nless|ngtr|nmid|nparallel|nexists|nsubseteq|nsupseteq|nsim|ncong|nearrow|nwarrow|nRightarrow|nLeftarrow|nrightarrow|nleftarrow)$/;
var OVER_ESCAPED_NEWLINE = /\\n(?=\\n|[A-Z0-9\s.,;:!?)]|$)/;
var DOUBLED_MACRO = /\\\\([a-zA-Z]{2,})/g;
function unescapeOverEscaped(s) {
  const doubled = [...s.matchAll(DOUBLED_MACRO)].some((m) => isTexMacroName(m[1]) || LATEX_NAMED.has(m[1]));
  if (!doubled && !OVER_ESCAPED_NEWLINE.test(s)) return s;
  let out = s.replace(
    /\\\\+([a-zA-Z]{2,})/g,
    (all, name) => isTexMacroName(name) || LATEX_NAMED.has(name) || name.startsWith("math") ? `\\${name}` : all
  );
  out = out.replace(/\\{1,2}n([a-zA-Z]*)/g, (all, rest) => {
    if (N_MACRO.test(`n${rest}`)) return all.startsWith("\\\\") ? `\\n${rest}` : all;
    return `
${rest}`;
  });
  out = out.replace(/\\"/g, '"');
  return out;
}
function unwrapHighlight(inner) {
  const t = inner.trim();
  const display = /^\$\$([\s\S]+)\$\$$/.exec(t);
  if (display) return `$$${display[1].trim()}$$`;
  const inline = /^\$([^$]+)\$$/.exec(t);
  if (inline) return `$${inline[1].trim()}$`;
  if (/\\[a-zA-Z]+/.test(t) && !looksLikeProse(t)) return `$${t}$`;
  return inner;
}
function rewriteMathSpans(s, display, rewrite) {
  const parts = splitFences(s);
  return parts.map((p) => {
    if (p.fence) return p.text;
    if (display) return p.text.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner) => rewrite(inner));
    return replaceInlineMath(p.text, rewrite);
  }).join("");
}
function replaceInlineMath(s, rewrite) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("$$", i)) {
      const end = s.indexOf("$$", i + 2);
      if (end < 0) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (s[i] === "$") {
      const end = s.indexOf("$", i + 1);
      if (end < 0) {
        out += s.slice(i);
        break;
      }
      out += rewrite(s.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    out += s[i++];
  }
  return out;
}
function looksLikeProse(s) {
  const bare = s.replace(/\\(begin|end)\{[^}]*\}/g, " ").replace(/\\(text|mathrm|operatorname)\{[^}]*\}/g, " ").replace(/\\[a-zA-Z]+/g, " ");
  const words = bare.match(/[A-Za-z]{3,}/g) ?? [];
  const english = words.filter((w) => !LATEX_NAMED.has(w) && !isTexMacroName(w));
  return english.length >= 3;
}
function isTexMacroName(w) {
  return /^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|nabla|infty|cdot|times|circ|oplus|otimes|wedge|vee|cap|cup|subset|supset|in|notin|to|mapsto|leq|geq|neq|approx|equiv|pm|mp|sum|prod|int|partial|emptyset|forall|exists|ell|hbar|mathbf|mathrm|mathsf|mathit|mathcal|mathbb|text|frac|dfrac|sqrt|overline|underline|hat|bar|vec|dot|ddot|tilde|left|right|big|Big|cdot|times|top|bot|mid|quad|qquad)$/i.test(
    w
  );
}
function wrapLatexPhrases(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("$$", i)) {
      const end = s.indexOf("$$", i + 2);
      if (end < 0) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (s[i] === "$") {
      const end = s.indexOf("$", i + 1);
      if (end < 0) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (s[i] === "\\") {
      const start = i;
      i = consumeLatex(s, i);
      const chunk = s.slice(start, i).trimEnd();
      out += chunk ? `$${chunk}$` : "";
      continue;
    }
    out += s[i++];
  }
  return out;
}
function consumeLatex(s, i) {
  const n = s.length;
  while (i < n) {
    if (s[i] === "\\") {
      i++;
      if (i < n && /[a-zA-Z]/.test(s[i])) {
        while (i < n && /[a-zA-Z]/.test(s[i])) i++;
        if (s[i] === "*") i++;
      } else if (i < n) {
        i++;
      }
      continue;
    }
    if (s[i] === "{" || s[i] === "(" || s[i] === "[") {
      const close = s[i] === "{" ? "}" : s[i] === "(" ? ")" : "]";
      const open = s[i];
      let depth = 1;
      i++;
      while (i < n && depth) {
        if (s[i] === "\\") {
          i += i + 1 < n ? 2 : 1;
          continue;
        }
        if (s[i] === open) depth++;
        else if (s[i] === close) depth--;
        i++;
      }
      continue;
    }
    if (s[i] === "^" || s[i] === "_") {
      i++;
      if (s[i] === "{") continue;
      if (i < n && s[i] !== " ") i++;
      continue;
    }
    if (s[i] === "'") {
      i++;
      continue;
    }
    if (/[0-9+\-=<>|/,.'.]/.test(s[i])) {
      i++;
      continue;
    }
    if (s[i] === " " || s[i] === "	") {
      let j = i + 1;
      while (j < n && (s[j] === " " || s[j] === "	")) j++;
      if (j < n && continuesMath(s, j)) {
        i = j;
        continue;
      }
      return i;
    }
    if (/[A-Za-z]/.test(s[i])) {
      let j = i;
      while (j < n && /[A-Za-z]/.test(s[j])) j++;
      const word = s.slice(i, j);
      if (word.length === 1 || LATEX_NAMED.has(word)) {
        i = j;
        continue;
      }
      return i;
    }
    return i;
  }
  return i;
}
function continuesMath(s, i) {
  const c = s[i];
  if (c === "\\" || c === "^" || c === "_" || c === "{" || c === "(" || c === "[" || c === "'" || /[0-9+\-=<>|/,.]/.test(c)) return true;
  if (/[A-Za-z]/.test(c)) {
    let j = i;
    while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
    const word = s.slice(i, j);
    return word.length === 1 || LATEX_NAMED.has(word);
  }
  return false;
}
function splitFences(md) {
  const out = [];
  const lines = md.split("\n");
  let fence = null;
  let start = 0;
  const emit = (end, isFence) => {
    if (end <= start) return;
    const text = lines.slice(start, end).join("\n");
    if (end < lines.length) out.push({ fence: isFence, text: text + "\n" });
    else out.push({ fence: isFence, text });
    start = end;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (fence) {
      if (t.startsWith(fence)) {
        emit(i + 1, true);
        fence = null;
      }
      continue;
    }
    const m = FENCE_LINE.exec(t);
    if (m) {
      emit(i, false);
      fence = m[1];
    }
  }
  emit(lines.length, !!fence);
  return out;
}

// ../core/src/quiz.ts
var FAMILIARITY_LABELS = [
  "I've never seen this",
  "Seen it before, can't place it",
  "Rings a bell, but I'm not sure",
  "Very familiar, I almost have it"
];
function clampFamiliarity(n) {
  const v = typeof n === "number" ? n : typeof n === "string" && n.trim() ? Number(n) : NaN;
  if (!Number.isFinite(v)) return void 0;
  return Math.min(MAX_FAMILIARITY, Math.max(0, Math.round(v)));
}
function familiarityLabel(n) {
  return FAMILIARITY_LABELS[clampFamiliarity(n) ?? 0];
}
function prepareQuiz(input, random = Math.random) {
  const format = input.format === "free" ? "free" : "choice";
  const base = {
    id: `q_${Date.now().toString(36)}${Math.floor(random() * 1e6).toString(36)}`,
    concept: input.concept,
    question: normalizeTutorMarkdown(String(input.question ?? "").trim()),
    details: input.details?.trim() ? normalizeTutorMarkdown(input.details.trim()) : void 0,
    purpose: input.purpose?.trim() ? normalizeTutorMarkdown(input.purpose.trim()) : void 0,
    explanation: normalizeTutorMarkdown(input.explanation?.trim() ?? ""),
    difficulty: Math.min(5, Math.max(1, Math.round(input.difficulty || 3))),
    kind: input.kind ?? "check"
  };
  if (!base.question) throw new Error("A quiz needs a question.");
  if (format === "free") {
    const reference = String(input.referenceAnswer ?? "").trim();
    if (!reference) throw new Error("A free-response question needs a referenceAnswer (the model answer).");
    return {
      ...base,
      format,
      options: [],
      correct: [],
      reference: normalizeTutorMarkdown(reference),
      rubric: input.rubric?.trim() ? normalizeTutorMarkdown(input.rubric.trim()) : void 0,
      multiSelect: false
    };
  }
  const seen = /* @__PURE__ */ new Set();
  const options = [];
  for (const o of input.options ?? []) {
    const label = String(o.label ?? "").trim();
    if (!label) continue;
    const value = String(o.value ?? label).trim();
    if (seen.has(value)) throw new Error(`Duplicate option value "${value}".`);
    seen.add(value);
    options.push({ label: normalizeTutorMarkdown(label), value, misconception: o.misconception?.trim() || void 0 });
  }
  if (options.length < 2) throw new Error('A multiple-choice quiz needs at least two options. For a typed answer use format "free" with a referenceAnswer.');
  if (options.some((o) => /^(i don'?t know|not sure|i'?m not sure)$/i.test(o.label))) {
    throw new Error(`Do not add an "I don't know" option; one is always shown automatically.`);
  }
  const correct = coerceAnswer(input.correctAnswer ?? "").map((v) => v.trim());
  if (!correct.length) throw new Error("correctAnswer is required.");
  for (const v of correct) {
    if (!seen.has(v)) {
      throw new Error(`correctAnswer "${v}" does not match any option value (${[...seen].map((s) => `"${s}"`).join(", ")}).`);
    }
  }
  const multiSelect = input.multiSelect ?? correct.length > 1;
  if (!multiSelect && correct.length > 1) throw new Error("Several correct answers require multiSelect: true.");
  if (input.shuffle !== false) {
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
  }
  return { ...base, format, options, correct: [...new Set(correct)], multiSelect };
}
function coerceAnswer(answer) {
  if (Array.isArray(answer)) return answer.map(String);
  const t = String(answer ?? "").trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
    }
  }
  return t ? [t] : [];
}
function needsJudgment(quiz, response) {
  return quiz.format === "free" && !response.dontKnow;
}
function gradeQuiz(quiz, response, judgment) {
  const label = (v) => quiz.options.find((o) => o.value === v)?.label ?? v;
  const correctLabels = quiz.format === "free" ? [quiz.reference ?? ""] : quiz.correct.map(label);
  if (response.dontKnow) {
    return { outcome: "dont_know", correct: false, selectedLabels: [], correctLabels };
  }
  if (quiz.format === "free") {
    if (!judgment) throw new Error("A free-response answer is graded by the tutor: pass a judgment.");
    const slip = judgment.slip === true;
    const outcome = slip ? "correct" : judgment.outcome === "correct" || judgment.outcome === "partial" ? judgment.outcome : "incorrect";
    return {
      outcome,
      correct: outcome === "correct",
      selectedLabels: response.text ? [response.text] : [],
      correctLabels,
      misconception: outcome !== "correct" ? judgment.misconception?.trim() || void 0 : void 0,
      feedback: judgment.feedback?.trim() ? normalizeTutorMarkdown(judgment.feedback.trim()) : void 0,
      ...slip ? { slip } : {}
    };
  }
  const sel = [...new Set(response.selected)];
  const ok = sel.length === quiz.correct.length && sel.every((v) => quiz.correct.includes(v));
  const wrongPicks = sel.filter((v) => !quiz.correct.includes(v));
  const misconception = wrongPicks.map((v) => quiz.options.find((o) => o.value === v)?.misconception).filter(Boolean).join("; ");
  return {
    outcome: ok ? "correct" : "incorrect",
    correct: ok,
    selectedLabels: sel.map(label),
    correctLabels,
    misconception: !ok && misconception ? misconception : void 0
  };
}
var letter = (i) => String.fromCharCode(65 + i);

// ../core/src/diagnose.ts
var ladders = /* @__PURE__ */ new Map();
var retaught = /* @__PURE__ */ new Map();
function seedLadder(sessionKey, rung) {
  const l = ladders.get(sessionKey) ?? { missed: [] };
  if (!l.missed.some((r) => sameRung(r, rung))) l.missed.push(rung);
  ladders.set(sessionKey, l);
}
var MAX_DESCENT_BEFORE_TEACHING = 3;
var rungName = (r) => `${r.concept} at d${r.difficulty}`;
var sameRung = (a, b) => a.concept === b.concept && a.difficulty === b.difficulty;
var quoteQ = (q) => `"${q.length > 140 ? `${q.slice(0, 137)}\u2026` : q}"`;
var isTeaching = (kind) => kind === "check" || kind === "review";
var WEAK = { unassessed: 0, learning: 1, rusty: 2, shaky: 3, solid: 4 };
var OFF_PATH = "Only chase a piece the goal actually needs. If it is off the path to the goal, name it in a line and keep going toward the goal.";
function nextMove(sessionKey, step, ctx) {
  if (step.kind === "test") return "";
  const ladder = ladders.get(sessionKey);
  if (step.outcome === "correct") return afterCorrect(sessionKey, step, ladder, ctx);
  if (isTeaching(step.kind) && !ladder?.missed.length) return afterTeachingMiss(sessionKey, step, ctx);
  return afterMiss(sessionKey, step, ladder, ctx);
}
function weakPrerequisites(prerequisites) {
  return [...prerequisites].sort((a, b) => WEAK[a.status] - WEAK[b.status]).filter((p) => p.status !== "solid");
}
function solidPrerequisites(prerequisites) {
  const solid = prerequisites.filter((p) => p.status === "solid").map((p) => p.title);
  return solid.length ? ` They already hold ${solid.join(", ")}: build on that.` : "";
}
function afterTeachingMiss(sessionKey, step, ctx) {
  const seen = retaught.get(sessionKey) ?? /* @__PURE__ */ new Set();
  retaught.set(sessionKey, seen);
  const lines = [];
  if (!seen.has(step.concept)) {
    seen.add(step.concept);
    lines.push(
      `Next move \u2014 keep teaching forward; do not start a string of easier quizzes. Say in a line what went wrong, then teach this step again from a different angle: the other representation of the same fact (a picture or a concrete case if you used symbols, symbols if you used a picture), and say it is the same fact. A new set of numbers in the same template is the same angle. Ground it in what they already know.${solidPrerequisites(ctx.prerequisites)} Then check it once with a fresh question at the same level, on a new case.`
    );
    if (step.outcome === "dont_know") {
      const f = step.familiarity ?? 0;
      lines.push(
        f >= 3 ? `They said "I don't know" but it felt very familiar (${familiarityLabel(f)}): give a short cue or the first move, then let them finish the faded step.` : `They said "I don't know" (${familiarityLabel(f)}): skip another attempt. Teach it directly, concrete case first, then the same fact in symbols, before asking again.`
      );
    } else if (step.outcome === "partial") {
      lines.push("Partly right: name the one piece that broke and fix it in the explanation. If the core idea of this node is there, move on instead of re-checking.");
    } else if (step.misconception) {
      lines.push(
        `Their answer points to a belief: "${step.misconception}". If that belief is a wrong claim inside the right idea, show one case where it gives the wrong answer. If it files the idea under the wrong kind (a process treated as a thing, a limit treated as plugging in), name the kind it is and the kind it is not.`
      );
    }
    lines.push("If it was really a slip (they plainly understand, only the arithmetic or a click went wrong), say so and continue with the plan instead.");
    return lines.join("\n");
  }
  const l = { missed: [step] };
  ladders.set(sessionKey, l);
  const weakest = weakPrerequisites(ctx.prerequisites);
  lines.push(
    `Next move \u2014 second miss on ${step.concept} after re-teaching, so a piece underneath is probably missing. Ask one quick question on the single piece this step most depends on${weakest.length ? ` (weakest prerequisite: ${weakest[0].title}, ${weakest[0].status})` : ""}, easier than this one. Right \u2192 teach from there back up to this step. Wrong \u2192 teach that piece directly. ${OFF_PATH}`
  );
  return lines.join("\n");
}
function afterMiss(sessionKey, step, ladder, ctx) {
  const l = ladder ?? { missed: [] };
  const top = l.missed[l.missed.length - 1];
  if (!top || !sameRung(top, step)) l.missed.push(step);
  ladders.set(sessionKey, l);
  const lines = [];
  if (l.floor) {
    lines.push(
      `Next move \u2014 this rung is where it breaks now. They hold ${rungName(l.floor)}; they miss ${rungName(step)}. Teach only the step between those two, building explicitly on what they just showed, in a smaller increment than before. Then check it with a fresh question at this level.`
    );
    return lines.join("\n");
  }
  const depth = l.missed.length;
  if (depth >= MAX_DESCENT_BEFORE_TEACHING) {
    lines.push(
      `Next move \u2014 ${depth} rungs down without a correct answer. Stop asking: teach the most basic piece directly (as an unconditional truth or a short derivation), confirm it reads as obviously true, then teach forward from it toward ${rungName(l.missed[0])}. ${OFF_PATH}`
    );
    return lines.join("\n");
  }
  lines.push(
    depth === 1 ? "Next move \u2014 this question sat above their frontier. Find where it starts with one or two smaller questions, not a long descent, then teach up from the first one they get right." : `Next move \u2014 still above their frontier (${depth} rungs down from ${rungName(l.missed[0])}). One more smaller question at most, then teach.`
  );
  const weakest = weakPrerequisites(ctx.prerequisites);
  const prereqText = weakest.length ? `Its prerequisites, weakest first: ${weakest.map((p) => `${p.title} (${p.status}${p.floor ? `, holds d${p.floor}` : ""})`).join(", ")}.` : ctx.prerequisites.length ? `Its recorded prerequisites (${ctx.prerequisites.map((p) => p.title).join(", ")}) are solid, so the gap is inside this concept: split the question into its sub-steps.` : "It has no recorded prerequisites yet: name the pieces this question needs (definitions, notation, the sub-steps), add them with upsert_concept, and ask about the most basic one.";
  if (step.outcome === "dont_know") {
    const f = step.familiarity ?? 0;
    lines.push(`They said "I don't know" \u2014 familiarity: ${familiarityLabel(f)} (${f}/3).`);
    if (f >= 3) {
      lines.push(
        `Tip of the tongue: the idea is probably there but not retrievable. Give a retrieval cue (a first step, a related fact, the notation), not the answer, and ask the same idea one level easier (d${Math.max(1, step.difficulty - 1)}). A correct answer then is the floor.`
      );
    } else if (f === 0 || step.difficulty <= 1) {
      lines.push(`Nothing to build on in this concept yet, so drop below it. ${prereqText}`);
    } else {
      lines.push(
        `Something is there. Ask about the one piece it most needs, easier: this concept at d${Math.max(1, step.difficulty - 2)}, or a prerequisite. ${prereqText}`
      );
    }
  } else if (step.outcome === "partial") {
    lines.push(`Partly right: part of the method is there. Ask a question on only the step that went wrong, one level easier (d${Math.max(1, step.difficulty - 1)}).`);
  } else {
    if (step.misconception) {
      lines.push(`Their answer points to a belief: "${step.misconception}". Dislodge it explicitly when you teach.`);
    }
    lines.push(`Step down: the same idea at d${Math.max(1, step.difficulty - 1)} or one piece of it. ${prereqText}`);
  }
  lines.push(OFF_PATH);
  return lines.join("\n");
}
function afterCorrect(sessionKey, step, ladder, ctx) {
  const recovered = retaught.get(sessionKey)?.delete(step.concept) ?? false;
  const slipNote = step.slip ? "It was a slip, not a gap: mention it in a line and move on. " : "";
  if (!ladder || !ladder.missed.length) {
    ladders.delete(sessionKey);
    if (recovered) return `Next move \u2014 ${slipNote}${step.concept} landed after re-teaching. Continue forward to the next step of the plan; do not re-check it.`;
    if (step.kind !== "probe") return slipNote ? `Next move \u2014 ${slipNote}Continue with the plan.` : "";
    if (ctx.ceiling !== void 0 && ctx.ceiling <= step.difficulty + 1 && ctx.ceiling > step.difficulty) {
      return `Next move \u2014 ${slipNote}edge bracketed on ${step.concept}: holds d${step.difficulty}, misses d${ctx.ceiling}. Teaching on this strand starts at d${ctx.ceiling}.`;
    }
    if (ctx.ceiling === void 0 && step.difficulty < 5) {
      return `Next move \u2014 ${slipNote}no ceiling found yet on ${step.concept}. Jump to d${Math.min(5, step.difficulty + 2)} rather than inching up, or stop probing this strand if you know enough to plan.`;
    }
    return slipNote ? `Next move \u2014 ${slipNote}` : "";
  }
  ladder.floor = step;
  const climbed = ladder.missed.filter((r) => r.concept === step.concept && r.difficulty <= step.difficulty);
  ladder.missed = ladder.missed.filter((r) => !climbed.includes(r));
  const next = ladder.missed[ladder.missed.length - 1];
  if (!next) {
    const origin2 = climbed[0] ?? step;
    ladders.delete(sessionKey);
    return `Next move \u2014 ${slipNote}gap closed: they now answer ${rungName(origin2)}, the level they originally missed. Continue the plan toward the goal.`;
  }
  const origin = ladder.missed[0];
  return [
    climbed.length ? `Next move \u2014 ${slipNote}rung climbed (${rungName(step)}).` : `Next move \u2014 ${slipNote}floor found: they hold ${rungName(step)}. Teach forward from here; no more descending.`,
    `Next rung up: ${rungName(next)} \u2014 ${quoteQ(next.question)}. Teach just the step from what they showed to that rung: one contrast, then the statement that names it, then a check on a new case at that level.`,
    ladder.missed.length > 1 ? `Rungs left to the original question (${rungName(origin)}): ${ladder.missed.length}.` : ""
  ].filter(Boolean).join("\n");
}

// ../core/src/grading.ts
var pct = (x) => `${Math.round(x * 100)}%`;
var VERDICT = {
  correct: "CORRECTLY",
  partial: "PARTLY CORRECTLY (partial credit)",
  incorrect: "INCORRECTLY"
};
function describeQuizOutcome(o) {
  const { grade, quiz, response, before, after } = o;
  const lines = [];
  if (grade.outcome === "dont_know") {
    const f = response.familiarity ?? 0;
    lines.push(`The learner chose "I don't know" \u2014 an honest gap, not a guess. Familiarity: ${familiarityLabel(f)} (${f}/3).`);
  } else if (grade.slip) {
    lines.push("The learner answered CORRECTLY, with a slip: the understanding is there, only a careless step went wrong. Point out the slip in one line and move on. Do not step back, re-check it, or treat it as a gap.");
    if (quiz.format === "free") lines.push(`They wrote:
${response.text ?? ""}`);
  } else {
    lines.push(`The learner answered ${VERDICT[grade.outcome]}.`);
    if (quiz.format === "free") lines.push(`They wrote:
${response.text ?? ""}`);
    else lines.push(`Selected: ${grade.selectedLabels.join(" | ")}`);
  }
  lines.push(quiz.format === "free" ? `Reference answer: ${quiz.reference ?? ""}` : `Correct: ${grade.correctLabels.join(" | ")}`);
  if (grade.feedback) lines.push(`Your feedback (shown to them): ${grade.feedback}`);
  if (grade.misconception) lines.push(`Diagnosed misconception: ${grade.misconception}`);
  if (response.note) lines.push(`Learner's note: ${response.note}`);
  lines.push(
    `Recorded in vault \u2192 ${o.conceptTitle}: ${before.attempts ? pct(before.current) : "unassessed"} \u2192 ${pct(after.current)} (status ${after.status}; ${describeEdge(after)}; d${quiz.difficulty} ${quiz.kind}).`
  );
  lines.push(`Predicted chance on next d${Math.min(5, quiz.difficulty + 1)}: ${pct(predictCorrect(after, quiz.difficulty + 1))}.`);
  if (o.judgmentNote) lines.push(o.judgmentNote);
  if (o.guidance) lines.push("", o.guidance);
  return lines.join("\n");
}
async function recordQuizAnswer(store, quiz, response, session, judgment) {
  let applied = judgment;
  let judgmentNote;
  const client = store.judgments();
  if (client && judgment && quiz.format === "free" && response.text?.trim()) {
    const graded = await judgeUnderstanding(client, {
      question: quiz.question,
      response: response.text,
      reference: quiz.reference,
      rubric: quiz.rubric
    });
    if (graded) {
      const tutorSlip = judgment.slip === true;
      const tutorOutcome = tutorSlip ? "correct" : judgment.outcome;
      if (graded.outcome !== tutorOutcome || graded.slip !== tutorSlip) {
        judgmentNote = `Jev graded the understanding as ${graded.slip ? "a slip" : graded.outcome}. That is what was recorded.`;
      }
      applied = { ...judgment, outcome: graded.outcome, slip: graded.slip };
    }
  }
  const grade = gradeQuiz(quiz, response, applied);
  const { concept, before, after } = await store.recordEvidence(quiz.concept, {
    outcome: grade.outcome,
    difficulty: quiz.difficulty,
    kind: quiz.kind,
    question: stripMd(quiz.question),
    chosen: quiz.format === "free" ? void 0 : grade.selectedLabels.join(" | ") || void 0,
    response: quiz.format === "free" && response.text ? response.text.slice(0, 2e3) : void 0,
    correctAnswer: grade.correctLabels.join(" | ").slice(0, 500),
    misconception: grade.misconception,
    slip: grade.slip,
    familiarity: grade.outcome === "dont_know" ? response.familiarity ?? 0 : void 0,
    note: response.note,
    session: session?.id
  });
  const index = await store.concepts();
  const prerequisites = concept.prerequisites.map((id) => index.get(id)).filter((c) => !!c).map((c) => ({ title: c.title, status: c.stats.status, floor: c.stats.floor }));
  let guidance = nextMove(
    session?.id ?? "default",
    {
      concept: concept.title,
      difficulty: quiz.difficulty,
      question: stripMd(quiz.question),
      outcome: grade.outcome,
      familiarity: response.familiarity,
      misconception: grade.misconception,
      slip: grade.slip,
      kind: quiz.kind
    },
    { prerequisites, floor: after.floor, ceiling: after.ceiling }
  );
  const weak = prerequisites.filter((p) => p.status !== "solid");
  if (client && guidance.includes("prerequisite") && weak.length >= 2 && grade.outcome !== "correct") {
    const piece = await pickLabel(
      client,
      "Which prerequisite is the piece this missed question actually depends on?",
      { concept: concept.title, question: stripMd(quiz.question), misconception: grade.misconception ?? "" },
      weak.map((p) => ({ id: p.title, label: p.title, detail: `${p.status}${p.floor ? `, holds d${p.floor}` : ""}` }))
    );
    if (piece) guidance = `${guidance}
The missing piece is ${piece}. Ask about that prerequisite, not the others.`;
  }
  return { quiz, response, grade, before, after, conceptTitle: concept.title, guidance: guidance || void 0, judgmentNote };
}
var awaiting = /* @__PURE__ */ new Map();
function awaitJudgment(quiz, response) {
  awaiting.set(quiz.id, { quiz, response });
  return [
    `The learner submitted a free-response answer. Grade it now: call grade_answer with quiz_id "${quiz.id}". Nothing is recorded until you do.`,
    "",
    `Question (${quiz.concept}, d${quiz.difficulty}): ${quiz.question}`,
    `They wrote:
${response.text ?? ""}`,
    response.note ? `Their note: ${response.note}` : void 0,
    `Reference answer: ${quiz.reference ?? ""}`,
    quiz.rubric ? `Rubric: ${quiz.rubric}` : void 0,
    "",
    FREE_RESPONSE_GRADING
  ].filter((l) => l !== void 0).join("\n");
}
var FREE_RESPONSE_GRADING = "Grading rules: judge the understanding, not the formatting or the arithmetic. An equivalent form (rearranged, unsimplified but correct, different notation) is correct. A slip is a non-conceptual error in otherwise right work: an arithmetic or sign mistake, a dropped term while copying, a typo. Set slip: true for it (it is recorded as correct) and never call a slip a misconception. partial = the key idea is right but a conceptual piece is missing or wrong; incorrect = the approach itself is wrong or missing. In feedback, address them directly: name what is right first, then the exact step that went wrong (for a slip, one short line). Use LaTeX for math. If a wrong belief shows, put it in misconception. If a <hint_transcript> is in the conversation, an answer that only repeats what the hint already stated is not full credit: mark partial or incorrect for the part they did not reach on their own.";
function takeAwaiting(quizId) {
  const hit = awaiting.get(quizId);
  awaiting.delete(quizId);
  return hit;
}
function stripMd(s) {
  return s.replace(/\s+/g, " ").trim().slice(0, 300);
}

// ../core/src/jev/grade.ts
function toGradeItem(quiz, response, hintTranscript) {
  return {
    question: quiz.question,
    reference: quiz.reference ?? "",
    rubric: quiz.rubric,
    answer: response.text ?? "",
    note: response.note,
    hintTranscript
  };
}
function asJudgment(value) {
  if (!value || typeof value !== "object") return null;
  const outcome = value.outcome;
  if (outcome !== "correct" && outcome !== "partial" && outcome !== "incorrect") return null;
  const raw = value;
  return {
    outcome,
    feedback: typeof raw.feedback === "string" ? raw.feedback : void 0,
    misconception: typeof raw.misconception === "string" ? raw.misconception : void 0,
    slip: raw.slip === true
  };
}
async function judgmentsFor(grader, items, signal) {
  if (!grader || !items.length) return items.map(() => null);
  try {
    const out = await grader.grade(items, signal);
    if (!Array.isArray(out) || out.length !== items.length) return items.map(() => null);
    return out.map(asJudgment);
  } catch {
    return items.map(() => null);
  }
}

// ../core/src/practice.ts
var MAX_TEST_QUESTIONS = 40;
function prepareTest(input, random = Math.random) {
  const title = String(input.title ?? "").trim() || "Practice test";
  const qs = input.questions ?? [];
  if (!qs.length) throw new Error("A practice test needs at least one question.");
  if (qs.length > MAX_TEST_QUESTIONS) throw new Error(`Keep a practice test to ${MAX_TEST_QUESTIONS} questions or fewer.`);
  const id = `t_${Date.now().toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
  const questions = qs.map((q, i) => {
    try {
      return { ...prepareQuiz({ ...q, kind: "test" }, random), id: `${id}_${i + 1}` };
    } catch (e) {
      throw new Error(`Question ${i + 1}: ${e.message}`);
    }
  });
  const minutes = Number(input.timeLimitMinutes);
  return {
    id,
    title,
    goal: input.goal?.trim() || void 0,
    examPlan: input.examPlan?.trim() || void 0,
    objective: input.objective?.trim() || void 0,
    instructions: input.instructions?.trim() || void 0,
    timeLimitMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : void 0,
    questions
  };
}
var inProgress = /* @__PURE__ */ new Map();
var BLANK = { dontKnow: true, selected: [], familiarity: 0, note: "Left blank" };
function answerFor(test, response, questionId) {
  const r = response.answers[questionId];
  if (!r) return BLANK;
  const q = test.questions.find((x) => x.id === questionId);
  const empty = !r.dontKnow && (q?.format === "free" ? !r.text?.trim() : !r.selected.length);
  return empty ? { ...BLANK, note: r.note ?? BLANK.note } : r;
}
async function startTestGrading(store, test, response, session) {
  const state = { test, response, session, grades: /* @__PURE__ */ new Map(), before: /* @__PURE__ */ new Map(), after: /* @__PURE__ */ new Map() };
  for (const q of test.questions) {
    const r = answerFor(test, response, q.id);
    if (needsJudgment(q, r)) continue;
    await recordOne(store, state, q, r);
  }
  inProgress.set(test.id, state);
  return state;
}
async function recordOne(store, state, q, r, judgment) {
  const o = await recordQuizAnswer(store, q, r, state.session, judgment);
  if (!state.before.has(o.conceptTitle)) state.before.set(o.conceptTitle, o.before);
  state.after.set(o.conceptTitle, o.after);
  state.grades.set(q.id, o.grade);
}
function ungraded(state) {
  return state.test.questions.filter((q) => !state.grades.has(q.id));
}
async function gradeOutstandingWritten(store, state, grader, signal) {
  const pending = ungraded(state);
  if (!grader || !pending.length) return;
  const items = pending.map((q) => toGradeItem(q, answerFor(state.test, state.response, q.id)));
  const judgments = await judgmentsFor(grader, items, signal);
  const ready = pending.flatMap((q, i) => {
    const judgment = judgments[i];
    return judgment ? [{ question: q.id, ...judgment }] : [];
  });
  if (ready.length) await applyTestJudgments(store, state, ready);
}
function testInProgress(testId) {
  return inProgress.get(testId);
}
async function applyTestJudgments(store, state, judgments) {
  const problems = [];
  for (const j of judgments) {
    const q = findQuestion(state.test, j.question);
    if (!q) {
      problems.push(`No question ${j.question} in this test.`);
      continue;
    }
    if (state.grades.has(q.id)) continue;
    await recordOne(store, state, q, answerFor(state.test, state.response, q.id), j);
  }
  return problems;
}
function findQuestion(test, ref) {
  const s = String(ref).trim();
  const byId = test.questions.find((q) => q.id === s);
  if (byId) return byId;
  const n = Number(s.replace(/^q/i, ""));
  return Number.isInteger(n) ? test.questions[n - 1] : void 0;
}
function describeTestForGrading(state) {
  const pending = ungraded(state);
  const lines = [
    `The learner submitted the practice test "${state.test.title}". Multiple-choice answers are graded and recorded. ${pending.length} free-response answer${pending.length === 1 ? "" : "s"} still need your judgment: call grade_practice_test with test_id "${state.test.id}" and one grade per question below. The evaluation is written once every answer is graded.`,
    ""
  ];
  for (const q of pending) {
    const n = state.test.questions.indexOf(q) + 1;
    const r = answerFor(state.test, state.response, q.id);
    lines.push(
      `### Question ${n} (${q.concept}, d${q.difficulty})`,
      q.question,
      `They wrote:
${r.text ?? ""}`,
      r.note ? `Their note: ${r.note}` : "",
      `Reference answer: ${q.reference ?? ""}`,
      q.rubric ? `Rubric: ${q.rubric}` : "",
      ""
    );
  }
  lines.push(FREE_RESPONSE_GRADING, "Do not show grades to the learner until the evaluation is back; they see it in the test card.");
  return lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}
var POINTS = { correct: 1, partial: 0.5, incorrect: 0, dont_know: 0 };
async function finishTest(store, state) {
  const { test, response } = state;
  const results = test.questions.map((q, i) => {
    const grade = state.grades.get(q.id);
    return {
      id: q.id,
      number: i + 1,
      concept: q.concept,
      difficulty: q.difficulty,
      format: q.format,
      outcome: grade.outcome,
      points: POINTS[grade.outcome],
      response: answerFor(test, response, q.id),
      grade
    };
  });
  const concepts = /* @__PURE__ */ new Map();
  for (const r of results) {
    const c = concepts.get(r.concept) ?? {
      concept: r.concept,
      earned: 0,
      possible: 0,
      percent: 0,
      questions: [],
      before: state.before.get(r.concept),
      status: state.after.get(r.concept)?.status ?? "unassessed",
      now: state.after.get(r.concept)?.current ?? 0
    };
    c.earned += r.points;
    c.possible += 1;
    c.questions.push(r.number);
    concepts.set(r.concept, c);
  }
  for (const c of concepts.values()) c.percent = c.possible ? c.earned / c.possible : 0;
  const byConcept = [...concepts.values()].sort((a, b) => a.percent - b.percent || a.now - b.now);
  const earned = results.reduce((s, r) => s + r.points, 0);
  const misconceptions = results.filter((r) => r.grade.misconception).map((r) => ({ concept: r.concept, misconception: r.grade.misconception }));
  const report = {
    testId: test.id,
    title: test.title,
    goal: test.goal,
    examPlan: test.examPlan,
    date: (/* @__PURE__ */ new Date()).toISOString(),
    elapsedSeconds: response.elapsedSeconds,
    earned,
    possible: results.length,
    percent: results.length ? earned / results.length : 0,
    results,
    byConcept,
    misconceptions
  };
  report.notePath = await writeTestNote(store, test, report);
  inProgress.delete(test.id);
  const firstMiss = results.filter((r) => r.outcome !== "correct").sort((a, b) => concepts.get(a.concept).percent - concepts.get(b.concept).percent || a.difficulty - b.difficulty)[0];
  if (firstMiss) {
    const q = test.questions[firstMiss.number - 1];
    seedLadder(state.session?.id ?? "default", {
      concept: q.concept,
      difficulty: q.difficulty,
      question: stripMd(q.question),
      outcome: firstMiss.outcome,
      familiarity: firstMiss.response.familiarity,
      misconception: firstMiss.grade.misconception
    });
  }
  return report;
}
var pct2 = (x) => `${Math.round(x * 100)}%`;
var fmtPoints = (x) => Number.isInteger(x) ? String(x) : x.toFixed(1);
function fmtTime(s) {
  if (s === void 0) return void 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}
function describeTestReport(report) {
  const lines = [
    `Practice test evaluated: "${report.title}" \u2014 ${fmtPoints(report.earned)}/${report.possible} (${pct2(report.percent)})${report.elapsedSeconds !== void 0 ? `, ${fmtTime(report.elapsedSeconds)} taken` : ""}. Saved to ${report.notePath}. The learner sees the full breakdown in the test card.`,
    "",
    "By concept, weakest first:",
    ...report.byConcept.map(
      (c) => `- ${c.concept}: ${fmtPoints(c.earned)}/${c.possible} on Q${c.questions.join(", Q")} \u2192 now ${pct2(c.now)} (${c.status})`
    ),
    "",
    "Per question:",
    ...report.results.map((r) => {
      const what = r.outcome === "dont_know" ? `I don't know (${familiarityLabel(r.response.familiarity)})` : r.outcome;
      return `- Q${r.number} ${r.concept} d${r.difficulty} ${r.format === "free" ? "free response" : "choice"}: ${what}${r.grade.misconception ? ` \u2014 belief: ${r.grade.misconception}` : ""}`;
    })
  ];
  if (report.misconceptions.length) lines.push("", `Misconceptions surfaced: ${report.misconceptions.map((m) => `${m.concept}: ${m.misconception}`).join("; ")}`);
  const weak = report.byConcept.filter((c) => c.percent < 1);
  lines.push(
    "",
    weak.length ? `Next move \u2014 debrief briefly (what held, where it broke, in two or three sentences, no re-listing of every question), then ask whether to work on the weakest area now. Remediate from ${weak[0].concept}, but do not re-teach from the top: ask one or two smaller questions to find the piece that missed question needed, then teach forward from the first one they get right. Skip slips and anything the exam does not need. The diagnosis ladder is seeded with that miss.` : "Next move \u2014 everything held. Say so briefly, then raise the bar: a harder test, or questions at a higher difficulty than the exam needs."
  );
  return lines.join("\n");
}
async function writeTestNote(store, test, report) {
  const date = report.date.slice(0, 10);
  let path = `${PATHS.tests}/${safeFileName(`${date} ${test.title}`)}.md`;
  for (let i = 2; await store.io.exists(path); i++) path = `${PATHS.tests}/${safeFileName(`${date} ${test.title}`)} ${i}.md`;
  const verdict = { correct: "\u2705", partial: "\u{1F7E1}", incorrect: "\u274C", dont_know: "\u2754" };
  const body = [
    `# ${test.title}`,
    "",
    ...test.objective ? [`**What this measured:** ${test.objective}`, ""] : [],
    `**Score:** ${fmtPoints(report.earned)}/${report.possible} (${pct2(report.percent)})${report.elapsedSeconds !== void 0 ? ` \xB7 **Time:** ${fmtTime(report.elapsedSeconds)}${test.timeLimitMinutes ? ` of ${test.timeLimitMinutes}:00` : ""}` : ""}`,
    "",
    "## By concept",
    "",
    "| Concept | Score | Questions | Now |",
    "| --- | --- | --- | --- |",
    ...report.byConcept.map((c) => `| [[${c.concept}]] | ${fmtPoints(c.earned)}/${c.possible} | ${c.questions.map((n) => `Q${n}`).join(", ")} | ${pct2(c.now)} (${c.status}) |`),
    ""
  ];
  if (report.misconceptions.length) {
    body.push("## Misconceptions surfaced", "", ...report.misconceptions.map((m) => `- [[${m.concept}]]: ${m.misconception}`), "");
  }
  body.push("## Questions", "");
  for (const r of report.results) {
    const q = test.questions[r.number - 1];
    body.push(`### Q${r.number} ${verdict[r.outcome]}${r.grade.slip ? " (slip)" : ""} \xB7 [[${q.concept}]] \xB7 level ${q.difficulty}`, "", demoteHeadings(q.question), "");
    if (q.format === "free") {
      body.push(
        r.outcome === "dont_know" ? `**Your answer:** I don't know (${familiarityLabel(r.response.familiarity)})` : `**Your answer:**

${r.response.text ?? ""}`,
        "",
        `**Model answer:**

${q.reference ?? ""}`,
        ""
      );
      if (r.grade.feedback) body.push(`**Feedback:** ${r.grade.feedback}`, "");
    } else {
      body.push(
        ...q.options.map((o, i) => {
          const mark = q.correct.includes(o.value) ? " \u2713" : r.response.selected.includes(o.value) ? " \u2717" : "";
          return `${letter(i)}. ${o.label}${mark}`;
        }),
        ""
      );
      if (r.outcome === "dont_know") body.push(`*I don't know \u2014 ${familiarityLabel(r.response.familiarity)}*`, "");
    }
    if (r.grade.misconception) body.push(`> [!warning] Likely belief
> ${r.grade.misconception}`, "");
    if (q.explanation) body.push(`> [!note]- Explanation
${q.explanation.split("\n").map((l) => `> ${l}`).join("\n")}`, "");
  }
  const fm = {
    title: test.title,
    type: "practice-test",
    date,
    score: `${fmtPoints(report.earned)}/${report.possible}`,
    percent: Math.round(report.percent * 100),
    goal: test.goal ? wikilink(test.goal) : void 0,
    exam: test.examPlan ? wikilink(test.examPlan) : void 0,
    concepts: report.byConcept.map((c) => wikilink(c.concept)),
    weakest: report.byConcept.filter((c) => c.percent < 1).slice(0, 3).map((c) => wikilink(c.concept)),
    tags: ["groundwork/test"]
  };
  await store.writeFile(path, serializeNote(fm, body.join("\n")));
  return path;
}

// ../core/src/tools.ts
function withMarginNotes(text, ui) {
  const notes = ui.marginNotes?.();
  return notes ? `${text}

${notes}` : text;
}
var str = (description) => ({ type: "string", description });
var strList = (description) => ({ type: "array", items: { type: "string" }, description });
var json = (v) => JSON.stringify(v, null, 2);
var pct3 = (x) => `${Math.round(x * 100)}%`;
var evidenceKinds = ["probe", "check", "review", "explain"];
var questionProperties = {
  concept: str("Title of the concept this question measures (create it with upsert_concept or set_goal first)."),
  question: str(
    "Exactly one question, fully self-contained: the learner sees only this card, not your files. State every given, and define every symbol and term the first time it appears (e.g. 'where $\\mu$ is the coefficient of friction'). Never write 'as in the lecture' or rely on notation from a document. Markdown and LaTeX allowed."
  ),
  details: str("Setup shown under the question: the scenario, the givens, and what each symbol means."),
  format: {
    type: "string",
    enum: ["choice", "free"],
    description: '"choice" (default): multiple choice, graded instantly. "free": the learner types an answer (markdown + LaTeX; math renders in the answer box) and YOU grade it against referenceAnswer with grade_answer. Use free when the skill is producing something: a computation, an expression, a derivation step, a definition in their words.'
  },
  options: {
    type: "array",
    minItems: 2,
    description: "Choice only: the real, gradable options (2+). Never include an 'I don't know' option \u2014 it is added automatically.",
    items: {
      type: "object",
      properties: {
        label: str("The option as shown. A bare claim with no justification. Markdown/LaTeX allowed."),
        value: str("Short stable id used in correctAnswer, e.g. 'a' or 'chain-rule'."),
        misconception: str("Distractors only: the specific wrong belief that would lead someone to pick this.")
      },
      required: ["label", "value"]
    }
  },
  correctAnswer: {
    description: "Choice only: option value (single-select) or array of values (multi-select, exact-set grading).",
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }]
  },
  referenceAnswer: str("Free only (required): the model answer, with LaTeX. Shown to the learner after grading."),
  rubric: str("Free only: what full credit requires and what earns partial credit."),
  explanation: str("Revealed after answering: why the correct answer is correct (and why tempting distractors are wrong)."),
  difficulty: {
    type: "integer",
    minimum: 1,
    maximum: 5,
    description: "1 recognize \xB7 2 recall/restate \xB7 3 apply (standard) \xB7 4 combine/multi-step \xB7 5 transfer/novel."
  },
  multiSelect: { type: "boolean", description: "Choice only: true when more than one option is correct." },
  shuffle: { type: "boolean", description: "Choice only. Default true. False only when option order carries meaning." }
};
var quizInputSchema = {
  type: "object",
  properties: {
    ...questionProperties,
    purpose: str(
      "Shown above the question, one plain sentence to the learner: what this checks and why it matters for where you are headed, e.g. 'Checking you can find a slope from two points \u2014 the derivative is built from exactly this.'"
    ),
    kind: { type: "string", enum: evidenceKinds.slice(0, 3), description: "probe = mapping the edge, check = confirming a node just taught, review = spaced retrieval." }
  },
  required: ["concept", "question", "purpose", "explanation", "difficulty", "kind"]
};
var practiceTestInputSchema = {
  type: "object",
  properties: {
    title: str("e.g. 'Midterm 1 practice \u2014 derivatives'."),
    goal: str("Goal this test measures, if any."),
    examPlan: str("Exam plan it mirrors, if any."),
    objective: str("Shown at the top, in plain terms: what skills this test measures and why that matters for their goal or exam."),
    instructions: str("Shown at the top: scope, rules (e.g. no calculator), how it maps to the real exam. Define any notation the whole test shares here."),
    timeLimitMinutes: { type: "integer", minimum: 1, description: "Optional. Shown as a countdown; the test is not cut off." },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_TEST_QUESTIONS,
      description: "In exam order. Mix choice and free response as the real exam would.",
      items: { type: "object", properties: questionProperties, required: ["concept", "question", "explanation", "difficulty"] }
    }
  },
  required: ["title", "objective", "questions"]
};
var judgmentProperties = {
  outcome: { type: "string", enum: ["correct", "partial", "incorrect"] },
  feedback: str("Shown to the learner: what is right, then the exact step that went wrong. LaTeX allowed."),
  misconception: str("If a wrong belief shows: that belief, stated specifically. Never for a slip."),
  slip: {
    type: "boolean",
    description: "True when the method and understanding are right and the only error is non-conceptual (arithmetic, a sign, copying a term, a typo). Recorded as correct, barely counted against them. Mention the slip in feedback and move on."
  }
};
function iconFor(outcome) {
  return outcome === "correct" ? "\u2713" : outcome === "partial" ? "\u25D0" : outcome === "dont_know" ? "?" : "\u2717";
}
function outcomeSummary(o) {
  return `${iconFor(o.grade.outcome)} ${o.conceptTitle}: ${o.before.attempts ? pct3(o.before.current) : "\u2014"} \u2192 ${pct3(o.after.current)}`;
}
var TOOLS = [
  {
    name: "get_learner_overview",
    description: 'Call FIRST in every learning session. Returns the learner profile, tutorContext (extra notes the learner wrote in Settings \u2014 read them, do not rewrite them or copy them into the learner profile), knowledge counts, active goals (each goal is the targets not yet built), workingGoal (the goal pinned in the dropdown, or null when they left it on "you choose"), due spaced reviews, recently practiced concepts, and open misconceptions. Use it to recall what they already hold about the topic they brought. A pin is not a reason to ignore a topic or file they just brought.',
    inputSchema: { type: "object", properties: {} },
    async run(_i, { store }) {
      const o = await store.overview();
      const { nextUp: _nextUp, ...forTutor } = o;
      return {
        text: json(forTutor),
        summary: `Loaded memory: ${o.conceptCount} concepts, ${o.activeGoals.length} active goals, ${o.dueReviews.length} due reviews`
      };
    }
  },
  {
    name: "suggest_what_to_study",
    description: "One concept to study when the learner asks what to study and did not name a topic, a goal, or bring a file. Do not call this to change the subject when they already said what they want to learn.",
    inputSchema: { type: "object", properties: {} },
    async run(_i, { store }) {
      const step = await store.studyNext();
      if (!step) return { text: "Nothing is waiting in the vault. Ask what they want to learn.", summary: "Nothing queued to study" };
      return { text: json(step), summary: `Suggested ${step.concept}` };
    }
  },
  {
    name: "search_knowledge",
    description: "Search the learner's vault for concepts and goals related to a topic. Use before probing so you build on recorded knowledge.",
    inputSchema: { type: "object", properties: { query: str("Keywords.") }, required: ["query"] },
    async run({ query }, { store }) {
      const hits = await store.search(query);
      return {
        text: hits.length ? json(hits.map((h) => h.concept ? { kind: h.kind, ...conceptSummary(h.concept) } : { kind: h.kind, title: h.title })) : `Nothing in the vault matches "${query}" yet.`,
        summary: `Searched memory for \u201C${query}\u201D \u2014 ${hits.length} hits`
      };
    }
  },
  {
    name: "get_concepts",
    description: "Full detail for concepts: calibrated status, current strength, bracketed edge (floor/ceiling difficulty), open misconceptions, prerequisites with their status, dependents, and the concept note.",
    inputSchema: { type: "object", properties: { concepts: strList("Concept titles.") }, required: ["concepts"] },
    async run({ concepts }, { store }) {
      const out = [];
      const index = await store.concepts();
      for (const ref of concepts) {
        const c = await store.resolve(ref);
        if (!c) {
          out.push({ title: ref, found: false });
          continue;
        }
        out.push({
          ...conceptSummary(c),
          found: true,
          domain: c.domain,
          attempts: c.stats.attempts,
          correct: c.stats.correct,
          openMisconceptions: c.stats.openMisconceptions,
          prerequisites: c.prerequisites.map((p) => {
            const pc = index.get(p);
            return pc ? { title: pc.title, status: pc.stats.status } : { title: p, status: "unknown" };
          }),
          dependents: (await store.dependents(c.id)).map((d) => d.title),
          note: c.body.slice(0, 4e3)
        });
      }
      return { text: json(out), summary: `Read ${concepts.length} concept note${concepts.length === 1 ? "" : "s"}` };
    }
  },
  {
    name: "upsert_concept",
    description: "Create or update a concept note in the vault. A concept is a reusable idea (Linear functions, Affine compositions), never a source document or a task tied to one (Lecture Note 1 fluency, Practice Exam 1, Prepare for the midterm). Those are goals: put the file in the goal's sources. Prerequisites are DIRECT dependencies (missing ones are created as stubs) and are merged with existing ones unless replacePrerequisites is true. Sections are markdown and replace the existing section. Do not mention a file path or a document title in the note.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Reusable idea, e.g. 'Linear functions'. Not a lecture, homework, exam, or fluency task."),
        domain: str("Subject area, e.g. 'linear algebra'."),
        aliases: strList("Other names."),
        prerequisites: strList("Titles of direct prerequisite concepts."),
        replacePrerequisites: { type: "boolean" },
        summary: str("What it is, in terms the learner has accepted."),
        unconditionalTruths: str("The caveat-free facts this rests on."),
        connections: str("How it follows from its prerequisites and what it unlocks."),
        misconceptions: str("Traps to watch for."),
        notes: str("Anything else worth keeping.")
      },
      required: ["title"]
    },
    async run(input, { store }) {
      const { concept, created, createdPrerequisites } = await store.upsertConcept(input);
      const extra = createdPrerequisites.length ? ` Created prerequisite stubs: ${createdPrerequisites.join(", ")}.` : "";
      return {
        text: `${created ? "Created" : "Updated"} [[${concept.title}]] (${concept.path}).${extra}`,
        summary: `${created ? "Created" : "Updated"} concept \u201C${concept.title}\u201D`
      };
    }
  },
  {
    name: "set_goal",
    description: "Save a learning goal. A goal is the list of targets: concepts the learner has not built yet. The title may name a course, exam, or document (Lecture 1 note fluency, Prepare for the midterm). targets and nodes must be abstract concepts that would still make sense in another class \u2014 never a file and never fluency on a file. Pass sources for the vault files this goal draws on. nodes is the construction graph: the targets plus the foundations they rest on, each with its direct prerequisites. Pass due as YYYY-MM-DD when the learner has a deadline; omit it and a new goal is due in 14 days. Pass weights when a syllabus says how much each concept counts (percents). Concepts the learner already holds are stored as built, not as open targets. Returns the open targets, what is already built, the frontier, and a mermaid map.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Short name. May name a course or a file, e.g. 'Lecture 1 note fluency' or 'Backpropagation'."),
        objective: str("Optional context in the learner's words. The goal is the targets, not this sentence."),
        why: str("What the learner wants this for."),
        approach: str("Your teaching plan in prose: order and why."),
        targets: strList(
          "Concepts this goal is made of. A target is a concept not yet built (not solid at its required level). Each must also appear in nodes. Name concepts they already hold too; those are recorded as built."
        ),
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: str("Concept title."),
              prerequisites: strList("Direct prerequisite titles."),
              summary: str("Optional one-line summary."),
              domain: str("Optional subject area."),
              requiredLevel: {
                type: "integer",
                minimum: 1,
                maximum: 5,
                description: "Exam depth this node must reach (same 1\u20135 scale as quizzes). Set when the goal is exam prep."
              }
            },
            required: ["title"]
          }
        },
        status: { type: "string", enum: ["active", "paused", "done"] },
        due: str("Deadline as YYYY-MM-DD, such as the exam day. Omit it and a new goal is due in 14 days."),
        weights: {
          type: "array",
          description: "How much of the goal each concept is worth, as percents that add up to about 100. Leave a concept out and it shares what remains.",
          items: {
            type: "object",
            properties: {
              title: str("Concept title, one of the nodes."),
              weight: { type: "number", exclusiveMinimum: 0, description: "Percent of the goal, e.g. 25." }
            },
            required: ["title", "weight"]
          }
        },
        examPlan: str("Title of the exam plan note this goal was built from, if any."),
        sources: strList("Vault paths of the source documents for this goal, e.g. resources/Lecture Note 1.pdf. Never put these on a concept.")
      },
      required: ["title", "targets", "nodes"]
    },
    async run(input, { store, ui }) {
      const r = await store.setGoal(input);
      ui?.focusGoal?.((await store.workingGoal())?.title ?? null);
      const titleOf = (id) => r.nodes.find((n) => n.id === id)?.title ?? id;
      return {
        text: json({
          goal: r.goal.title,
          note: r.goal.path,
          status: r.goal.status,
          ...await goalCalendarFields(store, r),
          progress: describeGoalProgress(r.goal),
          targets: r.goal.targets.map(titleOf),
          built: r.goal.built.map(titleOf),
          next: r.next ?? null,
          frontier: r.analysis.frontier.map((n) => n.title),
          blocked: r.analysis.blocked.map((n) => n.title),
          rusty: r.analysis.rusty.map((n) => n.title),
          unassessed: r.analysis.unassessed.map((n) => n.title),
          sources: r.goal.sources,
          mermaid: r.mermaid,
          judgments: r.judgmentNotes ?? []
        }),
        summary: `Saved goal \u201C${r.goal.title}\u201D \u2014 ${describeGoalProgress(r.goal)}`
      };
    }
  },
  {
    name: "get_goal",
    description: "Calibrated status of a goal the learner is already working: the targets not yet built, what is already built, per-node role and edge, the frontier, and a mermaid map. `next` is the step to take on this goal, not a reason to switch away from something else they asked to learn.",
    inputSchema: { type: "object", properties: { goal: str("Goal title.") }, required: ["goal"] },
    async run({ goal }, { store }) {
      const r = await store.goalReport(goal);
      const next = await store.chooseNext(r);
      const titleOf = (id) => r.nodes.find((n) => n.id === id)?.title ?? id;
      return {
        text: json({
          goal: r.goal.title,
          status: r.goal.status,
          objective: r.goal.objective,
          ...await goalCalendarFields(store, r),
          progress: describeGoalProgress(r.goal),
          targets: r.goal.targets.map(titleOf),
          built: r.goal.built.map(titleOf),
          next: next ?? r.next ?? null,
          order: r.analysis.order.map((n) => {
            const d = r.nodes.find((x) => x.id === n.id);
            const need = r.goal.requiredLevels[n.id];
            return {
              title: n.title,
              role: d.role,
              status: n.status,
              built: isBuilt(n.status, d.floor, need),
              now: n.status === "unassessed" ? null : pct3(n.current),
              edge: d.edge,
              requiredLevel: need,
              misconceptions: d.openMisconceptions
            };
          }),
          frontier: r.analysis.frontier.map((n) => n.title),
          blocked: r.analysis.blocked.map((n) => n.title),
          rusty: r.analysis.rusty.map((n) => n.title),
          unassessed: r.analysis.unassessed.map((n) => n.title),
          sources: r.goal.sources,
          mermaid: r.mermaid
        }),
        summary: `Checked goal \u201C${r.goal.title}\u201D \u2014 ${describeGoalProgress(r.goal)}`
      };
    }
  },
  {
    name: "set_goal_status",
    description: "Mark a goal active, paused, or done.",
    inputSchema: {
      type: "object",
      properties: { goal: str("Goal title."), status: { type: "string", enum: ["active", "paused", "done"] } },
      required: ["goal", "status"]
    },
    async run({ goal, status }, { store, ui }) {
      const g2 = await store.setGoalStatus(goal, status);
      const pinned = await store.workingGoal();
      if (!pinned || pinned.id === g2.id) ui?.focusGoal?.(pinned?.title ?? null);
      return { text: `Goal "${g2.title}" is now ${status}.`, summary: `Goal \u201C${g2.title}\u201D \u2192 ${status}` };
    }
  },
  {
    name: "set_working_goal",
    description: `Set the goal shown in the learner's dropdown. Pass the goal title, or "you choose" when they are not pinned to one. Call this when you create a goal, switch goals, or merge into one, so the dropdown matches the conversation.`,
    inputSchema: {
      type: "object",
      properties: { goal: str('Goal title, or "you choose".') },
      required: ["goal"]
    },
    async run({ goal }, { store, ui }) {
      const pinned = await store.setWorkingGoal(goal);
      ui?.focusGoal?.(pinned?.title ?? null);
      if (!pinned) return { text: 'The goal dropdown is now "you choose".', summary: "Goal dropdown \u2192 you choose" };
      const left = pinned.left === 1 ? "1 concept left" : `${pinned.left} concepts left`;
      return { text: `The goal dropdown is now "${pinned.title}" (${left}). Teach toward it.`, summary: `Goal dropdown \u2192 ${pinned.title}` };
    }
  },
  {
    name: "merge_goals",
    description: "Fold duplicate goals into one. The kept goal gains the others' concepts. The others are marked done and point at the kept goal. If the dropdown was on a goal you folded in, it moves to the kept goal.",
    inputSchema: {
      type: "object",
      properties: {
        keep: str("Goal title to keep."),
        merge: strList("Goal titles to fold into it. These are marked done.")
      },
      required: ["keep", "merge"]
    },
    async run({ keep, merge: merge2 }, { store, ui }) {
      const report = await store.mergeGoals(keep, merge2 ?? []);
      const pinned = await store.workingGoal();
      ui?.focusGoal?.(pinned?.title ?? null);
      const titleOf = (id) => report.nodes.find((n) => n.id === id)?.title ?? id;
      return {
        text: json({
          goal: report.goal.title,
          status: report.goal.status,
          progress: describeGoalProgress(report.goal),
          targets: report.goal.targets.map(titleOf),
          built: report.goal.built.map(titleOf),
          workingGoal: pinned?.title ?? null
        }),
        summary: `Merged into \u201C${report.goal.title}\u201D`
      };
    }
  },
  {
    name: "quiz",
    interactive: true,
    description: "Ask ONE graded question and wait for the learner's answer; it is recorded as calibrated evidence on the concept. Multiple choice (format choice) is graded instantly and shown with the explanation. Free response (format free) lets the learner type an answer with LaTeX. When the result says the answer was already graded, teach from it and do not call grade_answer. Otherwise grade it with grade_answer. Use for probing the edge (kind probe), confirming a node (check), and spaced review (review). 'I don't know' (with a familiarity slider from 'never seen this' to 'almost have it') and a note are always offered automatically. The result includes a 'Next move' from the diagnosis ladder: follow it.",
    inputSchema: quizInputSchema,
    async run(input, { store, ui, session, grader, signal }) {
      if (!ui) return { text: "quiz needs an interactive surface.", isError: true };
      const hit = await store.resolveForEvidence(input.concept, input.question);
      if (!hit) {
        return { text: `Unknown concept "${input.concept}". Create it with upsert_concept (or set_goal) first, then ask again.`, isError: true };
      }
      const concept = hit.concept;
      const quiz = prepareQuiz({ ...input, concept: concept.title });
      const response = await ui.quiz(quiz);
      if (!response) return { text: withMarginNotes("The learner dismissed the quiz without answering. Nothing was recorded.", ui), summary: "Quiz dismissed" };
      if (needsJudgment(quiz, response)) {
        const [judgment] = await judgmentsFor(grader, [toGradeItem(quiz, response)], signal);
        if (!judgment) return { text: withMarginNotes(awaitJudgment(quiz, response), ui), summary: `Answer submitted on ${concept.title} \u2014 grading` };
        const outcome2 = await recordQuizAnswer(store, quiz, response, session, judgment);
        ui.quizRecorded?.(outcome2);
        return {
          text: withMarginNotes(`${describeQuizOutcome(outcome2)}

Already graded. Teach from this result.`, ui),
          summary: outcomeSummary(outcome2),
          data: outcome2
        };
      }
      const outcome = await recordQuizAnswer(store, quiz, response, session);
      ui.quizRecorded?.(outcome);
      const matched = hit.matchedFrom ? `Matched \u201C${hit.matchedFrom}\u201D to [[${concept.title}]].
` : "";
      return { text: withMarginNotes(matched + describeQuizOutcome(outcome), ui), summary: outcomeSummary(outcome), data: outcome };
    }
  },
  {
    name: "grade_answer",
    description: "Grade a free-response answer the learner submitted to quiz (format free). Your grade, feedback, and the reference answer are shown on their card and recorded as evidence. Call right after the quiz result, before anything else.",
    inputSchema: {
      type: "object",
      properties: { quiz_id: str("The quiz_id from the quiz result."), ...judgmentProperties },
      required: ["quiz_id", "outcome", "feedback"]
    },
    async run(input, { store, ui, session }) {
      const pending = takeAwaiting(input.quiz_id);
      if (!pending) return { text: `No free-response answer is waiting with quiz_id ${input.quiz_id}. It may already be graded.`, isError: true };
      const outcome = await recordQuizAnswer(store, pending.quiz, pending.response, session, input);
      ui?.quizRecorded?.(outcome);
      const text = describeQuizOutcome(outcome);
      return { text: ui ? withMarginNotes(text, ui) : text, summary: outcomeSummary(outcome), data: outcome };
    }
  },
  {
    name: "practice_test",
    interactive: true,
    description: "Give the learner a full practice test (exam prep): many questions at once, multiple choice and free response mixed, with no feedback until they submit. Multiple choice is graded on submit. Written answers are graded with the result when Groundwork can; otherwise you grade them with grade_practice_test. Every answer is recorded as evidence, and an evaluation (score, per-concept breakdown, misconceptions) is saved to tests/ and shown to the learner. Build it from the exam plan or goal: cover every topic, at the required levels, in the real exam's proportions.",
    inputSchema: practiceTestInputSchema,
    async run(input, { store, ui, session, grader, signal }) {
      if (!ui?.test) return { text: "practice_test needs an interactive surface; quiz them one question at a time instead.", isError: true };
      const unknown = [];
      const questions = [];
      for (const q of input.questions ?? []) {
        const hit = await store.resolveForEvidence(q.concept, q.question);
        if (!hit) unknown.push(q.concept);
        else questions.push({ ...q, concept: hit.concept.title });
      }
      if (unknown.length) {
        return { text: `Unknown concepts: ${[...new Set(unknown)].join(", ")}. Create them with upsert_concept (or set_goal) first, then give the test.`, isError: true };
      }
      const test = prepareTest({ ...input, questions });
      const response = await ui.test(test);
      if (!response) return { text: withMarginNotes("The learner closed the practice test without submitting. Nothing was recorded.", ui), summary: "Practice test dismissed" };
      const state = await startTestGrading(store, test, response, session);
      await gradeOutstandingWritten(store, state, grader, signal);
      if (ungraded(state).length) {
        return { text: withMarginNotes(describeTestForGrading(state), ui), summary: `Practice test submitted \u2014 grading ${ungraded(state).length} written answer${ungraded(state).length === 1 ? "" : "s"}` };
      }
      const report = await finishTest(store, state);
      ui.testGraded?.(report);
      return { text: withMarginNotes(describeTestReport(report), ui), summary: `Practice test: ${pct3(report.percent)}`, data: report };
    }
  },
  {
    name: "grade_practice_test",
    description: "Grade the free-response answers of a submitted practice test. Pass one grade per question listed in the practice_test result. When all are graded, the evaluation is saved and shown to the learner.",
    inputSchema: {
      type: "object",
      properties: {
        test_id: str("The test_id from the practice_test result."),
        grades: {
          type: "array",
          items: {
            type: "object",
            properties: { question: { type: "integer", description: "Question number (1-based)." }, ...judgmentProperties },
            required: ["question", "outcome", "feedback"]
          }
        }
      },
      required: ["test_id", "grades"]
    },
    async run(input, { store, ui }) {
      const state = testInProgress(input.test_id);
      if (!state) return { text: `No practice test awaiting grades with test_id ${input.test_id}. It may already be evaluated.`, isError: true };
      const problems = await applyTestJudgments(store, state, input.grades ?? []);
      const left = ungraded(state);
      if (left.length) {
        const nums = left.map((q) => state.test.questions.indexOf(q) + 1);
        return {
          text: [...problems, `Still ungraded: question${nums.length === 1 ? "" : "s"} ${nums.join(", ")}. Call grade_practice_test again for ${nums.length === 1 ? "it" : "them"}.`].join("\n"),
          summary: `Graded \u2014 ${left.length} left`
        };
      }
      const report = await finishTest(store, state);
      ui?.testGraded?.(report);
      const text = [...problems, describeTestReport(report)].join("\n");
      return { text: ui ? withMarginNotes(text, ui) : text, summary: `Practice test: ${pct3(report.percent)}`, data: report };
    }
  },
  {
    name: "ask_user",
    interactive: true,
    description: "Ask the learner a question with NO right answer (their goal, preference, direction, energy). Offer options when useful; free text is allowed by default. For anything gradable use quiz instead.",
    inputSchema: {
      type: "object",
      properties: {
        question: str("The question."),
        details: str("Optional context."),
        options: strList("Suggested answers."),
        multiSelect: { type: "boolean" },
        allowFreeText: { type: "boolean", description: "Default true." }
      },
      required: ["question"]
    },
    async run(input, { ui }) {
      if (!ui) return { text: "ask_user needs an interactive surface; ask in chat instead.", isError: true };
      const r = await ui.ask(input);
      if (!r) return { text: withMarginNotes("The learner dismissed the question.", ui), summary: "Question dismissed" };
      const parts = [];
      if (r.selected.length) parts.push(`Selected: ${r.selected.join(" | ")}`);
      if (r.text) parts.push(`Wrote: ${r.text}`);
      return { text: withMarginNotes(parts.join("\n") || "(no answer)", ui), summary: "Learner answered" };
    }
  },
  {
    name: "record_evidence",
    description: "Record a graded observation you judged yourself from conversation, e.g. an explanation they typed in chat. Prefer quiz (choice or free response) for anything you ask on purpose: it records automatically and feeds the diagnosis ladder.",
    inputSchema: {
      type: "object",
      properties: {
        concept: str("Concept title."),
        outcome: { type: "string", enum: ["correct", "partial", "incorrect", "dont_know"] },
        difficulty: { type: "integer", minimum: 1, maximum: 5 },
        kind: { type: "string", enum: evidenceKinds },
        what: str("What was asked / what they did."),
        misconception: str("If incorrect: the specific wrong belief revealed."),
        slip: { type: "boolean", description: "Right understanding, careless error only. Recorded as correct with a slip." }
      },
      required: ["concept", "outcome", "difficulty", "what"]
    },
    async run(input, { store, session }) {
      const slip = input.slip === true;
      const hit = await store.resolveForEvidence(input.concept, input.what);
      if (!hit) return { text: `Unknown concept "${input.concept}". Create it with upsert_concept or set_goal first.`, isError: true };
      const { concept, before, after } = await store.recordEvidence(hit.concept.title, {
        outcome: slip ? "correct" : input.outcome,
        difficulty: input.difficulty,
        kind: input.kind ?? "explain",
        question: input.what,
        misconception: slip ? void 0 : input.misconception,
        ...slip ? { slip } : {},
        session: session?.id
      });
      return {
        text: `Recorded. ${concept.title}: ${before.attempts ? pct3(before.current) : "unassessed"} \u2192 ${pct3(after.current)} (${after.status}; ${describeEdge(after)}).`,
        summary: `Recorded ${input.outcome.replace("_", " ")} on \u201C${concept.title}\u201D`
      };
    }
  },
  {
    name: "ingest_exam_materials",
    description: "Parse course files (lecture slides, homeworks, study guides, practice exams) into the topics and the level each must be learned to, save an exam plan, and create a teaching goal. Call this as soon as the learner attaches or mentions those files \u2014 do not wait to 'just start teaching'. Pass vault paths and/or the text you extracted. Returns the blueprint, required levels (1\u20135), and the goal map.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Goal / exam-plan title, e.g. 'Prepare for the calc midterm'."),
        why: str("Why they are studying, in their words."),
        userText: str("The learner's message, used to guess exam kind (midterm/final/quiz)."),
        files: strList("Vault paths of attached or existing files (e.g. resources/HW2.md)."),
        materials: {
          type: "array",
          description: "Text you pulled from a file the automatic parser couldn't read (compressed PDF, image, etc.).",
          items: {
            type: "object",
            properties: {
              name: str("File name."),
              text: str("Extracted text or a close paraphrase of every problem/topic."),
              kind: { type: "string", enum: ["lecture", "homework", "study_guide", "practice_exam", "exam", "notes", "unknown"] },
              path: str("Vault path if you have one.")
            },
            required: ["name", "text"]
          }
        },
        createGoal: { type: "boolean", description: "Default true. Set false to only write the exam plan." }
      }
    },
    async run(input, ctx) {
      const { store, ui } = ctx;
      if (!(input.files?.length || input.materials?.length)) {
        return { text: "Pass files (vault paths) and/or materials (extracted text).", isError: true };
      }
      const reads = accessFromContext(ctx).readFolders;
      const files = [];
      for (const file of input.files ?? []) {
        if (!reads.length) return { text: "No folders are open for reading. The learner picks them in Settings \u2192 Groundwork.", isError: true };
        const found = await resolveVaultFile(store.context, file, reads);
        if (!found) {
          return {
            text: `"${file}" isn't in a folder Groundwork can read (${reads.map((dir) => `${dir}/`).join(", ")}).`,
            isError: true,
            summary: "File is outside the read folders"
          };
        }
        files.push(found);
      }
      const r = await store.ingestExamMaterials({ ...input, files });
      ui?.focusGoal?.((await store.workingGoal())?.title ?? null);
      return {
        text: json({
          title: r.blueprint.title,
          examKind: r.blueprint.examKind,
          plan: r.planPath,
          goal: r.goal ? {
            title: r.goal.goal.title,
            progress: describeGoalProgress(r.goal.goal),
            targets: r.goal.goal.targets.map((id) => r.goal.nodes.find((n) => n.id === id)?.title ?? id),
            built: r.goal.goal.built.map((id) => r.goal.nodes.find((n) => n.id === id)?.title ?? id),
            frontier: r.goal.analysis.frontier.map((n) => n.title),
            sources: r.goal.goal.sources,
            mermaid: r.goal.mermaid
          } : null,
          mustKnow: r.blueprint.mustKnow,
          topics: r.blueprint.topics.map((t) => ({
            title: t.title,
            requiredLevel: t.requiredLevel,
            sources: t.sources,
            ideas: t.ideas
          })),
          materials: r.blueprint.materials,
          notes: r.blueprint.notes,
          judgments: r.goal?.judgmentNotes ?? []
        }),
        summary: r.blueprint.topics.length ? `Exam plan: ${r.blueprint.topics.length} topic${r.blueprint.topics.length === 1 ? "" : "s"} from ${r.blueprint.materials.length} file${r.blueprint.materials.length === 1 ? "" : "s"}` : "Couldn't extract topics yet \u2014 read the files and try again"
      };
    }
  },
  {
    name: "get_exam_plan",
    description: "Load a saved exam plan (topics, required levels, source files). Use after ingest_exam_materials or when continuing exam prep.",
    inputSchema: { type: "object", properties: { exam: str("Exam plan title.") }, required: ["exam"] },
    async run({ exam }, { store }) {
      const path = await store.resolveExamPlan(exam);
      if (!path) return { text: `No exam plan named "${exam}". Call ingest_exam_materials first.`, isError: true };
      return { text: await store.io.read(path), summary: `Opened exam plan \u201C${exam}\u201D` };
    }
  },
  {
    name: "list_vault_files",
    description: "List files inside the folders the learner allowed (named in your instructions). Omit folder to list every allowed folder. Pass a folder only when it is one of those, or a subfolder of one. The rest of the vault stays closed.",
    inputSchema: { type: "object", properties: { folder: str("A read folder, or a subfolder of one. Omit it to list every folder the learner allowed.") } },
    async run({ folder }, ctx) {
      const { store } = ctx;
      const reads = accessFromContext(ctx).readFolders;
      if (!reads.length) {
        return { text: "No folders are open for reading. The learner picks them in Settings \u2192 Groundwork.", isError: true, summary: "No read folders" };
      }
      const requested = folder?.trim() ?? "";
      let files;
      let where;
      if (!requested) {
        files = [];
        for (const dir of reads) {
          for (const file of await listVaultFiles(store.context, dir)) {
            if (pathInsideAny(file, reads) && !files.includes(file)) files.push(file);
          }
        }
        where = reads.map((dir) => `${dir}/`).join(", ");
      } else if (!pathInsideAny(requested, reads)) {
        return {
          text: `Groundwork can only list ${reads.map((dir) => `${dir}/`).join(", ")}. "${requested}" is outside those folders.`,
          isError: true,
          summary: "Folder isn't readable"
        };
      } else {
        const dir = requested.replace(/^\/+|\/+$/g, "");
        files = (await listVaultFiles(store.context, dir)).filter((file) => pathInsideAny(file, reads));
        where = `${dir}/`;
      }
      if (!files.length) {
        return { text: `No files in ${where} yet. The learner can attach files in the chat or put them in a read folder.`, summary: `No files in ${where}` };
      }
      return {
        text: files.map((f) => `- ${f} (${fileKind(f).kind})`).join("\n"),
        summary: `Listed ${files.length} file${files.length === 1 ? "" : "s"} in ${where}`
      };
    }
  },
  {
    name: "read_vault_file",
    description: "Open a PDF, image, text, or markdown file inside a folder the learner allowed. Pass a vault path or a file name. Files outside those folders are not opened.",
    inputSchema: { type: "object", properties: { path: str('e.g. "resources/Lecture 3.pdf" or "Lecture 3.pdf".') }, required: ["path"] },
    async run({ path }, ctx) {
      const reads = accessFromContext(ctx).readFolders;
      if (!reads.length) return { text: "No folders are open for reading. The learner picks them in Settings \u2192 Groundwork.", isError: true };
      const found = await resolveVaultFile(ctx.store.context, path, reads);
      if (!found) {
        return {
          text: `No file matching "${path}" in ${reads.map((dir) => `${dir}/`).join(", ")}. list_vault_files shows what is there. Files outside those folders stay closed.`,
          isError: true
        };
      }
      const file = await loadVaultFile(ctx.store.context, found);
      return { text: `Contents of ${found}:`, files: [file], summary: `Opened ${basename(found)}` };
    }
  },
  {
    name: "write_submission_file",
    description: "Write a text or markdown file the learner can hand in: a solution, a writeup, or answers to a problem set. The path has to be inside a write folder from your instructions. A bare file name is saved in the first write folder. This does not edit concept notes, goals, session notes, or their reference files.",
    inputSchema: {
      type: "object",
      properties: {
        path: str('File name or vault path inside a write folder, e.g. "homework-1.md" or "submissions/homework-1.md".'),
        content: str("The full file, markdown or plain text, ready to hand in.")
      },
      required: ["path", "content"]
    },
    async run({ path, content }, ctx) {
      const writes = accessFromContext(ctx).writeFolders;
      const target = resolveSubmissionPath(path, writes);
      if ("error" in target) return { text: target.error, isError: true, summary: "Couldn't write the file" };
      const body = content ?? "";
      if (!body.trim()) return { text: "The file is empty. Pass the text they should hand in.", isError: true };
      if (body.length > 2e5) return { text: "That file is over 200,000 characters. Shorten it and try again.", isError: true };
      const vault = ctx.store.context;
      const existed = await vault.exists(target.path);
      const dir = target.path.includes("/") ? target.path.slice(0, target.path.lastIndexOf("/")) : "";
      if (dir) await ensureDir(vault, dir);
      await vault.write(target.path, body.endsWith("\n") ? body : `${body}
`);
      const verb = existed ? "Replaced" : "Wrote";
      return { text: `${verb} ${target.path}. The learner can open it in the vault and hand it in.`, summary: `${verb} ${target.path}` };
    }
  },
  {
    name: "save_flashcard",
    description: "Save one flashcard on the learner's account. It is not copied into the vault unless they ask to write the cards down. One idea per card: front is the question, back is a short answer in their terms. Pass deck as a goal title when the card belongs to that goal.",
    inputSchema: {
      type: "object",
      properties: {
        concept: str("Concept this card checks. The title of a concept you have already saved."),
        front: str("The question on the front of the card. One checkable idea. Markdown and LaTeX allowed."),
        back: str("The answer on the back, in the learner's terms. Short."),
        deck: str("Goal title this card belongs to. Omit for the Library deck.")
      },
      required: ["concept", "front", "back"]
    },
    async run({ concept, front, back, deck }, ctx) {
      try {
        const saved = await saveFlashcard(ctx.store, { concept, front, back, deck });
        return {
          text: `Saved a flashcard on ${saved.card.concept}. It stays on the account until the learner asks to write cards into the vault.`,
          summary: `Saved a flashcard on ${saved.card.concept}`
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: message, isError: true, summary: "Couldn't save the flashcard" };
      }
    }
  },
  {
    name: "list_due_flashcards",
    description: "Flashcards that are due now: new cards, cards in learning, and reviews whose interval has elapsed. Use this before offering a flashcard session.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } },
    async run({ limit }, { store }) {
      const lib = await loadFlashcardLibrary(store.io);
      const due = buildStudyQueue(lib.cards, /* @__PURE__ */ new Date());
      const shown = due.slice(0, limit ?? 20);
      if (!shown.length) return { text: "No flashcards are due.", summary: "No flashcards due" };
      const lines = shown.map((c) => `- ${c.concept} [${c.state}] ${c.front.split("\n")[0]}`);
      const more = due.length > shown.length ? `
${due.length - shown.length} more due.` : "";
      return { text: `${lines.join("\n")}${more}`, summary: `${due.length} flashcard${due.length === 1 ? "" : "s"} due` };
    }
  },
  {
    name: "get_due_reviews",
    description: "Concepts whose memory has decayed enough that a spaced review is due, oldest first.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } },
    async run({ limit }, { store }) {
      const due = await store.dueReviews(limit ?? 10);
      return {
        text: due.length ? json(due.map(conceptSummary)) : "No reviews are due.",
        summary: `${due.length} review${due.length === 1 ? "" : "s"} due`
      };
    }
  },
  {
    name: "update_learner_profile",
    description: "Write durable observations about the learner to learner.md: background, how they learn best, patterns seen across several sessions. Not a list of weak topics (per-concept mastery already lives in the evidence), and never a conclusion from one or two misses or from slips. When later evidence contradicts an observation, rewrite the section with mode replace.",
    inputSchema: {
      type: "object",
      properties: {
        section: str("Section heading, e.g. 'Background', 'How I learn best', 'Observations'."),
        content: str("Markdown. With mode replace, the whole new section."),
        mode: { type: "string", enum: ["append", "replace"] }
      },
      required: ["section", "content"]
    },
    async run({ section, content, mode }, { store }) {
      await store.updateProfile(section, content, mode ?? "append");
      return { text: `Updated learner profile section "${section}".`, summary: `Updated learner profile (${section})` };
    }
  },
  {
    name: "save_session_summary",
    description: "Save a session summary: what was covered, where the edges now sit, and what to do next. Call at the end of a session or at natural breaks.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Short session title."),
        summary: str("Markdown summary."),
        concepts: strList("Concept titles touched."),
        next: str("What to do next time.")
      },
      required: ["summary"]
    },
    async run(input, { store, session }) {
      const links = (input.concepts ?? []).map((c) => `[[${c}]]`).join(", ");
      const block = [
        demoteHeadings(input.summary.trim()),
        links ? `
**Concepts:** ${links}` : "",
        input.next ? `
**Next time:** ${input.next.trim()}` : ""
      ].join("\n");
      let path = session?.notePath;
      if (!path) {
        path = await store.sessionNotePath(input.title ?? "Session");
        if (session) session.notePath = path;
      }
      const existing = await store.io.exists(path) ? await store.io.read(path) : `# ${input.title ?? "Session"}
`;
      await store.writeFile(path, setSection(existing, "Summary", block, ["Transcript"]));
      return { text: `Saved summary to ${path}.`, summary: "Saved session summary" };
    }
  }
];
async function goalCalendarFields(store, report) {
  const timing = await store.goalTiming(report);
  const titleOf = (id) => report.nodes.find((node) => node.id === id)?.title ?? id;
  return {
    due: report.goal.due ?? null,
    daysLeft: timing.schedule?.daysLeft ?? null,
    dueLabel: timing.schedule ? daysLeftPhrase(timing.schedule.daysLeft) : null,
    pace: timing.schedule?.pace ?? null,
    readiness: Math.round(timing.readiness * 100),
    weights: report.nodes.map((node) => ({ title: titleOf(node.id), percent: Math.round(timing.weights[node.id] ?? 0) })),
    studiedDays: timing.schedule?.studiedDays ?? 0
  };
}

// ../core/src/template.ts
var PLUGIN_ID = "groundwork";
var VAULT_TEMPLATE = {
  "README.md": `# My knowledge vault

This is a **Groundwork** knowledge vault: a calibrated, persistent memory of what I understand. It is an Obsidian vault and a git repository at the same time, so the same memory follows me to every computer.

| Folder | What lives there |
| --- | --- |
| \`concepts/\` | One note per reusable idea (linear functions, the chain rule). A concept never names a lecture, homework, or exam. \`prerequisites\` link to the concepts it depends on. Status is recalculated from quiz evidence. |
| \`goals/\` | One note per goal. A goal can name a course or a file (Lecture 1 note fluency) and list those source documents. It is made of concepts, which stay useful for the next goal. |
| \`sessions/\` | Transcripts of tutoring sessions. Manage and delete them from the Library, on the Chats tab. |
| \`resources/\` | PDFs, slides, images, and notes I learn from. Files I attach in the tutor chat are saved here. The tutor reads only the folders chosen in Settings. Resetting the vault leaves this folder alone. |
| \`submissions/\` | Files to hand in. The tutor writes them here when I ask, and only into the write folders chosen in Settings. |
| \`exams/\` | Syllabi parsed from those files: topics and the level each must be learned to. |
| \`learner.md\` | My background and how I learn best. The tutor reads it every session and may update it. Edit it from Settings in the tutor panel, or open this note. |
| \`.groundwork/tutor-context.md\` | Extra notes I write for the tutor in Settings. Separate from \`learner.md\`; the tutor reads them and does not rewrite them. |
| \`.groundwork/evidence/\` | Append-only quiz evidence (source of truth for all stats). |

Open the **Groundwork** panel from the ribbon (graduation cap) to talk to the tutor. Goals, concepts, and past chats each have a tab in the Library. Settings in that panel holds the learner file, extra notes, a few preferences, and a way to reset the learning vault. The folders above are storage.
`,
  [PATHS.learner]: DEFAULT_LEARNER_PROFILE,
  [`${PATHS.concepts}/.gitkeep`]: "",
  [`${PATHS.goals}/.gitkeep`]: "",
  [`${PATHS.sessions}/.gitkeep`]: "",
  [`${PATHS.exams}/.gitkeep`]: "",
  [`${PATHS.evidence}/.gitkeep`]: "",
  [`${PATHS.chats}/.gitkeep`]: "",
  [`${RESOURCES_DIR}/.gitkeep`]: "",
  [`${DEFAULT_WRITE_FOLDERS[0]}/.gitkeep`]: "",
  ".gitattributes": `# Evidence logs are append-only: merge both machines' lines instead of conflicting.
.groundwork/evidence/*.jsonl merge=union
`,
  ".gitignore": `.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
.DS_Store
`,
  ".obsidian/app.json": JSON.stringify({ alwaysUpdateLinks: true, showFrontmatter: false, attachmentFolderPath: RESOURCES_DIR }, null, 2),
  ".obsidian/community-plugins.json": JSON.stringify([PLUGIN_ID], null, 2),
  ".obsidian/graph.json": JSON.stringify(
    {
      colorGroups: [
        { query: "[status:solid]", color: { a: 1, rgb: 2062925 } },
        { query: "[status:shaky]", color: { a: 1, rgb: 12040479 } },
        { query: "[status:learning]", color: { a: 1, rgb: 12604961 } },
        { query: "[status:rusty]", color: { a: 1, rgb: 7030465 } }
      ],
      showTags: false,
      showAttachments: false,
      hideUnresolved: true
    },
    null,
    2
  )
};

// ../core/src/account/plans.ts
var PLANS = {
  free: {
    id: "free",
    name: "Free",
    priceUsdPerMonth: 0,
    hostedCreditUsd: 3,
    ownModel: false,
    summary: "Groundwork's smaller model. Enough to actually study."
  },
  byom: {
    id: "byom",
    name: "Bring your own model",
    priceUsdPerMonth: 9,
    hostedCreditUsd: 0,
    ownModel: true,
    summary: "Use the Claude subscription on this computer, or paste a key from OpenRouter, Anthropic, Google, xAI, or OpenAI."
  },
  included: {
    id: "included",
    name: "Groundwork",
    priceUsdPerMonth: 20,
    hostedCreditUsd: 8,
    ownModel: false,
    summary: "We run the models, on the smaller model by default."
  }
};
var PLAN_IDS = Object.keys(PLANS);

// graph-client/entry.ts
function mountSiteGraph(host, payload, options = {}) {
  const data = buildFromGroundwork(payload.concepts, payload.graph);
  return mountForceGraph(host, data, {
    className: "graph-canvas",
    onNodeClick: (id) => options.onSelect?.(id)
  });
}
if (typeof window !== "undefined") {
  window.GroundworkGraph = { mount: mountSiteGraph, buildSyntheticGraph };
}
export {
  mountSiteGraph
};
