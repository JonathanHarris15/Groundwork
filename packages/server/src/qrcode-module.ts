declare module "qrcode" {
	interface QrApi {
		toString(
			text: string,
			options: { type: "svg"; margin?: number; width?: number; color?: { dark?: string; light?: string } },
		): Promise<string>;
	}
	const qr: QrApi;
	export default qr;
}
