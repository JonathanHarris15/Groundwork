// In Obsidian's renderer, AbortSignal is the DOM one, which Node's events.setMaxListeners rejects.
// The Agent SDK calls it only to silence listener-count warnings, so a failure there is safe to ignore.
const events = require("events");

function setMaxListeners(n, ...targets) {
	try {
		return events.setMaxListeners(n, ...targets);
	} catch {
		return undefined;
	}
}

module.exports = new Proxy(events, {
	get: (target, key) => (key === "setMaxListeners" ? setMaxListeners : Reflect.get(target, key)),
});
