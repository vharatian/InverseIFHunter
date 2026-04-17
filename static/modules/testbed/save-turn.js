/**
 * testbed/save-turn.js — "Save & Preview" / "Save to Turn N" footer + orchestration.
 */

import { state } from '../state.js';
import { showToast } from '../celebrations.js?v=43';
import { adminBypass, getConfigValue } from '../config.js';
import { parseCriteria, validateModelReferenceAndCriteria } from '../notebook.js';
import { playJudgeSuccess, playJudgeError } from '../sounds.js?v=43';
import {
    tbState, getActiveRun, getSharedLeft, persistTabEdits,
    chipsToJson, chipsToString, judgeContentKey, getJudgeModelName,
} from './store.js';
import { validateJudgeOutputFormat } from './validate.js';
import {
    showSaveValidationModal,
    showStreamingSavePreviewModal,
    updateSpmJudgeHeader,
    appendSpmCriterion,
    finalizeSavePreviewModal,
    showCachedJudgeModal,
    getPreviousTurnJspForTurn,
} from './modals.js';

export function renderSaveFooter() {
    const footer = document.getElementById('testbedSaveFooter');
    if (!footer) return;

    footer.classList.remove('hidden');

    const labelText = (state.currentTurn || 1) === 1 ? 'Judge Ideal Response and Continue' : `Save to Turn ${state.currentTurn} and Continue`;
    const saveBtn0 = document.getElementById('testbedSaveBtn');
    if (saveBtn0) {
        const span = document.getElementById('testbedSaveBtnLabel');
        if (span) {
            span.textContent = labelText;
        } else {
            saveBtn0.innerHTML = `<span id="testbedSaveBtnLabel">${labelText}</span>`;
        }
    }

    const saveBtn = document.getElementById('testbedSaveBtn');
    if (saveBtn && !saveBtn._wired) {
        saveBtn._wired = true;
        saveBtn.addEventListener('click', saveRunToTurn);
    }
}

/**
 * Save testbed content to current turn editors, judge ideal response, and show notebook preview overlay.
 */
