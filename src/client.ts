// The TextFold client: GET requests to TextFold's server on 127.0.0.1 only, one at a time, each given up after a
// short timeout. It never POSTs: in 0.1 the plugin only reads.
import { requestUrl } from "obsidian";
import { NotesFile, Paper, parseNotes, parsePapers } from "./notes";
import { Resolved, loopbackUrl, resolveServer } from "./server";

export type Address = { mode: "auto" | "manual"; manualUrl: string };

export class TextFoldError extends Error {
	constructor(message: string, readonly kind: "unreachable" | "http" | "format") {
		super(message);
	}
}

const PROBE_MS = 2500;
const READ_MS = 8000;
const FRESH_MS = 60_000; // an address that answered is used this long without asking again

export class TextFoldClient {
	private queue: Promise<unknown> = Promise.resolve();
	private resolved: (Resolved & { at: number }) | null = null;
	private checking: Promise<Resolved> | null = null;
	private listeners = new Set<(state: Resolved | null) => void>();

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
		this.emit();
	}

	/** Look for TextFold now: server.json, else the default port, or the manual address; and whether it answers.
	 *  Calls made while a check runs share it. */
	check(): Promise<Resolved> {
		this.checking ??= (async () => {
			try {
				const { mode, manualUrl } = this.address();
				const r = await resolveServer(mode, manualUrl, { probe: url => this.probe(url) });
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

	/** A document's notes, or null when TextFold has no document with this id. */
	async notes(id: string): Promise<NotesFile | null> {
		const data = await this.getJson(`/api/notes/${encodeURIComponent(id)}`, true);
		return data === null ? null : parseNotes(data, id);
	}

	private async getJson(path: string, missingIsNull = false): Promise<unknown> {
		const r = await this.server();
		if (!r.reachable) throw new TextFoldError(`TextFold is not running at ${r.url}`, "unreachable");
		let res;
		try {
			res = await this.get(r.url + path, READ_MS);
		} catch (e) {
			this.markUnreachable();
			throw new TextFoldError(`TextFold did not answer at ${r.url} (${(e as Error).message})`, "unreachable");
		}
		if (res.status === 404 && missingIsNull) return null;
		if (res.status !== 200) throw new TextFoldError(`TextFold answered ${res.status} to ${path}`, "http");
		try {
			return JSON.parse(res.text) as unknown;
		} catch {
			throw new TextFoldError(`TextFold's answer to ${path} is not JSON`, "format");
		}
	}

	private async probe(url: string): Promise<boolean> {
		try {
			const res = await this.get(`${url}/api/models`, PROBE_MS);
			return res.status === 200 && /^\s*\{/.test(res.text);
		} catch {
			return false;
		}
	}

	/** One GET at a time; a request still unanswered after `ms` is given up (the next one goes ahead). */
	private get(url: string, ms: number): Promise<{ status: number; text: string }> {
		const base = loopbackUrl(new URL(url).origin);
		if (!base) return Promise.reject(new Error("not an address on 127.0.0.1"));
		const run = async () => {
			let timer = 0;
			const timeout = new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
			});
			try {
				const res = await Promise.race([requestUrl({ url, method: "GET", throw: false }), timeout]);
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
