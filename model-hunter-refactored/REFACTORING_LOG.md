# Model Hunter Refactoring Log

> Started: 2026-02-12 16:52 IST
> Source: `model-hunter/` (original, untouched)
> Target: `model-hunter-refactored/` (this folder)
> **Deploy:** Only after all planned updates are complete, not before.

## Session 1 — Feb 12, 2026

### Setup (16:52)
- [x] Copied `model-hunter/` → `model-hunter-refactored/`
- [x] Created this tracking file

### P2: Debug Prints → Logger (Completed)
- Target: `services/notebook_parser.py`
- Change: Replaced `print` with `logger.debug`.
- Status: DONE

### P3: GitHub Actions CI/CD (Completed)
- Created `.github/workflows/ci-cd.yml`.
- Added linting (ruff, black) and testing (pytest) steps.
- Status: DONE

### P4: Split `main.py` into Route Modules (Completed)
- Decomposed monolithic `main.py` into `routes/*.py`.
- Created slim `main.py` entry point.
- Verified app startup and route registration.
- Status: DONE

### P9: Remove Dual Storage Ambiguity (Completed)
- Implemented `save_full_session` in Redis layer.
- Updated `helpers/shared.py` to auto-restore from disk on Redis miss.
- Refactored `routes/session.py`, `notebook.py` to use unified retrieval.
- Verified with crash recovery tests.
- Status: DONE

### P0: Frontend Refactoring (Phase 1) - Feb 12, 2026 (ATTEMPTED & REVERTED)
- **Attempt**: Started refactoring `app.js` into ES6 modules (`config.js`, `utils.js`).
- **Issue**: Changes were inadvertently applied to the `model-hunter` (original) directory instead of `model-hunter-refactored` (target).
- **Resolution**: Reverted `model-hunter/static/app.js` to its original monolithic state (from backup). Deleted `model-hunter/static/modules` directory. Reverted `index.html`.
- **Status**: REVERTED. Ready for retry in `model-hunter-refactored`.

### P0: Frontend Refactoring (Phase 1 — Config & Utils) ✅
- Created `modules/config.js` (80 lines) — API URLs, model lists, constants.
- Created `modules/utils.js` (145 lines) — `escapeHtml`, `getModelDisplayName`, `formatJSON`, etc.
- Created `modules/types.js` (25 lines) — JSDoc type definitions.
- Updated `index.html` with ES6 module bridge (`<script type="module">`).
- Status: DONE

### P0: Frontend Refactoring (Phase 2 — Core State & API) ✅
- Created `modules/state.js` (90 lines) — reactive state object, `resetTurnState`, `getCumulativeStats`.
- Created `modules/api.js` (200 lines) — version check, update prompt, app modal.
- Created `modules/auth.js` (185 lines) — trainer registration, heartbeat, session management.
- Added `defer` to `app.js` script tag to fix module bridge timing.
- Status: DONE

### P0: Frontend Refactoring (Phase 3 — Deep Split) ✅
- Created `modules/dom.js` (120 lines) — centralized DOM element references.
- Created `modules/theme.js` (47 lines) — theme toggle, tab initialization.
- Created `modules/notebook.js` (1,815 lines) — file upload, notebook loading, preview, save, criteria parsing.
- Created `modules/editors.js` (652 lines) — markdown editors, structured input, prompt validation.
- Created `modules/hunt.js` (715 lines) — hunt limits, SSE progress, hunt execution.
- Created `modules/results.js` (2,497 lines) — slideouts, selection cards, review, grading, export.
- Created `modules/multiturn.js` (1,150 lines) — turn journey bar, conversation thread, calibration.
- Created `modules/celebrations.js` (340 lines) — particle engine, confetti, toast notifications.
- **`app.js` reduced from ~8,650 to 1,676 lines** (80% reduction).
- Updated module bridge to load all 13 modules.
- Cleaned up duplicate `escapeHtml` across modules.
- All 15 files pass `node -c` syntax checks.
- Status: DONE

### P0: Frontend Refactoring (Phase 4 — Direct Imports & Fixes) ✅
- **Comprehensive Import Verification**: Scanned `notebook.js`, `hunt.js`, `multiturn.js`, `results.js` for missing imports.
- **Fixed ReferenceErrors**: Added 14+ missing imports in `notebook.js` (`updateMarkdownPreview`, `validatePromptLength`, `showModelLockedIndicator`, etc.).
- **Dependency Cleanup**: Removed unused imports in `hunt.js`, fixed circular references (`getTurnColor`), removed duplicate definitions.
- **Stability**: Code base is now free of prevalent module ReferenceErrors.
- Status: DONE

