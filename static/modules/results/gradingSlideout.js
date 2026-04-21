/**
 * results/gradingSlideout.js — Grading slide-out panel + grading-review submit flow.
 */

import { state } from '../state.js';
import {
    escapeHtml,
    countWords,
    getWordCountLabel,
    getExplanationValidationError,
    getModelDisplayName,
} from '../utils.js';
import { showToast } from '../celebrations.js?v=43';
import { MIN_EXPLANATION_WORDS } from '../config.js';
import {
    alignmentGateActive,
    persistTrainerUi,
    normalizeReviewRowNumber,
} from '../alignment.js';
import { createFocusTrap } from '../focusTrap.js';
import { isResultBreaking } from './resultModel.js';
import { renderJudgeExplanation } from './clearAndFormat.js';
import { updateReviewProgress } from './selectionConfirmAndProgress.js';
import { enqueue, isOnline } from '../offlineQueue.js';

const GRADING_SPLIT_STORAGE_KEY = 'modelhunter_grading_split_percent';

let _gradingSlideoutTrap = null;

export function updateGradingProgressHeader(huntId) {
    const el = document.getElementById('gradingProgressText');
    if (!el) return;
    const criteria = state.criteria || [];
    const grades = (state.humanReviews?.[huntId] || {}).grades || {};
    const graded = criteria.filter(c => grades[c.id] !== undefined).length;
    const total = criteria.length;
    if (total === 0) {
        el.textContent = '';
        el.classList.add('hidden');
    } else {
        el.textContent = `${graded}/${total} criteria graded`;
        el.classList.remove('hidden');
        el.style.color = graded === total ? 'var(--success)' : 'var(--text-muted)';
    }
}

