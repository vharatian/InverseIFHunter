/**
 * testbed/modals.js — Modal dialogs used throughout the testbed:
 *   - JSP-changed warning
 *   - Save-validation (missing fields / errors)
 *   - Close-tab confirmation
 *   - Save-preview result modal (legacy non-streaming)
 *   - Streaming save-preview modal (header / criterion rows / finalization)
 *   - Cached judge result modal
 */

import { state } from '../state.js';
import { escapeHtml } from '../utils.js';
import { showToast } from '../celebrations.js?v=43';
import { adminBypass } from '../config.js';
import { parseCriteriaToJSON } from '../utils.js';
import { progressiveSaveToColab } from '../notebook.js';
import { tbState, getActiveRun } from './store.js';
import { closeRun } from './render-chrome.js';
import { parseJudgeExplanation } from './store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Progressive save helpers (used by save-preview modal Continue handler)
// ─────────────────────────────────────────────────────────────────────────────

function getPreviousTurnJsp(currentTurn) {
    if (!state.turns || state.turns.length === 0) return '';
    const prevTurn = state.turns.find(t =>
        (t.turnNumber || t.turn_number) === currentTurn - 1
    );
    return prevTurn?.judge_system_prompt || prevTurn?.judgeSystemPrompt || state.turns[state.turns.length - 1]?.judge_system_prompt || '';
}

export function getPreviousTurnJspForTurn(turnNum) {
    return getPreviousTurnJsp(turnNum);
}

function showJspChangeWarning(turnNum) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:var(--bg-secondary,#1e1e2e);border-radius:12px;padding:1.5rem 2rem;max-width:440px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);border:1px solid var(--border,#333);">
                <div style="font-size:1.5rem;text-align:center;margin-bottom:0.75rem;">&#9888;&#65039;</div>
                <div style="font-weight:700;font-size:1.05rem;text-align:center;margin-bottom:0.75rem;color:var(--warning,#f59e0b);">
                    Judge System Prompt Changed
                </div>
                <div style="font-size:0.9rem;color:var(--text-secondary,#a0a0b0);text-align:center;margin-bottom:1.25rem;line-height:1.5;">
                    The Judge System Prompt for <strong>Turn ${turnNum}</strong> differs from the previous turn.<br>
                    Do you want to save the new version to Colab?
                </div>
                <div style="display:flex;gap:0.75rem;justify-content:center;">
                    <button id="jspWarnNo" style="padding:0.5rem 1.25rem;border-radius:8px;border:1px solid var(--border,#444);background:transparent;color:var(--text-primary,#e0e0e0);cursor:pointer;font-weight:600;">Skip (use previous)</button>
                    <button id="jspWarnYes" style="padding:0.5rem 1.25rem;border-radius:8px;border:none;background:var(--warning,#f59e0b);color:#000;cursor:pointer;font-weight:600;">Save new JSP</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#jspWarnYes').addEventListener('click', () => { overlay.remove(); resolve(true); });
        overlay.querySelector('#jspWarnNo').addEventListener('click', () => { overlay.remove(); resolve(false); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    });
}

/**
 * Build and fire a progressive save for the current turn's content:
 * prompt, ideal response, criteria, and (conditionally) judge system prompt.
 */
