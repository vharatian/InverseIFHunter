/**
 * testbed/lifecycle.js — Reset, state-sync helpers, navbar wiring.
 */

import { state } from '../state.js';
import { parseCriteria } from '../notebook.js';
import { tbState, getSharedLeft, persistTabEdits, chipsToJson } from './store.js';
import { destroyResizer } from './layout-resize.js';
import { getTabBarEl, getTabContentEl, showTestbed } from './render-chrome.js';

/**
 * Sync the active testbed run's fields into state.notebook so that
 * startHunt() picks up the latest prompt/criteria even if the user
 * never clicked "Save Run to Turn".
 */
export function syncActiveRunToNotebook() {
    persistTabEdits();
    if (!state.notebook) state.notebook = {};
    const left = getSharedLeft();
    if (left.prompt)        state.notebook.prompt             = left.prompt;
    if (left.idealResponse) state.notebook.response           = left.idealResponse;
    if (left.modelReasoning !== undefined) state.notebook.model_reasoning = left.modelReasoning;
    if (left.criteriaChips?.length) {
        state.notebook.response_reference = chipsToJson(left.criteriaChips);
        try {
            const parsed = parseCriteria(state.notebook.response_reference);
            if (parsed?.length) {
                state.criteria = parsed;
                state.initialCriteria = parsed;
            }
        } catch { /* ignore */ }
    }
    if (left.judgePrompt)  state.notebook.judge_system_prompt = left.judgePrompt;
}

export function resetTestbed() {
    destroyResizer();
    tbState.runs                  = [];
    tbState.activeRunId           = null;
    tbState.runCounter            = 0;
    tbState.sharedLeft            = null;
    tbState.previewDismissed      = false;
    tbState.savedCurrentTurnEdits = null;
    tbState.activeTurnTabKey      = 'current';
    tbState.judgeCache            = null;
    const bar     = getTabBarEl();
    const content = getTabContentEl();
    if (bar)     bar.innerHTML     = '';
    if (content) content.innerHTML = '';
    document.getElementById('tbNotebookPreviewOverlay')?.remove();
}

/**
 * Enable the navbar Testbed button (called after Turn 1 first Save & Check).
 */
export function enableNavTestbedButton() {
    const btn = document.getElementById('navTestbedBtn');
    if (!btn) return;
    btn.disabled = false;
    btn.title = 'Open Testbed — build & test prompts in parallel tabs';
    if (!btn._testbedWired) {
        btn._testbedWired = true;
        btn.addEventListener('click', () => showTestbed());
    }
}