export async function saveRunToTurn() {
    const saveBtn = document.getElementById('testbedSaveBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
        const span = document.getElementById('testbedSaveBtnLabel');
        if (span) span.textContent = 'Saving...';
        else saveBtn.innerHTML = '<span id="testbedSaveBtnLabel">Saving...</span>';
    }

    tbState.previewDismissed = false;
    persistTabEdits();
    const left = getSharedLeft();

    const cacheKey        = judgeContentKey(left);
    const judgeModelName  = getJudgeModelName();
    if (tbState.judgeCache && tbState.judgeCache.key === cacheKey) {
        if (saveBtn) {
            saveBtn.disabled = false;
            const label = (state.currentTurn || 1) === 1 ? 'Judge Ideal Response and Continue' : `Save to Turn ${state.currentTurn} and Continue`;
            const span = document.getElementById('testbedSaveBtnLabel');
            if (span) span.textContent = label;
            else saveBtn.innerHTML = `<span id="testbedSaveBtnLabel">${label}</span>`;
        }
        showCachedJudgeModal(tbState.judgeCache);
        return;
    }

    const criteriaJson = chipsToJson(left.criteriaChips || []);
    if (!state.notebook) state.notebook = {};
    state.notebook.prompt = left.prompt;
    if (left.idealResponse) state.notebook.response = left.idealResponse;
    if (left.modelReasoning !== undefined) state.notebook.model_reasoning = left.modelReasoning;
    state.notebook.response_reference = criteriaJson || chipsToString(left.criteriaChips);
    if (left.judgePrompt) state.notebook.judge_system_prompt = left.judgePrompt;

    try {
        const missing = [];
        if (!(left.prompt || '').trim()) missing.push('Prompt');
        if (!(left.idealResponse || '').trim()) missing.push('Ideal Response');
        const criteriaForValidation = criteriaJson || chipsToString(left.criteriaChips || []);
        let criteriaCount = 0;
        try {
            const parsed = parseCriteria(criteriaForValidation);
            criteriaCount = (parsed || []).length;
        } catch (_) { /* ignore */ }
        if (criteriaCount < 3 && !(state.adminMode && adminBypass('min_criteria_count'))) missing.push(`Criteria (minimum 3 required, you have ${criteriaCount})`);
        if (!(left.judgePrompt || '').trim()) missing.push('Judge System Prompt');

        if (missing.length > 0) {
            showSaveValidationModal({
                type: 'missing',
                title: 'Missing Required Fields',
                message: 'Please fill in all required fields before saving:',
                details: missing.map((m) => `• ${m}`).join('\n'),
            });
            return;
        }

        const formatCheck = validateJudgeOutputFormat(left.judgePrompt);
        if (!formatCheck.valid) {
            showSaveValidationModal({
                type: 'missing',
                title: 'Judge Output Format Required',
                message: formatCheck.message,
            });
            return;
        }

        if (!state.sessionId) {
            showSaveValidationModal({
                type: 'error',
                title: 'Session Required',
                message: 'Please load a notebook first.',
            });
            return;
        }

        if (saveBtn) saveBtn.textContent = 'Saving to Colab...';

        const colabCells = [];
        if (left.prompt) colabCells.push({ cell_type: 'prompt', content: left.prompt });
        if (left.idealResponse) colabCells.push({ cell_type: 'response', content: left.idealResponse });
        if (left.modelReasoning) colabCells.push({ cell_type: 'model_reasoning', content: left.modelReasoning });
        if (criteriaJson) colabCells.push({ cell_type: 'response_reference', content: criteriaJson });

        const turnNum = state.currentTurn || 1;
        let jspChangedOrFirst = false;
        if (left.judgePrompt) {
            if (turnNum === 1) {
                jspChangedOrFirst = true;
            } else {
                const prevJsp = getPreviousTurnJspForTurn(turnNum);
                jspChangedOrFirst = left.judgePrompt.trim() !== (prevJsp || '').trim();
            }
            if (jspChangedOrFirst) {
                colabCells.push({ cell_type: 'judge_system_prompt', content: left.judgePrompt });
            }
        }

        const colabUrl = (state.notebook?.url || document.getElementById('colabUrlInput')?.value || '').trim() || undefined;
        const saveRes = await fetch(`api/update-notebook-cells/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cells: colabCells, session_only: false, colab_url: colabUrl }),
        });

        if (left.judgePrompt && !jspChangedOrFirst) {
            fetch(`api/update-notebook-cells/${state.sessionId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cells: [{ cell_type: 'judge_system_prompt', content: left.judgePrompt }],
                    session_only: true,
                }),
            }).catch(() => {});
        }
        if (!saveRes.ok) {
            const err = await saveRes.json().catch(() => ({}));
            throw new Error(err.detail || err.message || `Save failed: ${saveRes.status}`);
        }
        const saveData = await saveRes.json().catch(() => ({}));
        if (saveData.message && saveData.message.includes('Colab')) {
            showToast(saveData.message, 'success');
        }

        if (saveBtn) saveBtn.textContent = 'Judging...';

        const bypass = getConfigValue('bypass_hunt_criteria', false);
        let judgeData = { criteria: {}, explanation: '', score: 0 };

        const activeRunJudgeModel = getActiveRun()?.judgeModel || '';
        if (!activeRunJudgeModel) {
            showSaveValidationModal({ type: 'error', title: 'No Judge Model', message: 'Please select a judge model in the testbed tab before judging.' });
            return;
        }
        const judgeRes = await fetch(
            `api/judge-reference-stream/${state.sessionId}?skip_colab_refresh=true&judge_model=${encodeURIComponent(activeRunJudgeModel)}`,
            { method: 'POST' }
        );
        if (!judgeRes.ok) {
            if (judgeRes.status === 404) {
                showSaveValidationModal({ type: 'error', title: 'Session Expired', message: 'Please reload the notebook from Colab.' });
                return;
            }
            const err = await judgeRes.json().catch(() => ({}));
            throw new Error(err.detail || err.message || 'Judge failed');
        }

        showStreamingSavePreviewModal(left.idealResponse || '', judgeModelName);

        const reader = judgeRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamPassing = 0, streamTotal = 0;
        const criteriaEventsThisRun = [];

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
                if (event.type === 'error') throw new Error(event.message || 'Judge streaming error');
                if (event.type === 'start') {
                    streamTotal = event.total;
                    updateSpmJudgeHeader(0, streamTotal, true);
                }
                if (event.type === 'criterion') {
                    streamPassing = event.passing;
                    criteriaEventsThisRun.push(event);
                    appendSpmCriterion(event);
                    updateSpmJudgeHeader(event.passing, event.total, true);
                }
                if (event.type === 'done') {
                    judgeData = { criteria: event.criteria, explanation: event.explanation, score: event.score };
                    streamPassing = event.passing;
                    streamTotal = event.total;
                    updateSpmJudgeHeader(event.passing, event.total, false);
                }
            }
        }

        const criteria = judgeData.criteria || {};
        const entries = Object.entries(criteria);
        const failed = entries.filter(([, v]) => String(v).toUpperCase() !== 'PASS' && String(v).toUpperCase() !== 'MISSING');
        const missingCriteria = entries.filter(([, v]) => String(v).toUpperCase() === 'MISSING');
        const isPassing = bypass || (failed.length === 0 && missingCriteria.length === 0);

        if (isPassing && !bypass) {
            state.referenceValidated = true;
        }

        tbState.judgeCache = {
            key:            cacheKey,
            isPassing,
            idealResponse:  left.idealResponse || '',
            judgeData,
            criteriaEvents: criteriaEventsThisRun,
            judgeModelName,
        };

        validateModelReferenceAndCriteria(criteriaForValidation);
        if (isPassing && !bypass) {
            state.referenceValidated = true;
        }
        const configSection = document.getElementById('configSection');
        if (configSection) configSection.classList.remove('hidden');

        finalizeSavePreviewModal(isPassing, left.idealResponse || '', judgeData);

        if (isPassing) {
            playJudgeSuccess();
            showToast('Ideal response verified — continue to hunt when ready', 'success');
        } else {
            playJudgeError();
        }
    } catch (err) {
        playJudgeError();
        document.getElementById('spmStreamOverlay')?.remove();
        showSaveValidationModal({
            type: 'error',
            title: 'Error',
            message: 'Something went wrong:',
            details: err.message || String(err),
        });
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            const label = (state.currentTurn || 1) === 1 ? 'Judge Ideal Response and Continue' : `Save to Turn ${state.currentTurn} and Continue`;
            const span = document.getElementById('testbedSaveBtnLabel');
            if (span) {
                span.textContent = label;
            } else {
                saveBtn.innerHTML = `<span id="testbedSaveBtnLabel">${label}</span>`;
            }
        }
    }
}
