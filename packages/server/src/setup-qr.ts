import QRCode from "qrcode";

/** Public setup page. An untrusted Host header cannot turn this into an open QR generator. */
export function setupPageUrl(host: string | undefined, proto: string | undefined): string {
	const raw = (host ?? "").trim().toLowerCase();
	const name = raw.split(":")[0] ?? "";
	const local = name === "localhost" || name === "127.0.0.1";
	const allowed = local || name === "groundworklearn.com" || name === "www.groundworklearn.com" || name.endsWith(".a.run.app");
	if (!allowed || !name) return "https://groundworklearn.com/get-started";
	const scheme = local ? "http" : proto === "http" ? "http" : "https";
	const authority = local ? raw : name;
	return `${scheme}://${authority}/get-started`;
}

export async function setupQrSvg(url: string): Promise<string> {
	return QRCode.toString(url, {
		type: "svg",
		margin: 1,
		width: 168,
		color: { dark: "#16181d", light: "#ffffff" },
	});
}
