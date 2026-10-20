// "Import notes": one note per TextFold document in a folder of the vault, its properties naming the document, and its
// TextFold notes in a block between two marker comments. A re-import finds the note by its `textfold:` property,
// replaces only that block and the properties it set, and keeps everything written around them.
import { App, FuzzyMatch, FuzzySuggestModal, Notice, TFile, normalizePath } from "obsidian";
import type { TextFoldClient } from "./client";
import { Doc, yearOf } from "./doc";
import { buildLink } from "./links";
import { Paper } from "./notes";
import { noteFileName, notesBlock, replaceBlock } from "./notesMarkdown";

export interface ImportOptions {
	folder: string;
	byCitekey: boolean; // name the notes by citekey when TextFold lists one
}

type Outcome = { id: string; file?: TFile; result: "new" | "updated" | "unchanged" | "missing" | "failed"; error?: string };

export class Importer {
	constructor(private app: App, private client: TextFoldClient, private options: () => ImportOptions) {}

	/** Import these documents' notes, one at a time, and say in one notice what happened. */
	async importPapers(ids: string[]): Promise<TFile[]> {
		let papers: Paper[] = [];
		try {
			papers = await this.client.papers();
		} catch (e) {
			new Notice((e as Error).message);
			return [];
		}
		const byId = new Map(papers.map(p => [p.id, p]));
		const out: Outcome[] = [];
		for (const id of ids) out.push(await this.importOne(id, byId.get(id)));
		const files = out.flatMap(o => (o.file ? [o.file] : []));
		const count = (r: Outcome["result"]) => out.filter(o => o.result === r).length;
		const parts = [["new", count("new")], ["updated", count("updated")], ["unchanged", count("unchanged")], ["not in TextFold", count("missing")], ["failed", count("failed")]]
			.filter(([, n]) => n)
			.map(([w, n]) => `${n} ${w}`);
		const where = files.length === 1 ? files[0].path : this.folder();
		const failed = out.find(o => o.error);
		new Notice(`TextFold notes imported into ${where}: ${parts.join(", ") || "nothing"}.${failed ? ` ${failed.error}` : ""}`, 8000);
		return files;
	}

	private folder(): string {
		return normalizePath(this.options().folder.trim() || "TextFold");
	}

	private async importOne(id: string, paper: Paper | undefined): Promise<Outcome> {
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
				authors: doc?.authors.length ? doc.authors : paper?.authors ?? [],
				year: yearOf(doc?.date ?? ""),
				citekey: paper?.citekey,
				link: buildLink({ paper: id }),
			};
			const existing = this.findImported(id);
			if (existing) {
				const text = await this.app.vault.read(existing);
				const next = replaceBlock(text, block);
				const changed = next !== text;
				if (changed) await this.app.vault.process(existing, t => replaceBlock(t, block));
				const propsChanged = await this.setProps(existing, props);
				return { id, file: existing, result: changed || propsChanged ? "updated" : "unchanged" };
			}
			const file = await this.app.vault.create(await this.freePath(noteFileName(title, paper?.citekey, this.options().byCitekey), id), `${block}\n`);
			await this.setProps(file, props);
			return { id, file, result: "new" };
		} catch (e) {
			return { id, result: "failed", error: (e as Error).message };
		}
	}

	/** The note imported before for this document: in the import folder, with this id as its `textfold:` property. */
	private findImported(id: string): TFile | undefined {
		const prefix = `${this.folder()}/`;
		return this.app.vault.getMarkdownFiles().find(f => f.path.startsWith(prefix) && this.app.metadataCache.getFileCache(f)?.frontmatter?.textfold === id);
	}

	private async freePath(name: string, id: string): Promise<string> {
		const folder = this.folder();
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		for (const candidate of [name, `${name} (${id})`]) {
			const path = normalizePath(`${folder}/${candidate}.md`);
			if (!this.app.vault.getAbstractFileByPath(path)) return path;
		}
		for (let i = 2; ; i++) {
			const path = normalizePath(`${folder}/${name} (${id}) ${i}.md`);
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
