# Developing TextFold Bridge

## Build and test

```bash
npm install
npm run build   # typecheck, then a minified main.js
npm run dev     # an unminified main.js with an inline source map, for debugging
npm test        # the logic tests in test/
npm run lint    # eslint with Obsidian's plugin review rules (eslint-plugin-obsidianmd)
```

Obsidian loads `main.js`, `manifest.json` and `styles.css` from `<vault>/.obsidian/plugins/textfold-bridge/`. Each build copies the three files there: into the folder named by the `TEXTFOLD_BRIDGE_PLUGIN_DIR` environment variable, or else into `~/Documents/Obsidian Vault/.obsidian/plugins/textfold-bridge/` when that vault's plugins folder exists. After a rebuild, run `obsidian plugin:reload id=textfold-bridge` (the Obsidian CLI) or turn the plugin off and on under **Settings → Community plugins**.

## Against a running TextFold

Run TextFold from a clone of its repository, which reads and writes only the clone's own `papers/`:

```bash
cd <textfold clone> && python3 -m textfold serve --port 3017
```

With the address on **Automatic** and no `server.json` in TextFold's data folder, the plugin uses `http://127.0.0.1:3017`. TextFold's desktop app picks a free port from 31917 up and keeps your own library; test against the clone, not against it. One-off check scripts go in `temp/`, which is git-ignored.

## How it works

`src/main.ts` only wires the parts together. Three modules hold the logic as pure functions without runtime imports from `obsidian`, tested in `test/`:

- `src/links.ts` parses and builds `textfold://open?paper=…` links, maps one to the reader's address (`<server>/p/<id>?lang=<code>#n=<note>&u=<paragraph>&level=<name>`; the reader reads each of `#n=`, `#u=`, `#level=` on its own, so a link with both a note and a paragraph still lands on the paragraph when the note is gone), and finds the documents a note refers to in its `textfold:` property and its text.
- `src/server.ts` finds TextFold: `dataFolders()` follows TextFold's own `store.app_data()`, `parseServerFile()` accepts only a `textfold/server` file of version 1 on `127.0.0.1`, and `resolveServer()` takes the first `server.json` whose process still runs (`process.kill(pid, 0)`) and whose URL answers, else the default port. The request that checks an address is passed in, so the tests run it against real files in a temporary folder.
- `src/notes.ts` reads `GET /api/papers` and `GET /api/notes/<id>` (TextFold's `docs/notes-format.md`) leniently, and turns an answer's inline citations (`[[u6]]`, `[[?]]`, `[[!12]]`) into reader links before Obsidian renders them, so they never become wikilinks.

`src/client.ts` is the only code that makes requests: `requestUrl` GETs to `127.0.0.1` only, queued one at a time, each given up after 2.5 s (the alive check, `GET /api/models`) or 8 s. An address that answered is reused for a minute; a failed request makes the next one look again. It never POSTs.

`src/opener.ts` opens links. Obsidian opens an external link through `window.open` both in Live Preview (`triggerClickableToken`: the link is a CodeMirror token, not an `<a>`) and in Reading view (`onExternalLinkClick` on `a.external-link`, whose `textfold:` href the renderer keeps). For a scheme other than http(s) and `obsidian:` the main process asks before passing it to the system; an http(s) URL opened with the target `_external` goes to the default browser instead of Obsidian's web viewer. So a capture-phase click handler takes `a[href^="textfold:" i]` in every window (Reading view, embeds, hover previews, the sidebar's hover card), and a wrapper around `window.open` takes `textfold:` URLs from Live Preview. Everything else passes through. On unload the wrapper is removed if it is still the outermost one, and otherwise turns into a pass-through.

`src/view.ts` is the sidebar (`textfold-notes`). It refreshes on `file-open`, when Obsidian's window gets the focus back (at most every 3 s, only while the view is shown), when the note's set of documents changes, and from its refresh button. Each note is one row; hovering it for 350 ms shows a card beside the sidebar with the passage, the reader's text and the conversation, rendered with `MarkdownRenderer` into a child component that is unloaded when the card hides. Server text goes in through `setText` and `MarkdownRenderer` only. `src/picker.ts` is the **Insert link to a TextFold paper** picker. `src/settings.ts` declares the settings with `getSettingDefinitions()`, so they appear in Obsidian's settings search; the connection row is rendered by hand for its **Test connection** button.

The plugin reads a file outside the vault with Node's `fs`, so `isDesktopOnly` is `true`.

## Release

The id `textfold-bridge` is a working name; settle it before the first release, because an id cannot change once released.

1. `npm version <x.y.z>` sets the version in `package.json`, `manifest.json` and `versions.json` (through `version-bump.mjs`), commits, and tags the commit `x.y.z` without a `v`.
2. `git push --follow-tags` starts `.github/workflows/release.yml`, which checks that the tag matches `manifest.json`, builds, tests, lints and opens a draft release with `main.js`, `manifest.json` and `styles.css` attached.
3. Review the draft on GitHub and publish it.
