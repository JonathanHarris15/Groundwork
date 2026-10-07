import "obsidian";

// Obsidian's Window has createEl at runtime (popout documents use doc.win.createEl).
// The published obsidian.d.ts puts those helpers on Node and on the global scope, not on Window.
declare global {
	interface Window {
		createEl: typeof createEl;
		createDiv: typeof createDiv;
		createSpan: typeof createSpan;
		createSvg: typeof createSvg;
		createFragment: typeof createFragment;
	}
}
