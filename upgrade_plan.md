# Model Hunter — Unified App Upgrade Plan (v2)

## Design Principle: Visual Feedback Everywhere

This applies to ALL phases, not just one. Every user action must have clear visual feedback — the user should never wonder "did that work?" or "what went wrong?"

**Every API call / async operation must have:**

- **Loading state** — spinner, skeleton, or progress indicator while waiting
- **Success feedback** — toast notification with clear message (e.g., "Task submitted for review"), auto-dismiss after 3-4s
- **Error feedback** — modal or persistent toast with: what failed, why (human-readable), and what to do next (retry button, fix suggestion)
- **Empty states** — when a list is empty, show a helpful message + action (not a blank screen)

**Specific patterns to implement:**

- **Toast notification system** — reusable, stackable, color-coded (green=success, red=error, yellow=warning, blue=info)
- **Error modals** — for critical failures (auth expired, server down, data loss risk) that need user attention before proceeding
- **Inline validation** — form fields show errors immediately, not after submit
- **Connection status indicator** — persistent badge showing Redis/API health (especially during hunts and SSE streams)
- **Retry affordance** — failed operations show a "Retry" button, not just an error message
- **Progress tracking** — multi-step operations (hunt, QC, review) show which step we're on and what's next

**Per phase, this means:**

- Phase 0: Login errors (wrong email, wrong password, role not found) get specific modals explaining what happened
- Phase 1: Agent review progress streams with step-by-step visual updates; chat errors show inline retry
- Phase 2: Config save shows validation errors inline; system health checks animate during probe
- Phase 3: Queue loading shows skeletons; empty tabs show helpful prompts
- Phase 4: Auth failures redirect to login with "session expired" toast
- Phase 5: Consolidate all existing error handling into the unified toast/modal system

---

## Decisions Made

After reviewing disadvantages of the original plan:

- **Sub-app mount** (not route import) — avoids import conflicts between the 3 apps' `services/` packages
- **Email + password auth** (not email-only) — prevents impersonation, builds a proper foundation
- **Fix critical bugs in parallel** with Phase 0, not deferred to Phase 5
- **Reuse `dashboard/auth.py`** — it already has `itsdangerous` signed cookies, session tokens, and admin registry. We extend it rather than building from scratch.

---

## Current State

- **3 separate FastAPI apps** with conflicting module namespaces:
  - Trainer: `main.py` → `services.redis_session` (its Redis client)
  - Reviewer: `reviewer-app/main.py` → `services.redis_client` (different Redis client)
  - Dashboard: `dashboard/main.py` → `log_reader.py` (file-based, no Redis)
- **Role hierarchy already defined** in `config/team.yaml`: super_admin > admin > reviewer > trainer
- **Auth partially built**: `dashboard/auth.py` has signed cookies, token verification, admin registry — but never wired to routes
- **Known bugs**: ISSUES-FUTURE.md lists duplicate SSE streams, no stream cancellation, partial results on network drop

---

## Target Architecture

```
 ┌──────────────────────────────────────────────────┐
 │              Main FastAPI App (port 8000)         │
 │                                                   │
 │  Auth Middleware (email+password, signed cookie)   │
 │  Role: team.yaml resolution                       │
 ├──────────────────────────────────────────────────┤
 │                                                   │
 │  /login          → Login page (all roles)         │
 │  /api/*          → Trainer routes (existing)      │
 │  /               → Trainer SPA                    │
 │                                                   │
 │  /reviewer/*     → Reviewer sub-app (mounted)     │
 │    Own services/, static/, routes                  │
 │    Gated: role = reviewer | super_admin            │
 │                                                   │
 │  /admin/*        → Dashboard sub-app (mounted)    │
 │    Own log_reader, static/, routes                 │
 │    Gated: role = admin | super_admin               │
 │                                                   │
 ├──────────────────────────────────────────────────┤
 │  Shared: Redis, SQLite (.storage/), team.yaml     │
 └──────────────────────────────────────────────────┘
```

