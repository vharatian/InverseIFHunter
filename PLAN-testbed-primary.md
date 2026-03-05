# Plan: Make Testbed the Primary Editor (Kill Old Notebook Preview)

## Goal

Remove the old Notebook Preview card (`#notebookPreviewCard`) from the config section and make the Testbed the sole editing interface. The Notebook Preview Fullscreen Overlay (`#tbNotebookPreviewOverlay`) stays as the read-only review step between editing and hunting.

**New flow:**
`Load Notebook → Testbed (edit) → Save & Preview Overlay (review) → Hunt Config → Hunt`

## Current State

| # | Component | Element | Status |
|---|-----------|---------|--------|
| 1 | Old Notebook Preview card | `#notebookPreviewCard` in `index.html` | **REMOVED** |
| 2 | Testbed | `#testbedSection` in `index.html` | **PRIMARY — active** |
| 3 | Notebook Preview Overlay | `#tbNotebookPreviewOverlay` (dynamic JS) | **Active** (read-only review) |

---

## Phase 1: Rewire Save-to-Colab to Read from Testbed State — DONE

**`state.notebook` is now the single source of truth.** All save paths read from `state.notebook`, and the Testbed writes back to `state.notebook` via `syncActiveRunToNotebook()`.

### Changes made:

**`static/modules/testbed.js`**
- `getSharedLeft()` — rewired to read `prompt`, `idealResponse`, `modelReasoning`, `criteriaChips`, `judgePrompt` exclusively from `state.notebook`. All DOM fallbacks to `promptMarkdown`, `responseMarkdown`, `judgeMarkdown`, `modelrefPreview` removed.
- `showNotebookPreview()` — removed DOM fallbacks for `promptMd`, `responseMd`, `criterias`, `judgePrompt`; reads only from `sharedLeft` / `state.notebook`.
- `saveRunToTurn()` — removed the call to `populatePreviewTabs(state.notebook)`.

**`static/modules/notebook.js`**
- Added `import { syncActiveRunToNotebook } from './testbed.js'` to flush Testbed edits before saves.
- `saveAllCells()` — calls `syncActiveRunToNotebook()` first, then reads `prompt`, `response`, `response_reference`, `judge_system_prompt` from `state.notebook`.
- `saveCurrentCellsToColab()` — reads all fields from `state.notebook` (removed conditional logic for `testbedVisible` and direct DOM reads).
- `submitToColab()` — reads `judgeSystemPrompt` from `state.notebook`.
- `judgeReferenceResponse()` — calls `syncActiveRunToNotebook()`, reads `judgePromptValue` and `currentRefText` from `state.notebook`.
- `refreshValidationState()` — reads `responseRef` from `state.notebook`.
- `invalidateReferenceJudge()` — reads `responseRef` from `state.notebook`.
- `buildLiveExportHtml()` — reads `prompt`, `response`, `criteria`, `judge` from `state.notebook`.
- `saveCell()` — calls `syncActiveRunToNotebook()`, reads cell content from `state.notebook` based on `cellType`.
- `turn1TestPromptGenerate()` — calls `syncActiveRunToNotebook()`, reads `prompt` from `state.notebook`.
- `saveAndJudgeResponse()` — calls `syncActiveRunToNotebook()`, reads `currentRefText` from `state.notebook.response_reference`.
- `saveResponseOnly()` — calls `syncActiveRunToNotebook()`, reads `newResponse` from `state.notebook.response`.

**`static/modules/multiturn.js`**
- `_applyTurnAdvance()` — removed the call to `populatePreviewTabs(state.notebook)`.
- `_readPromptAndCriteriaFromDOM()` — rewritten to read `prompt` and `criteria` from `state.notebook` only (removed DOM lookups and `convertStructuredToJSON` calls). Removed `convertStructuredToJSON` import.
- `selectGoodResponse()` — reads `currentJudgePrompt` from `state.notebook`.

---

## Phase 2: Auto-Open Testbed After Notebook Load — DONE

### Changes made:

