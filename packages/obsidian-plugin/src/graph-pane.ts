import { forceGraphFromGoalMermaid } from "@groundwork/core";
import { createGraphPane, mountInteractiveGraph } from "./force-graph-host";

const HOSTS = [".mermaid", ".block-language-mermaid", "pre.language-mermaid"];
const watchers = new WeakMap<HTMLElement, { obs: MutationObserver; timer: number }>();

export interface GraphEnhanceOptions {
	onConcept?: (title: string) => void;
}

/** Replace goal dependency maps with an interactive force graph; other Mermaid blocks stay as Obsidian renders them. */
export function enhanceGraphs(root: HTMLElement, options: GraphEnhanceOptions = {}): void {
	for (const block of findMermaidBlocks(root)) wrapGoalGraph(block, options);
	let w = watchers.get(root);
	if (!w) {
		const obs = new MutationObserver(() => {
			for (const block of findMermaidBlocks(root)) wrapGoalGraph(block, options);
		});
		obs.observe(root, { childList: true, subtree: true });
		w = { obs, timer: 0 };
		watchers.set(root, w);
	}
	window.clearTimeout(w.timer);
	w.timer = window.setTimeout(() => {
		w.obs.disconnect();
		watchers.delete(root);
	}, 8000);
}

function findMermaidBlocks(root: HTMLElement): HTMLElement[] {
	const found = new Set<HTMLElement>();
	for (const sel of HOSTS) {
		root.querySelectorAll(sel).forEach((el) => {
			const host = el as HTMLElement;
			if (!host.closest(".gw-graph") && !host.classList.contains("gw-graph-done")) found.add(host);
		});
	}
	return [...found];
}

function mermaidSource(block: HTMLElement): string {
	const code = block.querySelector("code");
	if (code?.textContent?.trim()) return code.textContent;
	return block.textContent?.trim() ?? "";
}

function wrapGoalGraph(block: HTMLElement, options: GraphEnhanceOptions): void {
	if (block.classList.contains("gw-graph-done") || !block.parentElement) return;
	const source = mermaidSource(block);
	const data = forceGraphFromGoalMermaid(source);
	if (!data) return;

	const { pane, view } = createGraphPane(block.parentElement, "Dependency map");
	block.parentElement.insertBefore(pane, block);
	block.classList.add("gw-graph-done", "gw-graph-source-hidden");
	const titleById = new Map(data.nodes.map((n) => [n.id, n.title]));
	mountInteractiveGraph(view, data, {
		captureWheel: "when-active",
		onNodeClick: (id) => {
			const title = titleById.get(id);
			if (title) options.onConcept?.(title);
		},
	});
}
