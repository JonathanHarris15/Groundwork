export interface PyramidConcept {
	id: string;
	title: string;
	prerequisites: string[];
}

/** Longest prerequisite chain ending at this concept — foundations are 0, complex ideas sit higher. */
export function conceptLayerRanks(concepts: PyramidConcept[], pinTopId?: string): Map<string, number> {
	const ids = new Set(concepts.map((c) => c.id));
	const byId = new Map(concepts.map((c) => [c.id, c]));
	const memo = new Map<string, number>();
	const visiting = new Set<string>();
	const rank = (id: string): number => {
		const cached = memo.get(id);
		if (cached != null) return cached;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const node = byId.get(id);
		const priors = (node?.prerequisites ?? []).filter((p) => ids.has(p) && p !== id);
		const value = priors.length ? 1 + Math.max(...priors.map(rank)) : 0;
		visiting.delete(id);
		memo.set(id, value);
		return value;
	};
	for (const c of concepts) rank(c.id);
	if (pinTopId && ids.has(pinTopId)) {
		const top = Math.max(...memo.values(), 0);
		memo.set(pinTopId, Math.max(memo.get(pinTopId) ?? 0, top));
	}
	return memo;
}

export function placePyramidLayout(
	concepts: Array<{ id: string; title: string }>,
	ranks: Map<string, number>,
	opts: { width: number; height: number; paddingX?: number; paddingY?: number; rowGap?: number },
): Map<string, { x: number; y: number }> {
	const paddingX = opts.paddingX ?? 56;
	const paddingY = opts.paddingY ?? 48;
	const rowGap = opts.rowGap ?? 92;
	const layers = new Map<number, Array<{ id: string; title: string }>>();
	for (const c of concepts) {
		const layer = ranks.get(c.id) ?? 0;
		const row = layers.get(layer) ?? [];
		row.push(c);
		layers.set(layer, row);
	}
	const maxLayer = Math.max(0, ...layers.keys());
	const usableW = Math.max(120, opts.width - paddingX * 2);
	const bottomY = opts.height - paddingY;
	const out = new Map<string, { x: number; y: number }>();
	for (const [layer, members] of layers) {
		members.sort((a, b) => a.title.localeCompare(b.title));
		const y = bottomY - layer * rowGap;
		const span = usableW / Math.max(1, members.length);
		members.forEach((node, index) => {
			const x = paddingX + span * index + span / 2;
			out.set(node.id, { x, y });
		});
	}
	// Nudge isolated top layer when only one node (goal) so it reads centered.
	if (maxLayer === 0 && concepts.length === 1) {
		const only = concepts[0];
		out.set(only.id, { x: opts.width / 2, y: bottomY });
	}
	return out;
}
