// "Import notes": one note per TextFold document, its properties naming the document, and its TextFold notes in a block
// between two marker comments. A new note goes to the folder set in the settings, the folder of the note open when the
// import starts, or the vault's own folder. A re-import finds the note imported before wherever it is now (its
// `textfold:` property and the importer's block), replaces only that block and the properties it set, and keeps
// everything written around them: a document never gets a second note.
import { App, FuzzyMatch, FuzzySuggestModal, Notice, TFile, normalizePath } from "obsidian";
import type { TextFoldClient } from "./client";
import { Doc, yearOf } from "./doc";
import { buildLink } from "./links";
import { Paper } from "./notes";
import { BLOCK_START, ImportLocation, importTarget, isImportedNote, noteFileName, notesBlock, replaceBlock } from "./notesMarkdown";

export interface ImportOptions {
	location: ImportLocation;
	folder: string;
	byCitekey: boolean; // name the notes by citekey when TextFold lists one
}

type Outcome = { id: string; file?: TFile; result: "new" | "updated" | "unchanged" | "missing" | "failed"; error?: string };

const VERB = { new: "Created", updated: "Updated", unchanged: "Unchanged:" } as const;

export class Importer {
	constructor(private app: App, private client: TextFoldClient, private options: () => ImportOptions) {}

	/** Import these documents' notes, one at a time, and say in one notice what happened. `current` is the note the
	 *  import starts from (the sidebar's note), else the active one. */
	async importPapers(ids: string[], current?: TFile | null): Promise<TFile[]> {
		const opts = this.options();
		const from = current !== undefined ? current : this.app.workspace.getActiveFile();
		const note = from && from.extension === "md" ? from : null;
		const target = importTarget(opts.location, opts.folder, opts.location === "current" ? (note?.parent?.path ?? null) : null);
		let papers: Paper[] = [];
		try {
			papers = await this.client.papers();
		} catch (e) {
			new Notice((e as Error).message);
			return [];
		}
		const byId = new Map(papers.map(p => [p.id, p]));
		const out: Outcome[] = [];
		for (const id of ids) out.push(await this.importOne(id, byId.get(id), target.folder));
		const files = out.flatMap(o => (o.file ? [o.file] : []));
		const lines = out.flatMap(o => (o.file && (o.result === "new" || o.result === "updated" || o.result === "unchanged") ? [`${VERB[o.result]} ${o.file.basename} in ${where(o.file)}`] : []));
		const shown = lines.slice(0, 4);
		if (lines.length > shown.length) shown.push(`and ${lines.length - shown.length} more`);
		const missing = out.filter(o => o.result === "missing").length;
		if (missing) shown.push(`${missing} not in TextFold`);
		const failed = out.filter(o => o.result === "failed");
		if (failed.length) shown.push(`${failed.length} failed: ${failed[0].error ?? ""}`);
		if (target.fallback && out.some(o => o.result === "new")) shown.push(`No note was open, so new notes went to ${target.folder}.`);
		new Notice(shown.join("\n") || "Nothing imported.", 8000);
		return files;
	}

	private async importOne(id: string, paper: Paper | undefined, folder: string): Promise<Outcome> {
		try {
			const nf = await this.client.notes(id);
			if (!nf) return { id, result: "missing" };
			let doc: Doc | null = null;
			try {
				doc = await this.client.doc(id);
			} catch {
				doc = null; // an older TextFold: the notes without section names
			}
			const block = notesBlock(nf, doc);
			const title = doc?.title || paper?.title || nf.paper.title;
			const props: Record<string, unknown> = {
				textfold: id,
				title,
				authors: doc?.authors.length ? doc.authors : paper?.authors.length ? paper.authors : undefined,
				year: yearOf(doc?.date ?? ""),
				citekey: paper?.citekey,
				link: buildLink({ paper: id }),
			};
			const existing = await this.findImported(id, folder);
			if (existing) {
				const text = await this.app.vault.read(existing);
				const next = replaceBlock(text, block);
				const changed = next !== text;
				if (changed) await this.app.vault.process(existing, t => replaceBlock(t, block));
				const propsChanged = await this.setProps(existing, props);
				return { id, file: existing, result: changed || propsChanged ? "updated" : "unchanged" };
			}
			const file = await this.app.vault.create(await this.freePath(noteFileName(title, paper?.citekey, this.options().byCitekey), id, folder), `${block}\n`);
			await this.setProps(file, props);
			return { id, file, result: "new" };
		} catch (e) {
			return { id, result: "failed", error: (e as Error).message };
		}
	}

