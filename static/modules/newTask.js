/**
 * New-task flow and daily submission counter.
 *
 * `startNewTask()` — full client-side reset to prepare for a fresh Colab URL.
 * Shared by the queue's "+ New Task" button and the post-submit button morph
 * (see submit-colab.js). Keeping it in one place avoids reset-logic drift.
 *
 * `incrementTasksToday()` / `getTasksToday()` — localStorage-backed counter
 * ("X completed today"). Backend queue summary doesn't expose submit
 * timestamps, so we track per-browser. Resets automatically on date change.
 */

import { elements } from './dom.js?v=43';
import { state, resetTurnState } from './state.js?v=43';
import { resetTestbed, hideTestbed } from './testbed.js?v=43';
import { showTaskView } from './trainerQueue.js?v=43';
import { clearSectionLocks } from './sessionHydrator.js?v=43';
import { resetAllStatuses } from './autosave.js?v=43';

// ── Today counter ──────────────────────────────────────────────

const TASKS_TODAY_KEY = 'mh_tasks_today';
const TODAY_ELEMENT_ID = 'taskDoneToday';

function _todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _readTasksToday() {
    try {
        const raw = localStorage.getItem(TASKS_TODAY_KEY);
        if (!raw) return { date: _todayStr(), count: 0 };
        const parsed = JSON.parse(raw);
        if (parsed?.date !== _todayStr()) return { date: _todayStr(), count: 0 };
        return { date: parsed.date, count: Number(parsed.count) || 0 };
    } catch {
        return { date: _todayStr(), count: 0 };
    }
}

function _writeTasksToday(rec) {
    try { localStorage.setItem(TASKS_TODAY_KEY, JSON.stringify(rec)); } catch { /* quota */ }
}

export function getTasksToday() {
    return _readTasksToday().count;
}

export function incrementTasksToday() {
    const rec = _readTasksToday();
    rec.count += 1;
    _writeTasksToday(rec);
    refreshTasksTodayUI();
    return rec.count;
}

export function refreshTasksTodayUI() {
    const el = document.getElementById(TODAY_ELEMENT_ID);
    if (!el) return;
    const count = getTasksToday();
    el.querySelector('.task-done-today-count').textContent = String(count);
    el.querySelector('.task-done-today-label').textContent =
        `task${count === 1 ? '' : 's'} done today`;
}

// ── Start new task ─────────────────────────────────────────────

/**
 * Reset all client-side task state and return the trainer to a blank
 * "paste a Colab URL" task view. Kept identical to the previous inline
 * implementation in app.js so existing behaviour is preserved.
 */
export function startNewTask() {
    showTaskView();

    // ── Clear session identity ──
    state.sessionId = null;
    state.notebook = null;
    state.notebookId = null;
    state.metadata = null;
    state.metadataModel = null;
    state.criteria = null;
    state.initialCriteria = null;
    state.referenceValidated = false;
    state.originalNotebookJson = null;
    state.isHunting = false;
    state.huntLimitReached = false;
    state.totalHuntsCount = 0;
    state.reviewFeedback = null;
    state.adminMode = false;
    localStorage.removeItem('modelHunter_sessionId');

    // ── Reset multi-turn state ──
    state.currentTurn = 1;
    state.isMultiTurn = false;
    state.conversationHistory = [];
    state.turns = [];
    state.multiTurnTotalHunts = 0;
    state.previousTurnHuntIds = new Set();
    resetTurnState();

    // ── Hide multi-turn UI ──
    const journeyBar = document.getElementById('turnJourneyBar');
    if (journeyBar) journeyBar.classList.remove('visible');
    const container = document.getElementById('mainContainer');
    if (container) container.classList.remove('multi-turn-layout');

    // ── Hide all task sections except upload ──
    elements.configSection?.classList.add('hidden');
    elements.progressSection?.classList.add('hidden');
    elements.resultsSection?.classList.add('hidden');
    elements.summarySection?.classList.add('hidden');
    elements.multiTurnSection?.classList.add('hidden');
    elements.selectionSection?.classList.add('hidden');
    document.getElementById('multiTurnDecisionCard')?.classList.add('hidden');
    document.getElementById('goodResponsePicker')?.classList.add('hidden');

    // ── Show upload section, expanded ──
    const uploadSection = elements.uploadSection;
    if (uploadSection) uploadSection.classList.remove('hidden');
    const uploadBody = document.getElementById('uploadBody');
    const uploadChevron = document.getElementById('uploadChevron');
    const uploadHeaderText = document.getElementById('uploadHeaderText');
    if (uploadBody) uploadBody.classList.remove('collapsed');
    if (uploadChevron) uploadChevron.classList.remove('collapsed');
    if (uploadHeaderText) uploadHeaderText.textContent = 'Load Notebook';

    // ── Reset testbed ──
    resetTestbed();
    hideTestbed();

    // Submit-to-Colab button is reset by showTaskView() above (single source
    // of truth for un-morphing the post-submit "+ New Task" button).

    // ── Clear input and focus ──
    const urlInput = document.getElementById('colabUrlInput');
    if (urlInput) { urlInput.value = ''; urlInput.focus(); }

    clearSectionLocks();
    resetAllStatuses();
}
