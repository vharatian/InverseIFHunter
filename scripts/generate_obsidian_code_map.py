#!/usr/bin/env python3
"""
Generate a local Obsidian vault that mirrors selected repo folders as linked notes.

Output: ../local/obsidian-code-map/  (gitignored; no leading-dot folder so Finder/Obsidian can see it)

Usage (from repo root):
  python3 scripts/generate_obsidian_code_map.py

Re-run after big refactors to refresh the folder/file index. Your extra notes in the
vault persist if you only add new files; re-running overwrites generated *.md files
that still contain the GENERATOR_SENTINEL marker (see below).
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
OUT = REPO_ROOT / "local" / "obsidian-code-map"

# Only these top-level paths are mapped (plus their subtrees).
TOP_LEVEL = [
    "main.py",
    "routes",
    "services",
    "static",
    "models",
    "helpers",
    "storage",
    "config",
    "tests",
    "reviewer-app",
    "dashboard",
]

SKIP_DIR_NAMES = {
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    "node_modules",
    ".git",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
}

SOURCE_SUFFIXES = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".html", ".yaml", ".yml", ".json"}

# Do not recurse deeper than this from repo root (tests can be huge).
MAX_DEPTH = 6

GENERATOR_SENTINEL = "<!-- code-map-generator: managed -->"
GENERATOR_END = "<!-- /code-map-generator -->"

# Manual “architecture” links (edit in script if you want defaults updated).
FLOW_NOTE_BODY = """# Code map — request & hunt flow (starter)

This note is **not** auto-synced to imports; it is a **study guide**. Edit freely.

Suggested reading order:

1. [[Code - main.py]] — FastAPI app creation
2. [[Code - routes]] — HTTP surface
3. [[Code - services]] — hunt engine, workers, LLM clients
4. [[Code - static]] — UI shell
5. [[Code - static-modules]] — `app.js` wiring, hunt, testbed, results

Rough data flow:

- Browser calls `/api/...` → `routes/*`
- Hunt stream → `services/hunt_engine.py`, `services/hunt_worker.py`, Redis session code
- Judging → `services/openai_client.py`, `services/openrouter_client.py`
- Labels → `services/aggregation.py`

**Related folders:** [[Code - models]] · [[Code - storage]] · [[Code - config]]

---
"""


def _note_title_for_rel(rel: Path) -> str:
    """Stable Obsidian note title (no extension)."""
    rel = rel.as_posix().strip("/")
    if not rel or rel == ".":
        return "Code - HOME"
    return "Code - " + rel.replace("/", "-")


def _is_skipped_dir(name: str) -> bool:
    return name in SKIP_DIR_NAMES or name.startswith(".")


def _list_immediate_dirs(path: Path) -> list[Path]:
    if not path.is_dir():
        return []
    out = []
    for child in sorted(path.iterdir()):
        if child.is_dir() and not _is_skipped_dir(child.name):
            out.append(child)
    return out


def _list_source_files(path: Path) -> list[Path]:
    files = []
    if not path.is_dir():
        return files
    for child in sorted(path.iterdir()):
        if child.is_file() and child.suffix.lower() in SOURCE_SUFFIXES:
            files.append(child)
    return files


def _rel(p: Path) -> str:
    return p.resolve().relative_to(REPO_ROOT.resolve()).as_posix()


def _depth_from_parts(parts: tuple[str, ...]) -> int:
    return len(parts)


def _collect_dir_tree() -> list[Path]:
    """Return repo-relative directory paths to emit notes for."""
    roots: list[Path] = []
    for name in TOP_LEVEL:
        p = REPO_ROOT / name
        if p.exists():
            roots.append(p)

    dirs: set[Path] = set()

    def walk(p: Path, parts: tuple[str, ...]) -> None:
        if _depth_from_parts(parts) > MAX_DEPTH:
            return
        rel = Path(*parts) if parts else Path(".")
        dirs.add(rel)

        for d in _list_immediate_dirs(p):
            walk(d, parts + (d.name,))

    # HOME (repo root summary only — we do not walk entire repo)
    dirs.add(Path("."))

    for root in roots:
        if root.is_file():
            continue
        rel_parts = tuple(Path(root.relative_to(REPO_ROOT)).parts)
        walk(root, rel_parts)

    return sorted(dirs, key=lambda x: (len(x.parts), x.as_posix()))


def _minimal_obsidian_config(out: Path) -> None:
    """Friendly defaults so the vault opens cleanly."""
    meta = out / ".obsidian"
    meta.mkdir(parents=True, exist_ok=True)
    app_json = meta / "app.json"
    if not app_json.exists():
        app_json.write_text(
            json.dumps(
                {
                    "legacyEditor": False,
                    "showLineNumber": True,
                    "strictLineBreaks": False,
                    "readableLineLength": False,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    # Optional: show graph without forcing community plugins
    core = meta / "core-plugins.json"
    if not core.exists():
        core.write_text(
            json.dumps(
                {
                    "file-explorer": True,
                    "global-search": True,
                    "graph": True,
                    "backlink": True,
                    "page-preview": True,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )


def _write_managed_note(path: Path, title: str, body_md: str) -> None:
    content = f"""{GENERATOR_SENTINEL}
