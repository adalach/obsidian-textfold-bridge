// Drops and pastes from TextFold into any Markdown note: the item goes in where it was dropped (or at the cursor for a
// paste) as a callout, a quote with its link, or the link alone. Every other drop and paste is left to Obsidian.
import type { EditorView } from "@codemirror/view";
import { Editor, EditorPosition, Plugin } from "obsidian";
import type { TextFoldClient } from "./client";
import { DragItem, DropMode, formatItem, isItem, itemFromLink, readTransfer } from "./drag";
import { TextFoldLink } from "./links";

export class Drops {
	constructor(private plugin: Plugin, private client: TextFoldClient, private mode: () => DropMode) {}

	install(): void {
		const { workspace } = this.plugin.app;
		this.plugin.registerEvent(workspace.on("editor-drop", (evt, editor) => this.onDrop(evt, editor)));
		this.plugin.registerEvent(workspace.on("editor-paste", (evt, editor) => this.onPaste(evt, editor)));
	}

	private onDrop(evt: DragEvent, editor: Editor): void {
		if (evt.defaultPrevented || !evt.dataTransfer) return;
		const found = readTransfer(evt.dataTransfer);
		if (!found) return;
		evt.preventDefault(); // handled here, at once: the position is the one under the pointer now
		const at = dropPosition(editor, evt) ?? editor.getCursor();
		void this.insert(editor, found, at);
	}

	private onPaste(evt: ClipboardEvent, editor: Editor): void {
		if (evt.defaultPrevented || !evt.clipboardData) return;
		const found = readTransfer(evt.clipboardData);
		if (!found) return;
		evt.preventDefault();
		const from = editor.getCursor("from");
		editor.replaceSelection("");
		void this.insert(editor, found, from);
	}

	private async insert(editor: Editor, found: DragItem | TextFoldLink, at: EditorPosition): Promise<void> {
		const item = isItem(found) ? found : await this.fromLink(found);
		const mode = this.mode();
		const md = formatItem(item, mode);
		// a link, or text with the icon dropped among words, goes in among them; anything else on lines of its own
		const amongWords = editor.getLine(at.line).trim() !== "";
		const text = mode === "link" || (mode === "icon" && amongWords) ? inline(editor, at, md) : asBlock(editor, at, md);
		editor.replaceRange(text, at);
		editor.setCursor(editor.offsetToPos(editor.posToOffset(at) + text.length));
	}

	/** A plain link, with its title, section and text from TextFold when it answers. */
	private async fromLink(link: TextFoldLink): Promise<DragItem> {
		const doc = await this.client.doc(link.paper, link.lang).catch(() => null);
		const nf = link.n ? await this.client.notes(link.paper).catch(() => null) : null;
		const paper = await this.client.paperInfo(link.paper).catch(() => null);
		return itemFromLink(link, doc, nf, paper?.citekey);
	}
}

/** The editor position nearest a drop's pointer (CodeMirror's posAtCoords, not only over text: a drop beside a short
 *  or empty line goes to that line), or null without CodeMirror. */
function dropPosition(editor: Editor, evt: DragEvent): EditorPosition | null {
	const cm = (editor as unknown as { cm?: EditorView }).cm;
	return cm ? editor.offsetToPos(cm.posAtCoords({ x: evt.clientX, y: evt.clientY }, false)) : null;
}

/** A link among words, with a space on either side where it would touch one. */
function inline(editor: Editor, at: EditorPosition, md: string): string {
	const line = editor.getLine(at.line);
	const before = line.slice(0, at.ch);
	const after = line.slice(at.ch);
	return `${before && !/\s$/.test(before) ? " " : ""}${md}${after && !/^\s/.test(after) ? " " : ""}`;
}

/** A callout or quote on lines of its own, with blank lines around it: in the middle of a paragraph it splits it. */
function asBlock(editor: Editor, at: EditorPosition, md: string): string {
	const line = editor.getLine(at.line);
	const before = line.slice(0, at.ch);
	const after = line.slice(at.ch);
	const prevFull = at.line > 0 && editor.getLine(at.line - 1).trim() !== "";
	const nextFull = at.line < editor.lastLine() && editor.getLine(at.line + 1).trim() !== "";
	const prefix = before.trim() ? "\n\n" : prevFull ? "\n" : "";
	const suffix = after.trim() ? "\n\n" : nextFull ? "\n" : "";
	return prefix + md + suffix;
}
