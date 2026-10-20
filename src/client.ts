// The TextFold client: requests to TextFold's server on 127.0.0.1 only, one at a time, each given up after a short
// timeout. It reads the documents, their notes, the TextFold doc JSON and the jobs; it writes only when a note is
// folded: POST /api/import (a note's text, new or in place of its earlier text) and POST /api/generate.
import { requestUrl } from "obsidian";
import { Doc, parseDoc } from "./doc";
import { NotesFile, Paper, parseNotes, parsePapers } from "./notes";
import { Resolved, dataFolders, expandHome, loopbackUrl, resolveServer } from "./server";

export type Address = { mode: "auto" | "manual"; manualUrl: string; folder: string }; // folder: a clone of TextFold, also looked in

export type ErrorKind = "unreachable" | "http" | "format" | "busy" | "missing" | "refused";

export class TextFoldError extends Error {
	constructor(message: string, readonly kind: ErrorKind, readonly code = "") {
		super(message);
	}
}

/** A generation job as GET /api/jobs lists it. */
export interface Job {
	id: string;
	pid: string;
	lang: string;
	status: "queued" | "running" | "done" | "error" | "stopped";
	stage: string;
	done: number;
	total: number;
	error: string;
}

const PROBE_MS = 2500;
const READ_MS = 8000;
const WRITE_MS = 30_000; // a long note takes TextFold a moment to parse
const FRESH_MS = 60_000; // an address that answered is used this long without asking again
const PAPERS_MS = 30_000;

type Reply = { status: number; text: string };

export class TextFoldClient {
	private queue: Promise<unknown> = Promise.resolve();
	private resolved: (Resolved & { at: number }) | null = null;
	private checking: Promise<Resolved> | null = null;
	private listeners = new Set<(state: Resolved | null) => void>();
	private docs = new Map<string, Promise<Doc | null>>(); // per session: a document's text changes only when refolded
	private paperList: { at: number; list: Promise<Paper[]> } | null = null;

	constructor(private address: () => Address) {}

	/** The last known connection: null before the first check. */
	get state(): Resolved | null {
		return this.resolved;
	}

