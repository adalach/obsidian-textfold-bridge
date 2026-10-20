// Words travelling between levels, as in TextFold's reader (textfold/web/reader.js, Apache License 2.0) and the design
// mockup: measure every word near the viewport, re-render at the new level, then slide each word that is still there
// from where it was (FLIP), fade in the new ones, and fade out a ghost of each word that left. A key or a button runs
// it in time; a ⌘/Ctrl+scroll, a pinch or the slider scrubs it, and when the gesture stops the level springs to the
// nearer one. The paragraph under the pointer (else a third of the way down) stays where it is.

const DUR = 560;
const M = 160; // how far beyond the viewport words are measured

export interface Anchor {
	id: string;
	y: number;
	frac: number;
}

export interface MotionHooks {
	level(): number; // 1 (Full) … 5 (Topic)
	render(level: number): void; // draw the document at this level (and heat the rows near the viewport)
	locate(id: string): HTMLElement | null; // the row an anchor id is now, or the nearest one that stands for it
	shown(x: number): void; // the control follows the zoom position
	settled(level: number): void; // a change ended at this level
}

type Snap = { cr: DOMRect; snap: Map<string, { r: DOMRect; el: HTMLElement; font: string; color: string; bg: string }> };

export class Motion {
	private running: Animation[] = [];
	private tr: { from: number; to: number; anims: Animation[]; scroll0: number } | null = null;
	private pos: number | null = null;
	private springId = 0;
	private snapTimer = 0;
	private gesturePt: { x: number; y: number } | null = null;

	constructor(private content: HTMLElement, private ghosts: HTMLElement, private hooks: MotionHooks) {}

	get reduced(): boolean {
		return this.content.win.matchMedia("(prefers-reduced-motion: reduce)").matches;
	}

	/** Whether a change or a gesture is under way (popovers wait). */
	get busy(): boolean {
		return !!(this.tr || this.running.length || this.pos !== null);
	}

	private rowsNear(): { cr: DOMRect; rows: HTMLElement[] } {
		const cr = this.content.getBoundingClientRect();
		const rows: HTMLElement[] = [];
		for (const row of Array.from(this.content.querySelectorAll<HTMLElement>(".tfb-fl"))) {
			const r = row.getBoundingClientRect();
			if ((r.width || r.height) && r.bottom > cr.top - M && r.top < cr.bottom + M) rows.push(row);
		}
		return { cr, rows };
	}

