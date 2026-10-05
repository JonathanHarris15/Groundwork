const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
		(el) => !el.hidden && el.getAttribute("aria-hidden") !== "true" && el.offsetParent !== null,
	);
}

/** Keep keyboard focus inside an overlay until `release` is called. */
export function trapFocus(container: HTMLElement, onEscape?: () => void): () => void {
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			onEscape?.();
			return;
		}
		if (e.key !== "Tab") return;
		const els = focusables(container);
		if (!els.length) return;
		const first = els[0];
		const last = els[els.length - 1];
		const active = document.activeElement as HTMLElement | null;
		if (e.shiftKey) {
			if (active === first || !container.contains(active)) {
				e.preventDefault();
				last.focus();
			}
		} else if (active === last) {
			e.preventDefault();
			first.focus();
		}
	};
	document.addEventListener("keydown", onKeyDown, true);
	const previous = document.activeElement as HTMLElement | null;
	const prefer = container.querySelector<HTMLElement>(".gw-panel-close, .gw-start-primary, button, [href], input, textarea, select");
	(prefer ?? focusables(container)[0])?.focus();

	return () => {
		document.removeEventListener("keydown", onKeyDown, true);
		if (previous?.isConnected) previous.focus({ preventScroll: true });
	};
}