### Refactoring Audit — Feb 13, 2026 ✅
- **Full codebase audit** before new features. See `REFACTORING_AUDIT.md`.
- **Critical fixes applied:**
  1. `initFileUpload()` was never called → file upload (drag-drop, click) broken. Added to app.js init.
  2. `initCalibrationListeners()` was never called → Turn 2+ calibration panel buttons broken. Added to app.js init.
  3. `elements.responseEditor` undefined in notebook.js (dom.js has `referencePreview`). Fixed to use `referencePreview`.
- **Documented:** saveAndJudgeResponse is dead code (references non-existent saveAndJudgeResponseBtn). Safe to leave.
- Status: DONE

### Turn 2+ Empty Prompt/Response in History — Feb 13, 2026 ✅
- **Issue:** After entering Turn 3+, turn history showed empty prompt, criteria, and selected response for Turn 2+.
- **Root cause:** Backend used `session.notebook` for turn_data; in selectGoodResponse flow, session may not have been saved with Turn 2's prompt before advance.
- **Fix:**
  1. **Backend** (`routes/multiturn.py`): Added optional `current_prompt` and `current_criteria` to AdvanceTurnRequest. When provided, use them for turn_data instead of session.notebook. Added `clear_all_results` so results reset after advance.
  2. **Frontend** (`multiturn.js`): In `selectGoodResponse`, read prompt and criteria from DOM before advance API call; send as `current_prompt` and `current_criteria` in the request body.
- **Tests:** Updated `test_advance_turn_missing_prompt/criteria` to expect 400 (hunt not found) or 200 (optional fields). All 55 multi-turn/state-machine tests pass.
- Status: DONE

### P0: Frontend Refactoring (Phase 4 — Remove window.* Bridge) — Feb 13, 2026 ✅
- **Removed all window.* assignments** used for cross-module communication:
  - `auth.js`: Replaced `window.state` with `state` import.
  - `results.js`: Removed `window.openResponseSlideout`, `closeResponseSlideout`, `openSelectionDetailSlideout`, `openGradingSlideout`, `closeGradingSlideout`, `toggleSelectionResponse`.
  - `app.js`: Removed `window.fetchFromUrl`, `window.openResponseSlideout`, `window.toggleMetadataSidebar`.
- **Replaced inline onclick with event delegation**:
  - `hunt.js`: "View" button in results table now uses `data-row-number` attribute; event delegation in `initProgressUI` calls `openResponseSlideout` via direct import from `results.js`.
  - `index.html`: Removed `onclick` from fetch button; `initFileUpload` already attaches listener.
- **Module dependency comments** updated to reflect direct imports (no more "via window.* bridge").
- Status: DONE

### Frontend State Loss on Page Refresh — Feb 13, 2026 ✅

- **Issue:** Multi-turn state (currentTurn, conversationHistory, turns) lost on page refresh; backend preserved in Redis but frontend never called turn-status on restore.
- **Fix:** In `restoreSession()` (app.js), after successfully restoring session, call `syncTurnStatusFromBackend(savedSessionId)` to rehydrate state from `/api/turn-status`. Exported `syncTurnStatusFromBackend` from notebook.js.
- Status: DONE

### UI & Bug Fixes — Feb 13, 2026 ✅

- **Response column**: Moved to 3rd position (after Model); View button only; medium-size; response in slideout on click.
- **Status text**: "Calling model" → "Model thinking"; deprecated `calling_model` step.
- **Missing imports fixed**:
  - `results.js`: `showAppModal`, `MIN_EXPLANATION_WORDS`, `getIncompleteReviewIssues`, `getIncompleteReviewsModalMessage`
  - `notebook.js`: `getIncompleteReviewIssues`, `getIncompleteReviewsModalMessage`, `triggerColabConfetti`
  - `hunt.js`: local `escapeHtml` (avoids circular import)
- **Grading slideout**: z-index 100001; backdrop pointer-events; null checks.
- **Verify**: Full flow working; save to Colab succeeds; confetti fires.
- Status: DONE

### P7: Error Handling UX — Feb 13, 2026 ✅

