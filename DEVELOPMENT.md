# Developing TextFold Bridge

## Build and test

```bash
npm install
npm run build   # typecheck, then a minified main.js
npm run dev     # an unminified main.js with an inline source map, for debugging
npm test        # the logic tests in test/
npm run lint    # eslint with Obsidian's plugin review rules (eslint-plugin-obsidianmd)
```

Obsidian loads `main.js`, `manifest.json` and `styles.css` from `<vault>/.obsidian/plugins/textfold-bridge/`. Each build copies the three files there: into the folder named by the `TEXTFOLD_BRIDGE_PLUGIN_DIR` environment variable, or else into `~/Documents/Obsidian Vault/.obsidian/plugins/textfold-bridge/` when that vault's plugins folder exists. After a rebuild, run `obsidian plugin:reload id=textfold-bridge` (the Obsidian CLI; add `vault="<name>"` when more than one vault is open) or turn the plugin off and on under **Settings → Community plugins**.

## Against a running TextFold

Run TextFold from a clone of its repository, with the clone as its data folder, so it reads and writes only the clone's own test library:

```bash
cd <textfold clone> && TEXTFOLD_NO_MODELS=1 TEXTFOLD_DATA=<textfold clone> python3 -m textfold serve --port 3017
```

`TEXTFOLD_NO_MODELS=1` makes it find no model, so Fold and Refold run through without a model call (the document reads as written, and the sidebar says so); leave it out only to test folding with the model, which costs. The server writes `server.json` into the clone: name the clone under **TextFold run from source** to test discovery, or rely on the default port. TextFold's desktop app picks a free port from 31917 up and keeps your own library; test against the clone, not against it. Documents a test folds land in the clone's `papers/`; delete them, `server.json` and `library.json` afterwards. One-off check scripts go in `temp/`, which is git-ignored.

Drops are tested with a synthetic `DragEvent` carrying a `DataTransfer` (`new DataTransfer()`, `setData(...)`) dispatched on the test note's `cm.contentDOM` at `cm.coordsAtPos(...)`, and pastes with a `ClipboardEvent`; check first that the test note is the active one. A real drag from TextFold's app cannot be automated.

When testing commands through the Obsidian CLI, call the plugin with an explicit file (`app.plugins.plugins['textfold-bridge'].folds.fold(file)`) rather than running **Fold this note** by id: the command folds whatever note is active, which may be someone else's while Obsidian is in use.

## How it works

`src/main.ts` only wires the parts together and keeps the plugin's data: the settings and, under `folds`, one record per folded document (`FoldRecord`: the note, the hash of the text sent, the language, the last job).

Pure modules without runtime imports from `obsidian`, tested in `test/`:

- `src/links.ts` parses and builds `textfold://open?paper=…` links, maps one to the reader's address (`<server>/p/<id>?lang=<code>#n=<note>&u=<paragraph>&level=<name>`; the reader reads each of `#n=`, `#u=`, `#level=` on its own, so a link with both a note and a paragraph still lands on the paragraph when the note is gone), finds the documents a note refers to in its `textfold:` property and its text, and adds or removes an id in that property.
- `src/server.ts` finds TextFold: `dataFolders()` follows TextFold's own `store.app_data()`, `parseServerFile()` accepts only a `textfold/server` file of version 1 on `127.0.0.1`, and `resolveServer()` takes the first `server.json` whose process still runs (`process.kill(pid, 0)`) and whose URL answers, else the default port. The client puts the **TextFold run from source** folder before the system's data folder.
- `src/notes.ts` reads `GET /api/papers` (with `citekey` when TextFold lists one) and `GET /api/notes/<id>` (TextFold's `docs/notes-format.md`, including `anchor.lost` after a refold) leniently.
- `src/doc.ts` reads `GET /api/doc/<id>` (the `textfold/doc` format, `docs/format.md`): section names as the reader writes them, each unit's text per level, reading order and the reader's cite labels (`§3 ¶2`).
- `src/notesMarkdown.ts` groups notes by section in reading order and writes the imported block in the style of TextFold's `notesMarkdown` (reader.js); `replaceBlock()` swaps only the text between the two markers.
- `src/drag.ts` reads what TextFold puts on a drag or the clipboard, in order `application/x-textfold+json`, the same JSON in a `data-textfold` attribute of the `text/html`, or a lone `textfold://` link in `text/uri-list` or `text/plain` (filled in from `/api/doc` and the notes by `itemFromLink`), and writes the callout, quote or link a drop inserts. The JSON is TextFold's `textfold/drag` version 1 (`dragData` in its reader.js): for a note `text` is the reader's words or else the passage, `quote` the passage, `comment` the reader's words; for an Ask `text` is the last answer in one sentence and `comment` the question. The link in it is parsed and written anew, so a drop only ever inserts a `textfold://` link to its own document, and a `[[…]]` in it never becomes a wikilink (citations in the model's words become reader links).
- `src/flatten.ts` flattens a note for folding (outside code: wikilinks, embeds, images, comments, callouts, block ids, highlight marks) and hashes what is sent.

