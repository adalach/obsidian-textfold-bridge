// "Fold this note": a note's text (Obsidian syntax flattened) sent to TextFold as a Markdown document, its id kept in the
// note's `textfold:` property, and folded in a language. The plugin keeps, per document, a hash of what it sent, so it
// can tell when the note has changed since; a refold puts the new text in place of the old under the same id (TextFold
// finds its notes again in it) and folds it again. Progress comes from GET /api/jobs while a fold runs.
import { App, Notice, TFile } from "obsidian";
import { Job, TextFoldClient, TextFoldError } from "./client";
import { flattenNote, textHash } from "./flatten";
import { isPaperId, withId, withoutId } from "./links";

export interface FoldRecord {
	paper: string; // the md-… document the note became
	path: string; // the note, when last folded (for display; the note is found by its property)
	hash: string; // of the text sent
	lang: string;
	at: string; // ISO time of the last fold
	job?: string; // the last fold's job
}

export type FoldState =
	| { kind: "folding"; job: Job | null }
	| { kind: "failed"; error: string }
	| { kind: "changed" }
	| { kind: "folded" };

const POLL_MS = 1500;

export class Folds {
	private jobs = new Map<string, Job>(); // paper -> its fold's last known job
	private polling = false;
	private timer = 0;
	private listeners = new Set<() => void>();

	constructor(
		private app: App,
		private client: TextFoldClient,
		private records: () => Record<string, FoldRecord>,
		private save: () => Promise<void>,
		private lang: () => string,
	) {}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	stop(): void {
		window.clearTimeout(this.timer);
		this.polling = false;
	}

	/** The fold this note is: a document in its `textfold:` property that the plugin folded. */
	recordFor(file: TFile): FoldRecord | undefined {
		const records = this.records();
		return propertyIds(this.app, file).map(id => records[id]).find(Boolean);
	}

	/** What the sidebar says about a folded note. */
	async state(file: TFile, rec: FoldRecord): Promise<FoldState> {
		const job = this.jobs.get(rec.paper);
		if (job && (job.status === "queued" || job.status === "running")) return { kind: "folding", job };
		if (job?.status === "error") return { kind: "failed", error: job.error === "no-model" ? "TextFold has no model connected" : job.error || "unknown error" };
		const { hash } = await this.prepare(file);
		return hash === rec.hash ? { kind: "folded" } : { kind: "changed" };
	}

	/** Fold the note, or fold it again when it has changed since. */
	async fold(file: TFile): Promise<void> {
		const rec = this.recordFor(file);
		const { text, hash } = await this.prepare(file);
		if (!text.trim()) {
			new Notice("This note has no text to fold.");
			return;
		}
		const lang = this.lang();
		const running = rec && this.jobs.get(rec.paper);
		if (running && (running.status === "queued" || running.status === "running")) {
			new Notice("TextFold is still folding this note.");
			return;
		}
		try {
			if (rec && rec.hash === hash && rec.lang === lang) {
				new Notice("This note has not changed since it was folded.");
				return;
			}
			let paper: string;
			let force = false;
			if (rec && rec.hash !== hash) {
				try {
					paper = (await this.client.importText(`${file.basename}.md`, text, rec.paper)).paper;
				} catch (e) {
					if (e instanceof TextFoldError && e.kind === "missing") {
						await this.forget(file, rec.paper);
						new Notice(`TextFold no longer has this note's document (${rec.paper}). Run "Fold this note" again to fold it anew.`, 10_000);
						return;
					}
					throw e;
				}
				force = true;
			} else if (rec) paper = rec.paper; // the same text, in another language
			else {
				paper = (await this.client.importText(`${file.basename}.md`, text)).paper;
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					fm.textfold = withId(fm.textfold, paper);
				});
			}
			const job = await this.client.generate(paper, lang, force);
			this.records()[paper] = { paper, path: file.path, hash, lang, at: new Date().toISOString(), job: job.id };
			await this.save();
			this.jobs.set(paper, job);
			this.emit();
			this.poll();
			new Notice(force ? "Folding the note again in TextFold…" : "Folding the note in TextFold…");
		} catch (e) {
			new Notice(foldError(e), 10_000);
		}
	}

	/** Ask TextFold once about the last fold of these documents (the sidebar shows them). */
	async refreshJobs(papers: string[]): Promise<void> {
		const records = this.records();
		const wanted = papers.filter(p => records[p]?.job);
		if (!wanted.length) return;
		const jobs = await this.client.jobs();
		for (const p of wanted) {
			const job = jobs.find(j => j.id === records[p].job);
			if (job) this.jobs.set(p, job);
		}
		if (jobs.some(j => j.status === "queued" || j.status === "running")) this.poll();
	}

	/** The note's text as it would be sent, and its hash. */
	private async prepare(file: TFile): Promise<{ text: string; hash: string }> {
		const raw = await this.app.vault.cachedRead(file);
		const title: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
		const text = flattenNote(raw, title);
		return { text, hash: await textHash(text) };
	}

	private async forget(file: TFile, paper: string): Promise<void> {
		delete this.records()[paper];
		this.jobs.delete(paper);
		await this.save();
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const left = withoutId(fm.textfold, paper);
			if (left === undefined) delete fm.textfold;
			else fm.textfold = left;
		});
		this.emit();
	}

	/** Follow the folds under way on GET /api/jobs until they end. */
	private poll(): void {
		if (this.polling) return;
		this.polling = true;
		const tick = async () => {
			let active = false;
			try {
				const jobs = await this.client.jobs();
				for (const [paper, job] of this.jobs) {
					if (job.status !== "queued" && job.status !== "running") continue;
					const now = jobs.find(j => j.id === job.id) ?? { ...job, status: "done" as const }; // gone from the list: long over
					this.jobs.set(paper, now);
					if (now.status === "queued" || now.status === "running") active = true;
					else {
						this.client.forgetDoc(paper);
						if (now.status === "done") new Notice("TextFold has folded the note.");
					}
				}
			} catch {
				active = false; // TextFold went away: the sidebar says so
			}
			this.emit();
			if (active) this.timer = window.setTimeout(() => void tick(), POLL_MS);
			else this.polling = false;
		};
		this.timer = window.setTimeout(() => void tick(), POLL_MS);
	}

	private emit(): void {
		this.listeners.forEach(fn => fn());
	}
}

/** The documents named in a note's `textfold:` property. */
function propertyIds(app: App, file: TFile): string[] {
	const v: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.textfold;
	const list: unknown[] = Array.isArray(v) ? v : [v];
	return list.map(x => (typeof x === "number" ? String(x) : x)).filter((x): x is string => typeof x === "string" && isPaperId(x.trim())).map(x => x.trim());
}

function foldError(e: unknown): string {
	if (!(e instanceof TextFoldError)) return `Folding failed: ${String(e)}`;
	if (e.kind === "busy") return "TextFold is still folding this note. Fold it again when that is done.";
	if (e.kind === "unreachable") return `${e.message}. Start TextFold, then fold the note again.`;
	if (e.kind === "refused") return "TextFold refused the request (403).";
	if (e.code === "empty") return "This note has no text to fold.";
	if (e.code === "not-markdown") return "TextFold did not take the note as Markdown.";
	return `Folding failed: ${e.message}`;
}
