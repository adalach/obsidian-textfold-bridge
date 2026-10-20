// A note's TextFold document: the note's text (Obsidian syntax flattened) sent to TextFold as a Markdown document, its
// id kept in the note's `textfold:` property, and folded in a language. "Export this note to TextFold" and "Fold this
// note" (the fold view) both go through here, so a note has one document, whichever was done first. The plugin keeps, per document, a hash of what it sent, so it
// can tell when the note has changed since; a refold puts the new text in place of the old under the same id (TextFold
// finds its notes again in it) and folds it again. Progress comes from GET /api/jobs while a fold runs.
import { App, Modal, Notice, Setting, TFile, arrayBufferToBase64, normalizePath } from "obsidian";
import { Job, TextFoldClient, TextFoldError } from "./client";
import { ImageRef, PictureReport, describePictures, flattenNote, imageRefs, passesThrough, textHash } from "./flatten";
import { isPaperId, withId, withoutId } from "./links";

export interface FoldRecord {
	paper: string; // the md-… document the note became
	path: string; // the note, when last folded (for display; the note is found by its property)
	hash: string; // of the text sent
	lang: string;
	at: string; // ISO time of the last fold
	job?: string; // the last fold's job
}

/** What a fold() came to: a job started, nothing to do (folded already), or nothing done (asked no, gone, failed). */
export type FoldOutcome = "started" | "unchanged" | "cancelled" | "missing" | "failed" | "busy" | "empty";

export type FoldState =
	| { kind: "folding"; job: Job | null }
	| { kind: "failed"; error: string }
	| { kind: "changed" }
	| { kind: "folded" };

const POLL_MS = 1500;
const MAX_IMAGE = 15_000_000; // TextFold's own limit for one picture (local.py MAX_IMG)
const MIME: Record<string, string> = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp" }; // what TextFold takes


export class Folds {
	private jobs = new Map<string, Job>(); // paper -> its fold's last known job
	private polling = false;
	private timer = 0;
	private listeners = new Set<() => void>();
	private dataUris = new Map<string, { mtime: number; size: number; uri: string }>(); // a vault picture, read once per version

	constructor(
		private app: App,
		private client: TextFoldClient,
		private records: () => Record<string, FoldRecord>,
		private save: () => Promise<void>,
		private lang: () => string,
	) {}

