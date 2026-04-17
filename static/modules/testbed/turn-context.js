/**
 * testbed/turn-context.js — Turn-picker strip and load-turn-context-into-run.
 */

import { state } from '../state.js';
import { showToast } from '../celebrations.js?v=43';
import { tbState, getActiveRun, getSharedLeft, persistTabEdits, chipsToJson, criteriaStringToChips } from './store.js';
import { DEFAULT_JUDGE_SYSTEM_PROMPT } from './constants.js';
import { renderActiveTab } from './render-active-tab.js';
import { applySavedSplit } from './layout-resize.js';

/**
 * Render the turn-picker strip in the testbed header.
 * Shows one tab per completed turn plus a "Current" tab.
 */
export function renderTurnPicker() {
    const picker = document.getElementById('testbedTurnPicker');
    const tabsEl  = document.getElementById('testbedTurnPickerTabs');
    const hintEl  = document.getElementById('testbedTurnPickerHint');
    if (!picker || !tabsEl) return;

    const turns = state.turns || [];
    if (turns.length === 0) {
        picker.classList.add('hidden');
        return;
    }
    picker.classList.remove('hidden');

    const currentLabel = `Turn ${state.currentTurn} (current)`;

    const tabHtml = turns.map(t => {
        const n = t.turnNumber ?? t.turn_number ?? '?';
        return `<button class="tb-turn-tab" data-turn="${n}" title="Load Turn ${n} context into the active run">Turn ${n}</button>`;
    }).join('') + `<button class="tb-turn-tab tb-turn-tab-current tb-turn-tab-active" data-turn="current" title="Load current turn's context">${currentLabel}</button>`;

    tabsEl.innerHTML = tabHtml;
    tbState.activeTurnTabKey = 'current';
    if (hintEl) hintEl.textContent = 'Loads prompt, criteria, and judge prompt into the active run';

    tabsEl.querySelectorAll('.tb-turn-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            tabsEl.querySelectorAll('.tb-turn-tab').forEach(b => b.classList.remove('tb-turn-tab-active'));
            btn.classList.add('tb-turn-tab-active');
            loadTurnContextIntoRun(btn.dataset.turn);
        });
    });
}

/**
 * Load a turn's prompt / criteria / judge prompt into the currently active run.
 * @param {string|number} turnKey — turn number (1-based) or 'current'
 */
export function loadTurnContextIntoRun(turnKey) {
    const run = getActiveRun();
    if (!run) return;

    persistTabEdits();
    const left = getSharedLeft();

    let prompt = '', idealResponse = '', modelReasoning = '', criteria = '', judgePrompt = '';

    if (turnKey === 'current') {
        if (tbState.savedCurrentTurnEdits) {
            prompt         = tbState.savedCurrentTurnEdits.prompt;
            idealResponse  = tbState.savedCurrentTurnEdits.idealResponse;
            modelReasoning = tbState.savedCurrentTurnEdits.modelReasoning;
            criteria       = tbState.savedCurrentTurnEdits.criteria;
            judgePrompt    = tbState.savedCurrentTurnEdits.judgePrompt;
            tbState.savedCurrentTurnEdits = null;
        } else {
            prompt         = state.notebook?.prompt || '';
            idealResponse  = state.notebook?.response || '';
            modelReasoning = state.notebook?.model_reasoning || '';
            criteria       = state.notebook?.response_reference || '';
            judgePrompt    = state.notebook?.judge_system_prompt || '';
        }
    } else {
        if (tbState.activeTurnTabKey === 'current') {
            const chipsStr = left.criteriaChips?.length
                ? chipsToJson(left.criteriaChips)
                : '';
            tbState.savedCurrentTurnEdits = {
                prompt:         left.prompt || '',
                idealResponse:  left.idealResponse || '',
                modelReasoning: left.modelReasoning || '',
                criteria:       chipsStr,
                judgePrompt:    left.judgePrompt || '',
            };
        }

        const n    = parseInt(turnKey, 10);
        const turn = (state.turns || []).find(t => (t.turnNumber ?? t.turn_number) === n);
        if (!turn) return;
        prompt          = turn.prompt      || '';
        idealResponse   = turn.response || turn.selectedResponse || turn.selected_response || '';
        modelReasoning  = turn.model_reasoning || '';
        criteria        = typeof turn.response_reference === 'string'
            ? turn.response_reference
            : (turn.response_reference ? JSON.stringify(turn.response_reference, null, 2) : '');
        judgePrompt     = turn.judgePrompt || turn.judge_system_prompt || '';
    }

    left.prompt          = prompt;
    left.idealResponse   = idealResponse;
    left.modelReasoning  = modelReasoning;
    left.judgePrompt     = judgePrompt || DEFAULT_JUDGE_SYSTEM_PROMPT;
    left.criteriaChips   = criteriaStringToChips(criteria);

    tbState.activeTurnTabKey = String(turnKey);

    renderActiveTab();
    requestAnimationFrame(applySavedSplit);
    showToast(`Loaded ${turnKey === 'current' ? 'current' : `Turn ${turnKey}`} context`, 'success');
}
