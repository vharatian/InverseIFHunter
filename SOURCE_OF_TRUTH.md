# SOURCE_OF_TRUTH

> Generated: 2026-02-03 | Updated: 2026-02-08  
> This document reflects the current state of the repository as observed in the code.

## 1. Problem Statement

**Model Hunter** is a web application for "red-teaming" LLM models. It enables users to:

1. Load Jupyter/Colab notebooks containing prompts and evaluation criteria
2. Run parallel "hunts" - sending prompts to LLM models to find responses that fail criteria
3. Automatically judge responses using GPT-5 with criteria-based evaluation
4. Facilitate human review of model responses (blind judging workflow)
5. Save results back to Google Colab notebooks

The system targets finding "breaking responses" - model outputs that fail evaluation criteria (score 0).

---

## 2. Hard Constraints (Observed)

### API & Provider Constraints
- **OpenAI GPT-5 for judging**: Judge model is hardcoded to GPT-5 (see `openai_client.py:51`, `main.py:966`)
- **Max 16 hunts per task**: Frontend enforces this limit (observed in `index.html:375`)
- **Max 6 parallel workers**: Slider limited to 1-6 (observed in `index.html:326-332`)
- **Session expiration**: 2 hours TTL (`main.py:341`, `session_store.py:23`)
- **HTTP/1.1 forced**: HTTP/2 disabled to avoid `ConnectionTerminated` errors from OpenRouter GOAWAY frames (`http_config.py`)

### Notebook Format Constraints
- **Cell headings pattern**: `**[heading_name]**` format required (e.g., `**[prompt]**`, `**[response]**`)
- **Required cell types**: `prompt`, `response`, `response_reference`, `judge_system_prompt`
- **Model slots**: `{model}_1` through `{model}_4` pattern (e.g., `nemotron_1`, `qwen_1`)
- **Judge slots**: `llm_judge_1` through `llm_judge_4` and `human_judge_1` through `human_judge_4`
- **Response reference format**: Must be valid JSON array or plain text `C1: description` format

### Supported Models (Observed)
- **OpenRouter**: `nvidia/nemotron-3-nano-30b-a3b`, `qwen/qwen3-235b-a22b-thinking-2507`
- **Fireworks**: `accounts/fireworks/models/qwen3-235b-a22b-thinking-2507`

