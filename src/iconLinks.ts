// A textfold:// link whose label is exactly ↗ (`<text> [↗](textfold://…)`, as "Text with a TextFold icon" drops write
// it) is drawn as TextFold's icon, inline at the text's height. In Reading view a post-processor turns the rendered <a>
// into the icon; the plugin's click handler opens it (with the missing-paper check) and its hover handler previews it.
// In Live Preview it adds one mark decoration, on the ↗, and a class on the arrow widget after it: Obsidian renders the link as it always does
// (its label shown, the address hidden, its own click handling, which the plugin's window.open wrapper takes for
// textfold:), styles.css draws the marked ↗ as the logo and hides the external-link arrow Obsidian puts after it, a
// widget of its own: after each update the plugin gives the arrow that follows an icon in its line the class
// tfb-no-arrow (CodeMirror ignores changes in a widget's DOM), since CSS could only find it with :has. The
// line's DOM stays Obsidian's. (Until 0.5.0 a replace widget at the highest precedence stood in for the whole link,
// next to Obsidian's own widgets for it; a freshly dropped callout was seen drawn one letter per row after the first
// click into it, which switches it to its source lines.) While the cursor is in the link, it shows as written.
// Without the plugin the Markdown still reads as text with a ↗ link.
import { Prec, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
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
	// at the highest precedence the mark is the innermost span, around the glyph alone, inside Obsidian's link spans
	plugin.registerEditorExtension(Prec.highest(iconLinkPlugin));
}

// the ↗, drawn as the logo
const iconMark = Decoration.mark({ class: "tfb-lp-icon", attributes: { "aria-label": "Open in TextFold" } });

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
			builder.add(start + 1, start + 1 + ICON_LABEL.length, iconMark); // the ↗ of [↗](…)
		}
	}
	return builder.finish();
}

const iconLinkPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = build(view);
			markArrowsSoon(view);
		}

		update(u: ViewUpdate): void {
			if (u.docChanged || u.viewportChanged || u.selectionSet || u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false))
				this.decorations = build(u.view);
			markArrowsSoon(u.view);
		}
	},
	{ decorations: v => v.decorations },
);

/** After the view is drawn: the external-link arrow widget Obsidian puts after a link gets tfb-no-arrow when that link
 *  is a TextFold icon, and loses it otherwise (widgets are reused as the text changes). In reading order per line, a
 *  link's arrow is the first one after it. */
function markArrowsSoon(view: EditorView): void {
	view.requestMeasure({
		key: "tfb-no-arrow",
		read: () => null,
		write: () => {
			for (const line of Array.from(view.contentDOM.querySelectorAll(".cm-line"))) {
				let afterIcon = false;
				for (const el of Array.from(line.querySelectorAll(".cm-link, .cm-url.external-link"))) {
					if (el.classList.contains("cm-link")) afterIcon = el.querySelector(".tfb-lp-icon") !== null;
					else {
						el.classList.toggle("tfb-no-arrow", afterIcon);
						afterIcon = false;
					}
				}
			}
		},
	});
}