	/** The note imported before for this document, anywhere in the vault (it may have been moved): one whose
	 *  `textfold:` property is the id and that holds the importer's block. One in the target folder first. */
	private async findImported(id: string, folder: string): Promise<TFile | undefined> {
		const prop = (f: TFile): unknown => this.app.metadataCache.getFileCache(f)?.frontmatter?.textfold;
		const named = this.app.vault.getMarkdownFiles().filter(f => isImportedNote(prop(f), BLOCK_START, id)); // the property first: no file read
		const found: TFile[] = [];
		for (const f of named) if (isImportedNote(prop(f), await this.app.vault.cachedRead(f), id)) found.push(f);
		return found.find(f => (f.parent?.path === "/" ? "" : f.parent?.path) === folder) ?? found[0];
	}

	private async freePath(name: string, id: string, folder: string): Promise<string> {
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		const at = (file: string) => normalizePath(folder ? `${folder}/${file}` : file);
		for (const candidate of [name, `${name} (${id})`]) {
			const path = at(`${candidate}.md`);
			if (!this.app.vault.getAbstractFileByPath(path)) return path;
		}
		for (let i = 2; ; i++) {
			const path = at(`${name} (${id}) ${i}.md`);
			if (!this.app.vault.getAbstractFileByPath(path)) return path;
		}
	}

	/** Set the properties the import owns; others stay. True when one changed. */
	private async setProps(file: TFile, props: Record<string, unknown>): Promise<boolean> {
		const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
		const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
		const changed = Object.entries(props).some(([k, v]) => (v === undefined ? k in fm : !same(fm[k], v)));
		if (!changed) return false;
		await this.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
			for (const [k, v] of Object.entries(props)) {
				if (v === undefined) delete f[k];
				else f[k] = v;
			}
		});
		return true;
	}
}

const ALL = "all" as const;

/** "Import notes from TextFold": every document with notes, or one picked by title, id or citekey. */
export class ImportPicker extends FuzzySuggestModal<Paper | typeof ALL> {
	constructor(app: App, private papers: Paper[], private pick: (ids: string[]) => void) {
		super(app);
		this.setPlaceholder("Import the notes of a TextFold document");
		this.limit = 200;
	}

	private withNotes(): Paper[] {
		return this.papers.filter(p => p.notes > 0);
	}

	getItems(): (Paper | typeof ALL)[] {
		return [ALL, ...this.papers];
	}

	getItemText(p: Paper | typeof ALL): string {
		return p === ALL ? "All documents with notes" : [p.title, p.id, p.citekey ?? ""].join(" ");
	}

	renderSuggestion(match: FuzzyMatch<Paper | typeof ALL>, el: HTMLElement): void {
		const p = match.item;
		el.addClass("tfb-suggestion");
		if (p === ALL) {
			el.createSpan({ cls: "tfb-suggestion-title", text: "All documents with notes" });
			el.createSpan({ cls: "tfb-suggestion-meta", text: String(this.withNotes().length) });
			return;
		}
		el.createSpan({ cls: "tfb-suggestion-title", text: p.title });
		el.createSpan({ cls: "tfb-suggestion-meta", text: [p.notes ? `${p.notes} notes` : "", p.citekey, p.id].filter(Boolean).join(" · ") });
	}

	onChooseItem(p: Paper | typeof ALL): void {
		this.pick(p === ALL ? this.withNotes().map(x => x.id) : [p.id]);
	}
}

/** "Research/Convex", or "the vault folder" for a note at the top. */
function where(file: TFile): string {
	const p = file.parent?.path ?? "";
	return p && p !== "/" ? p : "the vault folder";
}
