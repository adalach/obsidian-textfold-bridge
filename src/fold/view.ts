// "Fold this note": the note itself, read at TextFold's five levels inside Obsidian. Full is the note as Obsidian renders
// it (its links, embeds, pictures, callouts and math intact); Brief, Key, Takeaway and Topic come from the note's TextFold
// document (GET /api/doc), Key and up written by TextFold's model. A note without a document, or changed since it was
// folded, is first sent to TextFold and folded there (as "Export this note to TextFold" does), so both share one
// document. The look and the motion follow TextFold's reader and the design mockup (src/fold/align.ts, motion.ts).
import { Component, FileView, HoverParent, HoverPopover, Keymap, MarkdownRenderer, Modal, Scope, Setting, TFile, ViewStateResult, WorkspaceLeaf, debounce, setTooltip } from "obsidian";
import type { Job } from "../client";
import { Doc, DocSection, DocUnit } from "../doc";
import { ICON } from "../icon";
import { FALLBACK_LANGS } from "../langs";
import type { Level } from "../links";
import type TextFoldBridgePlugin from "../main";
import { Note, NotesFile, citationLinks, noteLink } from "../notes";
import { FOLD_LEVELS, LEVEL_LABEL, Piece, PreparedUnit, alignRendered, piecesOf, piecesText, prepSection, prepUnit, tokenize } from "./align";
import { FoldMap, NoteBlock, mapUnits, splitBlocks } from "./blocks";
import { Motion } from "./motion";

export const FOLD_VIEW = "textfold-fold";

const ROLE: Record<string, string> = { context: "context", gap: "gap", claim: "claim", method: "method", setup: "setup", result: "result", analysis: "analysis", limitation: "limit." };
const n = (l: Level) => FOLD_LEVELS.indexOf(l) + 1;
const lv = (k: number) => FOLD_LEVELS[Math.min(5, Math.max(1, Math.round(k))) - 1];
const HOT_MARGIN = 600; // rows this close to the viewport get their word pieces

interface Cached {
	paper: string;
	hash: string;
	doc: Doc;
	notes: NotesFile | null;
}

export class FoldView extends FileView {
	level: Level = "full";
	lang: string | null = null; // this note's language when another than the setting's
	private run = 0;
	private blocks: NoteBlock[] = [];
	private rendered = new Map<number, HTMLElement>();
	private md: Component | null = null;
	private paper = "";
	private doc: Doc | null = null;
	private offline = false;
	private map: FoldMap | null = null;
	private units = new Map<string, PreparedUnit>();
	private unitDoc = new Map<string, DocUnit>();
	private unitSec = new Map<string, DocSection>();
	private secs = new Map<string, { tk: Piece[]; tp: Piece[] }>();
	private notesBy = new Map<string, Note[]>();
	private whole: Note[] = [];
	private unf = new Set<string>();
	private cold = new Map<HTMLElement, () => void>();
	private folding = false;
	private triedFold = false;
	private barEl!: HTMLElement;
	private lineEl!: HTMLElement;
	private docEl!: HTMLElement;
	private ghostsEl!: HTMLElement;
	private motion!: Motion;
	private hoverParent: HoverParent = { hoverPopover: null };
	private hoverAt = new WeakMap<HTMLElement, number>();
	private heatFrame = 0;
	private onEdit = debounce(() => {
		if (this.file && !this.folding) void this.reload(this.file, false);
	}, 1500, true);

	constructor(leaf: WorkspaceLeaf, private plugin: TextFoldBridgePlugin) {
		super(leaf);
		this.navigation = true;
	}

	getViewType(): string {
		return FOLD_VIEW;
	}

