/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MathField } from "../src/math-field";

vi.mock("obsidian", () => ({}));

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, Function>;
	if (proto.createEl) return;
	proto.createEl = function createEl(this: HTMLElement, tag: string, opts?: { cls?: string; text?: string }) {
		const el = this.ownerDocument.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		this.append(el);
		return el;
	};
});

describe("written-answer spacing", () => {
	it("keeps spaces and a tab in the answer source", () => {
		document.body.innerHTML = "";
		const host = document.createElement("div");
		document.body.append(host);
		const field = new MathField(host, async () => {}, { placeholder: "", hint: "", onChange: () => {} });
		field.value = "x  =  1";
		expect(field.value).toBe("x  =  1");
		field.value = "\treturn 1";
		field.editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
		expect(field.value).toBe("return 1");
		field.editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		expect(field.value.replace("\t", "")).toBe("return 1");
	});
});