### Authentication
- **Google Drive access**: Requires service account with editor permissions on notebooks
- **API Keys required**: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY` (optional)

---

## 3. Decisions (Observed / Assumed)

### Architecture Decisions (Observed)

| Decision | Evidence |
|----------|----------|
| **FastAPI backend** | `main.py` uses FastAPI framework |
| **SSE for real-time updates** | Hunt progress streamed via Server-Sent Events (`/api/hunt-stream`) |
| **Redis for session persistence** | `session_store.py` with fallback to in-memory |
| **Service account for Drive access** | `google_drive_client.py` uses service account credentials |
| **Singleton pattern for clients** | All API clients use singleton getters |
| **Connection pooling** | `base_client.py` uses httpx with shared pools |
| **Independent criteria judging** | Each criterion evaluated separately by GPT-5 (`openai_client.py:715-840`) |

### Scoring Logic (Observed)

- **Pass/Fail threshold**: >50% criteria pass = PASS (score 1), ≤50% = FAIL/BREAKING (score 0)
- **Breaking response**: Score 0 indicates the model "broke" on that prompt
- **Target**: Find 4 breaking responses for human review

### Session & Storage (Observed)

- **Session ID format**: UUID truncated to 8 characters
- **File storage**: `.storage/` directory for session JSON files
- **Telemetry storage**: `.telemetry/events.jsonl` for dashboard

### Assumed Decisions

| Assumption | Reasoning |
|------------|-----------|
| **Notebook modification is non-destructive** | Existing cells are updated in place; new cells inserted in defined order |
| **Metadata cell detection is pattern-based** | Multiple patterns checked for "# Metadata" |
| **Rate limiting is advisory** | Semaphore-based limiting with configurable concurrency per provider |

---

## 4. Key Files & Responsibilities

### Backend Core

| File | Responsibility |
|------|----------------|
| `model-hunter/main.py` | FastAPI application, REST API endpoints, session management |
| `model-hunter/models/schemas.py` | Pydantic models for requests, responses, sessions, hunt results |
| `model-hunter/services/hunt_engine.py` | Orchestrates parallel hunts, progress tracking, result aggregation |
| `model-hunter/services/notebook_parser.py` | Parses .ipynb files, extracts structured data, exports modified notebooks |

### API Clients

| File | Responsibility |
|------|----------------|
| `model-hunter/services/base_client.py` | Abstract base class for API clients, connection pooling, retry logic |
| `model-hunter/services/openrouter_client.py` | OpenRouter API integration (Nemotron, Qwen models) |
| `model-hunter/services/fireworks_client.py` | Fireworks AI API integration |
| `model-hunter/services/openai_client.py` | OpenAI GPT-5 judge client, criteria evaluation |
| `model-hunter/services/google_drive_client.py` | Google Drive API for reading/writing notebooks |

### Infrastructure Services

| File | Responsibility |
|------|----------------|
| `model-hunter/services/session_store.py` | Redis-backed session persistence with memory fallback |
| `model-hunter/services/rate_limiter.py` | Semaphore-based rate limiting per provider |
| `model-hunter/services/telemetry_logger.py` | Fire-and-forget JSON logging for dashboard (includes judge_explanation) |
| `model-hunter/services/trainer_identity.py` | Generates fun anime character names as trainer IDs (e.g., Gojo_42, Viktor_60) |
| `model-hunter/services/snapshot_service.py` | WYSIWYG notebook snapshot validation and write queuing |
| `model-hunter/services/http_config.py` | Shared HTTP connection pool configuration (HTTP/2 disabled) |

### Frontend

| File | Responsibility |
|------|----------------|
| `model-hunter/static/index.html` | Main UI structure, forms, modals |
| `model-hunter/static/app.js` | Frontend logic (~325K chars), state management, API calls |
| `model-hunter/static/style.css` | Styling, theming, responsive design |
| `model-hunter/static/multi-turn-workflow.html` | Multi-turn workflow reference page |

### Dashboard (v2 - Enhanced)

| File | Responsibility |
|------|----------------|
| `model-hunter/dashboard/main.py` | Original v1 dashboard backend (deprecated) |
| `model-hunter/dashboard/main_enhanced.py` | V2 dashboard backend with trainer leaderboard, criteria analysis, real-time stats |
| `model-hunter/dashboard/log_reader.py` | Original v1 log reader (deprecated) |
| `model-hunter/dashboard/log_reader_enhanced.py` | V2 log reader with trainer mapping, criteria difficulty, break/hunt detail lists |
| `model-hunter/dashboard/static/index_enhanced.html` | V2 dashboard UI with tabs: Overview, Trainers, Criteria, Models, Costs, Details |
| `model-hunter/dashboard/static/dashboard_enhanced.js` | V2 frontend JS with collapsible content, judge verdict display, criteria badges |
| `model-hunter/dashboard/static/style_enhanced.css` | V2 dashboard styling |

### ML Pipeline

| File | Responsibility |
|------|----------------|
| `model-hunter/ml_pipeline/export_ml_data.py` | Exports telemetry + session data to ML-ready datasets (run on VM) |
| `model-hunter/ml_pipeline/Model_Hunter_ML_Analysis.ipynb` | Google Colab notebook for ML analysis (break prediction, criteria ranking, model comparison) |
| `model-hunter/ml_pipeline/run_export.sh` | Quick export script for VM |

### Testing

| File | Responsibility |
|------|----------------|
| `model-hunter/test_dashboard_server.py` | FastAPI test runner server (port 8001), SSE streaming, pytest integration |
| `model-hunter/static/test-dashboard.html` | Visual test dashboard UI with trend charts, category breakdown, live grid |
| `model-hunter/tests/conftest.py` | Shared pytest fixtures (async client, mock sessions, mock notebooks) |
| `model-hunter/tests/unit/` | Unit tests for hunt engine and model clients |
| `model-hunter/tests/api/` | API tests: sessions, SSE, multi-turn, edge cases, crash recovery, data loss, timing/network, concurrency/races, state machine |
| `model-hunter/tests/e2e/` | End-to-end Playwright tests: notebook loading, multi-turn flow, turn history UI, responsive/theme, trainer scenarios |
| `model-hunter/tests/stress/` | Stress/performance tests: large payloads, concurrent sessions, memory, response time benchmarks |
| `model-hunter/tests/security/` | Security tests: XSS prevention, path traversal, UUID sessions, file upload, HTTP headers, ZAP scan |

### Deployment

| File | Responsibility |
|------|----------------|
| `model-hunter/Dockerfile` | Container image for app |
| `model-hunter/docker-compose.yml` | Multi-container setup (blue/green app, Redis, dashboard, nginx) |
| `model-hunter/deploy-blue-green.sh` | Automated blue-green deployment script for zero-downtime updates |
| `model-hunter/requirements.txt` | Python dependencies |

---

## 5. Current Status

### Done

- [x] Notebook loading (upload and URL fetch)
- [x] Notebook parsing with structured cell extraction
- [x] Parallel hunt execution with configurable workers (1-6)
- [x] Real-time progress via SSE streaming
- [x] GPT-5 judge integration with independent criteria evaluation
- [x] Google Drive integration for reading/saving notebooks
- [x] Redis session persistence with fallback
- [x] Rate limiting for API calls
- [x] Telemetry logging
- [x] Monitoring dashboard
- [x] Human review workflow (blind judging)
- [x] WYSIWYG notebook editing (prompt, response, criteria, judge prompt)
- [x] Response selection UI (pick 4 responses for review)
- [x] Save results back to Colab notebook
- [x] Docker deployment configuration
- [x] Maintenance mode toggle

### Recently Completed (Feb 2026)

- [x] **Nemotron empty response fix**: Disabled reasoning params for Nemotron (not a reasoning model), preventing empty responses
- [x] **HTTP/2 → HTTP/1.1**: Disabled HTTP/2 to eliminate `ConnectionTerminated` errors from OpenRouter GOAWAY frames
- [x] **Enhanced dashboard v2**: Deployed with trainer leaderboard, criteria analysis, models, costs, activity timeline, heatmap
- [x] **Dashboard judge verdict display**: Shows criteria badges (PASS/FAIL/MISSING) and judge explanation per hunt
- [x] **Collapsible content in dashboard**: Long model responses and judge reasoning collapsed by default with toggle
- [x] **Full content in detailed views**: Removed 500-char truncation from telemetry logger; frontend shows full text
- [x] **Efficiency metric fix**: Dashboard shows breaks/session as raw number instead of broken percentage
- [x] **Trainer identity system**: Anime character names (e.g., Gojo_42) assigned to trainers via `trainer_identity.py`
- [x] **Blue-green deployment**: Two app containers (blue:8000, green:8002) with Nginx switching for zero-downtime updates
- [x] **OpenRouter concurrency**: Increased from 6 to 50
- [x] **OpenAI judge concurrency**: Increased from 8 to 30
- [x] **ML pipeline**: Data export script + Colab analysis notebook (break prediction at 79% accuracy, criteria difficulty, model comparison, cost analysis)
- [x] **Dashboard .storage mount**: Fixed active trainers count by mounting session storage volume to dashboard container

### Recently Completed (Feb 2026 - Multi-Turn & Testing)

- [x] **Multi-turn conversation support**: Trainers can advance through N turns, each with its own prompt, criteria, and judge prompt. Conversation history accumulates across turns and is sent to the model. Implemented via `advance-turn` and `turn-status` endpoints, frontend conversation thread UI, and `TurnData`/`HuntSession` schema extensions.
- [x] **Multi-turn bug fix (`judge_reference`)**: `judge_reference` endpoint now skips Colab re-fetch when `session.current_turn > 1`, preserving the Turn 2+ notebook data set by `advance_turn` instead of overwriting it with the original Turn 1 content.
- [x] **Multi-turn bug fix (`update_config`)**: `update_config` endpoint now preserves `conversation_history` and `custom_judge_system_prompt` from the existing session config when the frontend sends an update, preventing Turn 2+ hunts from losing conversational context.
- [x] **Multi-turn advance_turn fix**: `advance_turn` now sets `session.notebook.response` to the selected good response from the completed turn, so that `judge_reference` in subsequent turns judges the correct response.
- [x] **Cumulative hunt stats**: Hunt summary now displays cumulative hunts and breaks across all turns via `getCumulativeStats()`, not just the current turn.
- [x] **Turn-scoped results filtering**: Introduced `previousTurnHuntIds` (Set) on the frontend to prevent results from completed turns bleeding into the current turn's display.
- [x] **UI improvements**: Centered hunt progress section, collapsible upload section after notebook load, compact header (reduced padding), metadata sidebar hidden in multi-turn layout, increased hunt progress max-width from 800px to 1000px.
- [x] **Contextual tips system**: Data-driven tips from ML analysis (break rates, criteria difficulty, model comparison) displayed at key workflow stages with rotation and animations.
- [x] **Full content in response selection**: When selecting a passing response to carry forward, full response content is shown instead of truncated previews.
- [x] **Pre-deployment test dashboard**: `test_dashboard_server.py` (port 8001) with `static/test-dashboard.html` -- visual test runner with SSE streaming, trend charts, category breakdown, failed test panel with tracebacks, and run history.
- [x] **Comprehensive test suite**: 194 tests across 24 files in 5 categories: unit, API, E2E (Playwright), stress/performance, and security. Covers crash recovery, data loss, timing/network, concurrency/races, state machine transitions, trainer scenarios, and security hardening.

### Unclear / Needs Confirmation

- GitHub Actions workflows (`ml_analysis.yml`, `ml_analysis_simple.yml`) - trigger conditions unclear

---

## 6. Known Issues / Risks (Observed)

### Debug Logging in Production
- **Issue**: Extensive `print(f"DEBUG: ...")` statements throughout codebase (~119 instances)
- **Location**: `main.py`, `notebook_parser.py`, `openai_client.py`
- **Risk**: Performance overhead, log verbosity in production

### Error Handling Gaps
- **Issue**: Some exceptions silently caught without logging
- **Location**: `telemetry_logger.py:91`, `hunt_engine.py:293`
- **Risk**: Silent failures may go unnoticed

### Session State Synchronization
- **Issue**: Session data stored in both memory and Redis; potential sync issues
- **Location**: `hunt_engine.py:78-84`, `main.py:574-588`
- **Risk**: Stale session data if Redis write fails

### Large Frontend File
- **Issue**: `app.js` is ~325K characters in a single file
- **Risk**: Maintainability, debugging difficulty

### Hardcoded Values
- **Issue**: Several configuration values hardcoded
- **Examples**:
  - APP_VERSION = "1.0.4" (`main.py:17`)
  - Max parallel workers = 6 (`index.html:326`)
  - Session TTL = 2 hours (`main.py:341`)

### Missing Error Responses
- **Issue**: Hunt can fail silently if selected hunt_ids not found in results
- **Location**: `main.py:1340-1356` (raises HTTPException but frontend handling unclear)

### ~~Multi-Turn Judge/Config Data Loss~~ (Resolved Feb 2026)
- **Issue**: In Turn 2+, `judge_reference` re-fetched the notebook from Colab and overwrote `session.notebook` with Turn 1 data. Separately, `update_config` replaced the entire `session.config`, wiping `conversation_history` and `custom_judge_system_prompt` set by `advance_turn`.
- **Fix**: `judge_reference` now skips Colab re-fetch when `current_turn > 1`. `update_config` now preserves multi-turn fields from the existing config when the incoming config doesn't include them.

---

## 7. Open Questions

1. ~~**What is the intended use of `services/trainer_identity.py`?**~~
   - **Resolved**: Generates fun anime character names (e.g., Gojo_42) as trainer IDs for the dashboard leaderboard

2. ~~**Is the ML pipeline (`ml_pipeline/`) actively integrated?**~~
   - **Resolved**: Export script runs on VM (`export_ml_data.py`), outputs uploaded to Colab notebook for analysis. First run: 2,900 sessions, 46K hunts, 79% break prediction accuracy.

3. **What triggers the GitHub Actions workflows?**
   - Workflow files exist but trigger conditions not verified

4. **What is the expected behavior when Redis is unavailable?**
   - Code falls back to memory, but session persistence across restarts would be lost

5. **How should the system handle Google Drive permission errors?**
   - Error messages guide users, but recovery workflow unclear

6. **What is the expected notebook structure for valid processing?**
   - Code implies specific format but no schema validation documentation found

7. **Is there a maximum prompt/response length enforced?**
   - No explicit limits observed in code

8. **How are API costs tracked/managed?**
   - Dashboard has cost endpoint but cost limits/alerts not observed

---

## Appendix: Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-5 judge |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for model calls |
| `FIREWORKS_API_KEY` | No | Fireworks AI API key (alternative provider) |
| `REDIS_URL` | No | Redis connection URL (default: `redis://localhost:6379/0`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON_PATH` | No | Path to service account JSON file |
| `MAINTENANCE_MODE` | No | Set to "true" to enable maintenance mode |
| `OPENROUTER_CONCURRENCY` | No | Max concurrent OpenRouter calls (default: 10, currently set to **50**) |
| `FIREWORKS_CONCURRENCY` | No | Max concurrent Fireworks calls (default: 8, currently set to **4**) |
| `OPENAI_CONCURRENCY` | No | Max concurrent OpenAI judge calls (default: 12, currently set to **30**) |

