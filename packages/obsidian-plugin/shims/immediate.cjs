"use strict";

// lie's immediate polyfill inserts a <script> to schedule a microtask.
// Native queueMicrotask is the same turn, without touching the document.
function immediate(fn) {
	if (typeof queueMicrotask === "function") queueMicrotask(fn);
	else setTimeout(fn, 0);
}

module.exports = immediate;
