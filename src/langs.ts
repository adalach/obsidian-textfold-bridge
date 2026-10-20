// The languages TextFold reads a text in. TextFold lists them (GET /api/langs) and keeps the reader's own language;
// until a TextFold that does answers, the plugin uses the list of its textfold/langs.py, and English.

export interface Lang {
	code: string;
	name: string; // in its own words, as TextFold's menus show it
}

export const FALLBACK_LANGS: Lang[] = [
	["en", "English"], ["zh", "简体中文"], ["zh-Hant", "繁體中文"], ["ja", "日本語"], ["ko", "한국어"], ["es", "Español"], ["fr", "Français"],
	["de", "Deutsch"], ["pt", "Português"], ["it", "Italiano"], ["ru", "Русский"], ["hi", "हिन्दी"], ["sv", "Svenska"], ["da", "Dansk"],
	["nb", "Norsk bokmål"], ["fi", "Suomi"], ["nl", "Nederlands"], ["pl", "Polski"], ["cs", "Čeština"], ["uk", "Українська"], ["tr", "Türkçe"],
	["id", "Bahasa Indonesia"], ["vi", "Tiếng Việt"],
].map(([code, name]) => ({ code, name }));

/** TextFold's list as GET /api/langs gives it ([{code, name}] or {code: name}), or null when it is not one. */
export function parseLangs(data: unknown): Lang[] | null {
	if (Array.isArray(data)) {
		const out = data.flatMap((x): Lang[] => {
			const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
			return typeof o.code === "string" && o.code ? [{ code: o.code, name: typeof o.name === "string" && o.name ? o.name : o.code }] : [];
		});
		return out.length ? out : null;
	}
	if (data && typeof data === "object") {
		const out = Object.entries(data as Record<string, unknown>).flatMap(([code, name]): Lang[] => (typeof name === "string" ? [{ code, name }] : []));
		return out.length ? out : null;
	}
	return null;
}

/** The reader's language in an answer of TextFold's (its settings or models), if it says one. */
export function readerLangOf(data: unknown): string | null {
	const o = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	for (const k of ["readerLang", "reader_lang", "lang", "language"]) if (typeof o[k] === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(o[k])) return o[k];
	return null;
}

/** The language to fold in: the one chosen, or TextFold's own ("textfold"), else English. */
export function foldLanguage(setting: string, readerLang: string | null): string {
	return setting && setting !== "textfold" ? setting : readerLang ?? "en";
}

/** "TextFold's language" first, then each language TextFold reads in, by its own name. */
export function languageOptions(langs: Lang[] | null): Record<string, string> {
	return { textfold: "TextFold's language", ...Object.fromEntries((langs ?? FALLBACK_LANGS).map(l => [l.code, l.name])) };
}