	onChange(fn: (state: Resolved | null) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** Forget the address (the settings changed), so the next request looks for it again. */
	reset(): void {
		this.resolved = null;
		this.docs.clear();
		this.paperList = null;
		this.emit();
	}

	/** Look for TextFold now: server.json, else the default port, or the manual address; and whether it answers.
	 *  Calls made while a check runs share it. */
	check(): Promise<Resolved> {
		this.checking ??= (async () => {
			try {
				const { mode, manualUrl, folder } = this.address();
				const folders = [...(folder ? [expandHome(folder)] : []), ...dataFolders()];
				const r = await resolveServer(mode, manualUrl, { folders, probe: url => this.probe(url) });
				if (r.url !== this.resolved?.url) this.docs.clear();
				this.resolved = { ...r, at: Date.now() };
				this.emit();
				return r;
			} finally {
				this.checking = null;
			}
		})();
		return this.checking;
	}

	/** The address of a TextFold that answered within the last minute, else a fresh check. */
	async server(): Promise<Resolved> {
		const r = this.resolved;
		if (r && r.reachable && Date.now() - r.at < FRESH_MS) return r;
		return this.check();
	}

	async papers(): Promise<Paper[]> {
		return parsePapers(await this.getJson("/api/papers"));
	}

	/** A document as /api/papers lists it, or undefined when TextFold has none with this id. The list is kept for
	 *  half a minute, so checking every link opened costs one request now and then. */
	async paperInfo(id: string): Promise<Paper | undefined> {
		const hit = this.paperList;
		if (!hit || Date.now() - hit.at > PAPERS_MS) {
			const list = this.papers();
			this.paperList = { at: Date.now(), list };
			list.catch(() => (this.paperList = null));
		}
		return (await this.paperList!.list).find(p => p.id === id);
	}

	/** A document's notes, or null when TextFold has no document with this id. */
	async notes(id: string): Promise<NotesFile | null> {
		const data = await this.getJson(`/api/notes/${encodeURIComponent(id)}`, true);
		return data === null ? null : parseNotes(data, id);
	}

	/** The document in the TextFold format, kept for the session; null when TextFold has no such document, or is a
	 *  TextFold without GET /api/doc. */
	doc(id: string, lang?: string): Promise<Doc | null> {
		const key = `${id}\n${lang ?? ""}`;
		let hit = this.docs.get(key);
		if (!hit) {
			const q = lang ? `?lang=${encodeURIComponent(lang)}` : "";
			hit = this.getJson(`/api/doc/${encodeURIComponent(id)}${q}`, true).then(parseDoc);
			hit.catch(() => this.docs.delete(key)); // a failure is asked again next time
			this.docs.set(key, hit);
		}
		return hit;
	}

	/** Forget a document's cached text (it was folded again). */
	forgetDoc(id: string): void {
		for (const key of [...this.docs.keys()]) if (key.startsWith(`${id}\n`)) this.docs.delete(key);
	}

	async jobs(): Promise<Job[]> {
		const data = await this.getJson("/api/jobs");
		return Array.isArray(data) ? data.filter((j): j is Job => !!j && typeof j === "object" && typeof (j as Job).id === "string") : [];
	}

	/** Store a note's text as a Markdown document, or (with id) put it in place of that document's earlier text. */
	async importText(name: string, text: string, id?: string): Promise<{ paper: string; title: string; replaced: boolean }> {
		const body: Record<string, string> = { name, text };
		if (id) body.id = id;
		const data = await this.postJson("/api/import", body);
		const o = (data ?? {}) as { paper?: unknown; title?: unknown; replaced?: unknown };
		if (typeof o.paper !== "string") throw new TextFoldError("TextFold's answer to the import names no document", "format");
		return { paper: o.paper, title: typeof o.title === "string" ? o.title : "", replaced: o.replaced === true };
	}

	/** Start folding a document in a language; with force, again from its text (the model's earlier replies are reused
	 *  where the text is unchanged). The job, to follow on GET /api/jobs. */
	async generate(paper: string, lang: string, force: boolean): Promise<Job> {
		const job = (await this.postJson("/api/generate", { paper, lang, force })) as Job | null;
		if (!job || typeof job.id !== "string") throw new TextFoldError("TextFold's answer to the fold names no job", "format");
		this.forgetDoc(paper);
		return job;
	}

	private async getJson(path: string, missingIsNull = false): Promise<unknown> {
		const r = await this.server();
		if (!r.reachable) throw new TextFoldError(`TextFold is not running at ${r.url}`, "unreachable");
		const res = await this.send(r.url, path, "GET", undefined, READ_MS);
		if (res.status === 404 && missingIsNull) return null;
		if (res.status !== 200) throw new TextFoldError(`TextFold answered ${res.status} to ${path}`, "http");
		return parseJson(res, path);
	}

	private async postJson(path: string, body: unknown): Promise<unknown> {
		const r = await this.server();
		if (!r.reachable) throw new TextFoldError(`TextFold is not running at ${r.url}`, "unreachable");
		const res = await this.send(r.url, path, "POST", JSON.stringify(body), WRITE_MS);
		if (res.status === 200) return parseJson(res, path);
		let code = "";
		try {
			const error = (JSON.parse(res.text) as { error?: unknown }).error;
			if (typeof error === "string") code = error;
		} catch {
			// not JSON: the status says enough
		}
		const kind: ErrorKind = res.status === 409 ? "busy" : res.status === 404 ? "missing" : res.status === 403 ? "refused" : "http";
		throw new TextFoldError(`TextFold answered ${res.status}${code ? ` (${code})` : ""} to ${path}`, kind, code);
	}

	private async send(base: string, path: string, method: "GET" | "POST", body: string | undefined, ms: number): Promise<Reply> {
		try {
			return await this.request(base + path, method, body, ms);
		} catch (e) {
			this.markUnreachable();
			throw new TextFoldError(`TextFold did not answer at ${base} (${(e as Error).message})`, "unreachable");
		}
	}

	private async probe(url: string): Promise<boolean> {
		try {
			const res = await this.request(`${url}/api/models`, "GET", undefined, PROBE_MS);
			return res.status === 200 && /^\s*\{/.test(res.text);
		} catch {
			return false;
		}
	}

	/** One request at a time; one still unanswered after `ms` is given up (the next one goes ahead). */
	private request(url: string, method: "GET" | "POST", body: string | undefined, ms: number): Promise<Reply> {
		if (!loopbackUrl(new URL(url).origin)) return Promise.reject(new Error("not an address on 127.0.0.1"));
		const run = async () => {
			let timer = 0;
			const timeout = new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
			});
			try {
				const req = requestUrl({ url, method, body, contentType: body === undefined ? undefined : "application/json", throw: false });
				const res = await Promise.race([req, timeout]);
				return { status: res.status, text: res.text };
			} finally {
				window.clearTimeout(timer);
			}
		};
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private markUnreachable(): void {
		if (this.resolved) this.resolved = { ...this.resolved, reachable: false };
		this.emit();
	}

	private emit(): void {
		this.listeners.forEach(fn => fn(this.resolved));
	}
}

function parseJson(res: Reply, path: string): unknown {
	try {
		return JSON.parse(res.text) as unknown;
	} catch {
		throw new TextFoldError(`TextFold's answer to ${path} is not JSON`, "format");
	}
}
