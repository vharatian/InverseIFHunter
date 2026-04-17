import { elements } from '../dom.js';
import { state } from '../state.js';
import { escapeHtml } from '../utils.js';
import { showToast, showError } from '../celebrations.js?v=43';
import { syncActiveRunToNotebook, enableNavTestbedButton } from '../testbed.js';
import { validateJudgeOutputFormat } from '../testbed/validate.js';
import { parseCriteria } from './criteria.js';
import { updateOriginalNotebookWithCell } from './ingest.js';
import { _appendNbStreamCriterion } from './quality-check.js';
export async function saveAndJudgeResponse() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    syncActiveRunToNotebook();
    // Check minimum 3 criteria requirement
    const currentRefText = state.notebook?.response_reference || '';
    let currentCriteria;
    try {
        currentCriteria = parseCriteria(currentRefText);
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showError(error, { operation: 'Parse criteria' });
        return;
    }
    if (currentCriteria.length < 3) {
        showToast(`Minimum 3 criteria required. Currently have ${currentCriteria.length}. Please add more criteria before saving.`, 'error');
        return;
    }
    
    const btn = elements.saveAndJudgeResponseBtn;
    if (!btn) {
        showToast('Save & Judge button not found', 'error');
        return;
    }
    const resultDiv = elements.referenceJudgeResult;
    // Get response from rich text editor (contenteditable div)
    const responseEditor = elements.referencePreview;
    const newResponse = responseEditor?.textContent || responseEditor?.innerText || '';
    
    if (!newResponse.trim()) {
        showToast('Response cannot be empty', 'error');
        return;
    }
    
    try {
        btn.disabled = true;
        btn.textContent = 'Saving...';
        // Don't hide result div - keep response editor visible
        if (resultDiv) {
            resultDiv.innerHTML = '';
            resultDiv.classList.add('hidden');
        }
        
        // Step 1: Save to Colab
        const saveResponse = await fetch(`api/update-response/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: newResponse })
        });
        
        if (!saveResponse.ok) {
            const error = await saveResponse.json();
            throw new Error(error.detail || 'Failed to save to Colab');
        }
        
        // CRITICAL: Update originalNotebookJson so snapshot saves include this cell
        updateOriginalNotebookWithCell('response', newResponse);
        
        showToast('Saved to Colab!', 'success');
        btn.textContent = 'Judging...';

        // Step 2: Judge via streaming SSE
        const judgeResponse = await fetch(`api/judge-reference-stream/${state.sessionId}`, { method: 'POST' });
        if (!judgeResponse.ok) {
            if (judgeResponse.status === 404) {
                showToast('Session expired. Please reload the notebook.', 'error');
                throw new Error('Session not found. Please reload the notebook from Colab.');
            }
            const error = await judgeResponse.json().catch(() => ({}));
            throw new Error(error.detail || 'Judge failed');
        }

        if (resultDiv) {
            resultDiv.innerHTML = `
                <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid var(--border);">
                    <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                        <span class="tb-spinner" style="width:14px;height:14px;"></span>
                        <span id="nbSaveJudgeScoreLabel" style="font-weight: 700;">Evaluating…</span>
                    </div>
                    <div id="nbSaveJudgeCriteriaBody" style="margin-top: 0.5rem;"></div>
                </div>`;
            resultDiv.classList.remove('hidden');
        }

        const reader = judgeResponse.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let finalEvent = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const sseLines = sseBuffer.split('\n');
            sseBuffer = sseLines.pop() || '';
            for (const line of sseLines) {
                if (!line.startsWith('data: ')) continue;
                let ev;
                try { ev = JSON.parse(line.slice(6)); } catch { continue; }
                if (ev.type === 'error') throw new Error(ev.message || 'Judge failed');
                if (ev.type === 'start') {
                    const lbl = document.getElementById('nbSaveJudgeScoreLabel');
                    if (lbl) lbl.textContent = `0/${ev.total} Passing…`;
                }
                if (ev.type === 'criterion') {
                    _appendNbStreamCriterion('nbSaveJudgeCriteriaBody', ev);
                    const lbl = document.getElementById('nbSaveJudgeScoreLabel');
                    if (lbl) lbl.textContent = `${ev.passing}/${ev.total} Passing…`;
                }
                if (ev.type === 'done') finalEvent = ev;
            }
        }

        const criteria = finalEvent.criteria || {};
        const criteriaEntries = Object.entries(criteria);
        const evaluatedCriteria = criteriaEntries.map(([id]) => id);
        const missingCriteria = (state.initialCriteria || [])
            .filter(c => !evaluatedCriteria.includes(c.id))
            .map(c => [c.id, c.criteria]);
        const hasMissingCriteria = missingCriteria.length > 0;
        const allCriteriaPass = criteriaEntries.length > 0 &&
            criteriaEntries.every(([k, v]) => String(v).toUpperCase() === 'PASS');
        const isPassing = allCriteriaPass && !hasMissingCriteria;

        state.referenceValidated = isPassing;
        if (elements.startHuntBtn) { elements.startHuntBtn.disabled = false; elements.startHuntBtn.title = ''; }

        const lbl = document.getElementById('nbSaveJudgeScoreLabel');
        if (lbl) {
            lbl.previousElementSibling?.remove();
            const sc = isPassing ? 'var(--success,#22c55e)' : 'var(--danger,#ef4444)';
            lbl.style.color = sc;
            lbl.textContent = `Score: ${finalEvent.score ?? 0} — ${finalEvent.passing || 0}/${finalEvent.total || 0} Passing`;
            if (resultDiv) {
                const container = resultDiv.querySelector('div');
                if (container) container.style.borderColor = sc;
            }
        }

        if (hasMissingCriteria) {
            const missingIds = missingCriteria.map(([id]) => id).join(', ');
            showToast(`Saved, but MISSING CRITERIA: ${missingIds}`, 'warning');
        } else if (isPassing) {
            showToast('Saved & Verified! Ready to hunt.', 'success');
            enableNavTestbedButton();
        } else {
            showToast('Saved, but criteria failed. Fix before hunting.', 'info');
        }
    } catch (error) {
        showError(error, { operation: 'Operation' });
        state.referenceValidated = false;
        if (elements.startHuntBtn) elements.startHuntBtn.disabled = false;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save & Verify';
    }
}

export async function judgeReferenceResponse(event) {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }

    syncActiveRunToNotebook();

    // Block judging if judge system prompt is empty or missing required output format
    const judgePromptValue = (state.notebook?.judge_system_prompt || '').trim();
    const formatCheck = validateJudgeOutputFormat(judgePromptValue);
    if (!formatCheck.valid) {
        showToast(formatCheck.message, 'error');
        return;
    }

    // Check for missing criteria before judging
    const currentRefText = (state.notebook?.response_reference || '').trim();
    
    let currentCriteria;
    try {
        currentCriteria = parseCriteria(currentRefText);
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showError(error, { operation: 'Parse criteria' });
        return;
    }
    
    const currentCriteriaIds = new Set(currentCriteria.map(c => c.id));
    const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
    const missingBeforeJudge = [...initialCriteriaIds].filter(id => !currentCriteriaIds.has(id));
    
    if (currentCriteria.length < 3) {
        showToast(`Minimum 3 criteria required. Currently have ${currentCriteria.length}.`, 'error');
        if (elements.referenceJudgeResult) {
            elements.referenceJudgeResult.innerHTML = `<div style="padding:1rem;background:var(--bg-primary);border:2px solid var(--warning);border-radius:8px;color:var(--text-secondary);">Minimum 3 Criteria Required. You have ${currentCriteria.length}.</div>`;
            elements.referenceJudgeResult.classList.remove('hidden');
        }
        return;
    }
    
    if (missingBeforeJudge.length > 0) {
        const missingIds = missingBeforeJudge.join(', ');
        showToast(`Missing criteria: ${missingIds}`, 'error');
        if (elements.referenceJudgeResult) {
            elements.referenceJudgeResult.innerHTML = `<div style="padding:1rem;background:var(--bg-primary);border:2px solid var(--warning);border-radius:8px;color:var(--text-secondary);">Missing criteria from original: ${missingIds}</div>`;
            elements.referenceJudgeResult.classList.remove('hidden');
        }
        return;
    }
    
    const btn = event?.target?.id === 'judgeBeforeHuntBtn' ? elements.judgeBeforeHuntBtn : elements.judgeReferenceBtn;
    const resultDiv = elements.referenceJudgeResult;
    
    try {
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Judging...';
        }
        if (resultDiv) {
            resultDiv.innerHTML = '';
            resultDiv.classList.add('hidden');
        }
        
        const response = await fetch(`api/judge-reference-stream/${state.sessionId}`, { method: 'POST' });
        if (!response.ok) {
            if (response.status === 404) {
                showToast('Session expired. Please reload notebook.', 'error');
                throw new Error('Session not found');
            }
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || 'Judge failed');
        }

        if (resultDiv) {
            resultDiv.innerHTML = `
                <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid var(--border);">
                    <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                        <span class="tb-spinner" style="width:14px;height:14px;"></span>
                        <span id="nbRefJudgeScoreLabel" style="font-weight: 700;">Evaluating…</span>
                    </div>
                    <div id="nbRefJudgeCriteriaBody" style="margin-top: 0.5rem;"></div>
                </div>`;
            resultDiv.classList.remove('hidden');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let finalEvent = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sseBuffer += decoder.decode(value, { stream: true });
            const sseLines = sseBuffer.split('\n');
            sseBuffer = sseLines.pop() || '';
            for (const line of sseLines) {
                if (!line.startsWith('data: ')) continue;
                let ev;
                try { ev = JSON.parse(line.slice(6)); } catch { continue; }
                if (ev.type === 'error') throw new Error(ev.message || 'Judge failed');
                if (ev.type === 'start') {
                    const lbl = document.getElementById('nbRefJudgeScoreLabel');
                    if (lbl) lbl.textContent = `0/${ev.total} Passing…`;
                }
                if (ev.type === 'criterion') {
                    _appendNbStreamCriterion('nbRefJudgeCriteriaBody', ev);
                    const lbl = document.getElementById('nbRefJudgeScoreLabel');
                    if (lbl) lbl.textContent = `${ev.passing}/${ev.total} Passing…`;
                }
                if (ev.type === 'done') finalEvent = ev;
            }
        }

        let criteria = finalEvent.criteria || {};
        let criteriaEntries = Object.entries(criteria);

        const initIds = new Set((state.initialCriteria || []).map(c => c.id));
        const judgedIds = new Set(Object.keys(criteria));
        const missingIds = [...initIds].filter(id => !judgedIds.has(id));
        if (missingIds.length > 0) {
            for (const id of missingIds) {
                if (!(id in criteria)) criteria[id] = 'MISSING';
            }
            criteriaEntries = Object.entries(criteria);
        }

        const evaluated = criteriaEntries.filter(([k, v]) => String(v).toUpperCase() !== 'MISSING');
        const missing = criteriaEntries.filter(([k, v]) => String(v).toUpperCase() === 'MISSING');
        const allPass = evaluated.length > 0 && evaluated.every(([k, v]) => String(v).toUpperCase() === 'PASS');
        const isPassing = allPass && missing.length === 0;

        state.referenceValidated = isPassing;
        if (elements.startHuntBtn) { elements.startHuntBtn.disabled = false; elements.startHuntBtn.title = ''; }

        let statusMsg = isPassing ? 'ALL CRITERIA PASS' : 'CRITERIA FAILED';
        if (missing.length > 0) statusMsg = `MISSING CRITERIA: ${missing.map(x => x[0]).join(',')}`;

        const lbl = document.getElementById('nbRefJudgeScoreLabel');
        if (lbl) {
            lbl.previousElementSibling?.remove();
            const sc = missing.length > 0 ? 'var(--warning)' : (isPassing ? 'var(--success,#22c55e)' : 'var(--danger,#ef4444)');
            lbl.style.color = sc;
            lbl.innerHTML = `<span class="score-badge ${isPassing ? 'score-1' : 'score-0'}">Score: ${finalEvent.score ?? 0}</span> ${escapeHtml(statusMsg)}`;
            if (resultDiv) {
                const container = resultDiv.querySelector('div');
                if (container) container.style.borderColor = sc;
            }
        }

        if (resultDiv) {
            const mainContainer = resultDiv.querySelector('div');
            if (mainContainer) {
                const explEl = document.createElement('div');
                explEl.style.marginTop = '0.75rem';
                explEl.innerHTML = `
                    <label style="font-weight: 600; font-size: 0.9rem;">Judge Explanation:</label>
                    <p style="margin-top: 0.25rem; font-size: 0.9rem; color: var(--text-secondary); white-space: pre-wrap;">${escapeHtml(finalEvent.explanation || 'No explanation')}</p>`;
                mainContainer.appendChild(explEl);
            }
        }
        if (elements.referencePreview) elements.referencePreview.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });

        const passCount = criteriaEntries.filter(([k, v]) => String(v).toUpperCase() === 'PASS').length;
        showToast(`Reference: ${passCount}/${criteriaEntries.length} pass`, isPassing ? 'success' : 'warning');
        
    } catch (error) {
        showError(error, { operation: 'Operation' });
        if (resultDiv) {
            resultDiv.innerHTML = `<div style="padding:1rem;background:var(--danger-bg);border:2px solid var(--danger);border-radius:8px;">Error: ${escapeHtml(error.message)}</div>`;
            resultDiv.classList.remove('hidden');
        }
        state.referenceValidated = false;
        if (elements.startHuntBtn) { elements.startHuntBtn.disabled = false; elements.startHuntBtn.title = ''; }
    } finally {
        if (btn) {
            btn.disabled = false;
            if (btn.id === 'judgeBeforeHuntBtn') btn.textContent = 'Check Ideal Response';
            else if (btn.id === 'judgeReferenceBtn') btn.textContent = 'Judge Only';
        }
    }
}

export async function saveResponseOnly() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    const btn = elements.saveResponseBtn;
    if (!btn) return;

    syncActiveRunToNotebook();
    const newResponse = state.notebook?.response || '';
    
    if (!newResponse.trim()) {
        showToast('Response cannot be empty', 'error');
        return;
    }
    
    try {
        btn.disabled = true;
        btn.textContent = 'Saving...';
        
        const saveResponse = await fetch(`api/update-response/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: newResponse })
        });
        
        if (!saveResponse.ok) {
            throw new Error('Failed to save to Colab');
        }
        
        updateOriginalNotebookWithCell('response', newResponse);
        showToast('Saved to Colab!', 'success');
        
    } catch (error) {
        showError(error, { operation: 'Operation' });
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Response';
    }
}
