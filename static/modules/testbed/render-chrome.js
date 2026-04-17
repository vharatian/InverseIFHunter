/**
 * testbed/render-chrome.js — Show/hide, tab bar rendering, run lifecycle (add/switch/close).
 */

import { tbState, makeRun, persistTabEdits, getActiveRun } from './store.js';
import { renderActiveTab } from './render-active-tab.js';
import { applySavedSplit, destroyResizer } from './layout-resize.js';
import { renderTurnPicker } from './turn-context.js';
import { renderSaveFooter } from './save-turn.js';
import { confirmCloseRun } from './modals.js';

export function getTestbedEl()    { return document.getElementById('testbedSection'); }
export function getTabBarEl()     { return document.getElementById('testbedTabBar'); }
export function getTabContentEl() { return document.getElementById('testbedTabContent'); }

export function showTestbed() {
    const el = getTestbedEl();
    if (!el) return;
    el.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (tbState.runs.length === 0) {
        addRun();
    } else {
        renderTabBar();
        renderActiveTab();
    }
    renderTurnPicker();
    renderSaveFooter();
    requestAnimationFrame(applySavedSplit);
}

export function hideTestbed() {
    const el = getTestbedEl();
    if (el) el.classList.add('hidden');
    document.body.style.overflow = '';
    destroyResizer();
}

export function addRun() {
    const run = makeRun();
    tbState.runs.push(run);
    tbState.activeRunId = run.id;
    renderTabBar();
    renderActiveTab();
    requestAnimationFrame(applySavedSplit);
    return run;
}

export function switchToRun(id) {
    persistTabEdits();
    tbState.activeRunId = id;
    renderTabBar();
    renderActiveTab();
    requestAnimationFrame(applySavedSplit);
}

export function closeRun(id) {
    persistTabEdits();
    const idx = tbState.runs.findIndex(r => r.id === id);
    if (idx === -1) return;
    if (tbState.runs[idx].number === 1) return;
    tbState.runs.splice(idx, 1);
    if (tbState.runs.length === 0) {
        tbState.runCounter = 0;
        addRun();
    } else {
        tbState.activeRunId = tbState.runs[Math.min(idx, tbState.runs.length - 1)].id;
        renderTabBar();
        renderActiveTab();
        requestAnimationFrame(applySavedSplit);
    }
}

export function statusIcon(status) {
    switch (status) {
        case 'generating': return `<span class="tb-status-icon tb-spin"  title="Generating...">...</span>`;
        case 'judging':    return `<span class="tb-status-icon tb-pulse" title="Judging...">...</span>`;
        case 'done':
        case 'judged':     return `<span class="tb-status-icon" style="color:var(--success)" title="Done">✓</span>`;
        case 'error':      return `<span class="tb-status-icon tb-error" title="Error">✗</span>`;
        default:           return `<span class="tb-status-icon tb-idle"  title="Idle">·</span>`;
    }
}

export function scoreLabel(run) {
    if (run.score === null || run.score === undefined) return '';
    const max = run.maxScore ?? '?';
    const pct = run.maxScore ? Math.round((run.score / run.maxScore) * 100) : null;
    const cls = pct === null ? '' : pct === 100 ? 'tb-score-perfect' : pct >= 60 ? 'tb-score-ok' : 'tb-score-bad';
    return `<span class="tb-score-badge ${cls}">${run.score}/${max}</span>`;
}

export function modelShortName(run) {
    const m = run.model || '';
    if (m.includes('nemotron'))          return 'Nemotron';
    if (m.includes('qwen3-235'))         return 'Qwen3-235B';
    if (m.includes('claude-opus-4.6'))   return 'Opus 4.6';
    if (m.includes('claude-opus-4.5'))   return 'Opus 4.5';
    if (m.includes('claude-sonnet-4.5')) return 'Sonnet 4.5';
    if (m.includes('claude'))            return 'Claude';
    if (m.includes('gpt'))               return 'GPT';
    const parts = m.split('/');
    const last  = parts[parts.length - 1];
    return last.length > 16 ? last.slice(0, 16) + '…' : last;
}

export function renderTabBar() {
    const bar = getTabBarEl();
    if (!bar) return;

    const tabs = tbState.runs.map(run => {
        const active = run.id === tbState.activeRunId;
        const showClose = run.number > 1;
        return `<button
            class="tb-tab ${active ? 'tb-tab-active' : ''} tb-status-${run.status}"
            data-run-id="${run.id}"
            title="Run ${run.number} — ${modelShortName(run)}"
        >
            ${statusIcon(run.status)}
            <span class="tb-tab-label">Run ${run.number}</span>
            <span class="tb-tab-model">${modelShortName(run)}</span>
            ${scoreLabel(run)}
            ${showClose ? `<button class="tb-tab-close" data-close-run-id="${run.id}" title="Close this run">✕</button>` : ''}
        </button>`;
    }).join('');

    bar.innerHTML = tabs + `<button class="tb-add-tab" id="testbedAddRunBtn" title="New run — inherits current edits">+ New Run</button>`;

    bar.querySelectorAll('.tb-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (e.target.closest('.tb-tab-close')) return;
            switchToRun(btn.dataset.runId);
        });
    });

    bar.querySelectorAll('.tb-tab-close').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const run = tbState.runs.find(r => r.id === btn.dataset.closeRunId);
            if (run) confirmCloseRun(run);
        });
    });

    document.getElementById('testbedAddRunBtn')?.addEventListener('click', () => {
        persistTabEdits();
        addRun();
    });
}
