# TextFold Bridge

**Link your Obsidian notes to papers in TextFold.**

[TextFold](https://github.com/chenxiachan/textfold) is a local reader that folds a paper into five zoom levels (Full, Brief, Key, Takeaway, Topic), translates it, and keeps your highlights, comments and questions to a model beside the text. TextFold Bridge connects it to Obsidian the way Zotero and the Zotero Integration plugin work together: TextFold stores and shows the papers and everything you wrote on them, and your notes keep links into it.

**You need TextFold installed and running.** This plugin does not install, start or update TextFold.

## What it does

- **`textfold://` links.** A link opens the paper in TextFold, at a paragraph, a note or a zoom level. Click it in Reading view, in Live Preview or in the sidebar.
- **Hover previews.** Hover a link to see its paragraph (at the link's level, else Takeaway), its section's title and summary, its note, one turn of a conversation (question and answer), or the paper's title and authors. In Reading view a hover is enough; in the editor hold Cmd (Ctrl on Windows and Linux), as with Obsidian's page previews.
- **Drops from TextFold.** Drag a paragraph, a section's summary, a note, a conversation or a selection from TextFold's reader into any note, or copy and paste it: it goes in where you drop it, with its title, section and a link back.
- **Insert link to a TextFold paper.** A command that searches TextFold's documents by title, id or citekey and inserts `[Title](textfold://open?paper=ID)` at the cursor. With text selected, the selection becomes the link's label.
- **TextFold sidebar.** For the note you are in, two lists behind a switch at the top. **In this note**: every TextFold citation in the note, one line each with what it cites; a click goes to that place in the note. **In TextFold**: the TextFold documents the note refers to, each with its highlights, comments and Ask conversations under their sections; hover a line to read the whole note with the model's answer, open TextFold at it, copy or insert its link, or drag it into a note. Open the sidebar with the command **Open TextFold notes**.
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

## Citations in this note

**In this note**, at the top of the sidebar, lists every `textfold://` link in the open note, in reading order: plain links, dropped callouts and quotes, and the ↗ icon links alike. A line shows what the link cites, as TextFold has it (the paragraph or section summary at the link's level, else Takeaway; a note's passage; an Ask's question, the linked turn's for a link to one turn), or else the link's own words, and on the right the paper's short title. Hover a line to preview it.

- **Click a line** to go to the link in the note: it scrolls into the middle and lights up for a moment, with the cursor on it in Live Preview and Source mode; in Reading view its line and the link light up.
- **The TextFold icon** on a line (shown on hover) opens TextFold there, as a click on the link would.
- **By heading · By paper** chooses the grouping: under the note's headings (links before the first heading under the note's title), or by paper, then by the paper's section, in the paper's order. Each group shows its count and folds away with a click. The plugin remembers the choice.

The list follows the note as you edit it and as you switch notes; it asks TextFold again only when the set of cited papers changes.

## Drops from TextFold

Drag something from TextFold's reader (a paragraph by its handle, a heading, a summary, a chip of the Topic map, a note's card, or selected text) into a note, or copy it and paste. The item goes in at the drop point, as set under **Settings → TextFold Bridge → Drops from TextFold → Dropped TextFold items as**:

- **Callout** (default):

  ```markdown
  > [!textfold] Convex Primitive Decomposition › 3 Method
  > The paragraph, at the level it was dragged at. [↗](textfold://open?paper=2602.07369&u=S3.p2&level=key)
  ```

  The callout's last line ends with a `↗` link back, which the plugin draws as TextFold's icon. A note shows its passage and then your comment; a conversation its passage, your question in bold and the answer. When the text is the model's words (a Key, Takeaway or Topic level, a summary, an answer), the callout says `[!textfold|written]` and shows "written by the model" after its title. The callout carries TextFold's icon and takes the colour of your theme's "example" callout.
