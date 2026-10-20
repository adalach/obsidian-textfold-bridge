// A textfold:// link whose label is exactly ↗ (`<text> [↗](textfold://…)`, as "Text with a TextFold icon" drops write
// it) is drawn as TextFold's icon, inline at the text's height: in Reading view by a post-processor, in Live Preview by
// a CodeMirror decoration that shows the Markdown again while the cursor is in the link. The icon is an
// <a href="textfold://…">, so the plugin's click handler opens it (with the missing-paper check) and its hover handler
// previews it. Without the plugin the Markdown still reads as text with a ↗ link.
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { Plugin, editorLivePreviewField, setIcon } from "obsidian";
import { ICON_LABEL } from "./drag";
import { ICON } from "./icon";
import { parseLink } from "./links";

const ICON_LINK = /\[↗\]\((textfold:\/\/open\/?\?[^)\s]*)\)/g;

/** Make an <a> the icon: TextFold's logo instead of the ↗ label, without Obsidian's external-link arrow. */
function asIcon(a: HTMLElement): void {
	a.addClass("tfb-icon-link");
	a.setAttr("aria-label", "Open in TextFold");
	a.empty();
	setIcon(a, ICON);
}

export function installIconLinks(plugin: Plugin): void {
	plugin.registerMarkdownPostProcessor(el => {
		el.querySelectorAll<HTMLElement>('a.external-link[href^="textfold:" i]').forEach(a => {
			if (a.textContent === ICON_LABEL && parseLink(a.getAttribute("href") ?? "")) asIcon(a);
		});
	});
	plugin.registerEditorExtension(iconLinkPlugin);
}

class IconWidget extends WidgetType {
	constructor(readonly href: string) {
		super();
	}

	eq(other: IconWidget): boolean {
		return other.href === this.href;
	}

	toDOM(): HTMLElement {
		const a = createEl("a", { cls: "external-link", href: this.href });
		asIcon(a);
		return a;
	}

	// a click opens the link (the plugin's capture handler) instead of putting the cursor in it
	ignoreEvent(): boolean {
		return true;
	}
}

/** Where code is in these lines: fenced blocks, and inline code spans by their backticks. */
function inCode(view: EditorView, from: number): (pos: number) => boolean {
	const doc = view.state.doc;
	let fence = false;
	const first = doc.lineAt(from).number;
	for (let n = 1; n < first; n++) if (/^\s{0,3}(`{3,}|~{3,})/.test(doc.line(n).text)) fence = !fence;
	const fenced = new Set<number>();
	for (let n = first; n <= doc.lines && doc.line(n).from <= view.viewport.to; n++) {
		const isFence = /^\s{0,3}(`{3,}|~{3,})/.test(doc.line(n).text);
		if (fence || isFence) fenced.add(n);
		if (isFence) fence = !fence;
	}
	return pos => {
		const line = doc.lineAt(pos);
		if (fenced.has(line.number)) return true;
		const ticks = (line.text.slice(0, pos - line.from).match(/`/g) ?? []).length;
		return ticks % 2 === 1;
	};
}

function build(view: EditorView): DecorationSet {
	if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
	const builder = new RangeSetBuilder<Decoration>();
	const ranges = view.state.selection.ranges;
	for (const { from, to } of view.visibleRanges) {
		const code = inCode(view, from);
		const text = view.state.doc.sliceString(from, to);
		for (const m of text.matchAll(ICON_LINK)) {
			const start = from + (m.index ?? 0);
			const end = start + m[0].length;
			if (ranges.some(r => r.from <= end && r.to >= start) || code(start) || !parseLink(m[1])) continue;
			builder.add(start, end, Decoration.replace({ widget: new IconWidget(m[1]) }));
		}
	}
	return builder.finish();
}

const iconLinkPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = build(view);
		}

		update(u: ViewUpdate): void {
			if (u.docChanged || u.viewportChanged || u.selectionSet || u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false))
				this.decorations = build(u.view);
		}
	},
	{ decorations: v => v.decorations },
);
