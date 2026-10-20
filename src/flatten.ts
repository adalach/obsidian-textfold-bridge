// A note as plain Markdown for TextFold ("Fold this note"): Obsidian's own syntax flattened, so TextFold reads the text
// as written. No runtime imports from obsidian; test/flatten.test.ts covers it.
//
//   [[a|b]] -> b   [[a]] -> a   [[a#h]] -> a > h   %% comment %% dropped
//   ![[picture.png]] and ![alt](picture.png) of the vault -> ![alt](data:image/png;base64,…), as fold.ts reads them
//   ![alt](https://…) kept (TextFold downloads it); any other embed (a note, a PDF) or picture dropped
//   > [!note] Title -> > **Title**   ==highlight== -> highlight   block ids (^abc) dropped   front matter replaced
// Code (fenced blocks and inline spans) is left exactly as written.

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const MARK = "\uE000"; // a private-use character: stands in for inline code while the rest is changed

/** A picture the note embeds: `![[target|alias]]`, or `![alt](src)`; `raw` is how it is written. */
export interface ImageRef {
	raw: string;
	kind: "embed" | "markdown";
	target: string; // the embed's link path (no subpath), or the Markdown image's address, decoded
	alt: string; // the embed's alias unless it is a size (300, 300x200), or the Markdown alt text
}

/** The text to send: the note's body flattened, under front matter holding only the note's own `title`, if it has one
 *  (TextFold otherwise takes a single top-level heading, else the file's name). `pictures` maps a picture as written
 *  (ImageRef.raw) to what goes in its place, such as a data-URI image; a vault picture not in it is left out. */
export function flattenNote(text: string, frontmatterTitle?: unknown, pictures?: Map<string, string>): string {
	const body = flatten(stripFrontmatter(text), pictures ?? new Map<string, string>());
	const title = typeof frontmatterTitle === "string" ? frontmatterTitle.trim() : "";
	return title ? `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}` : body;
}

export function stripFrontmatter(text: string): string {
	const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
	return m ? text.slice(m[0].length) : text;
}

function flatten(text: string, pictures: Map<string, string>): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let prose: string[] = [];
	let fence: string | null = null;
	const flush = () => {
		if (prose.length) out.push(...flattenProse(prose.join("\n"), pictures).split("\n"));
		prose = [];
	};
	for (const line of lines) {
		const m = FENCE.exec(line);
		if (fence) {
			out.push(line);
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
		} else if (m) {
			flush();
			fence = m[1];
			out.push(line);
		} else prose.push(line);
	}
	flush();
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

const EMBED = /!\[\[[^\]\n]*\]\]/g;
const MD_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;

/** The prose of a note as TextFold's flattening sees it: no front matter, no comments, code set aside. */
function prose(text: string, each: (chunk: string) => void): void {
	const lines = stripFrontmatter(text).replace(/\r\n?/g, "\n").split("\n");
	let fence: string | null = null;
	let chunk: string[] = [];
	const flush = () => {
		if (chunk.length) each(chunk.join("\n").replace(/(`+)[^`\n][\s\S]*?\1/g, "").replace(/%%[\s\S]*?(?:%%|$)/g, ""));
		chunk = [];
	};
	for (const line of lines) {
		const m = FENCE.exec(line);
		if (fence) {
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
		} else if (m) {
			flush();
			fence = m[1];
		} else chunk.push(line);
	}
	flush();
}

