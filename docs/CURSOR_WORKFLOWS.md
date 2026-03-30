# Cursor + AI workflows (Superpowers, GSD-style, Agency) — setup guide

This doc is **committed** so you can find it on any machine. The **heavy/generated stuff** stays **local** and is **gitignored** (see `.gitignore`: `.planning/`, `local/ai-workflows/`, `.claude/`).

---

## What never hits GitHub anyway

| Location | What it is |
|----------|------------|
| **`~/.cursor/`** (your home folder) | Cursor user config, many plugins, global commands — **outside the repo**. |
| **Cursor → Settings → Rules for AI** | User-level rules — **not in repo** unless you paste them into a file. |

So “don’t push to GitHub” is mostly: **don’t commit** `.planning/`, **don’t commit** workflow clones under `local/ai-workflows/`, and keep using **ignored** paths (already set).

---

## 1. Superpowers (best first step in Cursor)

**Cost:** Free (MIT). Optional sponsor. Uses **your Cursor / model billing**, not OpenRouter.

**Install (from your `superpowers.md`):**

1. Open **Cursor**.
2. In **Agent** chat, use the **plugin / marketplace** flow:
   - Try: `/add-plugin superpowers`  
   - Or open the **plugin marketplace** and search **Superpowers** (Obra / official marketplace as in their README).

3. **Restart** or start a **new chat**, then say something that should trigger a skill, e.g.  
   *“Help me plan this feature before we write code.”*

**Leverage it fully**

- Let it run **brainstorming → design → plan → TDD/subagents** instead of jumping straight to code.
- Say explicitly: *“Use Superpowers workflow: spec first, then tests, then implementation.”*
- When stuck: *“Use systematic-debugging / verification-before-completion.”*

**Extend**

- Add **project rules** in `.cursor/rules/` (committed) for InverseIFHunter-only facts: stack (FastAPI, vanilla JS modules), Redis, SSE, OpenRouter — so Superpowers + agent align with your app.
- Keep **secrets/personal prefs** out of committed rules; use **Cursor user rules** or gitignored notes in `local/ai-workflows/notes.md` and `@` that file when needed.

---

## 2. Get Shit Done (GSD)

**Important:** The **`get_shit_done.md`** you have describes **`get-shit-done-cc`**, which is built around **Claude Code, OpenCode, Codex, Copilot, Antigravity**, etc. It does **not** list Cursor as a first-class runtime in that upstream doc.

**Your options in Cursor (pick one):**

### A) Use Cursor only — community “GSD for Cursor” ports

There are **third-party** projects (e.g. `gsd-for-cursor`, `get-shit-done-cursor` on npm/GitHub) that try to map GSD-style commands to Cursor. **Treat them as community software:** read the repo, install only if you trust it, prefer **`~/.cursor/`** installs so nothing lands in the git repo.

**After install:** use their slash commands (often `/gsd:...` or `/gsd/...` depending on port) in **Agent** chat.

### B) Use GSD “for real” with Claude Code

If you want the **exact** workflow in `get_shit_done.md` (installer, agents, hooks):

1. Install **Claude Code** (Anthropic).
2. Run: `npx get-shit-done-cc@latest` and choose **Claude Code** + **local** if you want project-scoped files.

**Local + not on GitHub:** use **local** install; repo already ignores **`.claude/`**. Also ignore **`.planning/`** (already in `.gitignore`) for GSD roadmap/state.

### C) “GSD philosophy” inside Cursor (no extra installer)

You can mirror the idea manually:

1. Keep **`PROJECT.md` / `REQUIREMENTS.md` / `ROADMAP.md`** under **`.planning/`** (gitignored) — write them yourself or with the agent.
2. In each phase, prompt: *“Research → atomic plan → implement → verify with tests; one concern per message.”*

**Leverage / extend**

- **`/gsd:map-codebase`** (if your port supports it) before big features — same idea: *“Map `routes/`, `services/`, `static/modules/` and summarize dependencies.”*
- Extend with **your** templates in `local/ai-workflows/templates/` (gitignored): phase checklist, verification checklist for hunts/judge flow.

---

## 3. Agency agents

**What you have:** `agency_agents.md` is **documentation / roster**. The **real** repo (**agency-agents**) has `scripts/install.sh --tool cursor` and many `*.md` agent files.

**Recommended setup (local, not pushed):**

```bash
cd /Users/mandy/Downloads/mth/InverseIFHunter
mkdir -p local/ai-workflows
cd local/ai-workflows
git clone https://github.com/msitarzewski/agency-agents.git
cd agency-agents
./scripts/install.sh --tool cursor   # follow any prompts; read script first if you prefer
```

- **`local/ai-workflows/`** is **gitignored** — the clone **never** goes to GitHub.
- If you **don’t** want to clone, copy **single** agent files you need from GitHub into `local/ai-workflows/agents/` and `@`-reference them in chat.

**Leverage fully**

- Don’t load all 80+ agents. Pick **5–8** that match InverseIFHunter: e.g. Backend Architect, Frontend Developer, Security Engineer, Code Reviewer, Software Architect, Technical Writer.
- In Agent: *“Adopt the voice and checklist from @local/ai-workflows/agency-agents/engineering/engineering-backend-architect.md for this task.”*

**Extend**

- Fork mentally: save **`local/ai-workflows/my-inverseifhunter-agent.md`** (gitignored) that merges “Backend Architect” + your stack (FastAPI, Redis, SSE, OpenRouter judge).

---

## Suggested stack (all three without chaos)

| Role | Tool |
|------|------|
| **Default spine** | **Superpowers** in Cursor (spec, TDD, subagents). |
| **Big milestones / phases** | GSD-style **`.planning/`** docs + phased prompts, or Claude Code + real GSD if you use it. |
| **Specialist passes** | **Agency** personas via `@` files from `local/ai-workflows/`. |

Avoid running **two** full rigid systems on the same task (e.g. Superpowers strict TDD + GSD execute-phase) without deciding which wins — usually **Superpowers** for implementation, **GSD** for roadmap, **Agency** for one-off reviews.

---

## Quick checklist

- [ ] Install **Superpowers** in Cursor (marketplace / `/add-plugin`).
- [ ] `mkdir -p local/ai-workflows` and clone **agency-agents** there (or copy selected agents).
- [ ] (Optional) Install a **Cursor GSD port** under **`~/.cursor`** or use **Claude Code + npx get-shit-done-cc** for full GSD.
- [ ] Confirm **`.gitignore`** contains `.planning/`, `local/ai-workflows/`, `.claude/` — **do not** `git add` those paths.
- [ ] Add or refine **`.cursor/rules`** for stack-specific guidance (optional commit).

---

## OpenRouter vs Cursor

- **OpenRouter** = API for **your app** (InverseIFHunter server) — unrelated to these plugins.
- **Cursor Agent** = billed by **Cursor** (or your Cursor plan), unless you configure something else.

No extra paid **API** is required for Superpowers / Agency / GSD tooling itself.