- **Quote**: the text as a quote, its last line ending in the `↗` link back (and "written by the model" for the model's words).
- **Text**: just the text, followed by the TextFold icon that links back:

  ```markdown
  Primitives are fitted greedily. [↗](textfold://open?paper=2602.07369&u=S3.p2&level=key)
  ```

  A paragraph, summary, selection or chip goes in as it read; a note as its passage, then your comment; a conversation as its answer in one sentence. Dropped among words it goes in among them, else on a line of its own. The plugin draws every `textfold://` link labelled exactly `↗` as TextFold's icon, in Reading view and in Live Preview (put the cursor in it to edit the Markdown); a click opens TextFold there and a hover previews it. Without the plugin, on another device or in another app, it reads as the text and a ↗ link.
- **Full link**: a titled link, `[Title › Section](link)`, among the words where it was dropped.

A dragged or pasted bare `textfold://` link is filled in the same way from TextFold (title, section, the paragraph or summary at the link's level). Every other drop and paste is left to Obsidian. Rows of the TextFold notes sidebar can be dragged into a note the same way.

## Fold this note

Run **Fold this note** (or the layers button in the sidebar) in a note. The first time, the plugin asks before it sends anything. Then:

1. It sends the note's text to TextFold as a Markdown document, with Obsidian's own syntax flattened: `[[Note|label]]` becomes `label`, `[[Note]]` becomes `Note`, `%% comments %%` are left out, a callout becomes a plain quote, and block ids and `==highlight==` marks go. Code is sent as written. The note's properties stay in Obsidian; only a `title` property goes along.
   - **Pictures go along.** A picture of the vault the note embeds (`![[plot.png]]`, `![[plot.png|300]]`, `![[photo.jpg|caption]]`, or `![alt](figures/plot.png)`) is sent inside the text as the picture itself, and TextFold keeps it with the document: PNG, JPEG, GIF and WebP up to 15 MB each. A picture on the web (`![alt](https://…)`) is sent as it is, and TextFold downloads it. SVG pictures, larger files and embeds that lead nowhere are left out, and so are embedded notes and PDFs. The notice after folding says how many pictures went along and which were left out, and why. Changing a picture's file counts as a change of the note.
2. It records the new document's id in the note's `textfold:` property.
3. TextFold folds it in the language set under **Settings → TextFold Bridge → Fold this note → Language** (`en` by default). **Folding uses the model you set up in TextFold**, at its cost. Without a model, TextFold stores the note and it reads as written; the sidebar says so.

The sidebar shows the fold's progress, then **Folded** with **Open in TextFold**. The plugin keeps a hash of the text it sent, so after an edit the sidebar shows **Changed since folding** and **Refold**. A refold puts the new text in place of the old under the same id: your highlights and questions on the note stay, TextFold finds their passages again in the new text, and asks its model only for the sections that changed. A note whose passage is gone after the edit stays, marked **Passage not found after the edit**. If TextFold is still folding the note, Refold says so and does nothing; if TextFold no longer has the document, the plugin takes the id out of the note's property, and the next **Fold this note** makes a new document.

Refold needs a TextFold with refold in place (newer than 0.10.15).

## Import notes

**Import notes from TextFold** picks a document, or all documents that have notes; the sidebar's download buttons import the documents shown there. Each document becomes one note, named by its short title (the part before a colon) or, with **Note names → Citekey**, by its citekey when TextFold has one. **Location for imported notes**, as Obsidian words it for attachments, says where a new one goes:

- **In the folder specified below** (default): the folder set under **Folder**, `TextFold` to begin with.
- **Same folder as current note**: next to the note that is open when the import starts (for the sidebar's buttons, the note the sidebar shows). With no note open, the folder setting is used, and the notice says so.
- **Vault folder**: the top of the vault.

A document never gets a second note: before creating one, the plugin looks through the whole vault for the note it imported before (by its `textfold` property and the marker comments below), and updates that one where it is now, also after you moved it. The notice says what happened, such as "Updated Convex Partition Zoner in Research/Zoning" or "Created …".

- Properties: `textfold` (the id), `title`, `authors`, `year`, `citekey` when there is one, and `link` (`textfold://open?paper=…`).
- The notes come between two marker comments, `%% TextFold notes: … %%` and `%% End of TextFold notes %%`, in the style of TextFold's own Markdown export for Obsidian: grouped by section, each highlight a quote with the note's id as its block id (`^n-…`, so other notes can link to it), then your comment; each Ask conversation a `[!question]` callout, its citations links to the paragraphs they name. Each note's last line (your comment, else its passage or conversation) ends with a `↗` link back to it in TextFold, drawn as TextFold's icon; the document's own link at the top stays a plain link. A re-import rewrites these lines with the rest of the block.
- Importing again finds the note by its `textfold` property and the markers, wherever it is in the vault, replaces only what is between the markers and the properties above, and keeps everything else you wrote in the note and its other properties. An unchanged document leaves the note untouched.

Section names, paragraph previews and the cite labels in imported answers come from TextFold's `GET /api/doc` (newer than 0.10.15); with an older TextFold the plugin works without them.

## Links

```
textfold://open?paper=<document id>[&s=<section id>][&u=<paragraph id>][&n=<note id>[&t=<turn>]][&level=<full|brief|key|takeaway|topic>][&lang=<code>]
```

- `paper`: the document's id in TextFold, as in its reader's address (`/p/<id>`).
- `s`: a section; `u`: a paragraph; `n`: one of your notes; `t`: with `n`, one turn of its conversation (0 is the first question), which TextFold scrolls to in the chat or the note's window; `level`: the zoom level; `lang`: the language to read it in.

Before it opens a link, the plugin asks the running TextFold whether it has the document. If it has not (a link to a paper in another TextFold library, or one deleted since), a notice names the paper and nothing opens, instead of TextFold's home screen. If TextFold is not running, a link in **TextFold app** mode opens anyway, which starts the app.

**Settings → TextFold Bridge → Links → Open links in** chooses where a link opens:

- **Browser** (default): TextFold's reader page on the running TextFold, in your default browser.
- **TextFold app**: Obsidian hands the `textfold://` link to the system, for TextFold's desktop app to open. Only a packaged TextFold app that handles these links registers itself for them (TextFold 0.10.16 builds with it do), so keep **Browser** unless you have one. Obsidian asks once before it opens links of a new kind; tick **Always open** there to stop the question.

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
- It reads TextFold's documents, notes and jobs with GET requests, one at a time, each given up after a few seconds. A drop or paste from TextFold reads only what was dropped (and asks TextFold for a bare link's title and text).
- It writes to TextFold only when you fold a note: `POST /api/import` with the note's flattened text, and `POST /api/generate` to fold it. TextFold then sends the text to the model you set up in TextFold. Nothing else in TextFold is changed.
- It reads TextFold's `server.json`, a file outside your vault (see the table above). This is why the plugin is desktop only.
- It sends no telemetry and contacts no other server.
- Text from TextFold is shown through Obsidian's Markdown renderer or as plain text, never inserted as HTML.

## License

MIT. TextFold is a separate project under the Apache License 2.0.
