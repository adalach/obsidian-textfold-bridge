# TextFold Bridge

**Link your Obsidian notes to papers in TextFold.**

[TextFold](https://github.com/chenxiachan/textfold) is a local reader that folds a paper into five zoom levels (Full, Brief, Key, Takeaway, Topic), translates it, and keeps your highlights, comments and questions to a model beside the text. TextFold Bridge connects it to Obsidian the way Zotero and the Zotero Integration plugin work together: TextFold stores and shows the papers and everything you wrote on them, and your notes keep links into it.

**You need TextFold installed and running.** This plugin does not install, start or update TextFold.

## What it does

- **`textfold://` links.** A link opens the paper in TextFold, at a paragraph, a note or a zoom level. Click it in Reading view, in Live Preview or in the sidebar.
- **Insert link to a TextFold paper.** A command that searches TextFold's documents by title or id (and citekey, once TextFold lists one) and inserts `[Title](textfold://open?paper=ID)` at the cursor. With text selected, the selection becomes the link's label.
- **TextFold notes sidebar.** For the note you are in, the TextFold documents it refers to, each with its highlights, comments and Ask conversations, one line per note. Hover a line to read the whole note, with the model's answer and the paragraphs it cites. Each line can open TextFold at that note, copy a link to it, or insert the link at the cursor. Open it with the command **Open TextFold notes**.

A note refers to a document through a property, a link in its text, or both:

```markdown
---
textfold: 2605.00089
---
The zoning step follows [Convex Partition Zoner](textfold://open?paper=pdf-357ae69fe0759131&u=u6&level=key).
```

`textfold:` also takes a list of ids. Put an arXiv id in quotes (`textfold: "2605.10010"`), or YAML may read it as a number and drop a trailing zero.

## Links

```
textfold://open?paper=<document id>[&u=<paragraph id>][&n=<note id>][&level=<full|brief|key|takeaway|topic>][&lang=<code>]
```

- `paper`: the document's id in TextFold, as in its reader's address (`/p/<id>`).
- `u`: a paragraph; `n`: one of your notes; `level`: the zoom level; `lang`: the language to read it in.

**Settings → TextFold Bridge → Open links in** chooses where a link opens:

- **Browser** (default): TextFold's reader page on the running TextFold, in your default browser.
- **TextFold app**: Obsidian hands the `textfold://` link to the system, for a TextFold that opens these links. Obsidian asks once before it opens links of a new kind; tick **Always open** there to stop the question.

## Finding TextFold

With **TextFold address** set to **Automatic**, the plugin reads `server.json`, which TextFold writes into its data folder while it runs, and uses `http://127.0.0.1:3017` (the port of `python3 -m textfold serve`) when there is none. A `server.json` left behind by a crash is skipped: its process must still run and its address must answer. TextFold's data folder:

| System  | Folder                                                        |
| ------- | ------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/TextFold`                      |
| Windows | `%LOCALAPPDATA%\TextFold`                                     |
| Linux   | `$XDG_DATA_HOME/textfold`, or `~/.local/share/textfold`       |

A TextFold run from a clone of its repository writes `server.json` in that folder instead; set **TextFold address** to **Manual** and enter its address, such as `http://127.0.0.1:3017`. **Test connection** shows whether TextFold answers, its version, and where its address came from.

## Privacy

- The plugin talks only to TextFold on `127.0.0.1`. It refuses any other address, also one set by hand.
- It only reads: GET requests for the list of documents and a document's notes, one at a time, each given up after a few seconds. It never changes anything in TextFold.
- It reads TextFold's `server.json`, a file outside your vault (see the table above). This is why the plugin is desktop only.
- It sends no telemetry and contacts no other server.
- Answers from TextFold are shown as Markdown through Obsidian's renderer, never inserted as HTML.

## Not yet

Planned for 0.2: **Fold this note** (send a note's Markdown to TextFold to read it at five levels), importing TextFold's notes into the vault, and previews of a link's paragraph on hover.

## License

MIT. TextFold is a separate project under the Apache License 2.0.
