// Going to a citation in its note: the note's editor scrolls it to the middle, puts the cursor on it and lights it up
// for a moment (a CodeMirror mark, nothing selected, so typing cannot replace it); Reading view scrolls to its line and
// lights the line as Obsidian does for search results.
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { App, MarkdownView, TFile } from "obsidian";

const FLASH_MS = 1600;

const flash = StateEffect.define<{ from: number; to: number } | null>();

/** The editor extension that draws the light-up (registered once by the plugin). */
export const flashField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const e of tr.effects) {
			if (e.is(flash)) deco = e.value ? Decoration.set([Decoration.mark({ class: "tfb-flash" }).range(e.value.from, e.value.to)]) : Decoration.none;
		}
		return deco;
	},
	provide: f => EditorView.decorations.from(f),
});

/** Show this place of the note: in the tab that has it (the most recent one), else in a new one. */
export async function jumpTo(app: App, file: TFile, from: number, to: number, line: number, href: string, nth: number): Promise<void> {
	const { workspace } = app;
	const recent = workspace.getMostRecentLeaf();
	let leaf = recent?.view instanceof MarkdownView && recent.view.file === file ? recent : workspace.getLeavesOfType("markdown").find(l => l.view instanceof MarkdownView && l.view.file === file);
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.openFile(file);
	}
	await workspace.revealLeaf(leaf);
	workspace.setActiveLeaf(leaf, { focus: true });
	const view = leaf.view;
	if (!(view instanceof MarkdownView)) return;
	if (view.getMode() === "preview") {
		view.setEphemeralState({ line }); // scrolls there and lights the line up
		window.setTimeout(() => lightRendered(view, href, nth), 350);
		return;
	}
	const cm = (view.editor as unknown as { cm?: EditorView }).cm;
	if (!cm) {
		view.editor.setCursor(view.editor.offsetToPos(from));
		view.editor.scrollIntoView({ from: view.editor.offsetToPos(from), to: view.editor.offsetToPos(to) }, true);
		return;
	}
	const end = Math.min(to, cm.state.doc.length);
	cm.dispatch({ selection: { anchor: from }, effects: [flash.of({ from, to: end }), EditorView.scrollIntoView(from, { y: "center" })] });
	view.editor.focus();
	window.setTimeout(() => cm.dispatch({ effects: flash.of(null) }), FLASH_MS);
}

/** In Reading view, light up the rendered link itself: the nth link to this address in the note. */
function lightRendered(view: MarkdownView, href: string, nth: number): void {
	const links = [...view.previewMode.containerEl.querySelectorAll<HTMLElement>("a[href]")].filter(a => a.getAttribute("href") === href);
	const a = links[Math.min(nth, links.length - 1)];
	if (!a) return;
	a.addClass("tfb-flash");
	window.setTimeout(() => a.removeClass("tfb-flash"), FLASH_MS);
}
