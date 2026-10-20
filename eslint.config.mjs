// Lint with Obsidian's community-plugin rules (the same checks the plugin review runs).
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
	globalIgnores(["node_modules", "main.js", "design", "temp"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["*.mjs"] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
		// TextFold is a name: keep its capitals in UI text
		rules: { "obsidianmd/ui/sentence-case": ["warn", { ignoreWords: ["TextFold"] }] },
	},
	// build scripts and tests run in Node, not in Obsidian (the build copies into a vault's plugin folder)
	{
		files: ["*.mjs", "test/**/*.ts"],
		languageOptions: { globals: globals.node },
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"import/no-extraneous-dependencies": "off",
		},
	},
]);
