export type RenderMarkdown = (el: HTMLElement, markdown: string) => Promise<void>;

/** Shows `text` as plain text at once, then swaps in the rendered markdown once it has content. */
export function paintMarkdown<K extends keyof HTMLElementTagNameMap>(
	parent: HTMLElement,
	tag: K,
	cls: string,
	text: string,
	render: RenderMarkdown | undefined,
): void {
	const doc = parent.ownerDocument;
	const plain = doc.createElement(tag);
	if (cls) plain.className = cls;
	plain.textContent = text;
	parent.append(plain);
	if (!render) return;
	// The renderer appends, so it fills a fresh element that replaces the plain-text stand-in.
	const rendered = doc.createElement(tag);
	if (cls) rendered.className = cls;
	render(rendered, text).then(
		() => {
			if (rendered.textContent?.trim() || rendered.querySelector("img, svg, mjx-container")) plain.replaceWith(rendered);
		},
		() => {},
	);
}
