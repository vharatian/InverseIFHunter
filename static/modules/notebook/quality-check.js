import { state } from '../state.js';
import { adminBypass } from '../config.js';
import { escapeHtml } from '../utils.js';
import { showToast } from '../celebrations.js?v=43';
import { runQualityCheckInline } from '../qcInline.js';

export function _appendNbStreamCriterion(containerId, event) {
    const body = document.getElementById(containerId);
    if (!body) return;
    const isPass = event.status === 'PASS';
    const isMissing = event.status === 'MISSING';
    const icon = isMissing ? '[MISSING]' : isPass ? '[PASS]' : '[FAIL]';
    const color = isMissing ? 'var(--warning, #f59e0b)' : isPass ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
    const card = document.createElement('div');
    card.className = 'tb-criterion-enter';
    card.style.cssText = `margin-bottom: 0.5rem; padding: 0.65rem 0.75rem; background: var(--bg-secondary); border-radius: 8px; border-left: 4px solid ${color};`;
    card.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: ${event.reason ? '0.25rem' : '0'};">
            <span style="font-weight: 700; font-size: 0.88rem;">${icon} ${escapeHtml(event.id)}</span>
            <span style="color: ${color}; font-weight: 600; font-size: 0.82rem;">${escapeHtml(event.status)}</span>
        </div>
        ${event.reason ? `<div style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">${escapeHtml(event.reason)}</div>` : ''}`;
    body.appendChild(card);
}

async function _refreshSaveBtnFromStatus() {
    const saveBtn = document.getElementById('saveDriveBtn');
    if (!saveBtn) return;
    if (state.adminMode && adminBypass('reviewer_approval')) {
        saveBtn.disabled = false;
        saveBtn.style.opacity = '1';
        saveBtn.title = 'Admin mode — save anytime';
        return;
    }
    if (!state.sessionId) return;
    try {
        const res = await fetch(`api/session/${state.sessionId}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const status = data.review_status || 'draft';
        if (status === 'approved') {
            saveBtn.disabled = false;
            saveBtn.style.opacity = '1';
            saveBtn.title = 'Reviewer approved — save to Colab';
        } else {
            saveBtn.disabled = true;
            saveBtn.style.opacity = '0.5';
            const msg = {
                draft: 'Submit for review first',
                submitted: 'Waiting for reviewer approval',
                returned: 'Address reviewer feedback and resubmit first',
                rejected: 'Task was rejected by reviewer',
            }[status] || 'Waiting for reviewer approval';
            saveBtn.title = msg;
        }
    } catch (_) { /* network error — leave as-is */ }
}

export async function runProceedToQualityCheck() {
    const selectedRowNumbers = state.selectedRowNumbers || [];
    const selectedResults = selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r);
    const selectedHuntIds = selectedResults.map(r => r.hunt_id).filter(Boolean);

    const huntMode = state.config?.hunt_mode || 'break_50';
    if (huntMode === 'break_50') {
        if (selectedHuntIds.length !== 4 || selectedResults.length !== 4) {
            showToast('Select exactly 4 responses for review first.', 'error');
            return;
        }
    } else if (selectedHuntIds.length === 0 || selectedResults.length === 0) {
        showToast('Select at least 1 response for review first.', 'error');
        return;
    }

    const humanReviewsForApi = {};
    selectedResults.forEach((res, idx) => {
        const rn = selectedRowNumbers[idx];
        const review = state.humanReviews[`row_${rn}`];
        if (review && res.hunt_id) {
            const gradingBasis = review.grading_basis || {};
            const grades = {};
            for (const [k, v] of Object.entries(gradingBasis)) {
                grades[k] = typeof v === 'string' ? v.toLowerCase() : String(v).toLowerCase();
            }
            humanReviewsForApi[String(res.hunt_id)] = {
                grades,
                explanation: review.explanation || '',
                submitted: true,
            };
        }
    });

    const parent = document.getElementById('qcPersistentParent');
    if (!parent) {
        showToast('Quality check section not found.', 'error');
        return;
    }

    const storeEvaluation = (payload) => {
        const storageKey = `quality_check_evaluation_${state.sessionId}`;
        sessionStorage.setItem(storageKey, JSON.stringify(payload));
    };

    const btn = document.getElementById('proceedToQCBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Running QC...';
    }

    try {
        await runQualityCheckInline(parent, state.sessionId, selectedHuntIds, humanReviewsForApi, async (result) => {
            state.qcLastResult = result;
            if (result.overridden) showToast('Save proceeded with human override.', 'info');
            try {
                await fetch(`api/session/${state.sessionId}/mark-qc-done`, { method: 'POST' });
                const { refreshReviewSync } = await import('../reviewSync.js');
                refreshReviewSync(state.sessionId);
            } catch (_) { /* ignore */ }
            await _refreshSaveBtnFromStatus();
        }, storeEvaluation);
    } catch (err) {
        showToast(err.message || 'Quality check failed.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Proceed to Quality Check';
        }
    }
}