---

## Lessons Learned (Feb 2026)

### 1. One Concept, One Place
Feature enforcement (like model lock) must live in exactly one function. Everything else calls that function. Never sprinkle the same check across multiple event handlers, dropdown builders, and result-clearing functions independently. When a feature was spread across 5 locations, disabling it required finding and updating all 5 — and missing even one created cascading bugs.

### 2. Search Wide Before Editing
Before changing any feature, search for EVERY reference — not just the function name, but related variables, CSS classes, error messages, and event handlers. Map the full blast radius before writing a single line of code.

### 3. Validate After Every Edit
- Run `node -c app.js` after every JS edit (catches syntax errors in 0.5 seconds)
- Dead code after a `return` statement still gets parsed by JavaScript. Duplicate `const` declarations in dead code cause `SyntaxError` that kills the entire file. Always delete dead code — never leave it commented below a return.

### 4. Ask for the Error Message First
When something doesn't work, ask the user to check the browser console (F12) immediately instead of guessing. A single error message like `metadataModelKey is not defined` tells you the exact problem in seconds.

### 5. Auto-Reload is Destructive During Active Use
`reload=True` in uvicorn causes the server to restart on every file change, which cascades into page reloads, lost sessions, and broken UI state. Keep `reload=False` when users are actively using the tool. Restart manually when ready.

