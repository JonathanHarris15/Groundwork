/**
 * @vitest-environment jsdom
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KnowledgeStore, MemoryVaultIO } from "@groundwork/core";

vi.mock("obsidian", () => ({
	Notice: class {
		constructor(public message: string) {}
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

describe("flashcard library", () => {
	it("lets the learner make a deck and a card, with no teaching-notes toggle", async () => {
		const parent = document.createElement("div");
		document.body.append(parent);
		const studied: string[] = [];
		await renderFlashcardsLibrary(parent, {
			store: store(),
			writeFolders: () => [],
			onStudy: (deckId) => studied.push(deckId),
		});

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
		await renderFlashcardsLibrary(library, { store: memory, writeFolders: () => [], onStudy: () => {} });
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
		library.remove();
		root.remove();
	});
});