- **utils.js**: Added `getUserFriendlyError(error, context)` — maps network, timeout, 401/403/404/500, JSON parse, validation errors to user-friendly messages with hints.
- **celebrations.js**: Added `showToastWithRetry(message, hint, onRetry)` — toast with Retry button for transient errors. Added `showError(error, options)` — centralized error display.
- **Updated modules**: notebook.js, multiturn.js, results.js, app.js — replaced raw `showToast(\`Error: ${error.message}\`, 'error')` with `showError(error, { operation, retry })`.
- **Retry UI**: Fetch notebook and Save to Colab show Retry button for connection/timeout errors.
- **style.css**: Added `.toast-with-retry`, `.toast-retry-content`, `.toast-hint`, `.toast-retry-btn` styles.
- Status: DONE

### deploy.sh Path Fix — Feb 13, 2026 ✅

- **Issue:** Script had hardcoded `cd model-hunter` after `git pull`; would deploy original codebase instead of refactored when run from `model-hunter-refactored`.
- **Fix:** Added `SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"`; replaced `cd .. && git pull origin main && cd model-hunter` with `cd "$SCRIPT_DIR/.." && git pull origin main && cd "$SCRIPT_DIR"` in both `deploy_frontend` and `deploy_full`.
- Status: DONE

### Model Lock After Turn — Feb 13, 2026 ✅

- **Issue:** After Turn 1 (and any turn), model choice was locked until page refresh. Trainer could not change model for Turn 2+ hunts.
- **Root cause:** `handleHuntComplete` intentionally kept model/provider selects disabled (FIX 4: "only unlock on refresh").
- **Fix:** Re-enable model and provider selects when hunt completes. Model stays locked only during active hunt; once hunt completes, trainer can change model for next hunt in any turn.
- **Files:** `static/modules/results.js`
- Status: DONE

### Turn 1 Test Prompt — Feb 13, 2026 ✅

- **Feature:** Test prompt before writing criteria. Trainer can generate a response with any model, view it, and save to notebook. Similar to Turn 2 calibration but Turn 1 only, no judging.
- **Flow:** Prompt → [Generate Response] (optional) → Create criteria → Judge Reference → Hunt.
- **Details:** Separate Provider + Model dropdowns in Test Prompt panel (side by side). Single button: "Generate Response" → "Regenerate" after first run. Multiple generations enabled; latest saved. Optional—trainers can skip.
- **Files:** `routes/calibration.py` (optional model/provider/prompt in generate-single), `static/index.html`, `static/modules/notebook.js`, `static/app.js`.
- Status: DONE

### Hunt Config & UI Cleanup — Feb 13, 2026 ✅

- **Hunt Config:** Removed slider and number input; kept preset buttons (1, 2, 4, 6). Label: "Select the number of hunts to start". Judge Model shown (fixed to GPT-5).
- **Buttons:** Save Response, Judge Reference, Save Criteria, Save Judge, Save All & Judge — compact, centered, shorter labels ("Save Criteria", "Save Judge").
- **Preview toggle:** When preview off, collapse blank space — `.preview-collapsed` on split-view, hide resize handle, `min-height: unset`.
- **Model Reference:** Removed JSON preview — conversion still runs in backend, display removed from UI.
- **Space optimization:** `#notebookPreviewCard` min-height 800px→350px; `.preview-content` min-height 700px→0; `.preview-panel` flex: 1→0 0 auto.
- **Files:** `static/index.html`, `static/style.css`, `static/modules/editors.js`, `static/modules/notebook.js`, `static/modules/hunt.js`.
- Status: DONE

### Input Sections Extendable — Feb 13, 2026 ✅

- **Issue:** Input sections (prompt, response, etc.) could not be extended or resized freely.
- **Fix 1:** `.markdown-textarea` — changed `resize: none` to `resize: vertical` so users can drag the bottom-right corner to extend the textarea.
- **Fix 2:** When preview is collapsed (`.preview-collapsed`), `.markdown-editor-pane` now uses `flex: 1 1 auto` so the editor grows to fill available space.
- **Files:** `static/style.css`
- Status: DONE

### Big 3 Docs — Planned Features #3 & #4 Status — Feb 13, 2026 ✅