### 6. Bump APP_VERSION on Deploy
The frontend checks `/api/version` every 30 seconds. If version changes, it prompts trainers to reload. But this only works if `APP_VERSION` in `main.py` is bumped. Always bump it on deployment.

---

## Appendix: API Endpoints Summary

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/upload-notebook` | Upload .ipynb file |
| POST | `/api/fetch-notebook` | Fetch notebook from URL |
| GET | `/api/session/{session_id}` | Get session details |
| POST | `/api/update-config/{session_id}` | Update hunt configuration |
| POST | `/api/start-hunt` | Start hunt (non-streaming) |
| GET | `/api/hunt-stream/{session_id}` | SSE endpoint for hunt progress |
| POST | `/api/judge-reference/{session_id}` | Judge reference response |
| POST | `/api/update-notebook-cell/{session_id}` | Update single notebook cell |
| POST | `/api/update-notebook-cells/{session_id}` | Update multiple cells |
| POST | `/api/save-snapshot` | WYSIWYG save to Colab |
| POST | `/api/save-to-drive/{session_id}` | Save results to Drive |
| GET | `/api/results/{session_id}` | Get all hunt results |
| GET | `/api/review-results/{session_id}` | Get 4 results for review |
| POST | `/api/advance-turn/{session_id}` | Advance to next turn with selected response, new prompt, and new criteria |
| GET | `/api/turn-status/{session_id}` | Get current turn, conversation history, and all past turns |
| GET | `/api/health` | Health check |
| GET | `/api/version` | Get app version |
