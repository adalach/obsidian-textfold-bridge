# TextFold Bridge

**Link your Obsidian notes to papers in TextFold.**

[TextFold](https://github.com/chenxiachan/textfold) is a local reader that folds a paper into five zoom levels (Full, Brief, Key, Takeaway, Topic), translates it, and keeps your highlights, comments and questions to a model beside the text. TextFold Bridge connects it to Obsidian the way Zotero and the Zotero Integration plugin work together: TextFold stores and shows the papers and everything you wrote on them, and your notes keep links into it.

**You need TextFold installed and running.** This plugin does not install, start or update TextFold.

## What it does

- **`textfold://` links.** A link opens the paper in TextFold, at a paragraph, a note or a zoom level. Click it in Reading view, in Live Preview or in the sidebar.
- **Hover previews.** Hover a link to see its paragraph (at the link's level, else Takeaway), its note, or the paper's title and authors. In Reading view a hover is enough; in the editor hold Cmd (Ctrl on Windows and Linux), as with Obsidian's page previews.
- **Insert link to a TextFold paper.** A command that searches TextFold's documents by title, id or citekey and inserts `[Title](textfold://open?paper=ID)` at the cursor. With text selected, the selection becomes the link's label.
- **TextFold notes sidebar.** For the note you are in, the TextFold documents it refers to, each with its highlights, comments and Ask conversations, one line per note, under the names of their sections. Hover a line to read the whole note, with the model's answer and the paragraphs it cites. Each line can open TextFold at that note, copy a link to it, or insert the link at the cursor. Open it with the command **Open TextFold notes**.
- **Fold this note.** Send the note you are writing to TextFold and read it at five levels there. When you edit it later, the sidebar says **Changed since folding** and offers **Refold**.
- **Import notes from TextFold.** Bring a document's TextFold notes into the vault as a note of its own, and update it later without losing what you wrote in it.

A note refers to a document through a property, a link in its text, or both:

```markdown
---
textfold: "2605.00089"
---
The zoning step follows [Convex Partition Zoner](textfold://open?paper=pdf-357ae69fe0759131&u=u6&level=key).
```

`textfold:` also takes a list of ids. Put an arXiv id in quotes, as above, or YAML may read it as a number and drop a trailing zero.

## Fold this note

Run **Fold this note** (or the layers button in the sidebar) in a note. The first time, the plugin asks before it sends anything. Then:

1. It sends the note's text to TextFold as a Markdown document, with Obsidian's own syntax flattened: `[[Note|label]]` becomes `label`, `[[Note]]` becomes `Note`, embeds, images and `%% comments %%` are left out, a callout becomes a plain quote, and block ids and `==highlight==` marks go. Code is sent as written. The note's properties stay in Obsidian; only a `title` property goes along.
2. It records the new document's id in the note's `textfold:` property.
3. TextFold folds it in the language set under **Settings → TextFold Bridge → Fold this note → Language** (`en` by default). **Folding uses the model you set up in TextFold**, at its cost. Without a model, TextFold stores the note and it reads as written; the sidebar says so.

The sidebar shows the fold's progress, then **Folded** with **Open in TextFold**. The plugin keeps a hash of the text it sent, so after an edit the sidebar shows **Changed since folding** and **Refold**. A refold puts the new text in place of the old under the same id: your highlights and questions on the note stay, TextFold finds their passages again in the new text, and asks its model only for the sections that changed. A note whose passage is gone after the edit stays, marked **Passage not found after the edit**. If TextFold is still folding the note, Refold says so and does nothing; if TextFold no longer has the document, the plugin takes the id out of the note's property, and the next **Fold this note** makes a new document.

Refold needs a TextFold with refold in place (newer than 0.10.15).

## Import notes

**Import notes from TextFold** picks a document, or all documents that have notes; the sidebar's download buttons import the documents shown there. Each document becomes one note in the folder set under **Import notes → Folder** (`TextFold` by default), named by its short title (the part before a colon) or, with **Note names → Citekey**, by its citekey when TextFold has one.

- Properties: `textfold` (the id), `title`, `authors`, `year`, `citekey` when there is one, and `link` (`textfold://open?paper=…`).
- The notes come between two marker comments, `%% TextFold notes: … %%` and `%% End of TextFold notes %%`, in the style of TextFold's own Markdown export for Obsidian: grouped by section, each highlight a quote with the note's id as its block id (`^n-…`, so other notes can link to it), then your comment and a link back to it in TextFold; each Ask conversation a `[!question]` callout, its citations links to the paragraphs they name.
- Importing again finds the note by its `textfold` property, replaces only what is between the markers and the properties above, and keeps everything else you wrote in the note and its other properties. An unchanged document leaves the note untouched.

Section names, paragraph previews and the cite labels in imported answers come from TextFold's `GET /api/doc` (newer than 0.10.15); with an older TextFold the plugin works without them.

## Links

```
textfold://open?paper=<document id>[&u=<paragraph id>][&n=<note id>][&level=<full|brief|key|takeaway|topic>][&lang=<code>]
```

- `paper`: the document's id in TextFold, as in its reader's address (`/p/<id>`).
- `u`: a paragraph; `n`: one of your notes; `level`: the zoom level; `lang`: the language to read it in.

**Settings → TextFold Bridge → Links → Open links in** chooses where a link opens:

- **Browser** (default): TextFold's reader page on the running TextFold, in your default browser.
- **TextFold app**: Obsidian hands the `textfold://` link to the system, for TextFold's desktop app to open. Only a packaged TextFold app registers itself for these links, so keep **Browser** unless you have one that does. Obsidian asks once before it opens links of a new kind; tick **Always open** there to stop the question.

## Finding TextFold

With **TextFold address** set to **Automatic**, the plugin reads `server.json`, which TextFold writes into its data folder while it runs, and uses `http://127.0.0.1:3017` (the port of `python3 -m textfold serve`) when there is none. A `server.json` left behind by a crash is skipped: its process must still run and its address must answer. TextFold's data folder:

| System  | Folder                                                        |
| ------- | ------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/TextFold`                      |
| Windows | `%LOCALAPPDATA%\TextFold`                                     |
| Linux   | `$XDG_DATA_HOME/textfold`, or `~/.local/share/textfold`       |

A TextFold run from a clone of its repository writes `server.json` in the clone's folder instead: name that folder under **TextFold run from source**, or set **TextFold address** to **Manual** and enter its address. **Test connection** shows whether TextFold answers, its version, and where its address came from.

## Privacy

- The plugin talks only to TextFold on `127.0.0.1`. It refuses any other address, also one set by hand.
- It reads TextFold's documents, notes and jobs with GET requests, one at a time, each given up after a few seconds.
- It writes to TextFold only when you fold a note: `POST /api/import` with the note's flattened text, and `POST /api/generate` to fold it. TextFold then sends the text to the model you set up in TextFold. Nothing else in TextFold is changed.
- It reads TextFold's `server.json`, a file outside your vault (see the table above). This is why the plugin is desktop only.
- It sends no telemetry and contacts no other server.
- Text from TextFold is shown through Obsidian's Markdown renderer or as plain text, never inserted as HTML.

## License

MIT. TextFold is a separate project under the Apache License 2.0.
