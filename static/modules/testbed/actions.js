/**
 * testbed/actions.js — Generate / Judge run actions (both streaming).
 */

import { state } from '../state.js';
import { showToast } from '../celebrations.js?v=43';
import { escapeHtml } from '../utils.js';
import { tbState, getSharedLeft, persistTabEdits, chipsToString } from './store.js';
import { validateJudgeOutputFormat } from './validate.js';
import { renderTabBar } from './render-chrome.js';
import { renderActiveTab } from './render-active-tab.js';
import { applySavedSplit } from './layout-resize.js';

export async function triggerGenerate(run) {
    persistTabEdits();
    const left = getSharedLeft();

    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    const missing = [];
    if (!(left.prompt || '').trim()) missing.push('Prompt');
    if (!left.criteriaChips || left.criteriaChips.length === 0) missing.push('Criteria');
    if (!(left.judgePrompt || '').trim()) missing.push('Judge System Prompt');
    if (missing.length > 0) {
        showToast(`Missing required field(s): ${missing.join(', ')}. Please fill in all fields before generating.`, 'error');
        return;
    }

    const modelSel = document.getElementById(`tbModelSel-${run.id}`);
    if (modelSel) {
        const opt    = modelSel.options[modelSel.selectedIndex];
        run.model    = modelSel.value;
        run.provider = opt?.dataset?.provider || run.provider;
    }
    const judgeModelSel = document.getElementById(`tbJudgeModelSel-${run.id}`);
    if (judgeModelSel) run.judgeModel = judgeModelSel.value;

    run.status          = 'generating';
    run.response        = '';
    run.reasoningTrace  = '';
    run.errorMessage    = null;
    run.judgeResult     = null;
    run.score           = null;
    run.maxScore        = null;
    run.responseEditing = false;

    renderTabBar();
    if (run.id === tbState.activeRunId) renderActiveTab();

    try {
        const res = await fetch(`api/generate-single-stream/${state.sessionId}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                model:    run.model,
                provider: run.provider,
                prompt:   getSharedLeft().prompt,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || err.message || `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstContentReceived = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;

                const jsonStr = line.slice(6);
                let chunk;
                try { chunk = JSON.parse(jsonStr); } catch { continue; }

                if (chunk.type === 'error') {
                    throw new Error(chunk.text || 'Generation failed');
                }

                if (chunk.type === 'content') {
                    if (!firstContentReceived) {
                        firstContentReceived = true;
                        run.status = 'streaming';
                        renderTabBar();
                        if (run.id === tbState.activeRunId) renderActiveTab();
                    }
                    run.response += chunk.text;
                    appendStreamChunk(run);
                }

                if (chunk.type === 'reasoning') {
                    run.reasoningTrace += chunk.text;
                }

                if (chunk.type === 'done') {
                    run.response       = chunk.response  ?? run.response;
                    run.reasoningTrace = chunk.reasoning  ?? run.reasoningTrace;
                    run.model          = chunk.model     || run.model;
                    run.provider       = chunk.provider  || run.provider;
                }
            }
        }

        run.status = 'done';
        showToast(`Run ${run.number} response ready`, 'success');
    } catch (err) {
        run.status       = 'error';
        run.errorMessage = err.message || 'Generation failed. Check your network or API key.';
        showToast(`Run ${run.number} failed`, 'error');
    }

    renderTabBar();
    if (run.id === tbState.activeRunId) { renderActiveTab(); requestAnimationFrame(applySavedSplit); }
}

function appendStreamChunk(run) {
    if (run.id !== tbState.activeRunId) return;
    const streamEl = document.getElementById(`tbStreamArea-${run.id}`);
    if (!streamEl) {
        renderActiveTab();
        return;
    }
    const cursor = streamEl.querySelector('.tb-stream-cursor');
    if (cursor) cursor.remove();
    streamEl.textContent = run.response;
    const newCursor = document.createElement('span');
    newCursor.className = 'tb-stream-cursor';
    streamEl.appendChild(newCursor);
    const scrollParent = streamEl.closest('.tb-right-body') || streamEl.parentElement;
    if (scrollParent) scrollParent.scrollTop = scrollParent.scrollHeight;
}

