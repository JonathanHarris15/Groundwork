import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16).toString("hex");
	const hash = (await scryptAsync(password, salt, 32)) as Buffer;
	return `scrypt:${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [kind, salt, hex] = stored.split(":");
	if (kind !== "scrypt" || !salt || !hex) return false;
	const hash = (await scryptAsync(password, salt, 32)) as Buffer;
	const expected = Buffer.from(hex, "hex");
	if (hash.length !== expected.length) return false;
	return timingSafeEqual(hash, expected);
}

export function newToken(): string {
	return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