- **#3 Skip re-judge when model changes:** Marked Done. model-hunter-refactored does not call clearPreviousResults on model change; referenceValidated stays true.
- **#4 Save model after first turn:** Marked Dropped. Decision to keep model selection flexible in all turns.
- **Big 3 = three primary docs:** `SOURCE_OF_TRUTH.md`, `WORKLOG.md`, `model-hunter-refactored/REFACTORING_LOG.md` (this file). All three should be updated together for major changes.
- Status: DONE

### Big 3 — Recent Updates (Feb 17, 2026) — All Three Docs Updated ✅

- **#1 Colab Save Structure:** All cells use `**[Turn N - prompt]**` format. Single-turn = Turn 1 headings. Multi-turn = latest turn first, then previous turns (newest first). `number_of_attempts_made` = per-model markdown list with display names (e.g. Nemotron-3-Nano (Fast): 12, Claude Opus 4.5: 6). Turn history and selected response saved per turn.
- **#2 Calibration removed:** Turn 2+ now uses the same Test Prompt flow as Turn 1. No separate calibration step; trainers generate response, judge reference, then hunt.
- **#3 Collapsible judge result:** Criteria Breakdown and Judge Explanation in the notebook preview are collapsible for cleaner UX.
- **Big 3 updated:** SOURCE_OF_TRUTH.md, WORKLOG.md, REFACTORING_LOG.md

### Dashboard Refactor — Feb 13, 2026 ✅

- **Modular structure:** Split monolithic `dashboard.js` (757 lines) into ES6 modules:
  - `modules/config.js` — constants (SECTIONS, TABLE_MAX_ROWS, etc.)
  - `modules/state.js` — app state
  - `modules/utils.js` — esc, formatTime, metricCard, deltaClass, deltaText
  - `modules/api.js` — fetch wrapper
  - `modules/navigation.js` — navigateTo, keyboard shortcuts
  - `modules/live-feed.js` — SSE live activity
  - `modules/admin.js` — admin/test account management
  - `modules/sections/*.js` — command-center, trainers, intelligence, sessions, models, costs, datalab, system
- **Entry point:** `main.js` — init orchestrator, event delegation
- **Keyboard shortcuts:** 1-8 for sections, R for refresh (shown in sidebar footer)
- **Compact layout:** table-scroll (max-height 220px), list-scroll (180px), reduced table padding, live feed 220px
- **Event delegation:** Trainer drilldown, session replay, export cards, admin revoke — no inline onclick
- Status: DONE

### Architecture Graph — Feb 13, 2026 ✅

- **File:** `static/architecture-graph.html` — Interactive visual graph of all module connections.
- **Features:** Click a node to highlight its connected workflows (imports, API calls, dependencies). Click empty space to reset. Double-click to zoom. Color-coded: Frontend (blue), Routes (green), Services (amber), Storage (purple), Helpers (light blue).
- **Open:** With server running, visit `/static/architecture-graph.html` or open the file directly in a browser.
- Status: DONE

### Empty Response Picker (Continue to Turn 2) — Feb 13, 2026 ✅

- **Issue:** User could not see any response (passing or failing) to select when clicking "Continue to Turn 2".
- **Root causes:**
  1. **Backend:** `_get_all_accumulated_results_async` only returned COMPLETED results. Failed hunts (empty response, model errors) were in `results` but excluded from the API response.
  2. **Frontend:** Picker relied on merge logic; no guaranteed fresh fetch when opening.
- **Fix:**
  1. **hunt_engine.py:** Include ALL results (completed + failed) in `_get_all_accumulated_results_async` so the response picker shows every hunt.
  2. **results.js:** Added `replace: true` option to `fetchAllResponses()`; when set, replaces `allResponses` with API data.
  3. **multiturn.js:** `handleContinueToNextTurn` now always calls `fetchAllResponses({ replace: true })` when opening the picker.
- **Files:** services/hunt_engine.py, static/modules/results.js, static/modules/multiturn.js
- Status: DONE

### Bedrock "Assistant Message Prefill" Error — Feb 13, 2026 ✅

- **Error:** `This model does not support assistant message prefill. The conversation must end with a user message.`
- **Root cause:** Occurs when sending empty prompt. Bedrock requires last message from user; empty content can be stripped, leaving assistant as last.
- **Status:** Existing empty prompt guardrail in `hunt.js` blocks hunt start when prompt is empty. No code change needed.
- **Files:** SOURCE_OF_TRUTH.md, WORKLOG.md, REFACTORING_LOG.md
- Status: DONE

