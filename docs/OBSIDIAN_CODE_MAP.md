# Obsidian code map (local)

This repo can generate a **folder-linked** Obsidian vault under **`local/obsidian-code-map/`** (inside the repo, **not** hidden — so Finder and Obsidian’s “Open folder” dialog can see it).  
That directory is **gitignored** — it stays on your machine only.

### If you need to open a hidden folder (e.g. `.something`)

macOS hides names starting with `.`:

- **Finder:** press **`⌘ Command` + `⇧ Shift` + `.` (period)** to toggle hidden items.
- **Open dialog:** the same shortcut often works while the dialog is focused.
- **Go to folder:** **`⌘ Shift G`** and paste the full path (e.g. `/Users/you/.../.local/obsidian-code-map`).

## 1. Generate the vault

From the `InverseIFHunter` folder (with Python 3):

```bash
python3 scripts/generate_obsidian_code_map.py
```

Re-run after large moves/refactors to refresh the index. Notes include a managed block at the top; you can add your own notes in separate files or below the managed sections in copies if you prefer.

## 2. Open it in Obsidian

1. Launch **Obsidian**.
2. **Open folder as vault** (or *Create new vault* → pick an empty folder — **don’t** use that; you want *open existing*).
3. Choose this path (adjust if your clone lives elsewhere):

   `.../InverseIFHunter/local/obsidian-code-map`

4. Trust the vault if macOS / Obsidian asks.

You should see:

- **`Code - HOME`** — start here; links to top-level areas.
- **`Code map — flows`** — short suggested reading order (editable).
- **Many `Code - …` notes** — one per mapped folder, with wikilinks to children and file lists.

## 3. Use the graph

- Click **Graph view** in the left ribbon (or **Open graph** from command palette).
- Zoom/pan; click nodes to open notes.
- **Backlinks** (right sidebar) show what points *to* the current note.

This graph reflects **folder structure + our wikilinks**, not Python/JS import analysis.

## 4. Optional plugins (later)

Community plugins are optional. Useful ones for audits:

- **Dataview** — query notes by tag (if you add `tags:` in frontmatter to your own notes).
- **Excalidraw** — sketches for flows.

Enable: *Settings → Community plugins → Restricted mode off → Browse*.

## 5. Troubleshooting

| Issue | What to do |
|--------|------------|
| Vault looks empty | Confirm you opened **`local/obsidian-code-map`**, not the repo root. |
| No graph edges | Open `Code - HOME` and click a few `[[links]]`; graph fills as notes link. |
| Folder missing | Run the generator script once. |

## 6. What gets mapped

Configured in `scripts/generate_obsidian_code_map.py` (`TOP_LEVEL`):

`main.py`, `routes`, `services`, `static`, `models`, `helpers`, `storage`, `config`, `tests`, `reviewer-app`, `dashboard`.

Edit that list if you want more or fewer trees, then re-run the script.
