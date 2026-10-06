const SVG_NS = "http://www.w3.org/2000/svg";

/** Keep a drawing the model wrote. Drop scripts, embedded documents, and remote links. */
export function sanitizeSvg(markup: string): string {
	let svg = markup.replace(/^\uFEFF/, "").trim();
	if (!svg || svg.length > 200_000) throw new Error("That drawing is empty or too large.");
	if (!/<svg[\s>]/i.test(svg)) throw new Error("The drawing needs an <svg> root.");
	svg = svg.replace(/<!--[\s\S]*?-->/g, "");
	svg = svg.replace(/<script[\s\S]*?<\/script>/gi, "");
	svg = svg.replace(/<\/?script\b[^>]*>/gi, "");
	svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
	svg = svg.replace(/<\/?foreignObject\b[^>]*>/gi, "");
	svg = svg.replace(/<\/?(?:iframe|embed|object|audio|video|link|meta|style)\b[^>]*>/gi, "");
	svg = svg.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
	svg = svg.replace(/(\s(?:xlink:)?href)\s*=\s*("([^"]*)"|'([^']*)')/gi, (_full, attr: string, _quoted: string, dq?: string, sq?: string) => {
		const value = (dq ?? sq ?? "").trim();
		if (value.startsWith("#") && !/javascript:/i.test(value)) return `${attr}="${value.replace(/"/g, "")}"`;
		return "";
	});
	svg = svg.replace(/\s(?:src|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
	if (/<script|javascript:|foreignObject|<style\b/i.test(svg)) throw new Error("That drawing included something that cannot be shown.");
	if (!/\sxmlns\s*=/.test(svg)) svg = svg.replace(/<svg\b/i, `<svg xmlns="${SVG_NS}"`);
	return svg;
}
