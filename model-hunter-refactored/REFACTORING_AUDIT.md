# Model Hunter Refactored — Code Audit

> Audit date: Feb 13, 2026
> Purpose: Verify module structure, imports/exports, and initialization flow before new features.

---

## 1. Module Dependency Map

```
app.js (entry)
├── dom.js
├── theme.js
├── state.js
├── auth.js
├── api.js
├── hunt.js
│   ├── config.js, utils.js, state.js, dom.js
│   ├── celebrations.js, results.js, multiturn.js, api.js
│   ├── theme.js, notebook.js, editors.js
│   └── (circular: hunt ↔ notebook, hunt ↔ multiturn)
├── notebook.js
│   ├── dom.js, state.js, utils.js, celebrations.js
│   ├── results.js, editors.js, api.js, auth.js, hunt.js
│   └── (circular: notebook ↔ editors, notebook ↔ hunt)
├── results.js
│   ├── dom.js, state.js, utils.js, celebrations.js, editors.js
├── multiturn.js
│   ├── dom.js, state.js, utils.js, celebrations.js
│   ├── results.js, notebook.js, editors.js, hunt.js
├── editors.js
│   ├── dom.js, state.js, utils.js, celebrations.js, config.js
│   └── notebook.js (validateModelReferenceAndCriteria)
└── celebrations.js
    ├── dom.js, state.js, results.js, utils.js
```

**Circular dependencies:** `notebook ↔ editors`, `hunt ↔ notebook`, `hunt ↔ multiturn`. These are acceptable in ES modules — load order is handled by the runtime.

---

## 2. DOM Elements (dom.js ↔ index.html)

| Element Key | DOM ID | Status |
|-------------|--------|--------|
| saveResponseBtn | saveReponseBtn | ✅ Match (HTML typo preserved) |
| referencePreview | referencePreview | ✅ |
| fileDropzone | fileDropzone | ✅ |
| fileInput | fileInput | ✅ |
| fetchUrlBtn | fetchUrlBtn | ✅ |
| revealLLMBtn | revealLLMBtnBottom | ✅ |
| All others | — | ✅ Verified |

**Missing from dom.js:** `saveAndJudgeResponseBtn` — used in `saveAndJudgeResponse()` (notebook.js) but that function is **never called** (dead code). No HTML element with that ID exists.

---

## 3. Initialization Flow (app.js DOMContentLoaded)

| Step | Call | Purpose |
|------|------|---------|
| 1 | initTheme() | Theme toggle, tabs |
| 2 | initTrainerRegistration() | Registration modal |
| 3 | startHeartbeat() | Activity tracking |
| 4 | checkVersion() | Update notification |
| 5 | **initFileUpload()** | **File drag-drop, click-to-upload** (was missing, now added) |
| 6 | initHuntNumberControls() | Hunt limit UI |
| 7 | initPreviewTabs() | Tab switching |
| 8 | initSlideoutResize() | Resizable slideouts |
| 9 | **initCalibrationListeners()** | **Turn 2+ calibration panel buttons** (was missing, now added) |
| 10 | initRichTextEditors() | Markdown editors |
| 11 | initResizablePanels() | Panel resizing |
| 12 | initStructuredInput() | Criteria structured input |
| 13 | initPromptLengthValidation() | Word count validation |
| 14 | setupSaveHandlers() | Save button handlers |
| 15 | initEventListeners() | Hunt, save, judge, slideouts, etc. |
| 16 | initMultiTurnListeners() | Mark breaking, continue, start next turn |
| 17 | restoreSession() | Session recovery |
| 18 | setupBackupHandlers() | Fetch button, upload toggle |

---

## 4. Issues Found & Fixed

### Critical (Fixed)

| Issue | Location | Fix |
|-------|----------|-----|
| **initFileUpload() never called** | app.js | Added to DOMContentLoaded init sequence |
| **initCalibrationListeners() never called** | app.js | Added to DOMContentLoaded init sequence |
| **elements.responseEditor undefined** | notebook.js:2169 | Changed to `elements.referencePreview` |

### Minor / Documented

| Issue | Location | Notes |
|-------|----------|-------|
| saveAndJudgeResponse uses saveAndJudgeResponseBtn | notebook.js:1848 | Dead code — never called. Button doesn't exist. Safe to leave or remove later. |
| HTML typo: saveReponseBtn | index.html:277 | Intentional — dom.js matches. Fixing would require coordinated change. |

---

## 5. Global / Window Exposure

Functions exposed on `window` for HTML `onclick` or external access:

- `window.fetchFromUrl`
- `window.openResponseSlideout`
- `window.toggleMetadataSidebar`

Index.html uses: `onclick="if(typeof fetchFromUrl==='function')fetchFromUrl();"` — relies on app.js assigning to window.

---

## 6. Cross-Module Exports Check

| Module | Exports used by other modules | Verified |
|--------|------------------------------|----------|
| notebook.js | initFileUpload, fetchFromUrl, handleNotebookLoaded, saveToDrive, populatePreviewTabs, setupSaveHandlers, saveCell, saveAllCells, validateModelReferenceAndCriteria, initPreviewTabs, etc. | ✅ |
| editors.js | initRichTextEditors, validatePromptLength, updateModelOptions, etc. | ✅ |
| hunt.js | startHunt, initHuntNumberControls, updateHuntLimitUI, etc. | ✅ |
| results.js | formatJudgeCriteriaDisplay, clearPreviousResults, warmupConnections, etc. | ✅ |
| multiturn.js | initMultiTurnListeners, initCalibrationListeners, populatePreviewTabs, etc. | ✅ |
| celebrations.js | showToast, handleHumanJudgment, showNextBlindJudge | ✅ |

---

## 7. Backend Routes (model-hunter-refactored)

- `main.py` → routes: trainer, session, notebook, hunt, calibration, multiturn, system
- Static mount: `/static` → `static/`
- All route modules import correctly from `models`, `services`, `helpers`, `storage`

---

## 8. Summary

**Status:** Audit complete. Three critical init/wiring issues fixed.

**Next steps before new features:**
1. ✅ initFileUpload, initCalibrationListeners — fixed
2. ✅ responseEditor → referencePreview — fixed
3. Manual smoke test: file upload, URL fetch, judge, hunt, multi-turn, calibration
4. Optional: remove or fix dead `saveAndJudgeResponse` if unused