**Why sub-app mount instead of route import:**

- `app.mount("/reviewer", reviewer_app)` preserves each app's module space — `reviewer-app/services/` doesn't clash with `services/`
- Each sub-app keeps its own lifespan (startup/shutdown)
- If the reviewer sub-app has a bug, the main app's routes still work
- Minimal changes to existing code — we wrap, not rewrite

---

## Phase 0: Unified App + Auth (PREREQUISITE)

Everything else depends on this. Merge the 3 apps into 1 with proper access control.

### 0A. Auth System

**Reuse and extend `dashboard/auth.py`** — it already has:

- `itsdangerous` signed cookies with 30-day expiry
- `create_session_token()` / `verify_session_token()`
- `set_auth_cookie()` / `clear_auth_cookie()`
- Admin registry in `.storage/dashboard_admins.json`

**What we add:**

- `resolve_role(email)` — reads `config/team.yaml`, returns `{role, pod, name}`
- `verify_password(email, password)` — per-user passwords stored in a separate `.storage/credentials.json` (hashed with bcrypt)
- Login page: email + password form, POST to `/api/auth/login`
- Login endpoint: validates credentials → sets signed cookie with `{email, role, pod}`
- Middleware: every request extracts cookie → attaches `request.state.user` → rejects if role insufficient for path

**Password management:**

- Super-admin sets passwords for users via admin UI (Phase 2) or direct JSON edit for now
- Default password for initial setup (printed to console on first run)
- Passwords stored hashed (bcrypt) in `.storage/credentials.json`, NOT in team.yaml

### 0B. Sub-App Mount

**In `main.py`, add:**

```python
from reviewer_app_loader import create_reviewer_app
from dashboard_loader import create_dashboard_app

reviewer_sub = create_reviewer_app()
dashboard_sub = create_dashboard_app()

app.mount("/reviewer", reviewer_sub)
app.mount("/admin", dashboard_sub)
```

**Loader modules** (thin wrappers):

- `reviewer_app_loader.py` — adds `reviewer-app/` to sys.path, imports and returns the reviewer FastAPI app, injects role-gate middleware
- `dashboard_loader.py` — adds `dashboard/` to sys.path, imports and returns the dashboard FastAPI app, injects role-gate middleware

**Role-gate middleware per sub-app:**

- Before any request to `/reviewer/*`, check `request.state.user.role in ("reviewer", "super_admin")`
- Before any request to `/admin/*`, check `request.state.user.role in ("admin", "super_admin")`
- Return 403 if unauthorized

**What stays unchanged:**

- All existing trainer routes at `/api/*`
- Reviewer app's internal routing (its routes still think they're at `/api/*`, the mount handles the prefix)
- Dashboard's internal routing

### 0C. Unified Navigation

- `/login` — shared login page; after login, redirect based on role:
  - `super_admin` → `/` (with mode switcher visible)
  - `admin` → `/admin/`
  - `reviewer` → `/reviewer/`
  - `trainer` → `/`
- Super-admin mode switcher: floating pill in top-right corner, available on all 3 UIs
- Each UI header gets a role badge (e.g., "Trainer | alice@turing.com")
- Logout link clears cookie, redirects to `/login`
- Unauthenticated requests to any page → redirect to `/login`

### 0D. Critical Bug Fixes (in parallel)

Fix these from `ISSUES-FUTURE.md` while building 0A-0C:

- **Duplicate SSE streams on re-trigger** — add stream cancellation / dedup
- **No client-side timeout on network drop** — add reconnect + partial result handling
- **Duplicated SSE consumer pattern** — consolidate into single reusable helper

---

## Phase 1: Reviewer App Full Rework

Now at `/reviewer/*`. Most incomplete part of the app.

### 1A. Deep Multi-Pass Auto-Review Agent