### Future Ideas: Inverse IFEval — Feb 13, 2026 ✅

- **File:** `docs/IDEAS_INVERSE_IFEVAL.md`
- **Purpose:** Track future/extra ideas for making Model Hunter smarter, inspired by the Inverse IFEval research paper (cognitive inertia, counter-intuitive instruction following).
- **Contents:** 12 ideas — instruction type tagging, prompt templates, inverse criteria presets, mid-turn contradiction, model weakness profiles, think vs non-think comparison, and more.
- Status: DONE (tracking doc created)

### Prompt & Response Stacked Layout — Feb 13, 2026 ✅

- **Change:** Response section now appears directly below Prompt (stacked vertically) in both Notebook Preview and editor.
- **Tabs:** Replaced separate "Prompt" and "Response" tabs with single "Prompt & Response" tab. Model Reference and Judge System Prompt remain as separate tabs to the right.
- **Scope:** Applies to Turn 1 and Turn 2+ (same editor used for all turns).
- **Files:** index.html, style.css, notebook.js
- Status: DONE

### Auto-Save with Mitigations — Feb 13, 2026 ✅

- **Batch saves:** All 4 fields (Prompt, Response, Criteria, Judge) sent in one request to `/api/update-notebook-cells` with `session_only: true`.
- **Retry with backoff:** 3 retries (1s, 2s, 4s) on network/5xx/429 errors.
- **localStorage backup:** Draft saved before each save; grading drafts backed up per hunt.
- **Save failed + retry:** Status shows "✗ Save failed" (red); click to retry; toast with Retry button.
- **Serialized saves:** Only one save at a time; per-session rate limit (min 2s between batch saves).
- **Status indicators:** Next to headings — ✓ Saved (green), ⋯ Saving... (blue), ○ Unsaved (yellow), ✗ Save failed (red).
- **Scope:** Main editors, Turn 2+ next-turn editor, human grading slideout. Save All & Judge kept; individual save buttons removed.
- **Files:** `static/modules/autosave.js`, `routes/notebook.py` (session_only on update-notebook-cells), `static/style.css`
- Status: DONE

### Review Mode Button Lock — Feb 13, 2026 ✅

- **When selection confirmed:** Disable Judge Reference, Start Hunt, Save All & Judge, Confirm Selection. Only view buttons (Expand/Collapse) remain enabled.
- **Centralized:** `setReviewModeButtonsDisabled(true)` in results.js; called from confirmSelection, updateReviewProgress, refreshValidationState.
- **Guards:** notebook.js validateModelReferenceAndCriteria, judgeReferenceResponse, saveAndJudgeResponse check `state.selectionConfirmed` before enabling Start Hunt.
- **Admin bypass:** All locks bypassed in admin mode.
- **Files:** `static/modules/results.js`, `static/modules/notebook.js`
- Status: DONE

### Grading Split View — Feb 13, 2026 ✅

- **Layout:** Left panel (~45%) = Model Response + collapsible Reasoning; Right panel (~55%) = Grading criteria, Explanation, Submit, LLM Judge.
- **Resizable divider:** Drag to adjust split; persisted to localStorage (`modelhunter_grading_split_percent`).
- **Slideout width:** 800px → 1200px (min 700px) for split layout.
- **Files:** `static/modules/results.js`, `static/style.css`, `static/index.html`
- Status: DONE

### Grading UX Improvements — Feb 13, 2026 ✅

- **Keyboard shortcuts:** P = Pass, F = Fail on focused criterion; Tab between criteria; first criterion focused on open.
- **Progress in header:** "X/Y criteria graded" in slideout header; green when complete.
- **Persist divider:** Split ratio saved to localStorage on drag end; restored on open.
- **Files:** `static/modules/results.js`, `static/index.html`, `static/style.css`
- Status: DONE

### UX Improvements, Code Audit & Cleanup — Feb 16, 2026 ✅

- **UX (HCI/product best practices):** Grading shortcuts hint (P/F/Tab); status text by model type (reasoning vs non-reasoning); per-turn progress ("Turn X of Y"); criteria format hint + Colab URL validation; "Change selection" button; Pause/Dismiss for tips; criteria summary in results (C1: ✓ C2: ✗); Duolingo-style "No breaks" encouragement; How it works modal; term renames (Judge Reference → Check Ideal Response, Start Hunt → Find Breaking Responses, etc.); criteria buttons (+ C1, + C2); mobile message; i18n prep (`static/i18n/en.json`).
- **Code audit:** No malicious code. Dead: `saveAndJudgeResponse` (notebook.js). Duplicate: `escapeHtml` (hunt.js). Backup files: app.js.bak, app.js.monolith, index.html.bak.
- **Cleanup:** Removed `saveAndJudgeResponse` (~155 lines); hunt.js imports `escapeHtml` from utils.js; deleted 3 backup files. Risky items (innerHTML escaping, print→logger in dashboard) deferred.
- Status: DONE

