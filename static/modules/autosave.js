/**
 * autosave.js — Auto-save with debounce and status indicators
 *
 * Mitigations: batch saves, retry with backoff, localStorage backup,
 * save-failed + retry, serialized saves, per-session rate limit.
 * Status: ✓ Saved | ⋯ Saving... | ○ Unsaved | ✗ Save failed
 */

import { elements } from './dom.js';
import { state } from './state.js';
import { showToast, showError } from './celebrations.js';
import { validatePromptLength } from './editors.js';
import { convertStructuredToJSON } from './editors.js';
import { updateOriginalNotebookWithCell, scheduleLiveExportUpdate } from './notebook.js';
import { fetchConfigFromAPI } from './config.js';
import { isOnline, enqueue, onStatusChange } from './offlineQueue.js';

let DEBOUNCE_MS = 800;
let MIN_SAVE_INTERVAL_MS = 2000;
let _autoSaveEnabled = true;
const RETRY_DELAYS = [1000, 2000, 4000];
const STATUS = { SAVED: 'saved', SAVING: 'saving', UNSAVED: 'unsaved', FAILED: 'failed' };
const LOCKED_STATUSES = new Set(['submitted', 'approved', 'rejected']);

const timers = {};
const statusEls = {};
let batchSaveTimer = null;
let saveInProgress = false;
let lastSaveTime = 0;
let pendingRetry = null;

const DRAFT_KEY = () => `modelhunter_draft_${state.sessionId || 'none'}`;

/**
 * Load auto_save settings from server config (called once on init).
 */
async function _loadAutoSaveConfig() {
    try {
        const cfg = await fetchConfigFromAPI();
        const as = cfg?.auto_save || {};
        if (typeof as.debounce_ms === 'number') DEBOUNCE_MS = as.debounce_ms;
        if (typeof as.min_interval_ms === 'number') MIN_SAVE_INTERVAL_MS = as.min_interval_ms;
        if (as.enabled === false) _autoSaveEnabled = false;
    } catch (_) {}
}

/**
 * Check if auto-save is paused because the task is under review / approved / rejected.
 */
function _isLocked() {
    if (!_autoSaveEnabled) return true;
    const rs = state.reviewStatus || state._reviewStatus;
    return rs && LOCKED_STATUSES.has(rs);
}

/* ---- Global header save indicator ---- */
let _globalIndicator = null;

function _ensureGlobalIndicator() {
    if (_globalIndicator) return _globalIndicator;
    const header = document.querySelector('.app-header, header, .top-bar, nav');
    if (!header) return null;
    const el = document.createElement('span');
    el.id = 'globalSaveIndicator';
    el.className = 'autosave-global autosave-global--saved';
    el.setAttribute('aria-live', 'polite');
    el.textContent = '';
    header.appendChild(el);
    _globalIndicator = el;
    return el;
}

function _setGlobalStatus(status) {
    const el = _ensureGlobalIndicator();
    if (!el) return;
    el.className = `autosave-global autosave-global--${status}`;
    const labels = {
        saved: '',
        saving: 'Saving...',
        unsaved: 'Unsaved',
        failed: 'Save failed — click to retry',
        locked: 'Edits locked',
        offline: 'Offline — queued',
    };
    el.textContent = labels[status] || '';
}

/**
 * Create or get status indicator element next to a heading container.
 */
function getOrCreateStatusEl(fieldId, container) {
    if (statusEls[fieldId]) return statusEls[fieldId];
    const el = document.createElement('span');
    el.className = 'autosave-status autosave-saved';
    el.dataset.field = fieldId;
    el.setAttribute('aria-live', 'polite');
    el.textContent = '✓ Saved';
    const heading = container?.querySelector('label, .grading-section-title, h4');
    if (heading) {
        heading.style.display = 'inline-flex';
        heading.style.alignItems = 'center';
        heading.style.gap = '0.35rem';
        heading.style.flexWrap = 'nowrap';
        heading.appendChild(el);
    }
    statusEls[fieldId] = el;
    return el;
}