**`static/modules/sessionHydrator.js`**
- Added `import { resetTestbed, showTestbed } from './testbed.js'`.
- `_restoreSectionVisibility()` — when `state.notebook` exists and `state.allResponses.length === 0` (no hunt results yet), calls `resetTestbed()` then `showTestbed()` to auto-open the Testbed for editing.

---

## Phase 3: Add Prompt Word Counter to Testbed — DONE

### Changes made:

**`static/modules/testbed.js`**
- `renderActiveTab()` — added a `<div class="tb-word-count" id="tbPromptWordCount"></div>` below the prompt textarea.
- Added `updateTestbedWordCount()` function — calculates word count for `tbSharedPrompt` textarea, color-codes based on `state.promptLengthRange` (neutral/ok/bad), and displays range info.
- Added `input` event listener on `tbSharedPrompt` to call `updateTestbedWordCount()` on every keystroke.

**`static/style.css`**
- Added CSS for `.tb-word-count`, `.tb-wc-neutral`, `.tb-wc-ok`, `.tb-wc-bad`.

---

## Phase 4: Remove Old Notebook Preview Card — DONE

### Changes made:

**`static/index.html`**
- Removed the entire `#notebookPreviewCard` div (~286 lines), including:
  - Prompt & Response tab (markdown editors with toolbars, split-view preview panes)
  - Model Reference tab (criteria textarea with C1-C10 buttons, structured input)
  - Judge System Prompt tab (markdown editor)
  - Live Export tab
  - Save & Check button (`#saveAllBtn`)
  - Turn 1 Test Prompt panel (`#turn1TestPromptPanel`, `#openTestbedBtn`, `#turn1GenerateBtn`)
  - Reference judge result container (`#referenceJudgeResult`)
  - Judge Before Hunt button (`#judgeBeforeHuntBtn`)
  - Word count display (`#promptWordCount`)
- Kept: `#priorConversationBanner`, `#huntConfigCard`, and everything else in `#configSection`.

**`static/modules/dom.js`**
- Removed 20 element references: `previewTabs`, `promptPreview`, `referencePreview`, `modelrefPreview`, `judgePreview`, `promptMarkdown`, `responseMarkdown`, `judgeMarkdown`, `judgeReferenceBtn`, `saveResponseBtn`, `judgeBeforeHuntBtn`, `referenceJudgeResult`, `promptLengthWarning`, `promptLengthInfo`, `savePromptBtn`, `saveModelRefBtn`, `saveJudgeBtn`, `saveAllBtn`, `jsonPreviewContent`, `jsonPreviewStatus`.
- Kept: `metadataToggleBtn`, `metadataSidebar`, `metadataCard`, `metadataGrid`, and all other active elements.

**`static/modules/editors.js`**
- Removed functions: `initMarkdownEditors()`, `insertMarkdown()`, `updateMarkdownPreview()`, `initRichTextEditors()`, `initResizablePanels()`, `initStructuredInput()`, `convertStructuredToJSON()`, `initPromptLengthValidation()`, `disableSaveButtons()`, and the `markdownEditors` constant.
- Simplified `validatePromptLength()` to read from `state.notebook.prompt` instead of `document.getElementById('promptMarkdown')`. Returns boolean only (no DOM writes to removed word count elements).
- Kept: `validatePromptLength()`, `showModelLockedIndicator()`, `hideModelLockedIndicator()`, `validateModelMatch()`, `clearModelMismatchWarning()`, `showModelMismatchWarning()`, `updateModelOptions()`.

**`static/app.js`**
- Removed imports: `initPreviewTabs`, `setupSaveHandlers`, `initRichTextEditors`, `initResizablePanels`, `initStructuredInput`, `initPromptLengthValidation`, `saveResponseOnly`, `judgeReferenceResponse`, `saveAllCells`.
- Removed init calls: `initPreviewTabs()`, `initRichTextEditors()`, `initResizablePanels()`, `initStructuredInput()`, `initPromptLengthValidation()`, `setupSaveHandlers()`.
- Removed event listeners: `elements.judgeReferenceBtn` click, `elements.judgeBeforeHuntBtn` click, `elements.saveResponseBtn` click.
- Removed old criterion button wiring for `modelrefPreview` (kept `nextTurnCriteria` for the multi-turn editor).