export function openGradingSlideout(result, slotIndex, rowNumber) {
    const slideout = document.getElementById('gradingSlideout');
    const backdrop = document.getElementById('gradingSlideoutBackdrop');
    const slotBadge = document.getElementById('gradingSlotBadge');
    const slotModel = document.getElementById('gradingSlotModel');
    const body = document.getElementById('gradingSlideoutBody');

    if (!slideout || !body) {
        console.error('Grading slideout elements not found!', { slideout: !!slideout, body: !!body });
        return;
    }

    const isReadOnly = state.llmRevealed;

    const modelDisplay = getModelDisplayName(result.model);
    const slotNum = slotIndex !== undefined ? slotIndex + 1 : result.hunt_id;
    const responseText = result.response || 'No response available';
    const reasoningTrace = result.reasoning_trace || '';
    const huntId = result.hunt_id;

    const existingReview = state.humanReviews?.[huntId];
    const existingNotes = (existingReview?.notes || existingReview?.explanation || '');
    const rawGrades = existingReview?.grades || {};
    const fromGradingBasis = (gb) => {
        const out = {};
        Object.entries(gb || {}).forEach(([k, v]) => { out[k] = String(v).toUpperCase() === 'PASS' ? 1 : 0; });
        return out;
    };
    const existingGrades = Object.keys(rawGrades).length ? rawGrades : fromGradingBasis(existingReview?.grading_basis);

    slotBadge.textContent = `Slot ${slotNum}`;
    slotModel.textContent = modelDisplay;
    updateGradingProgressHeader(huntId);

    const disabledAttr = isReadOnly ? 'disabled' : '';
    const disabledStyle = isReadOnly ? 'opacity: 0.6; cursor: not-allowed; pointer-events: none;' : '';
    const textareaStyle = isReadOnly ? 'background: var(--bg-tertiary); opacity: 0.7;' : '';

    body.innerHTML = `
        ${isReadOnly ? `
        <div class="grading-locked-banner">
            <span style="font-weight: 700;">Locked</span>
            <span style="color: var(--warning); font-weight: 600;">Reviews are locked - View only mode</span>
        </div>
        ` : ''}
        <div class="grading-split-view">
            <div class="grading-split-left">
                <div class="grading-section">
                    <div class="grading-section-title">Model Response</div>
                    <div class="grading-response-box grading-response-scroll">${escapeHtml(responseText)}</div>
                </div>
                <div class="grading-section">
                    <button class="reasoning-toggle-btn" style="width: 100%; padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; justify-content: space-between;">
                        <span>Model Reasoning (Reference)</span>
                        <span class="reasoning-arrow">▼</span>
                    </button>
                    <div class="reasoning-content" style="display: none; margin-top: 0.75rem;">
                        ${reasoningTrace ? `
                            <div class="grading-response-box" style="max-height: 200px;">${escapeHtml(reasoningTrace)}</div>
                        ` : `
                            <div style="padding: 1rem; background: var(--bg-tertiary); border-radius: 8px; color: var(--text-muted); text-align: center; font-style: italic;">
                                No reasoning trace available
                            </div>
                        `}
                    </div>
                </div>
                ${(function () {
                    const fb = state.reviewFeedback?.section_feedback || state.reviewFeedback?.section_comments || [];
                    const entry = fb.find(s => s.section_id === `slot_${slotNum}` || s.section_id === `slot${slotNum}`);
                    const slotComment = entry ? (entry.comment || '').trim() : '';
                    if (!slotComment) return '';
                    return `<div class="slot-reviewer-feedback grading-section" style="margin-top: 1rem; padding: 0.75rem 1rem; background: var(--bg-tertiary); border-radius: 8px; border-left: 3px solid var(--accent-primary);">
                        <div class="grading-section-title" style="font-size: 0.9rem;">Reviewer feedback for slot ${slotNum}</div>
                        <div style="font-size: 0.9rem; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(slotComment)}</div>
                    </div>`;
                })()}
            </div>

            <div class="grading-split-divider" title="Drag to resize"></div>

            <div class="grading-split-right">
                <div class="grading-section">
                    <div class="grading-section-title">Grade Each Criterion ${isReadOnly ? '<span style="color: var(--warning); font-size: 0.8rem;">(Locked)</span>' : ''}</div>
                    <div class="grading-criteria-list" data-hunt-id="${huntId}">
                        ${(state.criteria || []).map(c => {
                            const existingGrade = existingGrades[c.id];
                            const passActive = existingGrade === 1 ? 'active' : '';
                            const failActive = existingGrade === 0 ? 'active' : '';
                            return `
                                <div class="grading-criterion" data-criterion-id="${c.id}" data-hunt-id="${huntId}" tabindex="0">
                                    <span class="grading-criterion-id">${c.id}:</span>
                                    <span class="grading-criterion-text">${escapeHtml(c.criteria)}</span>
                                    <div class="grading-criterion-buttons" style="${disabledStyle}">
                                        <button class="grading-btn grading-btn-pass ${passActive}" data-hunt-id="${huntId}" data-criterion="${c.id}" ${disabledAttr}>
                                            Pass
                                        </button>
                                        <button class="grading-btn grading-btn-fail ${failActive}" data-hunt-id="${huntId}" data-criterion="${c.id}" ${disabledAttr}>
                                            Fail
                                        </button>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
                <div class="grading-section">
                    <div class="grading-section-title">Explanation ${isReadOnly ? '<span style="color: var(--warning); font-size: 0.8rem;">(Locked)</span>' : ''}${!isReadOnly ? '<span class="autosave-status autosave-saved" data-field="grading-' + huntId + '" style="margin-left: 0.25rem;">Saved</span>' : ''}</div>
                    <textarea class="grading-notes-textarea" data-hunt-id="${huntId}"
                        placeholder="Explain your grading decisions (minimum ${MIN_EXPLANATION_WORDS} words required)..." ${disabledAttr} style="${textareaStyle}">${escapeHtml(existingNotes)}</textarea>
                    ${isReadOnly ? '' : `
                    <div class="grading-word-count" data-hunt-id="${huntId}" style="margin-top: 0.5rem; font-size: 0.9rem; font-weight: 600; color: var(--text-muted);">${getWordCountLabel(countWords(existingNotes))}</div>
                    `}
                </div>
                <div class="grading-section">
                    ${isReadOnly ? `
                        <div style="padding: 0.75rem 1rem; background: var(--bg-tertiary); border-radius: 8px; text-align: center; color: var(--text-muted);">
                            Review submitted and locked
                        </div>
                    ` : `
                        <button class="btn btn-primary grading-submit-btn" data-hunt-id="${huntId}" data-slot-index="${slotIndex}" data-row-number="${rowNumber !== undefined && rowNumber !== null ? rowNumber : ''}" disabled style="opacity: 0.7;">
                            Submit Review
                        </button>
                    `}
                    <div class="grading-status" data-hunt-id="${huntId}"></div>
                </div>
                <div class="llm-judge-section grading-section" data-hunt-id="${huntId}" style="display: ${state.llmRevealed ? 'block' : 'none'}; margin-top: 1.5rem; padding: 1.5rem; background: var(--bg-tertiary); border-radius: 12px; border: 2px solid var(--accent-primary);">
            <div class="grading-section-title" style="color: var(--accent-primary);">LLM Judge Result</div>
            <div style="margin-top: 0.75rem;">
                <span class="score-badge score-${result.judge_score || 0}" style="padding: 0.5rem 1rem;">
                    Score: ${result.judge_score ?? '-'} <span style="color: ${isResultBreaking(result) ? 'var(--success)' : 'var(--danger)'};">(${isResultBreaking(result) ? 'BREAK' : 'PASS'})</span>
                </span>
            </div>
            ${result.judge_explanation ? `
                <div style="margin-top: 1rem; padding: 1rem; background: var(--bg-card); border-radius: 8px; font-size: 0.9rem; line-height: 1.6;">
                    ${renderJudgeExplanation(result.judge_explanation)}
                </div>
            ` : ''}
                </div>
            </div>
        </div>
    `;

    setupGradingSlideoutEvents(body, huntId, result, slotIndex, rowNumber);

    slideout.style.right = '0';
    slideout.style.visibility = 'visible';
    slideout.classList.add('open');
    slideout.setAttribute('role', 'dialog');
    slideout.setAttribute('aria-modal', 'true');
    if (backdrop) backdrop.classList.add('visible');
    document.body.style.overflow = 'hidden';

    state.currentGradingSlot = { result, slotIndex, rowNumber, huntId };

    if (_gradingSlideoutTrap) { try { _gradingSlideoutTrap.release(); } catch { /* ignore */ } }
    _gradingSlideoutTrap = createFocusTrap(slideout, { onEscape: closeGradingSlideout });
}

function setupGradingSplitResize(container) {
    const splitView = container.querySelector('.grading-split-view');
    const divider = container.querySelector('.grading-split-divider');
    const leftPanel = container.querySelector('.grading-split-left');
    if (!splitView || !divider || !leftPanel) return;

    let isResizing = false;
    let startX = 0;
    let startLeftPercent = 0;

    try {
        const saved = localStorage.getItem(GRADING_SPLIT_STORAGE_KEY);
        if (saved) {
            const pct = parseFloat(saved);
            if (!isNaN(pct) && pct >= 25 && pct <= 65) {
                leftPanel.style.flex = `0 0 ${pct}%`;
            }
        }
    } catch (_) {}

    divider.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        startX = e.clientX;
        startLeftPercent = (leftPanel.offsetWidth / splitView.offsetWidth) * 100;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
    });

    function onMove(e) {
        if (!isResizing) return;
        const w = splitView.offsetWidth;
        const deltaPx = e.clientX - startX;
        const deltaPercent = (deltaPx / w) * 100;
        let newPercent = startLeftPercent + deltaPercent;
        newPercent = Math.max(25, Math.min(65, newPercent));
        leftPanel.style.flex = `0 0 ${newPercent}%`;
    }

    function onEnd() {
        if (!isResizing) return;
        const pct = (leftPanel.offsetWidth / splitView.offsetWidth) * 100;
        try { localStorage.setItem(GRADING_SPLIT_STORAGE_KEY, String(pct)); } catch (_) {}
        isResizing = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
    }
}

export function setupGradingSlideoutEvents(container, huntId, result, slotIndex, rowNumber) {
    setupGradingSplitResize(container);

    const reasoningToggle = container.querySelector('.reasoning-toggle-btn');
    const reasoningContent = container.querySelector('.reasoning-content');
    const reasoningArrow = container.querySelector('.reasoning-arrow');

    if (reasoningToggle && reasoningContent) {
        reasoningToggle.addEventListener('click', () => {
            const isHidden = reasoningContent.style.display === 'none';
            reasoningContent.style.display = isHidden ? 'block' : 'none';
            reasoningArrow.textContent = isHidden ? '▲' : '▼';
        });
    }

    const notesTextarea = container.querySelector('.grading-notes-textarea');
    const wordCountEl = container.querySelector('.grading-word-count');
    const submitBtn = container.querySelector('.grading-submit-btn');
    const criteriaIds = (state.criteria || []).map(c => c.id);

    function updateSlideoutSubmitState() {
        const notes = notesTextarea ? (notesTextarea.value || '').trim() : '';
        const words = countWords(notes);
        if (wordCountEl) {
            wordCountEl.textContent = getWordCountLabel(words);
            wordCountEl.style.color = words >= MIN_EXPLANATION_WORDS ? 'var(--success)' : 'var(--text-muted)';
        }
        const grades = (state.humanReviews[huntId] || {}).grades || {};
        const allGraded = criteriaIds.length > 0 && criteriaIds.every(id => grades[id] !== undefined);
        const canSubmit = allGraded && words >= MIN_EXPLANATION_WORDS;
        if (submitBtn) {
            submitBtn.disabled = !canSubmit;
            submitBtn.style.opacity = canSubmit ? '1' : '0.7';
        }
        updateGradingProgressHeader(huntId);
    }

    container.querySelectorAll('.grading-btn-pass').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const criterion = btn.dataset.criterion;
            const row = btn.closest('.grading-criterion');
            row.querySelector('.grading-btn-pass').classList.add('active');
            row.querySelector('.grading-btn-fail').classList.remove('active');
            if (!state.humanReviews[huntId]) {
                state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            }
            state.humanReviews[huntId].grades[criterion] = 1;
            updateSlideoutSubmitState();
        });
    });

    container.querySelectorAll('.grading-btn-fail').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const criterion = btn.dataset.criterion;
            const row = btn.closest('.grading-criterion');
            row.querySelector('.grading-btn-fail').classList.add('active');
            row.querySelector('.grading-btn-pass').classList.remove('active');
            if (!state.humanReviews[huntId]) {
                state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            }
            state.humanReviews[huntId].grades[criterion] = 0;
            updateSlideoutSubmitState();
        });
    });

    if (notesTextarea) {
        notesTextarea.addEventListener('input', () => {
            if (!state.humanReviews[huntId]) {
                state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            }
            state.humanReviews[huntId].notes = notesTextarea.value;
            updateSlideoutSubmitState();
        });
    }

    if (submitBtn) {
        submitBtn.addEventListener('click', () => {
            submitGradingReview(huntId, result, slotIndex, rowNumber);
        });
    }

    updateSlideoutSubmitState();
    updateGradingProgressHeader(huntId);

    if (!state.llmRevealed) {
        requestAnimationFrame(() => {
            const first = container.querySelector('.grading-criterion');
            if (first) first.focus();
        });
    }
}

export async function submitGradingReview(huntId, result, slotIndex, rowNumber) {
    const review = state.humanReviews[huntId] || {};
    const grades = review.grades || {};
    const notes = (review.notes || '').trim();

    const allGraded = (state.criteria || []).every(c => grades[c.id] !== undefined);
    if (!allGraded) {
        showToast('Please grade all criteria before submitting', 'warning');
        return;
    }
    const explanationErr = getExplanationValidationError(notes);
    if (explanationErr) {
        showToast(explanationErr, 'error');
        return;
    }

    const allPass = Object.values(grades).every(g => g === 1);
    const overallJudgment = allPass ? 1 : 0;

    const gradingBasis = {};
    Object.entries(grades).forEach(([key, value]) => {
        gradingBasis[key] = value === 1 ? 'PASS' : 'FAIL';
    });

    state.humanReviews[huntId] = { ...review, submitted: true };

    const rowKey = `row_${rowNumber}`;
    state.humanReviews[rowKey] = {
        hunt_id: huntId,
        row_number: normalizeReviewRowNumber(rowNumber) ?? rowNumber,
        judgment: overallJudgment,
        grading_basis: gradingBasis,
        explanation: notes,
        slotNum: slotIndex + 1,
        timestamp: new Date().toISOString(),
        submitted: true
    };

    // Persist with explicit ok-check, keepalive to survive slideout-close /
    // pagehide, rollback of the optimistic `submitted: true` on failure, and
    // offline-queue retry so a silent network blip can never again leave the
    // trainer believing their feedback was saved when it wasn't.
    const url = `api/save-reviews/${state.sessionId}`;
    const fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            reviews: { [rowKey]: state.humanReviews[rowKey] },
            auto_save: true,
        }),
        keepalive: true,
    };

    let persisted = false;
    let lastError = null;
    try {
        const resp = await fetch(url, fetchOptions);
        if (resp.ok) {
            persisted = true;
        } else {
            lastError = new Error(`save-reviews failed: ${resp.status} ${resp.statusText}`);
        }
    } catch (err) {
        lastError = err;
    }

    if (!persisted) {
        // Roll back the optimistic "submitted" flag so progress/alignment UI
        // don't treat this slot as done.
        if (state.humanReviews[huntId]) {
            state.humanReviews[huntId] = { ...state.humanReviews[huntId], submitted: false };
        }
        if (state.humanReviews[rowKey]) {
            state.humanReviews[rowKey] = { ...state.humanReviews[rowKey], submitted: false };
        }

        let queued = false;
        try {
            await enqueue({
                type: 'save-reviews',
                url,
                options: fetchOptions,
                sessionId: state.sessionId,
            });
            queued = true;
        } catch (qerr) {
            console.error('Failed to enqueue review for offline retry:', qerr);
        }

        const onlineNow = isOnline();
        const msg = queued
            ? (onlineNow
                ? 'Could not save your review to the server. Saved locally and will retry automatically.'
                : 'You appear to be offline. Review saved locally and will send when you reconnect.')
            : 'Could not save your review. Please check your connection and try again.';
        showToast(msg, 'error');
        console.error('submitGradingReview failed:', lastError);

        const statusElFail = document.querySelector(`.grading-status[data-hunt-id="${huntId}"]`);
        if (statusElFail) {
            statusElFail.innerHTML = queued
                ? '<span style="color: var(--warning);">Save pending — will retry</span>'
                : '<span style="color: var(--danger);">Save failed — please retry</span>';
        }
        return;
    }

    const statusEl = document.querySelector(`.grading-status[data-hunt-id="${huntId}"]`);
    if (statusEl) {
        statusEl.innerHTML = '<span style="color: var(--success);">Review Submitted!</span>';
    }

    const rowNorm = normalizeReviewRowNumber(rowNumber);
    const card =
        rowNorm !== null
            ? document.querySelector(`.slot-compact-card[data-row-number="${rowNorm}"]`)
            : document.querySelector(`.slot-compact-card[data-hunt-id="${huntId}"]`);
    if (card) {
        card.classList.add('reviewed');
        const statusDiv = card.querySelector('.slot-compact-status');
        if (statusDiv) {
            statusDiv.textContent = 'Review Submitted';
            statusDiv.classList.add('reviewed');
        }
        const btn = card.querySelector('.slot-open-btn');
        if (btn) btn.textContent = 'Edit';
    }

    if (
        alignmentGateActive() &&
        !state.llmRevealed &&
        (state.alignmentPhase === 'passed' || state.alignmentPhase === 're_review')
    ) {
        state.alignmentPhase = 'idle';
        state.alignmentLastSnapshot = null;
        void persistTrainerUi();
    }

    updateReviewProgress();

    showToast(`Review for Slot ${slotIndex + 1} submitted!`, 'success');

    setTimeout(() => { closeGradingSlideout(); }, 500);
}

export function closeGradingSlideout() {
    const slideout = document.getElementById('gradingSlideout');
    const backdrop = document.getElementById('gradingSlideoutBackdrop');
    const progressEl = document.getElementById('gradingProgressText');

    if (slideout) {
        const currentWidth = slideout.offsetWidth;
        slideout.style.right = `-${currentWidth + 10}px`;
        slideout.classList.remove('open');
    }
    if (backdrop) backdrop.classList.remove('visible');
    if (progressEl) {
        progressEl.textContent = '';
        progressEl.classList.add('hidden');
    }
    document.body.style.overflow = '';
    state.currentGradingSlot = null;

    if (_gradingSlideoutTrap) {
        try { _gradingSlideoutTrap.release(); } catch { /* ignore */ }
        _gradingSlideoutTrap = null;
    }
}

export function toggleSelectionResponse(rowNumber) {
    const cell = document.querySelector(`.selection-response-cell[data-row-number="${rowNumber}"]`);
    if (!cell) return;

    const preview = cell.querySelector('.selection-response-preview');
    const toggleBtn = cell.querySelector('.selection-response-toggle-btn');

    if (preview && toggleBtn) {
        const isExpanded = preview.style.maxHeight === 'none' || preview.style.maxHeight === '';
        if (isExpanded) {
            preview.style.maxHeight = '60px';
            toggleBtn.textContent = '▼ Expand';
        } else {
            preview.style.maxHeight = 'none';
            toggleBtn.textContent = '▲ Collapse';
        }
    }
}