function setStatus(fieldId, status, container) {
    const el = statusEls[fieldId] || (container && getOrCreateStatusEl(fieldId, container)) || document.querySelector(`[data-field="${fieldId}"]`);
    if (!el) return;
    el.className = `autosave-status autosave-${status}`;
    const texts = { saved: '✓ Saved', saving: '⋯ Saving...', unsaved: '○ Unsaved', failed: '✗ Save failed' };
    el.textContent = texts[status] || texts.unsaved;
    el.dataset.status = status;
    if (status === STATUS.FAILED) {
        el.style.cursor = 'pointer';
        el.title = 'Click to retry';
    } else {
        el.style.cursor = '';
        el.title = status === STATUS.SAVED ? 'Saved' : status === STATUS.SAVING ? 'Saving...' : 'Unsaved changes';
    }
}

/**
 * Persist draft to localStorage (backup before/after save).
 */
function saveDraftToStorage(draft) {
    try {
        localStorage.setItem(DRAFT_KEY(), JSON.stringify({ ...draft, _ts: Date.now() }));
    } catch (_) {}
}

/**
 * Fetch with retry (exponential backoff). Retries on 5xx, 429, or network errors.
 */
async function fetchWithRetry(url, options, attempt = 0) {
    let res;
    try {
        res = await fetch(url, options);
    } catch (err) {
        if (attempt < RETRY_DELAYS.length) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
            return fetchWithRetry(url, options, attempt + 1);
        }
        throw err;
    }
    if (res.ok) return res;
    const retryable = res.status >= 500 || res.status === 429;
    if (retryable && attempt < RETRY_DELAYS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        return fetchWithRetry(url, options, attempt + 1);
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Save failed');
}

/**
 * Collect current editor values and send batch save.
 */
