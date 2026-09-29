import { setIcon } from "obsidian";

const HOSTS = [".mermaid", ".block-language-mermaid", "pre.language-mermaid"];
const MIN = 0.25;
const MAX = 4;
const watchers = new WeakMap<HTMLElement, { obs: MutationObserver; timer: number }>();

/** Put each mermaid diagram in a framed, pannable viewport so a wide graph cannot blow out the chat. */
export function enhanceGraphs(root: HTMLElement): void {
	for (const block of findMermaidBlocks(root)) wrapGraph(block);
	let w = watchers.get(root);
	if (!w) {
		const obs = new MutationObserver(() => {
			for (const block of findMermaidBlocks(root)) wrapGraph(block);
		});
		obs.observe(root, { childList: true, subtree: true });
		w = { obs, timer: 0 };
		watchers.set(root, w);
	}
	window.clearTimeout(w.timer);
	w.timer = window.setTimeout(() => {
		w.obs.disconnect();
		watchers.delete(root);
	}, 5000);
}

function findMermaidBlocks(root: HTMLElement): HTMLElement[] {
	const found = new Set<HTMLElement>();
	for (const sel of HOSTS) {
		root.querySelectorAll(sel).forEach((el) => {
			const host = el as HTMLElement;
			if (!host.closest(".gw-graph")) found.add(host);
		});
	}
	root.querySelectorAll("svg[id^='mermaid']").forEach((svg) => {
		const host = (svg.closest(HOSTS.join(",")) ?? svg.parentElement) as HTMLElement | null;
		if (host && !host.closest(".gw-graph") && root.contains(host)) found.add(host);
	});
	return [...found];
}

function wrapGraph(block: HTMLElement): void {
	if (block.closest(".gw-graph") || !block.parentElement) return;

	const pane = document.createElement("div");
	pane.className = "gw-graph";

	const bar = pane.createDiv({ cls: "gw-graph-bar" });
	bar.createSpan({ cls: "gw-graph-title", text: "Map" });
	const pctEl = bar.createSpan({ cls: "gw-graph-pct", text: "Fit" });
	const tools = bar.createDiv({ cls: "gw-graph-tools" });

	const view = pane.createDiv({ cls: "gw-graph-view" });
	const stage = view.createDiv({ cls: "gw-graph-stage" });

	block.parentElement.insertBefore(pane, block);
	stage.appendChild(block);

	let scale = 1;
	let x = 0;
	let y = 0;
	let fitted = true;
	let dragging = false;
	let lastX = 0;
	let lastY = 0;

	const apply = () => {
		stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
		pctEl.setText(fitted ? "Fit" : `${Math.round(scale * 100)}%`);
	};

	const zoomAt = (next: number, cx: number, cy: number) => {
		const clamped = Math.min(MAX, Math.max(MIN, next));
		if (clamped === scale) return;
		const rect = view.getBoundingClientRect();
		const px = cx - rect.left;
		const py = cy - rect.top;
		x = px - ((px - x) * clamped) / scale;
		y = py - ((py - y) * clamped) / scale;
		scale = clamped;
		fitted = false;
		apply();
	};

	const fit = () => {
		const svg = stage.querySelector("svg");
		const vw = view.clientWidth;
		const vh = view.clientHeight;
		if (!svg || vw < 8 || vh < 8) {
			scale = 1;
			x = 8;
			y = 8;
			fitted = true;
			apply();
			return;
		}
		svg.removeAttribute("width");
		svg.removeAttribute("height");
		svg.style.width = "auto";
		svg.style.height = "auto";
		svg.style.maxWidth = "none";
		const bb = svgSize(svg);
		const pad = 20;
		const s = Math.min((vw - pad) / bb.w, (vh - pad) / bb.h, 1.4);
		scale = Math.min(MAX, Math.max(MIN, s));
		x = (vw - bb.w * scale) / 2;
		y = (vh - bb.h * scale) / 2;
		fitted = true;
		apply();
	};

	const btn = (icon: string, label: string, fn: () => void) => {
		const b = tools.createEl("button", { cls: "clickable-icon gw-graph-btn", attr: { "aria-label": label, type: "button" } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			fn();
		});
		return b;
	};

	btn("zoom-out", "Zoom out", () => {
		const r = view.getBoundingClientRect();
		zoomAt(scale / 1.25, r.left + r.width / 2, r.top + r.height / 2);
	});
	btn("zoom-in", "Zoom in", () => {
		const r = view.getBoundingClientRect();
		zoomAt(scale * 1.25, r.left + r.width / 2, r.top + r.height / 2);
	});
	btn("maximize-2", "Fit in window", () => fit());
	const expand = btn("expand", "Taller map", () => {
		pane.toggleClass("is-tall", !pane.hasClass("is-tall"));
		setIcon(expand, pane.hasClass("is-tall") ? "shrink" : "expand");
		expand.setAttr("aria-label", pane.hasClass("is-tall") ? "Shorter map" : "Taller map");
		window.requestAnimationFrame(fit);
	});

	view.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			e.stopPropagation();
			const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			zoomAt(scale * factor, e.clientX, e.clientY);
		},
		{ passive: false },
	);

	view.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		dragging = true;
		lastX = e.clientX;
		lastY = e.clientY;
		view.classList.add("is-dragging");
		view.setPointerCapture(e.pointerId);
	});
	view.addEventListener("pointermove", (e) => {
		if (!dragging) return;
		x += e.clientX - lastX;
		y += e.clientY - lastY;
		lastX = e.clientX;
		lastY = e.clientY;
		fitted = false;
		apply();
	});
	const endDrag = (e: PointerEvent) => {
		if (!dragging) return;
		dragging = false;
		view.classList.remove("is-dragging");
		if (view.hasPointerCapture(e.pointerId)) view.releasePointerCapture(e.pointerId);
	};
	view.addEventListener("pointerup", endDrag);
	view.addEventListener("pointercancel", endDrag);
	view.addEventListener("dblclick", (e) => {
		e.preventDefault();
		fit();
	});

	window.requestAnimationFrame(() => {
		fit();
		window.setTimeout(fit, 80);
		window.setTimeout(fit, 400);
	});
}

function svgSize(svg: SVGSVGElement): { w: number; h: number } {
	try {
		const box = svg.getBBox();
		if (box.width > 1 && box.height > 1) return { w: box.width, h: box.height };
	} catch {
		// getBBox throws if the SVG is not in the layout yet
	}
	const vb = svg.viewBox?.baseVal;
	if (vb && vb.width > 1 && vb.height > 1) return { w: vb.width, h: vb.height };
	const r = svg.getBoundingClientRect();
	if (r.width > 1 && r.height > 1) return { w: r.width / Math.max(0.01, currentScale(svg)), h: r.height / Math.max(0.01, currentScale(svg)) };
	return { w: 400, h: 240 };
}

function currentScale(el: Element): number {
	const stage = el.closest(".gw-graph-stage") as HTMLElement | null;
	if (!stage) return 1;
	const m = /scale\(([^)]+)\)/.exec(stage.style.transform);
	return m ? Number(m[1]) || 1 : 1;
}