**`static/modules/notebook.js`**
- Removed functions: `setupSaveHandlers()`, `initPreviewTabs()`, `buildLiveExportHtml()`, `renderLiveExportPreview()`, `scheduleLiveExportUpdate()`.
- Stubbed Turn 1 test prompt functions (HTML elements removed; Testbed handles generation): `showTurn1TestPromptPanel()`, `hideTurn1TestPromptPanel()`, `updateTurn1TestPromptVisibility()`, `initTurn1TestPromptListeners()` — all are empty no-ops.
- Removed `turn1TestPromptGenerate()` and `updateTurn1ModelOptions()`.
- Stripped `populatePreviewTabs()` down to state-only initialization:
  - Sets `state.referenceValidated = false`
  - Resets `state.unsavedChanges` flags
  - Calls `displayMetadata()`
  - Validates model reference JSON (`state.modelRefValid`)
  - Parses criteria (`state.criteria`, `state.initialCriteria`)
  - Calls `validateModelReferenceAndCriteria()`
  - Calls `resetAllStatuses()`
  - No longer writes to any DOM textareas or calls editor init functions.
- Removed imports from editors.js: `initMarkdownEditors`, `convertStructuredToJSON`, `updateMarkdownPreview`, `initRichTextEditors`, `initResizablePanels`, `initStructuredInput`, `initPromptLengthValidation`, `showModelLockedIndicator` (wait, kept), `hideModelLockedIndicator` (kept).
- Added null guard on `judgeReferenceResponse()` success path — `resultDiv.innerHTML` and `resultDiv.classList.remove('hidden')` wrapped in `if (resultDiv)`.

**`static/modules/autosave.js`**
- Removed imports: `convertStructuredToJSON`, `scheduleLiveExportUpdate`.
- Rewired `performBatchSave()` to read `prompt`, `response`, `response_reference`, `judge_system_prompt` from `state.notebook` instead of DOM elements.
- Removed dead DOM wiring from `initAutosave()` — old textarea input event listeners and live export timer.

**`static/modules/results.js`**
- Removed import and all calls to `scheduleLiveExportUpdate`.

**`static/modules/testbed.js`**
- Removed unused `import { updateMarkdownPreview } from './editors.js'`.
- Removed `notebookPreviewCard` hide logic from save-and-continue and preview-dismiss flows (2 locations).

**`static/modules/hunt.js`**
- Rewired `startHunt()` prompt read from `document.getElementById('promptMarkdown')` to `state.notebook?.prompt`.
- Rewired pre-hunt save flush from DOM read to `state.notebook?.prompt`.

**`static/style.css`**
- Removed ~620 lines of dead CSS:
  - `#notebookPreviewCard`
  - `.preview-content`, `.preview-panel` and sub-selectors
  - `.prompt-response-stack`, `.prompt-response-section`
  - `.preview-panel #previewReference` and sub-selectors
  - `.judge-result-container`, `@keyframes slideDown` (judge-specific)
  - `.add-criterion-btn` states
  - `.structured-input-container`, `.structured-input-editor`, `.structured-input-help`, `.criteria-add-btn`
  - `.prompt-length-warning`, `.prompt-length-info`
  - `#promptWordCount`, `#promptWordCountText`, `#promptWordCountRange`
  - `.markdown-editor-container` and entire markdown split editor block (toolbars, `.md-btn`, `.md-separator`, split views, resize handles, pane headers, textareas, toggle, preview pane, all `.markdown-preview` typography, empty-state placeholder, `@media` responsive overrides)
  - `.live-export-content`, `.live-export-section`, `.live-export-body`
  - `.save-all-btn`
  - `.nb-card-committed` and all sub-selectors
  - `.judge-reference-section`, `.judge-reference-btn`
  - `.rich-text-editor`, `.rich-text-toolbar`, `.rich-text-btn`, `.rich-text-content` and sub-selectors
  - `.json-preview`, `.json-preview-header`, `.json-preview-content`
  - `.save-section`, `.save-btn-individual`

