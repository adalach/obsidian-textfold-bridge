// "Insert link to a TextFold paper": a fuzzy picker over TextFold's documents (title, id, citekey when TextFold
// lists one) that inserts [Title](textfold://open?paper=ID) at the cursor, or links the selected text.
import { App, Editor, FuzzyMatch, FuzzySuggestModal, Notice } from "obsidian";
import type { TextFoldClient } from "./client";
import { markdownLink } from "./links";
import { Paper } from "./notes";

class PaperPicker extends FuzzySuggestModal<Paper> {
	constructor(app: App, private papers: Paper[], private pick: (p: Paper) => void) {
		super(app);
		this.setPlaceholder("Find a TextFold document by title, ID or citekey");
		this.limit = 200;
	}

	getItems(): Paper[] {
		return this.papers;
	}

	getItemText(p: Paper): string {
		return [p.title, p.id, p.citekey ?? ""].join(" ");
	}

	renderSuggestion(match: FuzzyMatch<Paper>, el: HTMLElement): void {
		const p = match.item;
		el.addClass("tfb-suggestion");
		el.createSpan({ cls: "tfb-suggestion-title", text: p.title });
		el.createSpan({ cls: "tfb-suggestion-meta", text: [p.citekey, p.id].filter(Boolean).join(" · ") });
		el.setAttr("title", [p.title, p.authors.join(", "), p.citekey, p.id].filter(Boolean).join("\n"));
	}

	onChooseItem(p: Paper): void {
		this.pick(p);
	}
}

export async function insertPaperLink(app: App, client: TextFoldClient, editor: Editor): Promise<void> {
	let papers: Paper[];
	try {
		papers = await client.papers();
	} catch (e) {
		new Notice((e as Error).message);
		return;
	}
	if (!papers.length) {
		new Notice("TextFold has no documents yet.");
		return;
	}
	const selected = editor.getSelection();
	new PaperPicker(app, papers, p => editor.replaceSelection(markdownLink(selected || p.title, { paper: p.id }))).open();
}
