// A note as plain Markdown for TextFold ("Fold this note"): Obsidian's own syntax flattened, so TextFold reads the text
// as written. No runtime imports from obsidian; test/flatten.test.ts covers it.
//
//   [[a|b]] -> b   [[a]] -> a   [[a#h]] -> a > h   ![[embed]] and ![image](…) dropped   %% comment %% dropped
//   > [!note] Title -> > **Title**   ==highlight== -> highlight   block ids (^abc) dropped   front matter replaced
// Code (fenced blocks and inline spans) is left exactly as written.

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const MARK = "\uE000"; // a private-use character: stands in for inline code while the rest is changed

/** The text to send: the note's body flattened, under front matter holding only the note's own `title`, if it has one
 *  (TextFold otherwise takes a single top-level heading, else the file's name). */
export function flattenNote(text: string, frontmatterTitle?: unknown): string {
	const body = flatten(stripFrontmatter(text));
	const title = typeof frontmatterTitle === "string" ? frontmatterTitle.trim() : "";
	return title ? `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}` : body;
}

export function stripFrontmatter(text: string): string {
	const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
	return m ? text.slice(m[0].length) : text;
}

function flatten(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let prose: string[] = [];
	let fence: string | null = null;
	const flush = () => {
		if (prose.length) out.push(...flattenProse(prose.join("\n")).split("\n"));
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

function flattenProse(text: string): string {
	// inline code is kept as it is: set aside while the rest changes
	const code: string[] = [];
	let s = text.replace(/(`+)[^`\n][\s\S]*?\1/g, m => `${MARK}${code.push(m) - 1}${MARK}`);
	s = s.replace(/%%[\s\S]*?(?:%%|$)/g, ""); // comments, also over several lines (an unclosed one runs to the end)
	s = s.replace(/!\[\[[^\]\n]*\]\]/g, ""); // embeds
	s = s.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ""); // images, so TextFold fetches nothing
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
