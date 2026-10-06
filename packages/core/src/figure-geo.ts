/** Coastlines and borders pulled from a public GeoJSON document, simplified enough to draw. */

export interface GeoPlate {
	polygons: Array<Array<[number, number]>>;
	lines: Array<Array<[number, number]>>;
}

const MAX_FEATURES = 400;
const MAX_RING_POINTS = 80;

export function geoPlate(value: unknown): GeoPlate {
	const polygons: Array<Array<[number, number]>> = [];
	const lines: Array<Array<[number, number]>> = [];
	let features = 0;
	const walk = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (record.type === "FeatureCollection" && Array.isArray(record.features)) {
			for (const feature of record.features) {
				if (features >= MAX_FEATURES) return;
				features++;
				walk(feature);
			}
			return;
		}
		if (record.type === "Feature") {
			walk(record.geometry);
			return;
		}
		collectGeometry(record, polygons, lines);
	};
	walk(value);
	if (!polygons.length && !lines.length) throw new Error("That GeoJSON has no lines or polygons to draw.");
	return { polygons, lines };
}

function collectGeometry(record: Record<string, unknown>, polygons: GeoPlate["polygons"], lines: GeoPlate["lines"]): void {
	const type = record.type;
	const coordinates = record.coordinates;
	if (type === "GeometryCollection" && Array.isArray(record.geometries)) {
		for (const geometry of record.geometries) {
			if (geometry && typeof geometry === "object") collectGeometry(geometry as Record<string, unknown>, polygons, lines);
		}
		return;
	}
	if (type === "Polygon") {
		const ring = ringAt(coordinates, 0);
		if (ring) polygons.push(ring);
		return;
	}
	if (type === "MultiPolygon" && Array.isArray(coordinates)) {
		for (const polygon of coordinates) {
			const ring = ringAt(polygon, 0);
			if (ring) polygons.push(ring);
		}
		return;
	}
	if (type === "LineString") {
		const line = positions(coordinates);
		if (line.length >= 2) lines.push(line);
		return;
	}
	if (type === "MultiLineString" && Array.isArray(coordinates)) {
		for (const line of coordinates) {
			const positionsLine = positions(line);
			if (positionsLine.length >= 2) lines.push(positionsLine);
		}
	}
}

function ringAt(value: unknown, index: number): Array<[number, number]> | null {
	if (!Array.isArray(value) || !Array.isArray(value[index])) return null;
	const ring = positions(value[index]);
	return ring.length >= 3 ? ring : null;
}

function positions(value: unknown): Array<[number, number]> {
	if (!Array.isArray(value)) return [];
	const points: Array<[number, number]> = [];
	for (const pair of value) {
		if (!Array.isArray(pair) || pair.length < 2) continue;
		const lon = typeof pair[0] === "number" ? pair[0] : Number(pair[0]);
		const lat = typeof pair[1] === "number" ? pair[1] : Number(pair[1]);
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
		points.push([lon, lat]);
	}
	return simplify(points);
}

function simplify(points: Array<[number, number]>): Array<[number, number]> {
	if (points.length <= MAX_RING_POINTS) return points;
	const step = Math.ceil(points.length / MAX_RING_POINTS);
	const out: Array<[number, number]> = [];
	for (let i = 0; i < points.length; i += step) out.push(points[i]);
	const last = points[points.length - 1];
	const end = out[out.length - 1];
	if (!end || end[0] !== last[0] || end[1] !== last[1]) out.push(last);
	return out;
}