/** The pictures a note embeds, once each, outside its code and comments. */
export function imageRefs(text: string): ImageRef[] {
	const refs = new Map<string, ImageRef>();
	prose(text, chunk => {
		for (const m of chunk.matchAll(EMBED)) {
			const inner = m[0].slice(3, -2);
			const [path, ...rest] = inner.split("|");
			const alias = rest.join("|").trim();
			refs.set(m[0], { raw: m[0], kind: "embed", target: path.split("#")[0].trim(), alt: /^\d+(x\d+)?$/.test(alias) ? "" : alias });
		}
		for (const m of chunk.matchAll(MD_IMAGE)) {
			const parts = /^!\[([^\]]*)\]\(\s*(<[^>]*>|\S+)(?:\s+["'(].*)?\)$/.exec(m[0]);
			if (!parts) continue;
			let src = parts[2].replace(/^<|>$/g, "");
			try {
				if (!/^data:/i.test(src)) src = decodeURIComponent(src);
			} catch {
				// not %-encoded after all: as written
			}
			const alt = parts[1].split("|")[0].trim();
			refs.set(m[0], { raw: m[0], kind: "markdown", target: src, alt: /^\d+(x\d+)?$/.test(alt) ? "" : alt });
		}
	});
	return [...refs.values()];
}

/** A picture TextFold takes as it is: one on the web (it downloads it), or already a data URI. */
export function passesThrough(ref: ImageRef): boolean {
	return ref.kind === "markdown" && /^(?:https?:|data:image\/)/i.test(ref.target);
}

function flattenProse(text: string, pictures: Map<string, string>): string {
	// inline code is kept as it is: set aside while the rest changes
	const code: string[] = [];
	let s = text.replace(/(`+)[^`\n][\s\S]*?\1/g, m => `${MARK}${code.push(m) - 1}${MARK}`);
	s = s.replace(/%%[\s\S]*?(?:%%|$)/g, ""); // comments, also over several lines (an unclosed one runs to the end)
	s = s.replace(EMBED, m => pictures.get(m) ?? ""); // a vault picture as a data URI; any other embed dropped
	s = s.replace(MD_IMAGE, m => pictures.get(m) ?? (/^!\[[^\]]*\]\(\s*<?(?:https?:|data:image\/)/i.test(m) ? m : ""));
	s = s.replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, (_, _target: string, label: string) => label.trim());
	s = s.replace(/\[\[([^\]\n]+)\]\]/g, (_, target: string) => linkText(target));
	s = s.replace(/==([^=\n](?:[^\n]*?[^=\n])?)==/g, "$1");
	s = s
		.split("\n")
		.flatMap(line => {
			const callout = /^(\s*(?:>\s*)+)\[![\w-]+\][+-]?\s*(.*)$/.exec(line);
			if (callout) return callout[2].trim() ? [`${callout[1]}**${callout[2].trim()}**`, callout[1].trimEnd()] : [];
			if (/^\s*\^[\w-]+\s*$/.test(line)) return [];
			return [line.replace(/\s+\^[\w-]+\s*$/, "")];
		})
		.join("\n");
	return s.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_, i: string) => code[Number(i)]);
}

/** A wikilink's target as text: the note's name, a heading after " > ", no block reference. */
function linkText(target: string): string {
	const [note, ...rest] = target.split("#");
	const sub = rest.join("#").trim();
	const name = note.trim().replace(/\.md$/i, "");
	if (!sub || sub.startsWith("^")) return name || sub.replace(/^\^/, "");
	return name ? `${name} > ${sub}` : sub;
}

/** A short hash of what was sent, to tell later whether the note changed since. */
export async function textHash(text: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(bytes).slice(0, 12), b => b.toString(16).padStart(2, "0")).join("");
}

/** What became of a note's pictures in a fold: how many went along, and which were left out, and why. */
export interface PictureReport {
	sent: number;
	left: { name: string; why: string }[];
}

/** " 2 pictures went along; 1 left out: diagram.svg (SVG).", or "" for a note without pictures. */
export function describePictures(r: PictureReport): string {
	if (!r.sent && !r.left.length) return "";
	const parts: string[] = [];
	if (r.sent) parts.push(`${r.sent} picture${r.sent === 1 ? "" : "s"} went along`);
	if (r.left.length) parts.push(`${r.left.length} left out: ${r.left.map(x => `${x.name} (${x.why})`).join(", ")}`);
	return ` ${parts.join("; ")}.`;
}