	getIcon(): string {
		return ICON;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Fold";
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "md";
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as { level?: unknown; lang?: unknown };
		if (typeof s.level === "string" && (FOLD_LEVELS as string[]).includes(s.level)) this.level = s.level as Level;
		if (typeof s.lang === "string" || s.lang === null) this.lang = s.lang;
		await super.setState(state, result);
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), level: this.level, lang: this.lang };
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("tfb-fold-view");
		this.barEl = root.createDiv("tfb-fold-bar");
		this.lineEl = root.createDiv("tfb-fold-line");
		this.docEl = root.createDiv("tfb-fold-doc");
		this.ghostsEl = root.createDiv("tfb-ghosts");
		this.motion = new Motion(root, this.ghostsEl, {
			level: () => n(this.level),
			render: k => {
				this.level = lv(k);
				this.unf.clear();
				this.draw();
			},
			locate: id => this.locate(id),
			shown: x => this.showLevel(x),
			settled: k => {
				this.level = lv(k);
				this.drawBar();
				this.app.workspace.requestSaveLayout();
			},
		});
		this.addAction("pencil", "Edit the Markdown", () => void this.edit());
		this.addAction(ICON, "Open in TextFold here", () => void this.openHere());

		// the levels by number while the view is focused, as in TextFold
		this.scope = new Scope(this.app.scope);
		for (let k = 1; k <= 5; k++) this.scope.register([], String(k), () => (this.go(k), false));

		// ⌘/Ctrl + scroll and a trackpad pinch (which arrives as ctrl + wheel) scrub the change
		this.registerDomEvent(root, "wheel", e => {
			if (!(e.ctrlKey || e.metaKey) || !this.doc) return;
			e.preventDefault();
			this.hideHover();
			this.motion.zoomBy(e.deltaY * (e.deltaMode === 1 ? 0.33 : 0.01), { x: e.clientX, y: e.clientY });
		}, { passive: false });
		let pinch: { d: number } | null = null;
		this.registerDomEvent(root, "touchstart", e => {
			if (e.touches.length === 2) pinch = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) };
		}, { passive: true });
		this.registerDomEvent(root, "touchmove", e => {
			if (!pinch || e.touches.length !== 2 || !this.doc) return;
			e.preventDefault();
			const [a, b] = [e.touches[0], e.touches[1]];
			const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
			this.motion.zoomBy(Math.log(pinch.d / d) * 2.2, { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
			pinch.d = d;
		}, { passive: false });
		this.registerDomEvent(root, "touchend", () => (pinch = null));
		this.registerDomEvent(root, "scroll", () => {
			this.hideHover();
			if (this.heatFrame) return;
			this.heatFrame = window.requestAnimationFrame(() => {
				this.heatFrame = 0;
				this.heat();
			});
		}, { passive: true });
		this.registerDomEvent(this.docEl, "click", e => this.onClick(e));
		this.registerDomEvent(this.docEl, "mouseover", e => this.onHover(e));

		this.register(this.plugin.folds.onChange(() => this.onFoldChange()));
		this.registerEvent(this.app.metadataCache.on("changed", f => {
			if (f === this.file) this.onEdit();
		}));
		this.register(() => this.onEdit.cancel());
	}

	async onLoadFile(file: TFile): Promise<void> {
		await this.reload(file, true);
	}

	async onUnloadFile(): Promise<void> {
		this.run++;
		this.motion?.stop();
		this.md?.unload();
		this.md = null;
		this.rendered.clear();
		this.docEl?.empty();
	}

	// ---------------------------------------------------------------- data

	/** Read the note, and its document from TextFold (folding it first when it has none or changed since). */
	private async reload(file: TFile, fresh: boolean): Promise<void> {
		const run = ++this.run;
		if (fresh) {
			this.triedFold = false;
			this.unf.clear();
		}
		await this.readNote(file, run);
		if (run !== this.run) return;
		await this.fetch(file, run);
	}

	private async readNote(file: TFile, run: number): Promise<void> {
		const text = await this.app.vault.cachedRead(file);
		const sections = this.app.metadataCache.getFileCache(file)?.sections?.map(s => ({ type: s.type, start: s.position.start.offset, end: s.position.end.offset }));
		const blocks = splitBlocks(text, sections);
		const md = new Component();
		const rendered = new Map<number, HTMLElement>();
		for (const b of blocks) {
			if (b.type === "heading") continue;
			const el = createDiv("tfb-md markdown-rendered");
			await MarkdownRenderer.render(this.app, b.markdown, el, file.path, md);
			rendered.set(b.index, el);
		}
		if (run !== this.run) {
			md.unload();
			return;
		}
		this.md?.unload();
		this.md = this.addChild(md);
		this.blocks = blocks;
		this.rendered = rendered;
	}

	private async fetch(file: TFile, run: number): Promise<void> {
		const { client, folds } = this.plugin;
		const want = this.lang ?? this.plugin.foldLanguage();
		const r = await client.server();
		if (run !== this.run) return;
		const rec = folds.recordFor(file);
		const { hash } = await folds.prepare(file);
		if (run !== this.run) return;
		if (!r.reachable) {
			const cached = rec ? this.readCache(rec.paper, want) : null;
			if (cached && cached.hash === hash) {
				this.use(cached.paper, cached.doc, cached.notes, true);
				this.say("TextFold is not running: the fold as it was when last read.");
			} else {
				this.clearDoc();
				this.say(`TextFold is not running at ${r.url}: the note as written.`);
			}
			this.draw();
			return;
		}
		const job = rec ? folds.running(rec.paper) : null;
		if (job) {
			this.folding = true;
			this.sayJob(job);
			this.clearDoc();
			this.draw();
			return;
		}
		const state = rec ? await folds.state(file, rec) : null;
		if ((!rec || state?.kind === "changed") && !this.triedFold) {
			this.triedFold = true;
			this.clearDoc();
			this.say(rec ? "Changed since it was folded: folding it again in TextFold…" : "Sending the note to TextFold…");
			this.draw();
			const out = await folds.fold(file, { quiet: true, lang: rec?.lang ?? want });
			if (run !== this.run) return;
			if (out === "started") {
				this.folding = true;
				const now = folds.recordFor(file);
				this.sayJob(now ? folds.running(now.paper) : null);
				return;
			}
			if (out !== "unchanged") {
				this.say(out === "cancelled" ? "Not folded: the note has no TextFold document yet." : "The note could not be folded: the note as written.", out === "cancelled" ? ["Fold", () => this.refold()] : undefined);
				return;
			}
		}
		const now = folds.recordFor(file);
		if (!now) {
			this.clearDoc();
			this.say("The note has no TextFold document: the note as written.", ["Fold", () => this.refold()]);
			this.draw();
			return;
		}
		const doc = await client.doc(now.paper, want).catch(() => null);
		const notes = await client.notes(now.paper).catch(() => null);
		if (run !== this.run) return;
		if (!doc) {
			this.clearDoc();
			this.say(`TextFold has no document ${now.paper} any more: the note as written.`);
			this.draw();
			return;
		}
		this.use(now.paper, doc, notes, false);
		this.writeCache({ paper: now.paper, hash, doc, notes }, want);
		if (doc.local) this.say("TextFold has no levels for this note yet (no model was connected when it was folded): Full only.", ["Fold again", () => this.refold(true)]);
		else if (doc.lang !== want) this.say(`Not in ${langName(this.plugin, want)} yet: shown in ${langName(this.plugin, doc.lang)}.`, ["Translate", () => void this.translate(want)]);
		else if (state?.kind === "changed") this.say("Changed since it was folded.", ["Refold", () => this.refold(true)]);
		else this.say("");
		this.draw();
	}

	private use(paper: string, doc: Doc, notes: NotesFile | null, offline: boolean): void {
		this.paper = paper;
		this.doc = doc;
		this.offline = offline;
		this.map = mapUnits(this.blocks, doc);
		this.units.clear();
		this.unitDoc.clear();
		this.unitSec.clear();
		this.secs.clear();
		this.notesBy.clear();
		this.whole = (notes?.notes ?? []).filter(x => x.on === "paper");
		for (const x of notes?.notes ?? []) if (x.unit) this.notesBy.set(x.unit, [...(this.notesBy.get(x.unit) ?? []), x]);
		for (const s of doc.sections) {
			this.secs.set(s.id, prepSection(s));
			for (const u of s.units) {
				const quotes = (this.notesBy.get(u.id) ?? []).filter(x => x.kind !== "ask" && !x.lost).map(x => x.quote);
				this.units.set(u.id, prepUnit(u, quotes));
				this.unitDoc.set(u.id, u);
				this.unitSec.set(u.id, s);
			}
		}
		if (doc.local && this.level !== "full") this.level = "full";
	}

	private clearDoc(): void {
		this.doc = null;
		this.map = null;
		this.units.clear();
		this.notesBy.clear();
		this.whole = [];
	}

	private onFoldChange(): void {
		if (!this.folding || !this.file) return;
		const rec = this.plugin.folds.recordFor(this.file);
		const job = rec ? this.plugin.folds.running(rec.paper) : null;
		if (job) {
			this.sayJob(job);
			return;
		}
		this.folding = false;
		void this.reload(this.file, false);
	}

	private refold(force = false): void {
		if (!this.file) return;
		this.triedFold = false;
		if (force) void this.foldAgain();
		else void this.reload(this.file, false);
	}

	private async foldAgain(): Promise<void> {
		if (!this.file) return;
		this.triedFold = true;
		const rec = this.plugin.folds.recordFor(this.file);
		const out = await this.plugin.folds.fold(this.file, { quiet: true, lang: rec?.lang });
		if (out === "started") {
			this.folding = true;
			this.sayJob(rec ? this.plugin.folds.running(rec.paper) : null);
		} else void this.reload(this.file, false);
	}

	/** Another language: TextFold translates the note (its model), then the view shows it. */
	private async translate(lang: string): Promise<void> {
		if (!this.file) return;
		if (!(await confirm(this.app, `Translate "${this.file.basename}" into ${langName(this.plugin, lang)}?`, "TextFold's model translates the note's folded levels. It reads in that language here and in TextFold.", "Translate"))) return;
		const out = await this.plugin.folds.fold(this.file, { quiet: true, lang });
		const rec = this.plugin.folds.recordFor(this.file);
		if (out === "started") {
			this.folding = true;
			this.sayJob(rec ? this.plugin.folds.running(rec.paper) : null);
		} else void this.reload(this.file, false);
	}

	private cacheKey(paper: string, lang: string): string {
		return `textfold-bridge-fold:${paper}:${lang}`;
	}

	private readCache(paper: string, lang: string): Cached | null {
		try {
			const v = this.app.loadLocalStorage(this.cacheKey(paper, lang)) as Cached | null;
			return v && typeof v === "object" && v.doc ? v : null;
		} catch {
			return null;
		}
	}

	private writeCache(c: Cached, lang: string): void {
		try {
			this.app.saveLocalStorage(this.cacheKey(c.paper, lang), c);
		} catch {
			// too large, or storage off: a fold just needs TextFold to open then
		}
	}

	// ---------------------------------------------------------------- lines and controls

	private say(text: string, action?: [string, () => void]): void {
		this.lineEl.empty();
		this.lineEl.toggleClass("is-empty", !text);
		if (!text) return;
		this.lineEl.createSpan({ text });
		if (action) {
			const b = this.lineEl.createEl("button", { cls: "tfb-button", text: action[0] });
			b.addEventListener("click", action[1]);
		}
	}

	private sayJob(job: Job | null): void {
		const stage = job ? (job.status === "queued" ? "waiting" : job.stage) : "";
		this.say(`Folding in TextFold${stage ? ` · ${stage}${job?.total ? ` ${job.done}/${job.total}` : ""}` : ""}…`);
	}

	private drawBar(): void {
		const bar = this.barEl;
		bar.empty();
		const ready = !!this.doc && !this.doc.local;
		const k = n(this.level);
		if (this.plugin.settings.foldControl === "slider") {
			const label = bar.createEl("label", { cls: "tfb-slider" });
			const input = label.createEl("input", { type: "range", attr: { min: "1", max: "5", step: "0.01", "aria-label": "Level" } });
			input.value = String(k);
			input.disabled = !ready;
			label.createEl("b", { cls: "tfb-slider-name", text: `${k} · ${LEVEL_LABEL[this.level]}` });
			input.addEventListener("input", () => this.motion.scrubTo(Number(input.value)));
			input.addEventListener("change", () => this.motion.spring());
		} else {
			const group = bar.createDiv({ cls: "tfb-lvl", attr: { role: "group", "aria-label": "Level" } });
			FOLD_LEVELS.forEach((l, i) => {
				if (i === 2) group.createSpan({ cls: "tfb-lvl-sep", attr: { "aria-label": "Left: your own words. Right: written by the model." } });
				const b = group.createEl("button", { cls: i >= 2 ? "is-written" : "", attr: { "aria-pressed": String(ready ? k === i + 1 : i === 0), "aria-label": `${LEVEL_LABEL[l]} (${i + 1})` } });
				b.createEl("kbd", { text: String(i + 1) });
				b.createSpan({ cls: "tfb-lvl-name", text: LEVEL_LABEL[l] });
				b.disabled = !ready && i > 0;
				b.addEventListener("click", () => this.go(i + 1));
			});
		}
		if (ready) bar.createSpan({ cls: "tfb-hint", text: "⌘ + scroll or pinch to zoom" });
		bar.createDiv("tfb-grow");
		// the note's language: another one is translated by TextFold
		const select = bar.createEl("select", { cls: "dropdown tfb-lang", attr: { "aria-label": "Language" } });
		const current = this.doc?.lang ?? this.lang ?? this.plugin.foldLanguage();
		for (const l of this.plugin.langs ?? FALLBACK_LANGS) select.createEl("option", { value: l.code, text: l.name });
		select.value = current;
		select.disabled = !this.doc || this.offline;
		select.addEventListener("change", () => {
			this.lang = select.value === this.plugin.foldLanguage() ? null : select.value;
			this.app.workspace.requestSaveLayout();
			if (this.file) void this.reload(this.file, false);
		});
	}

	/** The control follows the zoom position while a gesture runs. */
	private showLevel(x: number): void {
		const k = Math.round(x);
		const input = this.barEl.querySelector<HTMLInputElement>(".tfb-slider input");
		if (input && this.barEl.doc.activeElement !== input) input.value = String(x);
		const name = this.barEl.querySelector(".tfb-slider-name");
		if (name) name.setText(`${k} · ${LEVEL_LABEL[lv(k)]}`);
		this.barEl.querySelectorAll(".tfb-lvl button").forEach((b, i) => b.setAttribute("aria-pressed", String(i + 1 === k)));
	}

	private go(k: number): void {
		if (!this.doc || this.doc.local) return;
		this.hideHover();
		this.motion.jump(k);
	}

	private async edit(): Promise<void> {
		if (!this.file) return;
		await this.leaf.setViewState({ type: "markdown", state: { file: this.file.path, mode: "source" }, active: true });
	}

	/** TextFold at the paragraph a third of the way down, at this level. */
	private async openHere(): Promise<void> {
		if (!this.paper) {
			if (this.file) await this.plugin.folds.fold(this.file, { exported: true });
			return;
		}
		const a = this.motion.anchorAt(null);
		const id = a?.id ?? "";
		const link = { paper: this.paper, level: this.level, lang: this.doc?.lang };
		if (this.units.has(id)) await this.plugin.opener.open({ ...link, u: id });
		else if (this.secs.has(id)) await this.plugin.opener.open({ ...link, s: id });
		else await this.plugin.opener.open(link);
	}

	// ---------------------------------------------------------------- drawing

	private draw(): void {
		this.motion?.stop();
		this.hideHover();
		this.cold.clear();
		this.drawBar();
		const body = this.docEl;
		body.empty();
		const level: Level = this.doc && !this.doc.local ? this.level : "full";
		body.className = `tfb-fold-doc tfb-l${n(level)}${this.plugin.settings.foldComments === "inline" ? " tfb-inline" : ""}`;
		this.headRow(level);
		if (this.whole.length) this.wholeRow(level);
		if (level === "topic") this.topicMap();
		else if (level === "full") this.fullRows();
		else this.foldedRows(level);
		this.heat();
	}

	private row(cls: string, anchor?: string): { row: HTMLElement; gut: HTMLElement; txt: HTMLElement; mar: HTMLElement } {
		const row = this.docEl.createDiv(`tfb-r tfb-fl ${cls}`);
		if (anchor) row.dataset.anchor = anchor;
		return { row, gut: row.createDiv("tfb-gut"), txt: row.createDiv("tfb-txt"), mar: row.createDiv("tfb-mar") };
	}

	private headRow(level: Level): void {
		const { txt } = this.row("tfb-head", "head");
		const title = this.doc?.title || this.file?.basename || "";
		txt.createDiv("tfb-title").appendChild(piece({ id: "title:h", t: title }, "tfb-hd"));
		const doc = this.doc;
		if (doc && !doc.local) {
			const model = doc.model.split("/").slice(-2).join("/") || "TextFold's model";
			const when = doc.made ? ` on ${doc.made.slice(0, 10)}` : "";
			const prov = txt.createDiv("tfb-prov");
			prov.appendText("Full and Brief are your own words. ");
			prov.createEl("em", { text: `Key, Takeaway and Topic were written by ${model}${when}.` });
			if (n(level) >= 3) prov.appendText(" Hover a written line for the sentences it rests on.");
		}
	}

	private wholeRow(level: Level): void {
		const { gut, txt } = this.row("tfb-whole", "whole");
		gut.setText("Whole note");
		for (const x of this.whole) this.commentBox(txt, x, n(level) <= 2 ? "f" : "s");
	}

	/** Full: the note itself, block by block, as Obsidian renders it; its paragraphs' words become pieces near the
	 *  viewport, so they can travel to Brief and back. */
	private fullRows(): void {
		const map = this.map;
		for (const b of this.blocks) {
			if (map && b.index === map.titleBlock) continue;
			if (b.type === "heading") {
				const sec = map?.headingSection.get(b.index);
				const { row, gut, txt } = this.row(`tfb-sh tfb-d${Math.min(4, Math.max(1, (b.level ?? 2) - (map?.titleBlock !== null && map?.titleBlock !== undefined ? 1 : 0)))}`, sec ?? `b${b.index}`);
				const s = sec ? this.doc?.sections.find(x => x.id === sec) : undefined;
				if (s?.num) gut.appendChild(piece({ id: `${s.id}:n`, t: s.num }));
				txt.appendChild(piece({ id: `${sec ?? `b${b.index}`}:h`, t: b.heading ?? "" }, "tfb-hd"));
				row.dataset.block = String(b.index);
				continue;
			}
			const units = map?.blockUnits.get(b.index) ?? [];
			const { row, txt, mar } = this.row("tfb-blk", units[0] ?? `b${b.index}`);
			row.dataset.block = String(b.index);
			if (units.length) row.dataset.units = units.join(" ");
			const el = this.rendered.get(b.index);
			if (!el) continue;
			txt.appendChild(el);
			if (units.length > 1) {
				const items = Array.from(el.querySelectorAll<HTMLElement>(":scope > ul > li, :scope > ol > li"));
				if (items.length === units.length) items.forEach((li, i) => (li.dataset.anchor = units[i]));
			}
			if (units.length && !el.dataset.wrapped) this.cold.set(row, () => this.wrap(el, units));
			for (const u of units) this.comments(mar, u, "full", false);
		}
	}

	/** Brief, Key, Takeaway: the document's sections and paragraphs at the level, as word pieces. */
	private foldedRows(level: Level): void {
		const doc = this.doc;
		if (!doc) return;
		for (const s of doc.sections) {
			if (!s.title && !s.units.length) continue;
			if (s.title) {
				const { gut, txt } = this.row(`tfb-sh tfb-d${Math.min(4, s.depth)}`, s.id);
				if (s.num) gut.appendChild(piece({ id: `${s.id}:n`, t: s.num }));
				txt.appendChild(piece({ id: `${s.id}:h`, t: s.title.replace(/\$/g, "") }, "tfb-hd"));
			}
			const sp = this.secs.get(s.id);
			if (n(level) >= 3 && sp?.tk.length) {
				const { txt } = this.row("tfb-stk", `${s.id}:tk`);
				txt.addClass("tfb-ai");
				txt.dataset.evSec = s.id;
				piecesInto(txt, sp.tk);
			}
			for (const u of s.units) this.unitRow(u, level);
		}
	}

	private unitRow(u: DocUnit, level: Level): void {
		const p = this.units.get(u.id);
		if (!p) return;
		const unf = this.unf.has(u.id);
		const pcs = piecesOf(p, level, unf);
		if (!pcs.length) return;
		const { row, gut, txt, mar } = this.row(`tfb-u tfb-fold${unf ? " tfb-unf" : ""}${u.kind === "caption" ? " tfb-cap" : ""}`, u.id);
		row.dataset.u = u.id;
		if (u.role) gut.appendChild(piece({ id: `${u.id}:role`, t: ROLE[u.role] ?? u.role }, `tfb-role tfb-r-${u.role}`));
		if (unf) gut.createSpan({ cls: "tfb-full-tag", text: "Full" });
		if (n(level) >= 3 && !unf) txt.addClass("tfb-ai");
		const fill = () => {
			txt.empty();
			piecesInto(txt, pcs);
			this.mark(txt, u.id, level, pcs);
		};
		txt.setText(piecesText(pcs));
		this.cold.set(row, fill);
		this.comments(mar, u.id, level, unf);
	}

	/** Topic: a map of the sections, each a card of its topic and its paragraphs' topics as chips. */
	private topicMap(): void {
		const doc = this.doc;
		if (!doc) return;
		const noted = new Set(this.notesBy.keys());
		const secs = doc.sections.filter(s => s.units.length && (s.topic || s.units.some(u => u.topic)));
		const { txt } = this.row("tfb-mapnote");
		txt.setText(`${secs.length} section${secs.length === 1 ? "" : "s"}. Click a card for its takeaways, a chip for that paragraph in full.`);
		const map = this.docEl.createDiv("tfb-map");
		for (const s of secs) {
			const card = map.createDiv({ cls: "tfb-card tfb-fl", attr: { tabindex: "0" } });
			card.dataset.anchor = s.id;
			card.dataset.card = s.id;
			const head = card.createDiv("tfb-cs");
			if (s.num) head.append(piece({ id: `${s.id}:n`, t: s.num }), " ");
			head.appendChild(piece({ id: `${s.id}:h`, t: s.title.replace(/\$/g, "") || "Opening" }, "tfb-hd"));
			const sp = this.secs.get(s.id);
			if (sp?.tp.length) piecesInto(card.createDiv("tfb-cp"), sp.tp);
			const chips = card.createDiv("tfb-cps");
			for (const u of s.units) {
				const p = this.units.get(u.id);
				if (!p || !p.tp.length) continue;
				const chip = chips.createSpan({ cls: `tfb-chip${noted.has(u.id) ? " has-note" : ""}` });
				chip.dataset.anchor = u.id;
				chip.dataset.chip = u.id;
				setTooltip(chip, u.takeaway || u.topic, { placement: "top" });
				piecesInto(chip, piecesOf(p, "topic"));
			}
		}
	}

	/** A note's highlight whose passage is not on screen leaves a mark on its paragraph. */
	private mark(txt: HTMLElement, uid: string, level: Level, pcs: Piece[]): void {
		const ns = (this.notesBy.get(uid) ?? []).filter(x => x.quote);
		if (!ns.length || pcs.some(x => x.hl)) return;
		if (this.plugin.settings.foldComments === "margin" && n(level) >= 3) return;
		const dot = txt.createSpan({ cls: "tfb-dot tfb-mk", attr: { tabindex: "0", "aria-label": "Your note on this paragraph" } });
		dot.dataset.mk = uid;
	}

	/** TextFold's comments on a paragraph: in the margin (in full beside Full and Brief, one line beside Key, a dot
	 *  beyond), or under the paragraph where it is read in full. */
	private comments(mar: HTMLElement, uid: string, level: Level, unf: boolean): void {
		const ns = this.notesBy.get(uid) ?? [];
		if (!ns.length) return;
		const full = n(level) <= 2 || unf;
		if (this.plugin.settings.foldComments === "inline") {
			if (full) for (const x of ns) this.commentBox(mar, x, "c");
			return;
		}
		for (const x of ns) this.commentBox(mar, x, full ? "f" : n(level) === 3 ? "s" : "d", uid);
	}

	private commentBox(into: HTMLElement, x: Note, form: "f" | "c" | "s" | "d", uid?: string): void {
		const kind = x.kind === "ask" ? "Ask" : x.text ? "Note" : "Highlight";
		if (form === "d") {
			const box = into.createDiv("tfb-mn tfb-dotonly tfb-box");
			box.dataset.id = `note:${x.id}:d`;
			const dot = box.createSpan({ cls: "tfb-dot", attr: { tabindex: "0", "aria-label": `Your ${kind.toLowerCase()} on this paragraph` } });
			if (uid) dot.dataset.mk = uid;
			return;
		}
		const box = into.createDiv(`tfb-box ${form === "c" ? "tfb-cbox" : "tfb-mn"}${form === "s" ? " tfb-short" : ""}${x.kind === "ask" ? " is-ask" : ""}`);
		box.dataset.id = `note:${x.id}:${form}`;
		box.dataset.note = x.id;
		if (form === "s") {
			const line = x.kind === "ask" ? x.thread[0]?.q ?? "" : (x.text || x.quote).split("\n")[0];
			box.createSpan({ cls: "tfb-dot" });
			box.appendText(` ${line}`);
			if (uid) box.dataset.mk = uid;
			return;
		}
		const head = box.createDiv("tfb-mh");
		head.createSpan({ cls: "tfb-dot" });
		head.appendText(kind);
		if (x.lost) head.createSpan({ cls: "tfb-lost-tag", text: "passage not found after the edit" });
		const body = box.createDiv("tfb-mb");
		if (x.kind === "ask") {
			const turn = x.thread.find(t => t.a) ?? x.thread[0];
			if (turn) {
				body.createDiv({ cls: "tfb-q", text: turn.q });
				body.createDiv({ cls: "tfb-a", text: turn.takeaway || (turn.pending ? "Answering…" : "") });
			}
		} else {
			if (!x.text && x.quote) body.createDiv({ cls: "tfb-quote", text: `“${x.quote}”` });
			if (x.text) body.createDiv({ cls: "tfb-ntext", text: x.text });
		}
	}

	/** Wrap a rendered block's words into pieces with the ids of its paragraphs' words (Full ↔ Brief travel). */
	private wrap(el: HTMLElement, unitIds: string[]): void {
		if (el.dataset.wrapped) return;
		el.dataset.wrapped = "1";
		const tokens: { id: string; t: string; c0: number; c1: number; hl: boolean; lead: boolean }[] = [];
		for (const id of unitIds) {
			const p = this.units.get(id);
			if (!p) continue;
			const ev = new Set(p.ev);
			const sentOf = (i: number) => p.sr.findIndex(([a, b]) => i >= a && i < b);
			p.toks.forEach((t, i) => tokens.push({ id: `${id}:${i}`, t: t.t, c0: t.c0, c1: t.c1, hl: p.hl.has(i), lead: ev.has(sentOf(i)) }));
		}
		const SKIP = ".internal-embed, .math, pre, .callout-icon, .copy-code-button, .list-bullet, .collapse-indicator, .heading-collapse-indicator, .frontmatter, img, svg";
		const walker = el.doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const words: { node: Text; c0: number; c1: number; t: string }[] = [];
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			if (node.parentElement?.closest(SKIP)) continue;
			for (const t of tokenize(node.data)) words.push({ node, c0: t.c0, c1: t.c1, t: t.t });
		}
		const match = alignRendered(words.map(w => w.t), tokens);
		const byNode = new Map<Text, { c0: number; c1: number; tok: (typeof tokens)[number] }[]>();
		words.forEach((w, i) => {
			const j = match[i];
			if (j === undefined) return;
			byNode.set(w.node, [...(byNode.get(w.node) ?? []), { c0: w.c0, c1: w.c1, tok: tokens[j] }]);
		});
		for (const [node, hits] of byNode) {
			const text = node.data;
			const frag = createFragment();
			let at = 0;
			for (const h of hits) {
				if (h.c0 > at) frag.appendText(text.slice(at, h.c0));
				const span = frag.createSpan({ cls: `tfb-tk${h.tok.lead ? " tfb-lead" : ""}${h.tok.hl ? " tfb-hl" : ""}`, text: text.slice(h.c0, h.c1) });
				span.dataset.id = h.tok.id;
				at = h.c1;
			}
			if (at < text.length) frag.appendText(text.slice(at));
			node.replaceWith(frag);
		}
	}

	/** Rows near the viewport get their pieces; the rest stay plain text until they come near. */
	private heat(): void {
		if (!this.cold.size) return;
		const cr = this.contentEl.getBoundingClientRect();
		for (const [el, fill] of this.cold) {
			const r = el.getBoundingClientRect();
			if (r.bottom > cr.top - HOT_MARGIN && r.top < cr.bottom + HOT_MARGIN) {
				fill();
				this.cold.delete(el);
			}
		}
	}

	/** The row for an anchor id after a change: the same row, the block holding a paragraph, a paragraph's section, a
	 *  section's first paragraph. Rows near it are heated first, so their words can travel. */
	private locate(id: string): HTMLElement | null {
		const q = (sel: string) => this.docEl.querySelector<HTMLElement>(sel);
		const esc = (s: string) => CSS.escape(s);
		const el =
			q(`[data-anchor="${esc(id)}"]`) ??
			q(`[data-units~="${esc(id)}"]`) ??
			(this.unitSec.get(id) ? q(`[data-anchor="${esc(this.unitSec.get(id)!.id)}"]`) : null) ??
			(this.doc?.sections.find(s => s.id === id)?.units[0] ? q(`[data-anchor="${esc(this.doc.sections.find(s => s.id === id)!.units[0].id)}"]`) : null) ??
			(id.endsWith(":tk") ? q(`[data-anchor="${esc(id.slice(0, -3))}"]`) : null) ??
			this.blockFallback(id);
		this.heat();
		return el;
	}

	/** A block without a paragraph of TextFold's (code, a picture): the next block that has one. */
	private blockFallback(id: string): HTMLElement | null {
		const m = /^b(\d+)$/.exec(id);
		if (!m || !this.map) return null;
		for (let i = Number(m[1]); i < this.blocks.length; i++) {
			const u = this.map.blockUnits.get(i)?.[0];
			const el = u ? this.docEl.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(u)}"]`) : null;
			if (el) return el;
		}
		return null;
	}

	// ---------------------------------------------------------------- clicks and hovers

	private onClick(e: MouseEvent): void {
		const t = e.target as HTMLElement;
		const a = t.closest<HTMLAnchorElement>("a");
		if (a) {
			if (a.hasClass("internal-link")) {
				e.preventDefault();
				void this.app.workspace.openLinkText(a.getAttribute("data-href") ?? a.getAttribute("href") ?? "", this.file?.path ?? "", Keymap.isModEvent(e));
			} else if (a.hasClass("external-link") && /^https?:/i.test(a.getAttribute("href") ?? "")) {
				e.preventDefault();
				window.open(a.getAttribute("href") ?? "");
			}
			return; // (textfold:// links: the plugin's own click handler)
		}
		const chip = t.closest<HTMLElement>("[data-chip]");
		if (chip) {
			const id = chip.dataset.chip ?? "";
			this.motion.morph(() => this.drawAt(1), { id, y: chip.getBoundingClientRect().top, frac: 0 });
			return;
		}
		const card = t.closest<HTMLElement>("[data-card]");
		if (card) {
			const id = card.dataset.card ?? "";
			this.motion.morph(() => this.drawAt(4), { id, y: card.getBoundingClientRect().top, frac: 0 });
			return;
		}
		const box = t.closest<HTMLElement>("[data-note]");
		if (box && this.paper) {
			const x = [...this.notesBy.values()].flat().concat(this.whole).find(nn => nn.id === box.dataset.note);
			if (x) void this.plugin.opener.open(noteLink(this.paper, x));
			return;
		}
		const u = t.closest<HTMLElement>(".tfb-u.tfb-fold");
		if (u && t.closest(".tfb-txt") && !t.closest(".tfb-mk")) {
			const id = u.dataset.u ?? "";
			this.hideHover();
			const r = u.getBoundingClientRect();
			this.motion.morph(() => {
				if (this.unf.has(id)) this.unf.delete(id);
				else this.unf.add(id);
				this.draw();
			}, { id, y: r.top, frac: 0 });
		}
	}

	/** Draw a level as a motion's step does, and say so in the controls. */
	private drawAt(k: number): void {
		this.level = lv(k);
		this.unf.clear();
		this.draw();
		this.app.workspace.requestSaveLayout();
	}

	private onHover(e: MouseEvent): void {
		if (this.motion.busy) return;
		const t = e.target as HTMLElement;
		const mk = t.closest<HTMLElement>("[data-mk]");
		const ai = t.closest<HTMLElement>(".tfb-ai");
		const target = mk ?? ai;
		if (!target) return;
		const made = this.hoverAt.get(target);
		if (made && Date.now() - made < 1200) return;
		this.hoverAt.set(target, Date.now());
		const pop = new HoverPopover(this.hoverParent, target, mk ? 250 : 700);
		pop.hoverEl.addClass("tfb-hover", "tfb-fold-pop");
		const body = pop.hoverEl.createDiv("tfb-hover-body");
		if (mk) {
			for (const x of this.notesBy.get(mk.dataset.mk ?? "") ?? []) {
				body.createDiv({ cls: "tfb-hover-meta", text: `${x.kind === "ask" ? "Ask" : x.text ? "Note" : "Highlight"} · ^${x.id}` });
				if (x.quote) body.createDiv({ cls: "tfb-card-quote", text: x.quote });
				if (x.text) body.createDiv({ cls: "tfb-card-text", text: x.text });
				const turn = x.kind === "ask" ? x.thread.find(tt => tt.a) : undefined;
				if (turn) {
					body.createDiv({ cls: "tfb-card-q", text: turn.q });
					void MarkdownRenderer.render(this.app, citationLinks(turn.a, this.paper), body.createDiv("tfb-hover-text markdown-rendered"), "", pop);
				}
			}
			return;
		}
		if (ai?.dataset.evSec) {
			body.createDiv({ cls: "tfb-hover-meta", text: "The section's takeaway, written by the model from its paragraphs' takeaways." });
			return;
		}
		const uid = ai?.closest<HTMLElement>("[data-u]")?.dataset.u ?? "";
		const p = this.units.get(uid);
		if (!p) return;
		const ev = p.ev.length ? p.ev : [0];
		body.createDiv({ cls: "tfb-hover-meta", text: `Written by the model. It rests on your sentence${ev.length > 1 ? "s" : ""}:` });
		for (const i of ev) body.createDiv({ cls: "tfb-ev", text: p.sentences[i] ?? "" });
		body.createDiv({ cls: "tfb-hover-meta", text: "Click the paragraph to read it in full." });
	}

	private hideHover(): void {
		// (HoverPopover hides itself when the pointer leaves; a zoom or a scroll hides it at once)
		(this.hoverParent.hoverPopover as unknown as { hide?: () => void } | null)?.hide?.();
	}
}

