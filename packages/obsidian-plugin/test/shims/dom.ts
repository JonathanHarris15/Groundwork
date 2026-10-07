/** jsdom has neither Obsidian's doc.win.createEl nor Node#instanceOf. */
const view = globalThis.window;
const NodeRef = globalThis.Node;
const Doc = globalThis.Document;
if (view && NodeRef && Doc) {
	Object.defineProperty(NodeRef.prototype, "win", {
		configurable: true,
		get() {
			if (this.defaultView) return this.defaultView;
			return this.ownerDocument?.defaultView ?? view;
		},
	});
	NodeRef.prototype.instanceOf = function instanceOf(ctor: new (...args: never[]) => unknown) {
		return this instanceof ctor;
	};
	const make = (tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }): HTMLElement => {
		const el = view.document.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		if (opts?.attr) {
			for (const [key, value] of Object.entries(opts.attr)) el.setAttribute(key, value);
		}
		return el;
	};
	view.createEl = make;
	view.createDiv = (opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => make("div", opts);
	view.createSpan = (opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => make("span", opts);
	view.createSvg = (tag: string) => view.document.createElementNS("http://www.w3.org/2000/svg", tag);
	view.createFragment = () => view.document.createDocumentFragment();
}
