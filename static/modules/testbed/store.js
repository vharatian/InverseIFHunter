/**
 * testbed/store.js — mutable module state + pure utilities for the testbed.
 * All cross-module mutations go through the `tbState` object.
 */

import { state } from '../state.js';
import { getJudgeModels } from '../config.js';
import { parseCriteria } from '../notebook.js';
import { DEFAULT_JUDGE_SYSTEM_PROMPT } from './constants.js';

/**
 * Shared mutable state for the testbed subsystem.
 * Consumers read and write fields directly on this object.
 */
export const tbState = {
    /** @type {Run[]} */
    runs: [],
    activeRunId: null,
    runCounter: 0,
    /** @type {{prompt, idealResponse, modelReasoning, criteriaChips, judgePrompt} | null} */
    sharedLeft: null,
    /** Cached current-turn edits — saved when switching to a previous turn tab, restored on switch back. */
    savedCurrentTurnEdits: null,
    /** Tracks which turn-picker tab is currently active ('current' or a turn number string). */
    activeTurnTabKey: 'current',
    /** Judge-result cache: { key, isPassing, idealResponse, judgeData, criteriaEvents, judgeModelName } */
    judgeCache: null,
    /** Once user hits "Continue to Hunt", skip preview on subsequent shows */
    previewDismissed: false,
    /** Resizer teardown function */
    resizerCleanup: null,
};

/**
 * Shared left-panel state — same for ALL runs.
 */
export function getSharedLeft() {
    if (!tbState.sharedLeft) {
        const nb = state.notebook || {};
        tbState.sharedLeft = {
            prompt:        nb.prompt ?? '',
            idealResponse: nb.response ?? '',
            modelReasoning: nb.model_reasoning ?? '',
            criteriaChips: criteriaStringToChips(nb.response_reference ?? ''),
            judgePrompt:   nb.judge_system_prompt || DEFAULT_JUDGE_SYSTEM_PROMPT,
        };
    }
    return tbState.sharedLeft;
}

export function getActiveRun() {
    return tbState.runs.find(r => r.id === tbState.activeRunId) || null;
}

/** Parse raw criteria string into array of description strings (for chip UI). */
export function criteriaStringToChips(raw) {
    if (!raw || !raw.trim()) return [];
    try {
        const criteria = parseCriteria(raw);
        return criteria.map(c => (c.criteria != null ? String(c.criteria).trim() : ''));
    } catch {
        return raw.split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(l => l.replace(/^C\d+:\s*/i, '').trim())
            .filter(Boolean);
    }
}

export function chipsToString(chips) {
    return chips.map((c, i) => `C${i + 1}: ${c}`).join('\n');
}

/** Convert criteria chips to JSON array format for Colab/backend. */
export function chipsToJson(chips) {
    if (!chips || chips.length === 0) return '';
    const arr = chips.map((c, i) => ({
        id: `C${i + 1}`,
        [`criteria${i + 1}`]: String(c).trim()
    }));
    return JSON.stringify(arr, null, 2);
}

export function makeRun(overrides = {}) {
    const providerEl = document.getElementById('providerSelect');
    const modelEl    = document.getElementById('modelSelect');
    const src = getActiveRun();

    tbState.runCounter++;
    return {
        id:              `run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        number:          tbState.runCounter,
        model:           src?.model    ?? modelEl?.value  ?? 'qwen/qwen3-235b-a22b-thinking-2507',
        judgeModel:      src?.judgeModel ?? getJudgeModels()[0]?.id ?? 'openai/gpt-5.2',
        provider:        src?.provider ?? providerEl?.value ?? 'openrouter',
        status:           'idle',
        response:         '',
        responseEditing:  false,
        reasoningTrace:   '',
        reasoningEditing: false,
        errorMessage:     null,
        judgeResult:      null,
        score:            null,
        maxScore:         null,
        ...overrides,
    };
}

/** Flush live edits of the shared left panel back into sharedLeft */
export function persistTabEdits() {
    const left = getSharedLeft();
    const promptEl    = document.getElementById('tbSharedPrompt');
    const idealEl     = document.getElementById('tbSharedIdeal');
    const reasoningEl = document.getElementById('tbSharedReasoning');
    const judgeEl     = document.getElementById('tbSharedJudge');
    if (promptEl)    left.prompt         = promptEl.value;
    if (idealEl)     left.idealResponse  = idealEl.value;
    if (reasoningEl) left.modelReasoning = reasoningEl.value;
    if (judgeEl)     left.judgePrompt    = judgeEl.value;
}

export function judgeContentKey(left) {
    const run = getActiveRun();
    const judgeModelId = run?.judgeModel || '';
    return [
        (left.prompt || '').trim(),
        (left.idealResponse || '').trim(),
        chipsToJson(left.criteriaChips || []) || chipsToString(left.criteriaChips || []),
        (left.judgePrompt || '').trim(),
        judgeModelId,
    ].join('\x00');
}

export function getJudgeModelName() {
    const run = getActiveRun();
    const id  = run?.judgeModel || '';
    return getJudgeModels().find(m => m.id === id)?.name || id;
}

/**
 * Parse judge explanation to extract per-criterion (id, status, explanation).
 * Backend format: "[PASS] C1 (PASS): reason" or "[FAIL] C2 (FAIL): reason" or "[MISSING] C3 (MISSING): reason"
 */
export function parseJudgeExplanation(explanation, criteria) {
    const byId = {};
    const lines = (explanation || '').split('\n');
    const lineRe = /\[(PASS|FAIL|MISSING)\]\s+(C\d+)\s+\((PASS|FAIL|MISSING)\):\s*(.*)/i;
    for (const line of lines) {
        const m = line.match(lineRe);
        if (m) {
            byId[m[2]] = { id: m[2], status: m[3].toUpperCase(), explanation: m[4].trim() };
        }
    }
    for (const [id, val] of Object.entries(criteria || {})) {
        if (!byId[id]) {
            const status = String(val).toUpperCase();
            byId[id] = { id, status, explanation: status === 'MISSING' ? '(Not evaluated)' : '' };
        }
    }
    return Object.values(byId).sort((a, b) => {
        const aNum = parseInt(a.id.match(/C(\d+)/)?.[1] || '0');
        const bNum = parseInt(b.id.match(/C(\d+)/)?.[1] || '0');
        return aNum - bNum;
    });
}
