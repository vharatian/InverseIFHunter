# Reviewer App

Separate app for **human reviewers**: queue of tasks, task view, overall + per-section feedback, edit toggle (write-back human_reviews), and reviewer-side **agent** (LLM review: summary, suggestions, checks).

- **Allowlist:** Only identities in `config/global.yaml` → `reviewer.allowed_emails` can access API (use header `X-Reviewer-Email` or `X-Reviewer-Id`).
- **Redis:** Same Redis as trainer app (`mh:sess:*` keys). No new DB.
- **Modular:** Single responsibility per module; ~400 lines max. See `IMPLEMENTING/REVIEWER_SOURCE_OF_TRUTH.md`.

## Run locally

From **agentic-reviewer** root (recommended):

```bash
# Redis must be running (same as trainer app)
redis-server

# Install deps if needed (or use agentic-reviewer venv)
pip install -r reviewer-app/requirements.txt

# Run reviewer app (port 8001)
cd reviewer-app && uvicorn main:app --reload --port 8001
```

Then:

- **Health:** `GET http://localhost:8001/health` → `{"status":"ok"}`
- **Ready:** `GET http://localhost:8001/ready` → Redis status
- **Queue:** `GET http://localhost:8001/api/queue` with header `X-Reviewer-Email: you@example.com` (must be in allowlist)
- **Task:** `GET http://localhost:8001/api/tasks/{session_id}` with same header
- **UI:** Open `http://localhost:8001/` in browser; enter allowlisted email; use queue, task view, feedback, edit, and "Run agent"

## Allowlist

Edit `config/global.yaml` (in agentic-reviewer root):

```yaml
reviewer:
  allowed_emails:
    - reviewer@example.com
```

Then set header `X-Reviewer-Email: reviewer@example.com` on requests. If allowlist is empty, no one is allowed.

## Reviewer agent

Config in `config/global.yaml` under `reviewer.agent`:

```yaml
reviewer:
  agent:
    model: "anthropic/claude-sonnet-4"
    max_tokens: 2048
    timeout: 120
```

The agent uses the same OpenRouter/API keys as the trainer app (env). Run from the task view via "Run agent"; result is stored in Redis and shown in the agent panel.

## Audit log

Reviewer actions (feedback saved, task edited, agent run) are logged to Redis (`mh:rev_audit`). **GET** `/api/audit?limit=50` (with reviewer header) returns recent entries. See [RUNBOOK.md](./RUNBOOK.md) for deployment and identity details.

## Production (ports 80/443)

Serve trainer app on one hostname (e.g. port 80/443) and reviewer app on the other. Same VM, same Redis. See `IMPLEMENTING/REVIEWER_SOURCE_OF_TRUTH.md` §2.