	/** Called when a fold or translation ends well, with whether it was started by "Export this note" (to offer the
	 *  next step: open it in TextFold, or fold it here). */
	onFolded: ((rec: FoldRecord, exported: boolean) => void) | null = null;
	private exported = new Set<string>(); // papers whose last job came from Export

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
		const { hash } = await this.prepare(file);
		if (hash !== rec.hash) return { kind: "changed" };
		if (job?.status === "error") return { kind: "failed", error: job.error === "no-model" ? "no model is connected in TextFold, so it reads as written" : job.error || "unknown error" };
		return { kind: "folded" };
	}

	/** Send the note to TextFold and fold it, or fold it again when it has changed since; `lang` another language than
	 *  the setting's. `exported`: "Export this note" asked (it says so, and offers the next step when done). */
	async fold(file: TFile, opts: { exported?: boolean; lang?: string; quiet?: boolean } = {}): Promise<FoldOutcome> {
		const rec = this.recordFor(file);
		const { text, hash, pictures } = await this.prepare(file);
		if (!text.trim()) {
			new Notice("This note has no text to fold.");
			return "empty";
		}
		const lang = opts.lang ?? this.lang();
		const running = rec && this.jobs.get(rec.paper);
		if (running && (running.status === "queued" || running.status === "running")) {
			if (!opts.quiet) new Notice("TextFold is still folding this note.");
			return "busy";
		}
		try {
			if (rec && rec.hash === hash && (rec.lang === lang || opts.lang === undefined)) {
				const doc = await this.client.doc(rec.paper, lang).catch(() => null);
				if (doc && !doc.local && doc.lang === lang) {
					if (!opts.quiet) new Notice("This note has not changed since it was exported.");
					return "unchanged";
				} // else stored without levels (no model then), or not yet in this language: fold it now
			}
			let paper: string;
			let force = false;
			if (rec && rec.hash !== hash) {
				try {
					paper = (await this.client.importText(`${file.basename}.md`, text, rec.paper)).paper;
				} catch (e) {
					if (e instanceof TextFoldError && e.kind === "missing") {
						await this.forget(file, rec.paper);
						new Notice(`TextFold no longer has this note's document (${rec.paper}). Export or fold the note again to send it anew.`, 10_000);
						return "missing";
					}
					throw e;
				}
				force = true;
			} else if (rec) paper = rec.paper; // the same text: in another language, or still without levels
			else {
				if (!(await confirmFold(this.app, file, lang))) return "cancelled";
				paper = (await this.client.importText(`${file.basename}.md`, text)).paper;
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					fm.textfold = withId(fm.textfold, paper);
				});
			}
			const job = await this.client.generate(paper, lang, force);
			this.records()[paper] = { paper, path: file.path, hash, lang, at: new Date().toISOString(), job: job.id };
			await this.save();
			this.jobs.set(paper, job);
			if (opts.exported) this.exported.add(paper);
			else this.exported.delete(paper);
			this.emit();
			this.poll();
			const what = rec?.lang && rec.lang !== lang && !force ? `Translating the note in TextFold…` : force ? "Folding the note again in TextFold…" : opts.exported ? "Exporting the note to TextFold…" : "Folding the note in TextFold…";
			new Notice(`${what}${describePictures(pictures)}`, pictures.left.length ? 10_000 : 5000);
			return "started";
		} catch (e) {
			new Notice(foldError(e), 10_000);
			return "failed";
		}
	}

	/** The job under way for a document, if any. */
	running(paper: string): Job | null {
		const j = this.jobs.get(paper);
		return j && (j.status === "queued" || j.status === "running") ? j : null;
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
	/** The note's text as it would be sent, its hash (which changes when an embedded picture's file does), and what
	 *  became of its pictures. */
	async prepare(file: TFile): Promise<{ text: string; hash: string; pictures: PictureReport }> {
		const raw = await this.app.vault.cachedRead(file);
		const title: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
		const { map, report } = await this.pictures(file, raw);
		const text = flattenNote(raw, title, map);
		return { text, hash: await textHash(text), pictures: report };
	}

	/** The vault pictures the note embeds, as data-URI images TextFold stores with the document: PNG, JPEG, GIF and
	 *  WebP up to 15 MB. Web pictures go as they are; SVG, larger files and embeds that lead nowhere are left out. */
	private async pictures(file: TFile, raw: string): Promise<{ map: Map<string, string>; report: PictureReport }> {
		const map = new Map<string, string>();
		const report: PictureReport = { sent: 0, left: [] };
		for (const ref of imageRefs(raw)) {
			if (passesThrough(ref)) {
				report.sent++;
				continue;
			}
			const dest = this.pictureFile(ref, file);
			const name = dest?.name ?? ref.target;
			const ext = dest?.extension.toLowerCase() ?? "";
			if (!dest) {
				if (ref.kind === "markdown" || /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|avif)$/i.test(ref.target)) report.left.push({ name, why: "not found in the vault" });
				continue; // (an embed of a note or a PDF is no picture: dropped, as always)
			}
			if (ext === "svg") {
				report.left.push({ name, why: "SVG" });
				continue;
			}
			if (!MIME[ext]) {
				if (ref.kind === "markdown") report.left.push({ name, why: `not a picture TextFold takes (.${ext})` });
				continue;
			}
			if (dest.stat.size > MAX_IMAGE) {
				report.left.push({ name, why: "over 15 MB" });
				continue;
			}
			let hit = this.dataUris.get(dest.path);
			if (!hit || hit.mtime !== dest.stat.mtime || hit.size !== dest.stat.size) {
				hit = { mtime: dest.stat.mtime, size: dest.stat.size, uri: `data:image/${MIME[ext]};base64,${arrayBufferToBase64(await this.app.vault.readBinary(dest))}` };
				this.dataUris.set(dest.path, hit);
			}
			const alt = (ref.alt || dest.basename).replace(/[[\]\n]/g, " ").trim();
			map.set(ref.raw, `![${alt}](${hit.uri})`);
			report.sent++;
		}
		return { map, report };
	}

	/** The vault file a picture points at, as Obsidian resolves it: a link path from the note, else a path relative to
	 *  the note's folder. */
	private pictureFile(ref: ImageRef, note: TFile): TFile | null {
		const found = this.app.metadataCache.getFirstLinkpathDest(ref.target, note.path);
		if (found) return found;
		if (ref.kind !== "markdown") return null;
		const folder = note.parent?.path ?? "";
		const rel = this.app.vault.getAbstractFileByPath(normalizePath(folder && folder !== "/" ? `${folder}/${ref.target}` : ref.target));
		return rel instanceof TFile ? rel : null;
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
						const rec = this.records()[paper];
						if (now.status === "done" && rec && this.onFolded) this.onFolded(rec, this.exported.has(paper));
						else if (now.status === "done") new Notice("TextFold has folded the note.");
						this.exported.delete(paper);
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

/** A note's first fold, asked once: it sends the note's text to TextFold, and TextFold's model writes its levels. */
function confirmFold(app: App, file: TFile, lang: string): Promise<boolean> {
	return new Promise(resolve => {
		let answered = false;
		const modal = new Modal(app);
		const answer = (yes: boolean) => {
			answered = true;
			resolve(yes);
			modal.close();
		};
		modal.setTitle(`Fold "${file.basename}" in TextFold?`);
		modal.contentEl.createEl("p", {
			text: `TextFold stores the note's text and writes its levels in ${lang} with the model set up in TextFold. The note gets a textfold property with the document's id.`,
		});
		new Setting(modal.contentEl)
			.addButton(b => b.setButtonText("Cancel").onClick(() => answer(false)))
			.addButton(b => b.setButtonText("Fold").setCta().onClick(() => answer(true)));
		modal.onClose = () => {
			if (!answered) resolve(false);
		};
		modal.open();
	});
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
