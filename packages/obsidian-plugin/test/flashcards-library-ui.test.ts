/**
 * @vitest-environment jsdom
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createFlashcard, KnowledgeStore, MemoryVaultIO } from "@groundwork/core";

vi.mock("obsidian", () => ({
	Notice: class {
		constructor(public message: string) {}
	},
	Modal: class {
		app: unknown;
		containerEl: HTMLElement;
		titleEl: HTMLElement;
		contentEl: HTMLElement;
		constructor(app: unknown) {
			this.app = app;
			this.containerEl = document.createElement("div");
			this.containerEl.className = "modal-container";
			this.titleEl = document.createElement("div");
			this.titleEl.className = "modal-title";
			this.contentEl = document.createElement("div");
			this.contentEl.className = "modal-content";
			this.containerEl.append(this.titleEl, this.contentEl);
			document.body.append(this.containerEl);
		}
		setTitle(title: string) {
			this.titleEl.textContent = title;
			return this;
		}
		open() {
			(this as { onOpen?: () => void }).onOpen?.();
		}
		close() {
			(this as { onClose?: () => void }).onClose?.();
			this.containerEl.remove();
		}
	},
	Menu: class {
		items: { title: string; click: () => void }[] = [];
		addItem(cb: (item: { setTitle: (title: string) => unknown; onClick: (fn: () => void) => unknown }) => void) {
			const item = {
				title: "",
				click: () => {},
				setTitle(title: string) {
					item.title = title;
					return item;
				},
				setIcon() {
					return item;
				},
				onClick(fn: () => void) {
					item.click = fn;
					return item;
				},
			};
			cb(item);
			this.items.push(item);
			return this;
		}
		showAtMouseEvent() {
			(globalThis as { __gwLastMenu?: unknown }).__gwLastMenu = this;
		}
	},
}));

beforeAll(() => {
	// Obsidian adds these helpers to HTMLElement. jsdom does not.
	const proto = HTMLElement.prototype as any;
	proto.empty = function empty() {
		this.replaceChildren();
	};
	proto.setText = function setText(text: string) {
		this.textContent = text;
	};
	proto.addClass = function addClass(cls: string) {
		this.classList.add(cls);
	};
	proto.removeClass = function removeClass(cls: string) {
		this.classList.remove(cls);
	};
	proto.toggleClass = function toggleClass(cls: string, force?: boolean) {
		this.classList.toggle(cls, force);
	};
	proto.createEl = function createEl(tag: string, opts?: { cls?: string; text?: string; type?: string; attr?: Record<string, string> }) {
		const el = this.ownerDocument.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		if (opts?.type && "type" in el) (el as HTMLInputElement).type = opts.type;
		if (opts?.attr) {
			for (const [key, value] of Object.entries(opts.attr)) {
				if (key === "type" && "type" in el) (el as HTMLInputElement).type = value;
				else el.setAttribute(key, value);
			}
		}
		this.append(el);
		return el;
	};
	proto.createDiv = function createDiv(opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
		return this.createEl("div", opts);
	};
	proto.createSpan = function createSpan(opts?: { cls?: string; text?: string }) {
		return this.createEl("span", opts);
	};
});

const { renderFlashcardsLibrary } = await import("../src/flashcards-library-pane");
const { FlashcardsPane } = await import("../src/flashcards-pane");

function store() {
	return new KnowledgeStore(new MemoryVaultIO(), { context: new MemoryVaultIO(), now: () => new Date("2026-10-02T12:00:00.000Z") });
}

function click(root: ParentNode, label: string): void {
	const button = [...root.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
	if (!button) throw new Error(`No button named ${label}`);
	button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const app = {} as never;

function host(store: KnowledgeStore, studied: string[] = []) {
	return { app, store, writeFolders: () => [] as string[], onStudy: (deckId: string) => studied.push(deckId) };
}

describe("flashcard library", () => {
	it("lets the learner make a deck and a card, with no teaching-notes toggle", async () => {
		const parent = document.createElement("div");
		document.body.append(parent);
		const studied: string[] = [];
		await renderFlashcardsLibrary(parent, host(store(), studied));

		expect(parent.textContent).not.toContain("Make cards from teaching notes");
		expect(parent.textContent).not.toContain("One deck per goal");
		expect(parent.textContent).toContain("No decks yet.");

		click(parent, "New deck");
		const name = parent.querySelector<HTMLInputElement>("input[aria-label='Deck name']");
		expect(name).toBeTruthy();
		click(parent, "Create");
		await vi.waitFor(() => expect(parent.querySelector(".gw-fc-form-error")?.textContent).toBe("A deck needs a name."));
		name!.value = "Nightly drills";
		click(parent, "Create");
		await vi.waitFor(() => expect(parent.textContent).toContain("Nightly drills"));
		expect(parent.querySelector("h3")?.textContent).toBe("Nightly drills");
		expect(parent.textContent).toContain("No cards in this deck yet.");

		click(parent, "Add card");
		parent.querySelector<HTMLInputElement>("input[aria-label='Concept']")!.value = "Base rates";
		parent.querySelector<HTMLTextAreaElement>("textarea[aria-label='Question']")!.value = "Why 9%?";
		parent.querySelector<HTMLTextAreaElement>("textarea[aria-label='Answer']")!.value = "False alarms.";
		click(parent, "Save");
		await vi.waitFor(() => expect(parent.textContent).toContain("Why 9%?"));
		expect(parent.textContent).toContain("False alarms.");
		expect(parent.textContent).not.toContain("teaching notes");

		click(parent, "Study this deck");
		expect(studied).toEqual(["nightly-drills"]);
		parent.remove();
	});

	it("studies the deck the learner picked, not a goal", async () => {
		const memory = store();
		const library = document.createElement("div");
		document.body.append(library);
		await renderFlashcardsLibrary(library, host(memory));
		click(library, "New deck");
		library.querySelector<HTMLInputElement>("input[aria-label='Deck name']")!.value = "Nightly drills";
		click(library, "Create");
		await vi.waitFor(() => expect(library.textContent).toContain("Nightly drills"));
		click(library, "Add card");
		library.querySelector<HTMLInputElement>("input[aria-label='Concept']")!.value = "Base rates";
		library.querySelector<HTMLTextAreaElement>("textarea[aria-label='Question']")!.value = "Why 9%?";
		library.querySelector<HTMLTextAreaElement>("textarea[aria-label='Answer']")!.value = "False alarms.";
		click(library, "Save");
		await vi.waitFor(() => expect(library.textContent).toContain("Why 9%?"));

		click(library, "New deck");
		library.querySelector<HTMLInputElement>("input[aria-label='Deck name']")!.value = "Exam morning";
		click(library, "Create");
		await vi.waitFor(() => expect(library.querySelector("h3")?.textContent).toBe("Exam morning"));
		click(library, "Add card");
		library.querySelector<HTMLInputElement>("input[aria-label='Concept']")!.value = "Odds";
		library.querySelector<HTMLTextAreaElement>("textarea[aria-label='Question']")!.value = "What is odds?";
		library.querySelector<HTMLTextAreaElement>("textarea[aria-label='Answer']")!.value = "A ratio.";
		click(library, "Save");
		await vi.waitFor(() => expect(library.textContent).toContain("What is odds?"));

		const root = document.createElement("div");
		document.body.append(root);
		const pane = new FlashcardsPane(root, {
			app: { workspace: { openLinkText: async () => {} } } as never,
			store: memory,
			writeFolders: () => [],
			renderMarkdown: async () => {},
			onManageCards: () => {},
		});
		pane.study("nightly-drills");
		await pane.show();
		const select = root.querySelector<HTMLSelectElement>("select[aria-label='Flashcard deck']");
		expect(select?.value).toBe("nightly-drills");
		expect([...select!.options].map((option) => option.text)).toEqual(["Exam morning", "Nightly drills"]);
		expect(root.textContent).toContain("Why 9%?");
		expect(root.textContent).not.toContain("goal deck");
		expect(root.textContent).not.toContain("teaching notes");

		select!.value = "exam-morning";
		select!.dispatchEvent(new Event("change", { bubbles: true }));
		expect(root.textContent).toContain("What is odds?");
		expect(root.textContent).not.toContain("Why 9%?");

		root.querySelector<HTMLButtonElement>(".gw-fc-show")!.click();
		const again = root.querySelector(".gw-rb-again");
		expect(again?.closest(".gw-fc-unit")?.querySelector(":scope > .gw-fc-rate")).toBeTruthy();
		expect(again?.querySelector("b")?.textContent).toBe("Again");
		expect(again?.querySelector("kbd")?.textContent).toBe("1");
		expect(again?.querySelector(".gw-rb-when")?.textContent).toMatch(/^in /);
		library.remove();
		root.remove();
	});

	it("renames a deck, and deletes it only after the modal says how many cards go with it", async () => {
		const parent = document.createElement("div");
		document.body.append(parent);
		const memory = store();
		await renderFlashcardsLibrary(parent, host(memory));
		click(parent, "New deck");
		parent.querySelector<HTMLInputElement>("input[aria-label='Deck name']")!.value = "Nightly drills";
		click(parent, "Create");
		await vi.waitFor(() => expect(parent.querySelector("h3")?.textContent).toBe("Nightly drills"));
		click(parent, "Add card");
		parent.querySelector<HTMLInputElement>("input[aria-label='Concept']")!.value = "Base rates";
		parent.querySelector<HTMLTextAreaElement>("textarea[aria-label='Question']")!.value = "Why 9%?";
		parent.querySelector<HTMLTextAreaElement>("textarea[aria-label='Answer']")!.value = "False alarms.";
		click(parent, "Save");
		await vi.waitFor(() => expect(parent.textContent).toContain("Why 9%?"));
		expect(parent.querySelector(".gw-fc-lib-card button")?.textContent).toBe("Edit");
		expect(parent.querySelector(".gw-fc-card-row-tools")?.textContent).toContain("Delete");

		click(parent, "Rename");
		const name = parent.querySelector<HTMLInputElement>(".gw-fc-lib-rename input[aria-label='Deck name']");
		expect(name?.value).toBe("Nightly drills");
		name!.value = "Morning drills";
		click(parent.querySelector(".gw-fc-lib-rename")!, "Save");
		await vi.waitFor(() => expect(parent.querySelector("h3")?.textContent).toBe("Morning drills"));

		const row = [...parent.querySelectorAll(".gw-fc-lib-deck")].find((el) => el.textContent?.includes("Morning drills"));
		row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		const menu = (globalThis as { __gwLastMenu?: { items: { title: string; click: () => void }[] } }).__gwLastMenu;
		expect(menu?.items.map((item) => item.title)).toEqual(["Rename", "Delete"]);

		click(parent, "New deck");
		parent.querySelector<HTMLInputElement>("input[aria-label='Deck name']")!.value = "Exam morning";
		click(parent, "Create");
		await vi.waitFor(() => expect(parent.querySelector("h3")?.textContent).toBe("Exam morning"));
		[...parent.querySelectorAll(".gw-fc-lib-deck")].find((el) => el.textContent?.includes("Morning drills"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(parent.querySelector("h3")?.textContent).toBe("Morning drills");

		click(parent.querySelector(".gw-fc-lib-head")!, "Delete");
		const modal = document.querySelector(".modal-container");
		expect(modal?.textContent).toContain("Delete this deck?");
		expect(modal?.textContent).toContain("1 card");
		expect(modal?.textContent).toContain("Notes already in the vault stay there");
		click(modal!, "Cancel");
		expect(document.querySelector(".modal-container")).toBeNull();
		expect(parent.textContent).toContain("Morning drills");

		click(parent.querySelector(".gw-fc-lib-card")!, "Delete");
		expect(document.querySelector(".modal-title")?.textContent).toBe("Delete this card?");
		expect(document.body.textContent).toContain("the note stays in your vault");
		click(document.body, "Delete card");
		await vi.waitFor(() => expect(parent.textContent).toContain("No cards in this deck yet."));

		click(parent.querySelector(".gw-fc-lib-head")!, "Delete");
		expect(document.body.textContent).toContain("no cards");
		click(document.body, "Delete deck");
		await vi.waitFor(() => expect(parent.textContent).not.toContain("Morning drills"));
		expect(parent.querySelector("h3")?.textContent).toBe("Exam morning");

		click(parent.querySelector(".gw-fc-lib-head")!, "Delete");
		click(document.body, "Delete deck");
		await vi.waitFor(() => expect(parent.textContent).toContain("No decks yet."));
		expect(parent.textContent).toContain("Make a deck, then add cards to it.");
		parent.remove();
	});

	it("hides delete on Unsorted and still lets you rename it", async () => {
		const parent = document.createElement("div");
		document.body.append(parent);
		const memory = store();
		await createFlashcard(memory, { concept: "Odds", front: "What is odds?", back: "A ratio." });
		await renderFlashcardsLibrary(parent, host(memory));
		expect(parent.querySelector("h3")?.textContent).toBe("Unsorted");
		expect(parent.querySelector(".gw-fc-lib-note")?.textContent).toContain("aren't put in a deck");
		expect(parent.querySelector(".gw-fc-lib-head")?.textContent).not.toContain("Delete");
		expect(parent.querySelector(".gw-fc-card-row-tools")?.textContent).toContain("Delete");

		const row = parent.querySelector(".gw-fc-lib-deck");
		row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		const menu = (globalThis as { __gwLastMenu?: { items: { title: string }[] } }).__gwLastMenu;
		expect(menu?.items.map((item) => item.title)).toEqual(["Rename"]);

		click(parent, "Rename");
		parent.querySelector<HTMLInputElement>(".gw-fc-lib-rename input")!.value = "Inbox";
		click(parent.querySelector(".gw-fc-lib-rename")!, "Save");
		await vi.waitFor(() => expect(parent.querySelector("h3")?.textContent).toBe("Inbox"));
		expect(parent.querySelector(".gw-fc-lib-note")?.textContent).toContain("aren't put in a deck");
		expect(parent.querySelector(".gw-fc-lib-head")?.textContent).not.toContain("Delete");
		parent.remove();
	});
});