`src/client.ts` is the only code that makes requests: `requestUrl` to `127.0.0.1` only, queued one at a time, each given up after 2.5 s (the alive check, `GET /api/models`), 8 s (reads) or 30 s (an import). `requestUrl` goes through Obsidian's main process without an `Origin` header, which TextFold's check on POSTs accepts. A document's doc JSON is cached for the session and forgotten when it is folded again; an address that answered is reused for a minute.

`src/fold.ts` is **Fold this note**: a first fold asks once (it sends the note and uses TextFold's model), then `POST /api/import {name, text}`, `processFrontMatter` adds the id, and `POST /api/generate`; a refold is `POST /api/import {name, text, id}` (409 busy, 404 gone: the id leaves the property) and a generate with `force`. While a fold runs it follows `GET /api/jobs` every 1.5 s and stops when the job ends. `state()` tells the sidebar: folding, changed since (the hash differs), failed, or folded; a document stored without levels (`provenance.local`) is shown as such and Refold folds it.

`src/importer.ts` is **Import notes**: per document `GET /api/notes`, `GET /api/doc`, then a new note (named by `noteFileName()`) or the note in the folder whose `textfold` property is the id; `vault.process` replaces the block only when it changed, and `processFrontMatter` sets only the properties the import owns.

`src/drop.ts` handles Obsidian's `editor-drop` and `editor-paste` in any Markdown editor: when `readTransfer()` finds a TextFold item it calls `preventDefault()` at once (else Obsidian handles the event as always), takes the position under the pointer from CodeMirror's `posAtCoords` (the cursor for a paste), and inserts the block on lines of its own, splitting a paragraph it was dropped into, or the link among the words with spaces. The sidebar's rows put the same data on their `dragstart` (`setTransfer`).

`src/opener.ts` opens links. Before opening, it checks the document against `/api/papers` (kept for 30 s by the client): one the running TextFold has not gets a notice instead, since TextFold would show its home screen. Obsidian opens an external link through `window.open` both in Live Preview (`triggerClickableToken`: the link is a CodeMirror token, not an `<a>`) and in Reading view (`onExternalLinkClick` on `a.external-link`, whose `textfold:` href the renderer keeps). For a scheme other than http(s) and `obsidian:` the main process asks before passing it to the system; an http(s) URL opened with the target `_external` goes to the default browser instead of Obsidian's web viewer. So a capture-phase click handler takes `a[href^="textfold:" i]` in every window, and a wrapper around `window.open` takes `textfold:` URLs from Live Preview. Everything else passes through. On unload the wrapper is removed if it is still the outermost one, and otherwise turns into a pass-through.

`src/hover.ts` shows hover previews in Obsidian's own `HoverPopover` (page previews only show vault files): a mouseover on `a[href^="textfold:"]` in every window, and in the editor a CodeMirror `mouseover` handler that, with Cmd/Ctrl held, finds the Markdown link under the pointer in the line's text (the address is not in Live Preview's DOM). It shows a paragraph at the link's level or Takeaway, a section's title and summary (`s=`), a note, the document's title, authors and note count, or that TextFold has no such document.

`src/view.ts` is the sidebar (`textfold-notes`). It refreshes on `file-open`, when Obsidian's window gets the focus back (at most every 3 s, only while the view is shown), when the note's set of documents changes, when a fold ends, and from its refresh button; an edit of a folded note only recomputes its fold state. Notes are grouped under their sections' names; a lost note is in italics with a warning mark. Hovering a row for 350 ms shows a card beside the sidebar with the passage, the reader's text and the conversation, rendered with `MarkdownRenderer` into a child component that is unloaded when the card hides. Server text goes in through `setText` and `MarkdownRenderer` only. `src/picker.ts` is the **Insert link to a TextFold paper** picker. `src/settings.ts` declares the settings with `getSettingDefinitions()`, so they appear in Obsidian's settings search; the connection row is rendered by hand for its **Test connection** button.

The plugin reads a file outside the vault with Node's `fs`, so `isDesktopOnly` is `true`.

## Release

Nothing is released. The id `textfold-bridge` is a working name; settle it before a first release, because an id cannot change once released.

1. `npm version <x.y.z>` sets the version in `package.json`, `manifest.json` and `versions.json` (through `version-bump.mjs`), commits, and tags the commit `x.y.z` without a `v`.
2. `git push --follow-tags` starts `.github/workflows/release.yml`, which checks that the tag matches `manifest.json`, builds, tests, lints and opens a draft release with `main.js`, `manifest.json` and `styles.css` attached.
3. Review the draft on GitHub and publish it.
