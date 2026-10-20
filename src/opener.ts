// Opening textfold:// links. Obsidian opens an external link through window.open in Live Preview (the link is a
// CodeMirror token, not an <a>) and in Reading view (a click on a.external-link); a plain window.open of an unknown
// scheme asks before handing it to the system. So: a capture-phase click handler takes a[href^="textfold:"] in Reading
// view, embeds, hover previews and this plugin's sidebar, and a wrapper around window.open takes textfold: URLs from
// Live Preview. Everything else passes through untouched; the wrapper is removed on unload.
import { Notice, Plugin } from "obsidian";
import type { TextFoldClient } from "./client";
import { TextFoldLink, buildLink, parseLink, readerUrl } from "./links";

type OpenFn = typeof window.open;

const isTextFold = (url: unknown): url is string | URL => (typeof url === "string" || url instanceof URL) && /^textfold:/i.test(String(url));

export class LinkOpener {
	private nativeOpen: OpenFn = (...args) => window.open(...args);

	constructor(private client: TextFoldClient, private openIn: () => "browser" | "app") {}

	install(plugin: Plugin): void {
		const win = window;
		const original = Object.getOwnPropertyDescriptor(win, "open");
		const prev = (original?.value ?? win.open.bind(win)) as OpenFn;
		const take = (url: string) => void this.open(url);
		let on = true;
		const wrapped = function (this: Window, ...args: Parameters<OpenFn>): ReturnType<OpenFn> {
			if (on && isTextFold(args[0])) {
				take(String(args[0]));
				return null;
			}
			return prev.apply(this, args);
		};
		win.open = wrapped;
		this.nativeOpen = (...args) => prev.apply(win, args);
		plugin.register(() => {
			on = false; // if another plugin wrapped window.open after this one, ours stays in its chain as a pass-through
			if (win.open === wrapped) {
				if (original) Object.defineProperty(win, "open", original);
				else delete (win as { open?: OpenFn }).open;
			}
		});

		// the main window and every pop-out window
		const docs = new Set<Document>();
		const listen = (doc: Document) => {
			if (docs.has(doc)) return;
			docs.add(doc);
			plugin.registerDomEvent(doc, "click", e => this.onClick(e), { capture: true });
			plugin.registerDomEvent(doc, "auxclick", e => this.onClick(e), { capture: true });
		};
		listen(document);
		plugin.app.workspace.onLayoutReady(() => plugin.app.workspace.iterateAllLeaves(leaf => listen(leaf.view.containerEl.ownerDocument)));
		plugin.registerEvent(plugin.app.workspace.on("window-open", w => listen(w.doc)));
		plugin.registerEvent(plugin.app.workspace.on("window-close", w => docs.delete(w.doc)));
	}

	private onClick(evt: MouseEvent): void {
		if (evt.button !== 0 && evt.button !== 1) return;
		const a = (evt.target as Element | null)?.closest?.('a[href^="textfold:" i]');
		const href = a?.getAttribute("href");
		if (!href) return;
		evt.preventDefault();
		evt.stopPropagation();
		void this.open(href);
	}

	/** Open a textfold:// link (or its parts): in TextFold's app, or on the reader page of the running server. */
	async open(target: string | TextFoldLink): Promise<void> {
		const link = typeof target === "string" ? parseLink(target) : target;
		if (!link) {
			new Notice("This textfold:// link names no TextFold document.");
			return;
		}
		if (this.openIn() === "app") {
			this.nativeOpen(buildLink(link));
			return;
		}
		const r = await this.client.server();
		if (!r.reachable) {
			new Notice(`TextFold is not running at ${r.url}. Start TextFold, then open the link again.`);
			return;
		}
		this.nativeOpen(readerUrl(r.url, link), "_external"); // the system browser, not Obsidian's web viewer
	}
}