	private snapshot(): Snap {
		const { cr, rows } = this.rowsNear();
		const snap: Snap["snap"] = new Map();
		const styles = new Map<string, { font: string; color: string; bg: string }>();
		for (const row of rows)
			for (const el of Array.from(row.querySelectorAll<HTMLElement>("[data-id]"))) {
				const r = el.getBoundingClientRect();
				if (!(r.width || r.height) || r.bottom < cr.top - M || r.top > cr.bottom + M) continue;
				const key = `${row.className}|${el.className}`;
				let s = styles.get(key);
				if (!s) {
					const cs = getComputedStyle(el);
					s = { font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`, color: cs.color, bg: cs.backgroundColor };
					styles.set(key, s);
				}
				snap.set(el.dataset.id ?? "", { r, el, ...s });
			}
		return { cr, snap };
	}

	private build(before: Snap, scrubbed: boolean): Animation[] {
		const { rows } = this.rowsNear();
		const cr = this.content.getBoundingClientRect();
		const after = new Map<string, { el: HTMLElement; r: DOMRect }>();
		const anims: Animation[] = [];
		for (const row of rows)
			for (const el of Array.from(row.querySelectorAll<HTMLElement>("[data-id]"))) {
				const r = el.getBoundingClientRect();
				if ((r.width || r.height) && r.bottom > cr.top - M && r.top < cr.bottom + M) after.set(el.dataset.id ?? "", { el, r });
			}
		const fadeIn = scrubbed ? [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }] : [{ opacity: 0 }, { opacity: 1 }];
		const inOpts: KeyframeAnimationOptions = scrubbed ? { duration: 1000, fill: "both" } : { duration: DUR * 0.55, delay: DUR * 0.4, easing: "ease-out", fill: "backwards" };
		const moveOpts: KeyframeAnimationOptions = scrubbed ? { duration: 1000, fill: "both" } : { duration: DUR, easing: "cubic-bezier(.2,.8,.2,1)" };
		const fadeOut = scrubbed ? [{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }] : [{ opacity: 1 }, { opacity: 0 }];
		const outOpts: KeyframeAnimationOptions = scrubbed ? { duration: 1000, fill: "both" } : { duration: DUR * 0.45, easing: "ease-in", fill: "forwards" };
		for (const [id, b] of after) {
			const a = before.snap.get(id);
			if (!a) {
				anims.push(b.el.animate(fadeIn, inOpts));
				continue;
			}
			const dx = a.r.left - b.r.left, dy = a.r.top - b.r.top;
			let sc = b.el.hasClass("tfb-box") || !b.r.height ? 1 : a.r.height / b.r.height;
			if (!isFinite(sc) || sc <= 0) sc = 1;
			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sc - 1) < 0.01) continue;
			anims.push(b.el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sc})` }, { transform: "none" }], moveOpts));
		}
		// leaving: a ghost fades where the word was
		this.ghosts.setCssProps({ "--tfb-gl": `${cr.left}px`, "--tfb-gt": `${cr.top}px`, "--tfb-gw": `${cr.width}px`, "--tfb-gh": `${cr.height}px` });
		let n = 0;
		for (const [id, a] of before.snap) {
			if (after.has(id) || n > 900) continue;
			if (a.r.bottom < before.cr.top || a.r.top > before.cr.bottom) continue;
			const g = a.el.cloneNode(true) as HTMLElement;
			g.removeAttribute("data-id");
			g.addClass("tfb-ghost");
			g.setCssProps({ "--tfb-x": `${a.r.left - cr.left}px`, "--tfb-y": `${a.r.top - cr.top}px`, "--tfb-w": `${a.r.width}px`, "--tfb-h": `${a.r.height}px`, "--tfb-font": a.font, "--tfb-color": a.color, "--tfb-bg": a.bg });
			this.ghosts.append(g);
			n++;
			anims.push(g.animate(fadeOut, outOpts));
		}
		return anims;
	}

	stop(): void {
		for (const a of this.running) a.cancel();
		this.running = [];
		this.ghosts.empty();
		if (this.tr) {
			for (const a of this.tr.anims) a.cancel();
			this.tr = null;
		}
		this.pos = null;
		window.cancelAnimationFrame(this.springId);
		this.springId = 0;
		this.content.removeClass("tfb-morphing");
	}

	/** The place that stays put: the row under the pointer, else the one a third of the way down. */
	anchorAt(pt: { x: number; y: number } | null): Anchor | null {
		const cr = this.content.getBoundingClientRect();
		const y = pt ? pt.y : cr.top + cr.height * 0.3;
		let el: HTMLElement | null = pt ? (this.content.doc.elementFromPoint(pt.x, pt.y) as HTMLElement | null) : null;
		el = el && this.content.contains(el) ? el.closest<HTMLElement>("[data-anchor]") : null;
		if (!el) {
			let best: HTMLElement | null = null, bd = Infinity;
			for (const row of Array.from(this.content.querySelectorAll<HTMLElement>("[data-anchor]"))) {
				const r = row.getBoundingClientRect();
				if (!r.height) continue;
				const d = r.top > y ? r.top - y : r.bottom < y ? y - r.bottom : 0;
				if (d < bd) {
					bd = d;
					best = row;
				}
				if (r.top > y + 1500) break;
			}
			el = best;
		}
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { id: el.dataset.anchor ?? "", y, frac: r.height ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0 };
	}

	settle(a: Anchor | null): void {
		if (!a) return;
		const el = this.hooks.locate(a.id);
		if (!el) return;
		const r = el.getBoundingClientRect();
		this.content.scrollTop += r.top + a.frac * r.height - a.y;
	}

	/** A timed change: a key, a button, a click on a paragraph. */
	morph(mutate: () => void, anchor: Anchor | null): void {
		this.stop();
		if (this.reduced) {
			mutate();
			this.settle(anchor);
			return;
		}
		this.content.addClass("tfb-morphing");
		const before = this.snapshot();
		mutate();
		this.settle(anchor);
		this.running = this.build(before, false);
		const mine = this.running;
		window.setTimeout(() => {
			if (this.running !== mine) return;
			this.running = [];
			this.ghosts.empty();
			this.content.removeClass("tfb-morphing");
		}, DUR + 60);
	}

	jump(level: number): void {
		if (level === this.hooks.level()) return;
		this.morph(() => this.hooks.render(level), this.anchorAt(null));
		this.hooks.settled(level);
	}

	// ---- zoom as a position, not a jump ----

	private prepare(to: number): void {
		const from = this.hooks.level(), anchor = this.anchorAt(this.gesturePt), scroll0 = this.content.scrollTop;
		for (const a of this.running) a.cancel();
		this.running = [];
		this.ghosts.empty();
		this.content.addClass("tfb-morphing");
		const before = this.snapshot();
		this.hooks.render(to);
		this.settle(anchor);
		const anims = this.reduced ? [] : this.build(before, true);
		for (const a of anims) {
			a.pause();
			a.currentTime = 0;
		}
		this.tr = { from, to, anims, scroll0 };
	}

	private finish(keep: boolean): void {
		if (!this.tr) return;
		for (const a of this.tr.anims) a.cancel();
		this.ghosts.empty();
		if (!keep) {
			this.hooks.render(this.tr.from);
			this.content.scrollTop = this.tr.scroll0;
		}
		this.tr = null;
	}

	private step(): void {
		if (this.pos === null) return;
		for (let guard = 0; guard < 8; guard++) {
			const L = this.hooks.level();
			if (!this.tr) {
				if (Math.abs(this.pos - L) < 0.005) break;
				this.prepare(this.pos > L ? L + 1 : L - 1);
			}
			const tr = this.tr;
			if (!tr) break;
			const p = (this.pos - tr.from) / (tr.to - tr.from);
			if (p >= 0.999) {
				this.finish(true);
				continue;
			}
			if (p <= 0.001) {
				this.finish(false);
				continue;
			}
			for (const a of tr.anims) a.currentTime = p * 1000;
			break;
		}
		this.hooks.shown(Math.min(5, Math.max(1, this.pos)));
	}

	/** A gesture moved the zoom by dz levels (positive: coarser), around the point under the pointer. */
	zoomBy(dz: number, pt: { x: number; y: number } | null): void {
		if (this.running.length) {
			for (const a of this.running) a.cancel();
			this.running = [];
			this.ghosts.empty();
		}
		window.cancelAnimationFrame(this.springId);
		this.springId = 0;
		if (this.pos === null) this.pos = this.hooks.level();
		this.gesturePt = pt;
		this.pos = Math.min(5, Math.max(1, this.pos + dz));
		this.step();
		window.clearTimeout(this.snapTimer);
		this.snapTimer = window.setTimeout(() => this.spring(), 170);
	}

	/** The slider: a position between levels, held until it is let go. */
	scrubTo(x: number): void {
		if (this.pos === null) this.pos = this.hooks.level();
		window.cancelAnimationFrame(this.springId);
		this.springId = 0;
		window.clearTimeout(this.snapTimer);
		this.gesturePt = null;
		this.pos = Math.min(5, Math.max(1, x));
		this.step();
	}

	spring(): void {
		if (this.pos === null) return;
		const goal = Math.round(this.pos);
		const tick = () => {
			if (this.pos === null) return;
			this.pos += (goal - this.pos) * 0.28;
			if (Math.abs(goal - this.pos) < 0.01) this.pos = goal;
			this.step();
			if (this.pos !== goal) this.springId = window.requestAnimationFrame(tick);
			else {
				this.springId = 0;
				this.pos = null;
				this.content.removeClass("tfb-morphing");
				this.hooks.settled(goal);
			}
		};
		this.springId = window.requestAnimationFrame(tick);
	}
}