**Current**: `reviewer-app/services/review_agent.py` — one rule engine pass + one LLM call.

**Target**: Multi-dimensional structured review:

- Prompt quality (clarity, specificity, red-team effectiveness)
- Criteria quality (measurability, overlap, completeness)
- Grading accuracy (human grades vs. criteria alignment)
- Safety and factuality
- Overall coherence score

**Approach**:

- Extend `review_agent.py` — orchestrate multi-pass reviews (one focused LLM call per dimension)
- Reuse `agentic_reviewer/council.py` voting for subjective dimensions
- Add SSE streaming (reuse pattern from trainer QC in `routes/agentic.py`)

### 1B. Agent Pre-fills Feedback Form

Agent findings auto-populate the feedback form — reviewer edits/confirms instead of typing from scratch.

- `reviewer-app/static/js/feedback.js` — pre-fill from agent results
- `reviewer-app/api/routes/agent_routes.py` — return structured suggestions

### 1C. Chat/Discuss with Agent

Reviewer asks follow-up questions about findings, requests deeper analysis.

- New endpoint: `POST /reviewer/api/tasks/{id}/agent-chat`
- Redis-backed conversation state (per task, per reviewer)
- Chat UI panel (collapsible, right side)

### 1D. Reviewer UI/UX Overhaul

- Split-pane layout: task content left, agent + feedback right
- Structured feedback sections matching multi-pass dimensions
- Collapsible chat panel
- Queue: filters, search, priority badges
- Review history timeline (previous rounds)

---

## Phase 2: Admin Dashboard Extension

At `/admin/*`. Keep existing analytics, add admin controls.

### 2A. Config Management UI

- Structured forms for `config/global.yaml` sections
- Team management for `config/team.yaml` — add/remove pods, reassign people
- YAML write-back with validation
- Super-admin only for destructive operations

### 2B. Trainer & Reviewer Management

- View registered trainers (`.storage/trainers.json`) with session counts
- Reviewer workload (queue depth, avg turnaround)
- Add/remove from pods
- Password management (set/reset user passwords)

### 2C. System Controls

- API key health checks (test connectivity, don't expose keys)
- Maintenance mode toggle (auth-gated)
- Redis/SQLite status
- Active sessions monitor

---

## Phase 3: Home Page Enhancement

Trainer home at `/`.

- **Visual polish**: Modern cards, better spacing, animations, responsive
- **Stats & insights**: Tasks completed, avg review turnaround, pass/fail trends
- **Navigation**: Search, filter by date/status/reviewer, sort, progress indicators

---

## Phase 4: Safety Hardening

Auth from Phase 0 fixes the biggest gaps. Remaining:

- Session ownership (trainers access only their own sessions)
- Replace `X-Admin-Mode` header with role-based check from cookie session
- CORS configuration
- Rate limiting on auth and sensitive endpoints
- Rotate all default passwords from BACKEND-AUTOPSY.md

---

## Phase 5: Polish & Code Quality

- Remove dead code (old standalone launchers, unused modules)
- Consistent error handling, custom error pages
- Fix remaining ISSUES-FUTURE.md items
- Performance audit (Redis pooling, query optimization)
- Consolidate the two Redis clients (trainer's `redis_session` vs reviewer's `redis_client`) into one shared module — now possible since they're in the same process

---

## Execution Order

1. **Phase 0** (0A → 0B → 0C, with 0D in parallel) — Foundation. ~2-3 sessions.
2. **Phase 1** (1A → 1B → 1C → 1D) — Reviewer rework. ~4-5 sessions.
3. **Phase 2** (2A → 2B → 2C) — Admin controls. ~2-3 sessions.
4. **Phase 3** — Home page. ~1-2 sessions.
5. **Phase 4** — Safety. ~1 session.
6. **Phase 5** — Polish. Ongoing.

Checkpoint after each sub-phase. Reassess priorities as we learn more.
