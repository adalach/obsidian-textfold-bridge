// Settings as stored, brought up to date when an older version saved them. Pure: test/fold.test.ts covers it.
import type { BridgeSettings } from "./settings";

/** Settings as stored, brought up to date: 0.4 kept the fold language as foldLang ("en" unless changed). */
export function migrateSettings(data: Record<string, unknown>): Partial<BridgeSettings> {
	const out = { ...data } as Partial<BridgeSettings> & { foldLang?: unknown };
	if (out.language === undefined && typeof out.foldLang === "string" && out.foldLang && out.foldLang !== "en") out.language = out.foldLang;
	delete out.foldLang;
	return out;
}