> Regenerated by `scripts/generate_obsidian_code_map.py`. Safe to replace on re-run.

{body_md}

{GENERATOR_END}
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _build_home_note(top_links: list[str]) -> str:
    iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    links = "\n".join(f"- [[{t}]]" for t in top_links)
    return f"""# Code map — HOME

**Repo:** `{REPO_ROOT.name}/`  
**Generated:** {iso}

## Start

1. Open **Graph view** (left ribbon) to see links between notes.
2. Read [[Code map — flows]] for a suggested mental model.
3. Drill into an area below; each note lists **files** and **subfolders**.

## Top-level map

{links}

## Tips

- Add your own notes in this folder; keep personal audit notes **outside** managed blocks if you fork a note.
- Re-run the generator after large moves: `python3 scripts/generate_obsidian_code_map.py`

---
"""


def _build_dir_note(rel: Path, subdirs: list[Path], files: list[Path]) -> str:
    title = _note_title_for_rel(rel)
    rel_str = rel.as_posix() if str(rel) != "." else "."

    parent_parts = rel.parent.parts if rel.parts else ()
    if parent_parts:
        parent_title = _note_title_for_rel(rel.parent)
        parent_line = f"**Up:** [[{parent_title}]]\n"
    else:
        parent_line = "**Up:** [[Code - HOME]]\n"

    sub_lines = ""
    if subdirs:
        lines = []
        for d in subdirs:
            child_rel = d.relative_to(REPO_ROOT)
            lines.append(
                f"- [[{_note_title_for_rel(child_rel)}]] — `{_rel(d)}/`"
            )
        sub_lines = "\n## Subfolders\n\n" + "\n".join(lines) + "\n"

    file_lines = ""
    if files:
        file_lines = "\n## Files\n\n" + "\n".join(f"- `{_rel(f)}`" for f in files) + "\n"

    return f"""# {title}

**Path:** `{rel_str}`

{parent_line}
## Obsidian graph

This note links to **subfolder notes** (if any). Open **Graph** to see the tree.

{sub_lines}{file_lines}
## Your audit notes

(Add findings below; the generator only replaces the managed block at the top on re-run if you keep custom text *below* this section in a copy — simplest is to add a separate linked note.)

---
"""


def _build_main_file_note() -> str:
    p = REPO_ROOT / "main.py"
    exists = p.exists()
    return f"""# Code - main.py

**Path:** `main.py`  
**Up:** [[Code - HOME]]

## Status

{"`main.py` exists — FastAPI entry." if exists else "_File not found._"}

## Related

- [[Code - routes]]
- [[Code - services]]

---
"""


def generate() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    _minimal_obsidian_config(OUT)

    # Flow note (fully managed each run)
    flow_path = OUT / "Code map — flows.md"
    _write_managed_note(flow_path, "flows", FLOW_NOTE_BODY)

    # main.py note
    main_note = OUT / "Code - main.py.md"
    _write_managed_note(main_note, "main.py", _build_main_file_note())

    top_titles: list[str] = ["Code map — flows", "Code - main.py"]
    for name in TOP_LEVEL:
        p = REPO_ROOT / name
        if not p.exists():
            continue
        if name == "main.py":
            continue
        rel = Path(name)
        top_titles.append(_note_title_for_rel(rel))

    home_path = OUT / "Code - HOME.md"
    _write_managed_note(home_path, "HOME", _build_home_note(top_titles))

    dir_rels = _collect_dir_tree()
    for rel in dir_rels:
        # HOME is a dedicated note; do not replace with a raw root listing.
        if rel == Path("."):
            continue
        abs_dir = REPO_ROOT / rel
        if not abs_dir.is_dir():
            continue
        subdirs = _list_immediate_dirs(abs_dir)
        files = _list_source_files(abs_dir)
        # Skip empty dirs with no files and no subdirs (except we always want structure)
        if not subdirs and not files and rel != Path("."):
            # Still emit if parent chain matters — keep for navigation
            pass

        title = _note_title_for_rel(rel)
        note_path = OUT / f"{title}.md"
        body = _build_dir_note(rel, subdirs, files)
        _write_managed_note(note_path, title, body)

    print(f"Obsidian code map written to:\n  {OUT}\n")
    print("Next: In Obsidian → Open folder as vault → choose that path.")
    print("Docs: see docs/OBSIDIAN_CODE_MAP.md")


if __name__ == "__main__":
    if not REPO_ROOT.is_dir():
        print("Could not find repo root.", file=sys.stderr)
        sys.exit(1)
    generate()
