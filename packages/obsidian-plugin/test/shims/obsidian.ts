export class TAbstractFile {
	constructor(public path = "") {}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

export class TFile extends TAbstractFile {
	basename = "";
	extension = "";
	stat = { mtime: 0, ctime: 0, size: 0 };
}

export class Notice {
	constructor(public message: string) {}
}

export class Modal {
	contentEl: HTMLElement = globalThis.document?.createElement?.("div") ?? ({} as HTMLElement);
	titleEl: HTMLElement = globalThis.document?.createElement?.("div") ?? ({} as HTMLElement);
	constructor(public app: unknown) {}
	setTitle(_title: string) {
		return this;
	}
	open() {}
	close() {}
}

export class Menu {
	addItem(cb: (item: { setTitle: (title: string) => unknown; setIcon: (icon: string) => unknown; onClick: (fn: () => void) => unknown }) => void) {
		const item = {
			setTitle(_title: string) {
				return item;
			},
			setIcon(_icon: string) {
				return item;
			},
			onClick(_fn: () => void) {
				return item;
			},
		};
		cb(item);
		return this;
	}
	showAtMouseEvent(_evt?: MouseEvent) {}
}