---

## Phase 5: Rewire Remaining References — DONE

Most of Phase 5 was completed during Phase 1. The remaining item:

**`static/modules/sessionHydrator.js`**
- `_hydrateNotebookSection()` still calls `populatePreviewTabs(notebook)` — this now only does state initialization (no DOM writes), so it works correctly.
- `_lockConfigSectionsAndShowFeedback()` — simplified to store reviewer feedback in `state._reviewerConfigFeedback` instead of writing to removed DOM panels (`previewPrompt`, `previewModelref`, `previewJudge`).
- `_unlockConfigSections()` — simplified to clear `state._reviewerConfigFeedback`.

---

## Phase 6: Cleanup & Verification — DONE

### Straggler search
- Searched all `.js` files for `document.getElementById()` calls targeting any of the 30+ removed element IDs — **zero matches found**.
- Searched all `.js` files for `elements.` references to removed dom.js properties — all remaining references are null-guarded (`if (elements.xxx)` or `btn ? ... : ...`).
- Searched all `.js` files for references to removed function names — **zero matches found**.
- Searched `style.css` for selectors targeting removed IDs/classes — **zero matches found**.
- Verified all ES module imports match actual exports — **all valid**.
- Lint check across all 10 modified files — **zero errors**.

### Dead-but-harmless exports left in `notebook.js`
These functions are exported but no longer imported by anyone. They are null-safe (all DOM accesses guarded) and can be removed in a future cleanup:
- `saveCell()` — per-cell save to Colab (button animation code references removed `elements.savePromptBtn` etc., guarded by `if (btn)`)
- `saveAllCells()` — batch save + judge (references removed `elements.saveAllBtn`, guarded)
- `saveAndJudgeResponse()` — save response + auto-judge (references removed elements, early-returns on missing button)
- `saveResponseOnly()` — save response only (references removed `elements.saveResponseBtn`, early-returns)
- `judgeReferenceResponse()` — judge ideal response (references removed elements, all guarded with `if`)

### Verification checklist
- [x] Load notebook → Testbed opens with content
- [x] Edit in Testbed → Save & Preview shows correct data
- [x] Continue to Hunt → Hunt Config shows, hunt works
- [x] Multi-turn: advance turn → Testbed opens with carried-over content
- [x] Save to Colab works correctly from all paths
- [x] Session restore → Testbed shows correct state
- [x] Word count shows in Testbed prompt field
- [x] Judge reference works from Testbed

---

## Files Modified (Summary)

| File | Lines removed (approx) | Lines added (approx) | Nature of change |
|------|----------------------|---------------------|-----------------|
| `static/index.html` | ~286 | 0 | Removed `#notebookPreviewCard` |
| `static/style.css` | ~620 | 0 | Removed dead CSS |
| `static/modules/dom.js` | ~20 | 0 | Removed old element refs |
| `static/modules/editors.js` | ~550 | ~60 | Gutted; kept validation + model options |
| `static/modules/notebook.js` | ~310 | ~30 | Removed dead functions, slimmed populatePreviewTabs |
| `static/modules/testbed.js` | ~15 | ~30 | Word counter, removed dead refs |
| `static/modules/autosave.js` | ~25 | ~5 | Rewired to state.notebook |
| `static/modules/results.js` | ~5 | 0 | Removed scheduleLiveExportUpdate |
| `static/modules/multiturn.js` | ~15 | ~3 | Rewired to state.notebook |
| `static/modules/sessionHydrator.js` | ~25 | ~10 | Simplified lock/feedback logic |
| `static/modules/hunt.js` | ~3 | ~2 | Rewired prompt reads |
| `static/app.js` | ~25 | ~3 | Removed dead imports/calls |

**Total: ~1,900 lines removed, ~143 lines added.**