export async function triggerJudge(run) {
    persistTabEdits();
    const left = getSharedLeft();

    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    if (!run.response) {
        showToast('Generate a response first', 'error');
        return;
    }
    if (!left.criteriaChips || left.criteriaChips.length === 0) {
        showToast('Add at least one criterion before judging', 'error');
        return;
    }
    const formatCheck = validateJudgeOutputFormat(left.judgePrompt);
    if (!formatCheck.valid) {
        showToast(formatCheck.message, 'error');
        document.getElementById('tbSharedJudgeBody')?.classList.remove('tb-collapsed');
        document.getElementById('tbSharedJudge')?.focus();
        return;
    }

    run.status       = 'judging';
    run.errorMessage = null;
    run.judgeResult  = null;

    renderTabBar();
    if (run.id === tbState.activeRunId) renderActiveTab();

    try {
        const criteriaForJudge = chipsToString(left.criteriaChips);

        const res = await fetch(`api/judge-calibration-stream/${state.sessionId}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                response_text:       run.response,
                judge_model:         run.judgeModel || null,
                prompt:              left.prompt     || null,
                response_reference:  criteriaForJudge || null,
                judge_system_prompt: left.judgePrompt  || null,
                standard_response:   left.idealResponse || null,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || err.message || `HTTP ${res.status}`);
        }

        injectStreamingJudgeContainer(run);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let event;
                try { event = JSON.parse(line.slice(6)); } catch { continue; }

                if (event.type === 'error') {
                    throw new Error(event.message || 'Judge streaming error');
                }
                if (event.type === 'start') {
                    updateStreamingJudgeHeader(run, 0, event.total);
                }
                if (event.type === 'criterion') {
                    appendStreamingCriterion(run, event);
                    updateStreamingJudgeHeader(run, event.passing, event.total);
                }
                if (event.type === 'done') {
                    run.judgeResult = {
                        criteria: event.criteria,
                        explanation: event.explanation,
                        score: event.score,
                    };
                    run.status   = 'judged';
                    run.maxScore = event.total;
                    run.score    = event.passing;
                    finalizeStreamingJudge(run, event);
                }
            }
        }

        if (run.status !== 'judged') {
            run.status = 'judged';
        }
        showToast(`Run ${run.number} judged`, 'success');
    } catch (err) {
        run.status       = 'error';
        run.errorMessage = err.message || 'Judge failed. Check your criteria and judge prompt.';
        showToast(`Run ${run.number} judge failed`, 'error');
    }

    renderTabBar();
    if (run.id === tbState.activeRunId) { renderActiveTab(); requestAnimationFrame(applySavedSplit); }
}

function injectStreamingJudgeContainer(run) {
    const existing = document.getElementById(`tbJudgeStream-${run.id}`);
    if (existing) existing.remove();
    const rightBody = document.querySelector(`#tbLayout-${run.id} .tb-right-body`);
    if (!rightBody) return;
    const container = document.createElement('div');
    container.id = `tbJudgeStream-${run.id}`;
    container.className = 'tb-judge-result tb-judge-collapsible';
    container.innerHTML = `
        <div class="tb-judge-header">
            <span class="tb-judge-label">Judge Result</span>
            <span class="tb-judge-stream-score" id="tbJudgeStreamScore-${run.id}">
                <span class="tb-spinner" style="width:14px;height:14px;"></span> Evaluating…
            </span>
        </div>
        <div class="tb-judge-body tb-judge-stream-body" id="tbJudgeStreamBody-${run.id}"></div>`;
    rightBody.appendChild(container);
    const scrollParent = rightBody;
    if (scrollParent) scrollParent.scrollTop = scrollParent.scrollHeight;
}

function updateStreamingJudgeHeader(run, passing, total) {
    const scoreEl = document.getElementById(`tbJudgeStreamScore-${run.id}`);
    if (!scoreEl) return;
    scoreEl.innerHTML = `<span class="tb-spinner" style="width:14px;height:14px;"></span> ${passing}/${total} Passing…`;
}

function appendStreamingCriterion(run, event) {
    const body = document.getElementById(`tbJudgeStreamBody-${run.id}`);
    if (!body) return;
    const isPass   = event.status === 'PASS';
    const isMissing = event.status === 'MISSING';
    const icon     = isMissing ? '[MISSING]' : isPass ? '[PASS]' : '[FAIL]';
    const color    = isMissing ? 'var(--warning, #f59e0b)' : isPass ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
    const card = document.createElement('div');
    card.className = 'tb-criterion-enter';
    card.style.cssText = `margin-bottom: 0.5rem; padding: 0.65rem 0.75rem; background: var(--bg-primary); border-radius: 8px; border-left: 4px solid ${color};`;
    card.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: ${event.reason ? '0.25rem' : '0'};">
            <span style="font-weight: 700; font-size: 0.88rem;">${icon} ${escapeHtml(event.id)}</span>
            <span style="color: ${color}; font-weight: 600; font-size: 0.82rem;">${escapeHtml(event.status)}</span>
        </div>
        ${event.reason ? `<div style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">${escapeHtml(event.reason)}</div>` : ''}`;
    body.appendChild(card);
    const scrollParent = body.closest('.tb-right-body') || body.parentElement;
    if (scrollParent) scrollParent.scrollTop = scrollParent.scrollHeight;
}

function finalizeStreamingJudge(run, event) {
    const scoreEl = document.getElementById(`tbJudgeStreamScore-${run.id}`);
    if (!scoreEl) return;
    const allPass = event.passing === event.total && event.total > 0;
    const verdict = allPass ? 'PASSING' : 'BREAKING';
    const verdictCls = allPass ? 'tb-verdict-pass' : 'tb-verdict-break';
    scoreEl.innerHTML = `<span class="tb-verdict ${verdictCls}">${verdict}</span> <span class="tb-overall-score">${event.passing}/${event.total} Passing</span>`;
}