async function performBatchSave() {
    if (!state.sessionId || saveInProgress) return;
    if (_isLocked()) { _setGlobalStatus('locked'); return; }

    const promptInput = document.getElementById('promptMarkdown');
    const responseInput = document.getElementById('responseMarkdown');
    const modelrefInput = document.getElementById('modelrefPreview');
    const judgeInput = document.getElementById('judgeMarkdown');

    let prompt = promptInput?.value ?? '';
    let response = responseInput?.value ?? '';
    let modelref = '';
    try {
        convertStructuredToJSON();
        modelref = state.convertedModelRefJSON || (modelrefInput?.value ?? '');
    } catch {
        modelref = modelrefInput?.value ?? '';
    }
    const judge = judgeInput?.value ?? '';

    if (state.currentTurn <= 1 && !state.isMultiTurn && !validatePromptLength()) return;

    const draft = { prompt, response, response_reference: modelref, judge_system_prompt: judge };
    saveDraftToStorage(draft);

    const cells = [
        { cell_type: 'prompt', content: prompt },
        { cell_type: 'response', content: response },
        { cell_type: 'response_reference', content: modelref },
        { cell_type: 'judge_system_prompt', content: judge },
    ];

    saveInProgress = true;
    _setGlobalStatus('saving');
    ['prompt', 'response', 'modelref', 'judge'].forEach((f) => setStatus(f, STATUS.SAVING, null));

    try {
        const res = await fetchWithRetry(
            `/api/update-notebook-cells/${state.sessionId}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cells, session_only: true }),
            }
        );
        if (!res.ok) throw new Error('Save failed');

        lastSaveTime = Date.now();
        _setGlobalStatus('saved');
        ['prompt', 'response', 'modelref', 'judge'].forEach((f) => setStatus(f, STATUS.SAVED, null));
        cells.forEach((c) => updateOriginalNotebookWithCell(c.cell_type, c.content));
        state.unsavedChanges = { prompt: false, response: false, modelRef: false, judge: false };
    } catch (err) {
        if (!isOnline()) {
            _setGlobalStatus('offline');
            ['prompt', 'response', 'modelref', 'judge'].forEach((f) => setStatus(f, STATUS.UNSAVED, null));
            await enqueue({
                type: 'save-cells',
                url: `/api/update-notebook-cells/${state.sessionId}`,
                options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cells, session_only: true }) },
                sessionId: state.sessionId,
            });
        } else {
            _setGlobalStatus('failed');
            ['prompt', 'response', 'modelref', 'judge'].forEach((f) => setStatus(f, STATUS.FAILED, null));
            pendingRetry = () => performBatchSave();
            showError(err, { operation: 'Auto-save', retry: () => { pendingRetry?.(); pendingRetry = null; } });
        }
    } finally {
        saveInProgress = false;
    }
}

/**
 * Schedule batch save (debounced, serialized, rate-limited).
 */
function scheduleBatchSave() {
    if (_isLocked()) return;
    ['prompt', 'response', 'modelref', 'judge'].forEach((f) => setStatus(f, STATUS.UNSAVED, null));
    _setGlobalStatus('unsaved');

    if (batchSaveTimer) clearTimeout(batchSaveTimer);

    const elapsed = Date.now() - lastSaveTime;
    const delay = Math.max(DEBOUNCE_MS, saveInProgress ? 500 : Math.max(0, MIN_SAVE_INTERVAL_MS - elapsed));

    batchSaveTimer = setTimeout(() => {
        batchSaveTimer = null;
        performBatchSave();
    }, delay);
}

/**
 * Wire retry on click when status is failed.
 */
function setupRetryOnClick() {
    document.addEventListener('click', (e) => {
        const el = e.target.closest('.autosave-status[data-status="failed"]');
        if (!el) return;
        const field = el.dataset.field;
        if (field?.startsWith('grading-') && gradingPendingRetry) {
            gradingPendingRetry();
            gradingPendingRetry = null;
        } else if (pendingRetry) {
            pendingRetry();
            pendingRetry = null;
        }
    });
}

/**
 * Wire auto-save for main notebook fields (batched).
 */
export async function initAutosave() {
    await _loadAutoSaveConfig();
    setupRetryOnClick();
    onStatusChange((online) => {
        _setGlobalStatus(online ? 'saved' : 'offline');
    });

    const promptSection = document.getElementById('previewPrompt');
    const promptInput = document.getElementById('promptMarkdown');
    const responseSection = document.getElementById('previewReference');
    const responseInput = document.getElementById('responseMarkdown');
    const modelrefSection = document.getElementById('previewModelref');
    const modelrefInput = document.getElementById('modelrefPreview');
    const judgeSection = document.getElementById('previewJudge');
    const judgeInput = document.getElementById('judgeMarkdown');

    [promptSection, responseSection, modelrefSection, judgeSection].forEach((s, i) => {
        if (s) getOrCreateStatusEl(['prompt', 'response', 'modelref', 'judge'][i], s);
    });

    const onInput = () => {
        if (state.currentTurn > 1 || state.isMultiTurn || validatePromptLength()) scheduleBatchSave();
        else setStatus('prompt', STATUS.UNSAVED, promptSection);
    };

    let liveExportTimer = null;
    const onLiveExportInput = () => {
        if (liveExportTimer) clearTimeout(liveExportTimer);
        liveExportTimer = setTimeout(() => { scheduleLiveExportUpdate(); liveExportTimer = null; }, 400);
    };
    if (promptInput) promptInput.addEventListener('input', onInput);
    if (responseInput) responseInput.addEventListener('input', () => { scheduleBatchSave(); onLiveExportInput(); });
    if (modelrefInput) modelrefInput.addEventListener('input', () => { scheduleBatchSave(); onLiveExportInput(); });
    if (judgeInput) judgeInput.addEventListener('input', () => { scheduleBatchSave(); onLiveExportInput(); });
    if (promptInput) promptInput.addEventListener('input', onLiveExportInput);
}

/**
 * Restore draft from localStorage (call when appropriate, e.g. after session load if recovering from crash).
 */
export function restoreDraftFromStorage() {
    if (!state.sessionId) return;
    try {
        const raw = localStorage.getItem(DRAFT_KEY());
        if (!raw) return;
        const draft = JSON.parse(raw);
        const promptInput = document.getElementById('promptMarkdown');
        const responseInput = document.getElementById('responseMarkdown');
        const modelrefInput = document.getElementById('modelrefPreview');
        const judgeInput = document.getElementById('judgeMarkdown');
        if (promptInput && draft.prompt != null) promptInput.value = draft.prompt;
        if (responseInput && draft.response != null) responseInput.value = draft.response;
        if (modelrefInput && draft.response_reference != null) modelrefInput.value = draft.response_reference;
        if (judgeInput && draft.judge_system_prompt != null) judgeInput.value = draft.judge_system_prompt;
    } catch (_) {}
}

/**
 * Wire auto-save for next turn editor (Turn 2+).
 * Saves draft to session via advance-turn draft endpoint or localStorage.
 * For now we use localStorage - no backend draft endpoint.
 */
export function initNextTurnAutosave() {
    const nextPrompt = document.getElementById('nextTurnPrompt');
    const nextCriteria = document.getElementById('nextTurnCriteria');
    const nextJudge = document.getElementById('nextTurnJudgePrompt');

    const getDraftKey = () => `modelhunter_next_turn_draft_${state.sessionId || 'none'}`;

    [nextPrompt, nextCriteria, nextJudge].forEach((el, i) => {
        if (!el) return;
        const keys = ['prompt', 'criteria', 'judge'];
        const fieldId = `nextTurn${keys[i].charAt(0).toUpperCase() + keys[i].slice(1)}`;
        const container = el.closest('.form-group') || el.parentElement;
        getOrCreateStatusEl(fieldId, container);

        const saveDraft = () => {
            try {
                const key = getDraftKey();
                const draft = JSON.parse(localStorage.getItem(key) || '{}');
                draft[keys[i]] = el.value;
                localStorage.setItem(key, JSON.stringify(draft));
                setStatus(fieldId, STATUS.SAVED, container);
            } catch (_) {}
        };

        el.addEventListener('input', () => {
            setStatus(fieldId, STATUS.UNSAVED, container);
            clearTimeout(timers[fieldId]);
            timers[fieldId] = setTimeout(() => saveDraft(), DEBOUNCE_MS);
        });
    });

    // Restore draft on load
    try {
        const draft = JSON.parse(localStorage.getItem(getDraftKey()) || '{}');
        if (nextPrompt && draft.prompt) nextPrompt.value = draft.prompt;
        if (nextCriteria && draft.criteria) nextCriteria.value = draft.criteria;
        if (nextJudge && draft.judge) nextJudge.value = draft.judge;
    } catch (_) {}
}

/**
 * Clear next turn draft when hunt starts.
 */
export function clearNextTurnDraft() {
    if (state.sessionId) {
        localStorage.removeItem(`modelhunter_next_turn_draft_${state.sessionId}`);
    }
}

/**
 * Wire auto-save for human grading slideout.
 * Saves draft to session via save-reviews (submitted: false).
 */
export function initGradingAutosave() {
    // Grading slideout is dynamically rendered - we use event delegation
    document.addEventListener('input', (e) => {
        const notes = e.target.closest('.grading-notes-textarea');
        if (notes && state.sessionId) {
            const huntId = notes.dataset.huntId;
            if (!huntId) return;
            scheduleGradingSave(huntId);
        }
    });

    document.addEventListener('click', (e) => {
        if (e.target.closest('.grading-btn-pass, .grading-btn-fail') && state.sessionId) {
            const btn = e.target.closest('.grading-btn-pass, .grading-btn-fail');
            const huntId = btn?.dataset.huntId;
            if (huntId) scheduleGradingSave(huntId);
        }
    });
}

let gradingSaveTimer = null;
let gradingSaveInProgress = false;
let gradingPendingRetry = null;

function scheduleGradingSave(huntId) {
    if (gradingSaveTimer) clearTimeout(gradingSaveTimer);
    setStatus(`grading-${huntId}`, STATUS.UNSAVED);
    gradingSaveTimer = setTimeout(() => saveGradingDraft(huntId), DEBOUNCE_MS);
}

function getGradingDraftKey(huntId) {
    return `modelhunter_grading_draft_${state.sessionId || 'none'}_${huntId}`;
}

async function saveGradingDraft(huntId) {
    if (!state.sessionId || gradingSaveInProgress) return;
    if (_isLocked()) { _setGlobalStatus('locked'); return; }
    const body = document.getElementById('gradingSlideoutBody');
    if (!body) return;

    const grades = {};
    const criteriaList = body.querySelector(`.grading-criteria-list[data-hunt-id="${huntId}"]`);
    if (criteriaList) {
        criteriaList.querySelectorAll('.grading-criterion').forEach((row) => {
            const id = row.dataset.criterionId || row.querySelector('[data-criterion]')?.dataset.criterion;
            const passBtn = row.querySelector('.grading-btn-pass.active');
            if (id) grades[id] = passBtn ? 'PASS' : 'FAIL';
        });
    }

    const notesEl = body.querySelector(`.grading-notes-textarea[data-hunt-id="${huntId}"]`);
    const notes = notesEl?.value || '';

    const allPass = Object.keys(grades).length > 0 && Object.values(grades).every((g) => g === 'PASS');
    const judgment = allPass ? 1 : 0;

    const existing = state.humanReviews || {};
    const review = {
        ...(existing[huntId] || existing[`row_${huntId}`] || {}),
        hunt_id: parseInt(huntId, 10),
        judgment,
        grading_basis: grades,
        explanation: notes,
        submitted: false,
    };

    const reviews = { ...existing, [huntId]: review };
    const fieldId = `grading-${huntId}`;

    try {
        localStorage.setItem(getGradingDraftKey(huntId), JSON.stringify({ review, _ts: Date.now() }));
    } catch (_) {}

    gradingSaveInProgress = true;
    _setGlobalStatus('saving');
    setStatus(fieldId, STATUS.SAVING);

    try {
        const res = await fetchWithRetry(
            `/api/save-reviews/${state.sessionId}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reviews, auto_save: true }),
            }
        );
        if (!res.ok) throw new Error('Save failed');
        state.humanReviews = reviews;
        _setGlobalStatus('saved');
        setStatus(fieldId, STATUS.SAVED);
    } catch (err) {
        if (!isOnline()) {
            _setGlobalStatus('offline');
            setStatus(fieldId, STATUS.UNSAVED);
            await enqueue({
                type: 'save-reviews',
                url: `/api/save-reviews/${state.sessionId}`,
                options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviews, auto_save: true }) },
                sessionId: state.sessionId,
            });
        } else {
            _setGlobalStatus('failed');
            setStatus(fieldId, STATUS.FAILED);
            gradingPendingRetry = () => saveGradingDraft(huntId);
            showError(err, { operation: 'Auto-save grading', retry: () => { gradingPendingRetry?.(); gradingPendingRetry = null; } });
        }
    } finally {
        gradingSaveInProgress = false;
    }
}

/**
 * Reset all status indicators to saved (e.g. after manual Save All).
 */
/**
 * Update the review status tracked by autosave (called from reviewSync when status changes).
 */
export function setReviewStatus(status) {
    state._reviewStatus = status;
    if (LOCKED_STATUSES.has(status)) _setGlobalStatus('locked');
}

export function resetAllStatuses() {
    pendingRetry = null;
    gradingPendingRetry = null;
    Object.keys(statusEls).forEach((id) => {
        setStatus(id, STATUS.SAVED, null);
    });
    document.querySelectorAll('.autosave-status[data-status="failed"]').forEach((el) => {
        el.className = 'autosave-status autosave-saved';
        el.textContent = '✓ Saved';
        el.dataset.status = STATUS.SAVED;
        el.style.cursor = '';
        el.title = 'Saved';
    });
}