export async function progressiveSaveTurnContent() {
    const turnNum = state.currentTurn || 1;
    const prompt      = state.notebook?.prompt || '';
    const ideal       = state.notebook?.response || '';
    const rawCriteria = state.notebook?.response_reference || '';
    const jsp         = state.notebook?.judge_system_prompt || '';

    const criteria = parseCriteriaToJSON(rawCriteria);

    const cells = [];
    if (prompt)   cells.push({ heading: `Turn-${turnNum}: Prompt`,         content: prompt });
    if (ideal)    cells.push({ heading: `Turn-${turnNum}: Ideal Response`, content: ideal });
    if (criteria) cells.push({ heading: `Turn-${turnNum}: Criteria`,       content: criteria });

    let shouldSaveJsp = false;
    if (turnNum <= 1) {
        shouldSaveJsp = !!jsp;
    } else {
        const prevJsp = getPreviousTurnJsp(turnNum);
        if (jsp && jsp.trim() !== (prevJsp || '').trim()) {
            shouldSaveJsp = await showJspChangeWarning(turnNum);
        }
    }
    if (shouldSaveJsp && jsp) {
        cells.push({ heading: `Turn-${turnNum}: Judge System Prompt`, content: jsp });
    }

    if (cells.length === 0) return;

    try {
        const result = await progressiveSaveToColab(cells);
        if (result.success) {
            showToast(`Turn ${turnNum} content saved to Colab`, 'success');
        } else {
            console.warn('Progressive save failed:', result.message);
            showToast(`Could not save Turn ${turnNum} to Colab: ${result.message}`, 'warning');
        }
    } catch (e) {
        console.error('Progressive save error:', e);
        showToast(`Error saving Turn ${turnNum} to Colab`, 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation / close-tab modals
// ─────────────────────────────────────────────────────────────────────────────

export function showSaveValidationModal(opts) {
    const overlay = document.createElement('div');
    overlay.className = 'tb-confirm-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-labelledby', 'tb-validation-title');
    const icon = opts.type === 'error' ? '!' : opts.type === 'criteria_fail' ? '!' : '!';
    overlay.innerHTML = `
        <div class="tb-confirm-box" style="max-width: 480px;">
            <div class="tb-confirm-icon">${icon}</div>
            <div class="tb-confirm-title" id="tb-validation-title">${escapeHtml(opts.title)}</div>
            <div class="tb-confirm-msg" style="text-align: left;">
                ${opts.message}
                ${opts.details ? `<div style="margin-top: 1rem; padding: 0.75rem; background: var(--bg-primary); border-radius: 8px; font-size: 0.85rem; white-space: pre-wrap;">${escapeHtml(opts.details)}</div>` : ''}
            </div>
            <div class="tb-confirm-actions">
                <button class="tb-confirm-cancel tb-validation-ok">OK</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.tb-validation-ok').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

export function confirmCloseRun(run) {
    const overlay = document.createElement('div');
    overlay.className = 'tb-confirm-overlay';
    overlay.innerHTML = `
        <div class="tb-confirm-box">
            <div class="tb-confirm-icon">!</div>
            <div class="tb-confirm-title">Close Run ${run.number}?</div>
            <div class="tb-confirm-msg">
                Once closed, <strong>Run ${run.number}</strong> and all its generated content
                will be permanently gone. This cannot be undone.
            </div>
            <div class="tb-confirm-actions">
                <button class="tb-confirm-cancel">Keep it</button>
                <button class="tb-confirm-delete">Yes, close it</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.tb-confirm-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.tb-confirm-delete').addEventListener('click', () => {
        overlay.remove();
        closeRun(run.id);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy save-preview result modal (non-streaming)
// ─────────────────────────────────────────────────────────────────────────────

export function showSavePreviewModal(opts) {
    const { idealResponse, judgeData, isPassing } = opts;
    const criteria = judgeData?.criteria || {};
    const explanation = judgeData?.explanation || '';
    const parsed = parseJudgeExplanation(explanation, criteria);

    const criteriaHtml = parsed.map(({ id, status, explanation: expl }) => {
        const isPass = status === 'PASS';
        const isMissing = status === 'MISSING';
        const icon = isMissing ? '[MISSING]' : isPass ? '[PASS]' : '[FAIL]';
        const statusColor = isMissing ? 'var(--warning)' : isPass ? 'var(--success)' : 'var(--danger)';
        return `
            <div style="margin-bottom: 0.75rem; padding: 0.75rem; background: var(--bg-primary); border-radius: 8px; border-left: 4px solid ${statusColor};">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
                    <span style="font-weight: 700;">${icon} ${id}</span>
                    <span style="color: ${statusColor}; font-weight: 600;">${status}</span>
                </div>
                ${expl ? `<div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 0.35rem; line-height: 1.5;">${escapeHtml(expl)}</div>` : ''}
            </div>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'tb-confirm-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('role', 'dialog');
    overlay.innerHTML = `
        <div class="tb-confirm-box" style="max-width: 640px; max-height: 90vh; display: flex; flex-direction: column;">
            <div class="tb-confirm-title" style="margin-bottom: 0.5rem;">
                ${isPassing ? 'Ideal Response Verified' : 'Criteria Not Passed'}
            </div>
            <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem;">
                <div>
                    <label style="font-weight: 600; font-size: 0.9rem; display: block; margin-bottom: 0.5rem;">Ideal Response</label>
                    <div style="max-height: 400px; overflow-y: auto; padding: 0.75rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid var(--border); font-size: 0.9rem; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(idealResponse || '(empty)')}</div>
                </div>
                <div>
                    <label style="font-weight: 600; font-size: 0.9rem; display: block; margin-bottom: 0.5rem;">Judge Results</label>
                    ${criteriaHtml || '<div style="color: var(--text-muted);">No criteria breakdown</div>'}
                </div>
            </div>
            <div class="tb-confirm-actions" style="margin-top: 1rem;">
                ${isPassing
                    ? '<button class="tb-confirm-delete" id="spmContinueBtn">Continue to Hunt</button>'
                    : `<button class="tb-confirm-cancel" id="spmFixBtn">Fix in Testbed</button>
                       ${(state.adminMode || !document.getElementById('adminModeIndicator')?.classList.contains('hidden')) && adminBypass('reference_validation')
                           ? '<button class="tb-confirm-delete" id="spmContinueBtn" style="background:linear-gradient(135deg,#7c6cf0,#60a5fa);">Continue Anyway (Admin)</button>'
                           : ''}`}
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#spmContinueBtn')?.addEventListener('click', async () => {
        overlay.remove();

        const savingOverlay = document.createElement('div');
        savingOverlay.id = 'progressiveSavingOverlay';
        savingOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center;';
        savingOverlay.innerHTML = `
            <div style="background:var(--bg-secondary,#1e1e2e);border-radius:12px;padding:1.75rem 2.25rem;max-width:360px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.35);border:1px solid var(--border,#333);text-align:center;">
                <div style="margin-bottom:1rem;">
                    <div class="tb-btn-spinner" style="width:28px;height:28px;border-width:3px;margin:0 auto;"></div>
                </div>
                <div style="font-weight:700;font-size:1rem;color:var(--text-primary,#e0e0e0);margin-bottom:0.4rem;">Saving to Colab…</div>
                <div style="font-size:0.85rem;color:var(--text-secondary,#a0a0b0);line-height:1.5;">Syncing turn content with your notebook. This takes a moment.</div>
            </div>`;
        document.body.appendChild(savingOverlay);

        await progressiveSaveTurnContent();

        savingOverlay.remove();

        state.referenceValidated = true;
        const startHuntBtn = document.getElementById('startHuntBtn');
        if (startHuntBtn) {
            startHuntBtn.disabled = false;
            startHuntBtn.title = '';
        }

        const { showNotebookPreview } = await import('./notebook-preview.js');
        showNotebookPreview(getActiveRun());
    });
    overlay.querySelector('#spmFixBtn')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming save-preview modal (used by saveRunToTurn)
// ─────────────────────────────────────────────────────────────────────────────

export function showStreamingSavePreviewModal(idealResponse, judgeModelName = '') {
    document.getElementById('spmStreamOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'spmStreamOverlay';
    overlay.className = 'tb-confirm-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('role', 'dialog');
    const modelSubtitle = judgeModelName
        ? `<div id="spmJudgeModelLine" style="font-size:0.77rem;color:var(--text-muted);margin-top:0.2rem;font-weight:400;">Using ${escapeHtml(judgeModelName)}</div>`
        : '';
    overlay.innerHTML = `
        <div class="tb-confirm-box" style="max-width: 640px; max-height: 90vh; display: flex; flex-direction: column;">
            <div style="margin-bottom: 0.5rem;">
                <div class="tb-confirm-title" id="spmStreamTitle">
                    <span class="tb-spinner" style="width:18px;height:18px;"></span> Evaluating Criteria…
                </div>
                ${modelSubtitle}
            </div>
            <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem;">
                <div>
                    <label style="font-weight: 600; font-size: 0.9rem; display: block; margin-bottom: 0.5rem;">Ideal Response</label>
                    <div style="max-height: 400px; overflow-y: auto; padding: 0.75rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid var(--border); font-size: 0.9rem; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(idealResponse || '(empty)')}</div>
                </div>
                <div>
                    <label style="font-weight: 600; font-size: 0.9rem; display: block; margin-bottom: 0.5rem;">
                        Judge Results
                        <span id="spmStreamScore" style="font-weight: 400; font-size: 0.82rem; margin-left: 0.5rem; color: var(--text-secondary);"></span>
                    </label>
                    <div id="spmStreamBody"></div>
                </div>
            </div>
            <div class="tb-confirm-actions" id="spmStreamActions" style="margin-top: 1rem;"></div>
        </div>`;
    document.body.appendChild(overlay);
}

export function updateSpmJudgeHeader(passing, total, isLoading) {
    const scoreEl = document.getElementById('spmStreamScore');
    if (scoreEl) {
        scoreEl.innerHTML = isLoading
            ? `<span class="tb-spinner" style="width:12px;height:12px;display:inline-block;vertical-align:middle;"></span> ${passing}/${total} Passing…`
            : `${passing}/${total} Passing`;
    }
    const titleEl = document.getElementById('spmStreamTitle');
    if (titleEl && !isLoading) {
        const allPass = passing === total && total > 0;
        titleEl.textContent = allPass ? 'Ideal Response Verified' : 'Criteria Not Passed';
    }
}

export function appendSpmCriterion(event) {
    const body = document.getElementById('spmStreamBody');
    if (!body) return;
    const isPass = event.status === 'PASS';
    const isMissing = event.status === 'MISSING';
    const icon = isMissing ? '[MISSING]' : isPass ? '[PASS]' : '[FAIL]';
    const statusColor = isMissing ? 'var(--warning, #f59e0b)' : isPass ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
    const card = document.createElement('div');
    card.className = 'tb-criterion-enter';
    card.style.cssText = `margin-bottom: 0.75rem; padding: 0.75rem; background: var(--bg-primary); border-radius: 8px; border-left: 4px solid ${statusColor};`;
    card.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <span style="font-weight: 700;">${icon} ${escapeHtml(event.id)}</span>
            <span style="color: ${statusColor}; font-weight: 600;">${escapeHtml(event.status)}</span>
        </div>
        ${event.reason ? `<div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 0.35rem; line-height: 1.5;">${escapeHtml(event.reason)}</div>` : ''}`;
    body.appendChild(card);
}

export function finalizeSavePreviewModal(isPassing, idealResponse, judgeData) {
    const actionsEl = document.getElementById('spmStreamActions');
    if (!actionsEl) return;
    const isAdmin = state.adminMode || !document.getElementById('adminModeIndicator')?.classList.contains('hidden');
    actionsEl.innerHTML = isPassing
        ? '<button class="tb-confirm-delete" id="spmContinueBtn">Continue to Hunt</button>'
        : `<button class="tb-confirm-cancel" id="spmFixBtn">Fix in Testbed</button>
           ${isAdmin && adminBypass('reference_validation')
               ? '<button class="tb-confirm-delete" id="spmContinueBtn" style="background:linear-gradient(135deg,#7c6cf0,#60a5fa);">Continue Anyway (Admin)</button>'
               : ''}`;

    const overlay = document.getElementById('spmStreamOverlay');
    if (!overlay) return;

    overlay.querySelector('#spmContinueBtn')?.addEventListener('click', async () => {
        overlay.remove();
        const savingOverlay = document.createElement('div');
        savingOverlay.id = 'progressiveSavingOverlay';
        savingOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center;';
        savingOverlay.innerHTML = `
            <div style="background:var(--bg-secondary,#1e1e2e);border-radius:12px;padding:1.75rem 2.25rem;max-width:360px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.35);border:1px solid var(--border,#333);text-align:center;">
                <div style="margin-bottom:1rem;"><div class="tb-btn-spinner" style="width:28px;height:28px;border-width:3px;margin:0 auto;"></div></div>
                <div style="font-weight:700;font-size:1rem;color:var(--text-primary,#e0e0e0);margin-bottom:0.4rem;">Saving to Colab…</div>
                <div style="font-size:0.85rem;color:var(--text-secondary,#a0a0b0);line-height:1.5;">Syncing turn content with your notebook. This takes a moment.</div>
            </div>`;
        document.body.appendChild(savingOverlay);
        await progressiveSaveTurnContent();
        savingOverlay.remove();
        state.referenceValidated = true;
        const startHuntBtn = document.getElementById('startHuntBtn');
        if (startHuntBtn) { startHuntBtn.disabled = false; startHuntBtn.title = ''; }
        const { showNotebookPreview } = await import('./notebook-preview.js');
        showNotebookPreview();
    });

    overlay.querySelector('#spmFixBtn')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

/**
 * Show the judge result modal from cache — no API call.
 */
export function showCachedJudgeModal(cache) {
    showStreamingSavePreviewModal(cache.idealResponse || '', cache.judgeModelName);

    const sorted = [...cache.criteriaEvents].sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' })
    );
    sorted.forEach(ev => appendSpmCriterion(ev));

    const passingCount = sorted.filter(e => e.status === 'PASS').length;
    updateSpmJudgeHeader(passingCount, sorted.length, false);

    const modelLine = document.getElementById('spmJudgeModelLine');
    if (modelLine && cache.judgeModelName) {
        modelLine.textContent = `Judged with ${cache.judgeModelName}`;
    }

    finalizeSavePreviewModal(cache.isPassing, cache.idealResponse, cache.judgeData);

    const actionsEl = document.getElementById('spmStreamActions');
    const overlay   = document.getElementById('spmStreamOverlay');
    if (actionsEl && overlay) {
        const againBtn = document.createElement('button');
        againBtn.className   = 'tb-confirm-cancel';
        againBtn.id          = 'spmJudgeAgainBtn';
        againBtn.textContent = 'Judge Again';
        actionsEl.insertBefore(againBtn, actionsEl.firstChild);
        againBtn.addEventListener('click', async () => {
            overlay.remove();
            tbState.judgeCache = null;
            const { saveRunToTurn } = await import('./save-turn.js');
            saveRunToTurn();
        });
    }
}
