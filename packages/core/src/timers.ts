/** Node tests have no `window`. Obsidian popouts need the page's timers. */
const fallbackTimers = { setTimeout, clearTimeout };

/** DOM timers return a number; Node timers return a Timeout. */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

export function later(fn: () => void, ms: number): TimerHandle {
	if (typeof window !== "undefined") return window.setTimeout(fn, ms);
	return fallbackTimers.setTimeout(fn, ms);
}

export function cancelLater(id: TimerHandle): void {
	if (typeof window !== "undefined") window.clearTimeout(id);
	else fallbackTimers.clearTimeout(id);
}

export function every(fn: () => void, ms: number): TimerHandle {
	if (typeof window !== "undefined") return window.setInterval(fn, ms);
	return setInterval(fn, ms);
}

export function cancelEvery(id: TimerHandle): void {
	if (typeof window !== "undefined") window.clearInterval(id);
	else clearInterval(id);
}
