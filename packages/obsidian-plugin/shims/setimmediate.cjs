"use strict";

// jszip's setimmediate polyfill injects a <script> element (and can eval a string
// via new Function). Yield with a timer instead. jszip calls the global after
// a side-effect require, and uses it to break long inflate loops.
function later(fn) {
	if (typeof setTimeout === "function") setTimeout(fn, 0);
	else queueMicrotask(fn);
}

function setImmediateShim(fn) {
	const args = Array.prototype.slice.call(arguments, 1);
	later(() => {
		fn.apply(undefined, args);
	});
	return 0;
}

function clearImmediateShim() {}

const root = typeof globalThis !== "undefined" ? globalThis : window;
if (typeof root.setImmediate !== "function") root.setImmediate = setImmediateShim;
if (typeof root.clearImmediate !== "function") root.clearImmediate = clearImmediateShim;

module.exports = setImmediateShim;
