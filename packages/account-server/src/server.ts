import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { layoutConceptMap, parseKnowledgeSnapshot, type AccountUser, type KnowledgeSnapshot, type ProfilePayload } from "@groundwork/core/account";
import { hashPassword, hashToken, newToken, verifyPassword } from "./auth";
import { AccountStore, httpError, type UserRecord } from "./store";

const MAX_BODY = 1_000_000;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export interface AccountServerOptions {
	dataFile: string;
	siteDir: string;
}

export function createAccountServer(opts: AccountServerOptions) {
	const store = new AccountStore(opts.dataFile);
	return createServer(async (req, res) => {
		try {
			await route(store, opts.siteDir, req, res);
		} catch (e) {
			const status = typeof (e as { status?: number }).status === "number" ? (e as { status: number }).status : 500;
			const message = status === 500 ? "Something went wrong on the account server." : (e as Error).message;
			if (status === 500) console.error(e);
			sendJson(res, status, { error: message });
		}
	});
}

async function route(store: AccountStore, siteDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
		cors(res);
		res.writeHead(204);
		res.end();
		return;
	}
	if (url.pathname.startsWith("/api/")) {
		cors(res);
		await api(store, req, res, url);
		return;
	}
	await site(siteDir, req, res, url.pathname);
}

async function api(store: AccountStore, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const { pathname } = url;
	if (req.method === "POST" && pathname === "/api/register") {
		const body = await readJson(req);
		const email = emailOf(body);
		const password = passwordOf(body);
		const displayName = textOf(body, "displayName", 80) || email.split("@")[0] || "Learner";
		const requested = textOf(body, "handle", 32);
		const handle = slugHandle(requested || displayName || email.split("@")[0] || "learner");
		const token = newToken();
		const user = await store.register({
			email,
			handle,
			displayName,
			passwordHash: await hashPassword(password),
			tokenHash: hashToken(token),
		});
		sendJson(res, 201, { token, user: publicUser(user) });
		return;
	}
	if (req.method === "POST" && pathname === "/api/login") {
		const body = await readJson(req);
		const email = emailOf(body);
		const password = passwordOf(body);
		const user = await store.byEmail(email);
		if (!user || !(await verifyPassword(password, user.passwordHash))) throw httpError(401, "Email or password is wrong.");
		const token = newToken();
		await store.addToken(user.id, hashToken(token));
		sendJson(res, 200, { token, user: publicUser(user) });
		return;
	}
	if (req.method === "POST" && pathname === "/api/logout") {
		const header = req.headers.authorization ?? "";
		const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
		const user = await requireUser(store, req);
		await store.removeToken(user.id, hashToken(token));
		sendJson(res, 200, { ok: true });
		return;
	}
	if (req.method === "GET" && pathname === "/api/me") {
		const user = await requireUser(store, req);
		sendJson(res, 200, { user: publicUser(user) });
		return;
	}
	if (req.method === "PUT" && pathname === "/api/me/knowledge") {
		const user = await requireUser(store, req);
		const snapshot = parseKnowledgeSnapshot(await readJson(req));
		snapshot.updatedAt = new Date().toISOString();
		await store.setKnowledge(user.id, snapshot);
		sendJson(res, 200, { updatedAt: snapshot.updatedAt });
		return;
	}
	if (req.method === "GET" && pathname === "/api/me/profile") {
		const user = await requireUser(store, req);
		sendJson(res, 200, profileOf(user, true));
		return;
	}
	if (req.method === "GET" && pathname.startsWith("/api/profiles/")) {
		const handle = decodeURIComponent(pathname.slice("/api/profiles/".length));
		if (!handle || handle.includes("/")) throw httpError(404, "Profile not found.");
		const user = await store.byHandle(handle);
		if (!user) throw httpError(404, "Profile not found.");
		sendJson(res, 200, profileOf(user, false));
		return;
	}
	throw httpError(404, "No such account route.");
}

async function requireUser(store: AccountStore, req: IncomingMessage): Promise<UserRecord> {
	const header = req.headers.authorization ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	if (!token) throw httpError(401, "Sign in to your Groundwork account.");
	const user = await store.byTokenHash(hashToken(token));
	if (!user) throw httpError(401, "That sign-in expired. Sign in again.");
	return user;
}

function profileOf(user: UserRecord, includeEmail: boolean): ProfilePayload {
	const knowledge: KnowledgeSnapshot = user.knowledge ?? {
		updatedAt: "",
		concepts: [],
		goals: [],
		counts: { unassessed: 0, learning: 0, shaky: 0, solid: 0, rusty: 0 },
	};
	const shown: AccountUser = includeEmail ? publicUser(user) : { id: user.id, email: "", handle: user.handle, displayName: user.displayName };
	return {
		user: shown,
		updatedAt: user.knowledge?.updatedAt ?? null,
		map: layoutConceptMap(knowledge.concepts),
		goals: knowledge.goals,
		counts: knowledge.counts,
	};
}

function publicUser(user: UserRecord): AccountUser {
	return { id: user.id, email: user.email, handle: user.handle, displayName: user.displayName };
}

async function site(siteDir: string, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
	if (req.method !== "GET" && req.method !== "HEAD") throw httpError(405, "Method not allowed.");
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const isAsset = rel.includes(".");
	const file = isAsset ? safeFile(siteDir, rel) : path.join(siteDir, "index.html");
	if (!file) throw httpError(404, "Not found.");
	let info;
	try {
		info = await stat(file);
	} catch {
		throw httpError(404, "Not found.");
	}
	if (!info.isFile()) throw httpError(404, "Not found.");
	res.writeHead(200, {
		"Content-Type": contentType(file),
		"Content-Length": info.size,
		"Cache-Control": "no-cache",
	});
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	createReadStream(file).pipe(res);
}

function safeFile(siteDir: string, rel: string): string | null {
	if (rel.includes("\0")) return null;
	const root = path.resolve(siteDir);
	const full = path.resolve(root, rel);
	if (full !== root && !full.startsWith(root + path.sep)) return null;
	return full;
}

function contentType(file: string): string {
	switch (path.extname(file)) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		default:
			return "application/octet-stream";
	}
}

function cors(res: ServerResponse): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
	res.setHeader("Cache-Control", "no-store");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return;
	const json = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json) });
	res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		size += buf.length;
		if (size > MAX_BODY) throw httpError(413, "That upload is too large.");
		chunks.push(buf);
	}
	if (!size) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw httpError(400, "Expected a JSON object.");
		return parsed as Record<string, unknown>;
	} catch (e) {
		if ((e as { status?: number }).status) throw e;
		throw httpError(400, "That was not valid JSON.");
	}
}

function emailOf(body: Record<string, unknown>): string {
	const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw httpError(400, "Enter a valid email.");
	return email;
}

function passwordOf(body: Record<string, unknown>): string {
	const password = typeof body.password === "string" ? body.password : "";
	if (password.length < 8 || password.length > 200) throw httpError(400, "Password must be at least 8 characters.");
	return password;
}

function textOf(body: Record<string, unknown>, key: string, max: number): string {
	const value = typeof body[key] === "string" ? body[key].trim() : "";
	if (value.length > max) throw httpError(400, `${key} is too long.`);
	return value;
}

function slugHandle(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	if (HANDLE.test(slug)) return slug;
	return "learner";
}