/** One word piece (an id it keeps across levels). */
function piece(p: Piece, cls = ""): HTMLElement {
	const span = createSpan({ cls: `tfb-tk${cls ? ` ${cls}` : ""}${p.lead ? " tfb-lead" : ""}${p.hl ? " tfb-hl" : ""}${p.gap ? " tfb-gap" : ""}`, text: p.gap ? "…" : p.t });
	span.dataset.id = p.id;
	return span;
}

/** Pieces into an element, words that touch kept on one line (TextFold's piecesHTML, as DOM). */
function piecesInto(el: HTMLElement, pcs: Piece[]): void {
	let group: HTMLElement | null = null;
	pcs.forEach((x, i) => {
		const last = i === pcs.length - 1, nx = pcs[i + 1];
		const space = !last && (x.gap || x.s || nx.gap);
		const span = piece(x);
		if (!last && !space) {
			group ??= el.createSpan("tfb-wg");
			group.append(span);
		} else if (group) {
			group.append(span);
			group = null;
		} else el.append(span);
		if (space) el.append(x.hl && nx.hl ? createSpan({ cls: "tfb-hlsp", text: " " }) : " ");
	});
}

function langName(plugin: TextFoldBridgePlugin, code: string): string {
	return (plugin.langs ?? FALLBACK_LANGS).find(l => l.code === code)?.name ?? code;
}

function confirm(app: TextFoldBridgePlugin["app"], title: string, text: string, yes: string): Promise<boolean> {
	return new Promise(resolve => {
		let answered = false;
		const modal = new Modal(app);
		const answer = (v: boolean) => {
			answered = true;
			resolve(v);
			modal.close();
		};
		modal.setTitle(title);
		modal.contentEl.createEl("p", { text });
		new Setting(modal.contentEl)
			.addButton(b => b.setButtonText("Cancel").onClick(() => answer(false)))
			.addButton(b => b.setButtonText(yes).setCta().onClick(() => answer(true)));
		modal.onClose = () => {
			if (!answered) resolve(false);
		};
		modal.open();
	});
}