### Admin Mode — Feb 13, 2026 ✅

- **Trigger:** 5 clicks on Task ID (metadata sidebar). Removed copy-on-click for Task ID.
- **Password:** testmodel (ADMIN_MODE_PASSWORD in config.js).
- **On success:** Green "Admin" badge in header; state.adminMode = true; all locks bypassed.
- **Bypasses:** referenceValidated, hunt limit, model match, calibration, prompt word limit, review readiness (4 breaking / 3+1), diversity check, review-in-progress block.
- **Reveal LLM Judgments & Save to Colab:** In admin mode, both buttons enabled regardless of review completion, 4 hunts, diversity, or llmRevealed. results.js: displaySelectedForReview, updateReviewProgress, revealLLMJudgments. notebook.js: saveToDrive.
- **Disable:** Click the Admin badge to turn off.
- **Files:** state.js, config.js, api.js (showPasswordPrompt), notebook.js, hunt.js, editors.js, multiturn.js, results.js, app.js, index.html, style.css
- Status: DONE

### Big 3 — Staging Server & Deployment — Feb 17, 2026 ✅

- **SOURCE_OF_TRUTH:** Appendix "GitHub Repo, Branches & Servers" — repo https://github.com/vharatian/InverseIFHunter, branches (main, staging, feature/refactored), VM mandy@34.68.227.248. Production http://34.68.227.248 (port 80), Staging http://34.68.227.248:443 (port 443). Deploy: production via deploy.sh (main), staging via deploy-staging.sh (staging branch). Staging logs: docker logs model-hunter-staging-blue.
- **WORKLOG:** Entry for Big 3 staging/deployment update.
- Status: DONE

### Colab Save Structure — Feb 17, 2026 ✅

- **Heading format:** All cells use `**[Turn N - prompt]**` style. For n=1 (single-turn), use `**[Turn 1 - prompt]**`.
- **Single-turn:** `**[Turn 1 - prompt]**`, `**[Turn 1 - response]**`, `**[Turn 1 - response_reference]**`, `**[Turn 1 - judge_system_prompt]**`, `**[Turn 1 - {Model}_1]**`, `**[Turn 1 - llm_judge_1]**`, etc.
- **Multi-turn:** Latest turn first (full structure), then previous turns newest-first with `**[Turn K - prompt]**`, `**[Turn K - selected_response]**`, `**[Turn K - response_reference]**`, `**[Turn K - selected_judge]**`.
- **number_of_attempts_made:** Per-model markdown list with display names (e.g. `Nemotron-3-Nano (Fast): 12`, `Claude Opus 4.5: 6`). Same model variants use version names/numbers.
- **Files:** `services/notebook_parser.py` (export_notebook, export_multi_turn_notebook, format_number_of_attempts_made, get_model_display_name), `services/snapshot_service.py` (per_model_hunts), `routes/notebook.py`, `static/modules/notebook.js` (per_model_hunts computation)
- Status: DONE

### Collapsible Breaking Results Card & View LLM Judgment — Feb 18, 2026 ✅

- **Collapsible card:** Entire "Model Breaking Responses" card (header, progress, slots, save area) is collapsible. Auto-collapses when selection is confirmed and moved to review. Summary: "4 slots selected – click to expand". Click header or summary to toggle.
- **View LLM Judgment:** After reveal, slot button text changed from "View" to "View LLM Judgment" so trainer clearly understands they're viewing AI evaluation.
- **Files:** index.html, style.css, state.js, dom.js, results.js, app.js
- Status: DONE

### Live Export Preview — Feb 17, 2026 (Removed)

- **Was:** In-app Live Export tab in preview panel. Removed due to not working reliably.
- **Reverted:** Tab, panel, buildLiveExportHtml, renderLiveExportPreview, scheduleLiveExportUpdate; autosave/results wiring; CSS.
- Status: REMOVED

