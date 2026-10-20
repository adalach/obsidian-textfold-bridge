// Where TextFold's server is: the server.json it writes into its data folder, else the default port, or the address
// set by hand. No runtime imports from obsidian; the request that checks an address answers is passed in, so
// test/server.test.ts runs this in Node against real files.
//
// server.json: {"format": "textfold/server", "version": 1, "url": "http://127.0.0.1:<port>", "port": <int>,
// "pid": <int>, "textfold": "<package version>", "started": "<ISO UTC>"}. TextFold removes it on a clean exit; after a
// crash it stays, so its process and its URL are both checked before it is believed. Node's fs reads it: TextFold's
// data folder is outside the vault, which is why the plugin is desktop only.
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export const DEFAULT_URL = "http://127.0.0.1:3017"; // `python3 -m textfold serve`

export interface ServerFile {
	url: string;
	port: number;
	pid: number;
	textfold: string; // TextFold's version
	started: string;
}

/** TextFold's data folders to look in, first match first: TEXTFOLD_DATA (a test run's folder, which the desktop app
 *  also sets for its server), then the system's place for the app's data. */
export function dataFolders(platform: string = process.platform, env: Record<string, string | undefined> = process.env, home: string = homedir()): string[] {
	const dirs: string[] = [];
	if (env.TEXTFOLD_DATA) dirs.push(env.TEXTFOLD_DATA);
	if (platform === "darwin") dirs.push(join(home, "Library", "Application Support", "TextFold"));
	else if (platform === "win32") dirs.push(join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "TextFold"));
	else dirs.push(join(env.XDG_DATA_HOME || join(home, ".local", "share"), "textfold"));
	return [...new Set(dirs)];
}

/** A folder typed with ~ for the home folder. */
export function expandHome(path: string, home: string = homedir()): string {
	const p = path.trim();
	return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/** An address TextFold may be at: http on 127.0.0.1 (or localhost, rewritten) with a port, nothing after it.
 *  Returns the normalized URL, or null for anything else: the plugin talks to no other host. */
export function loopbackUrl(text: string): string | null {
	const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})\/?$/i.exec(text.trim());
	if (!m) return null;
	const port = Number(m[2]);
	return port >= 1 && port <= 65535 ? `http://127.0.0.1:${port}` : null;
}

/** server.json's contents, or null when it is not a textfold/server file of version 1 on 127.0.0.1. */
export function parseServerFile(text: string): ServerFile | null {
	let d: unknown;
	try {
		d = JSON.parse(text);
	} catch {
		return null;
	}
	if (!d || typeof d !== "object") return null;
	const o = d as Record<string, unknown>;
	if (o.format !== "textfold/server" || o.version !== 1) return null;
	const url = typeof o.url === "string" ? loopbackUrl(o.url) : null;
	if (!url) return null;
	const port = typeof o.port === "number" ? o.port : Number(new URL(url).port);
	return {
		url,
		port,
		pid: typeof o.pid === "number" && Number.isInteger(o.pid) ? o.pid : 0,
		textfold: typeof o.textfold === "string" ? o.textfold : "",
		started: typeof o.started === "string" ? o.started : "",
	};
}

/** Whether a process with this id runs (signal 0 only checks). Unknown (0) counts as running: the URL decides. */
export function processAlive(pid: number): boolean {
	if (!pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"; // running, but another user's
	}
}

export type Source = "manual" | "server.json" | "default";

export interface Resolved {
	url: string;
	source: Source;
	reachable: boolean;
	version?: string; // from server.json
	note?: string; // what was found on the way, such as a stale server.json
}

export interface ResolveDeps {
	folders?: string[];
	read?: (path: string) => Promise<string | null>;
	alive?: (pid: number) => boolean;
	probe: (url: string) => Promise<boolean>; // the URL answers as TextFold (GET /api/models)
}

const readText = async (path: string): Promise<string | null> => {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
};

/** The address to use. Manual: that address. Automatic: the first server.json whose process runs and whose URL
 *  answers, else the default port. `reachable` says whether the chosen address answered. */
export async function resolveServer(mode: "auto" | "manual", manualUrl: string, deps: ResolveDeps): Promise<Resolved> {
	if (mode === "manual") {
		const url = loopbackUrl(manualUrl);
		if (!url) return { url: manualUrl, source: "manual", reachable: false, note: "not an address on 127.0.0.1" };
		return { url, source: "manual", reachable: await deps.probe(url) };
	}
	const read = deps.read ?? readText;
	const alive = deps.alive ?? processAlive;
	const notes: string[] = [];
	for (const dir of deps.folders ?? dataFolders()) {
		const path = join(dir, "server.json");
		const text = await read(path);
		if (text === null) continue;
		const info = parseServerFile(text);
		if (!info) {
			notes.push(`${path} is not a TextFold server file`);
			continue;
		}
		if (!alive(info.pid)) {
			notes.push(`server.json is stale: process ${info.pid} has ended`);
			continue;
		}
		if (await deps.probe(info.url)) return { url: info.url, source: "server.json", reachable: true, version: info.textfold || undefined };
		notes.push(`server.json is stale: ${info.url} does not answer`);
	}
	const reachable = await deps.probe(DEFAULT_URL);
	return { url: DEFAULT_URL, source: "default", reachable, note: notes.length ? notes.join("; ") : "no server.json found" };
}
