/**
 * results/llmRevealAndReviewCards.js — review slot card render, LLM reveal flow,
 * legacy human-review handlers, cross-review completion check.
 */

import { elements } from '../dom.js';
import { state } from '../state.js';
import {
    countWords,
    getWordCountLabel,
    getExplanationValidationError,
    getModelDisplayName,
    getIncompleteReviewIssues,
    getIncompleteReviewsModalMessage,
} from '../utils.js';
import { showToast } from '../celebrations.js?v=43';
import { showAppModal } from '../api.js';
import { adminBypass } from '../config.js';
import {
    revealAllowedByAlignment,
    persistTrainerUi,
    alignmentGateActive,
    normalizeReviewRowNumber,
    syncAlignmentSlotDisplays,
} from '../alignment.js';
import { isResultBreaking } from './resultModel.js';
import { openGradingSlideout } from './gradingSlideout.js';
import { updateReviewProgress } from './selectionConfirmAndProgress.js';

/** Apply DOM state when session was hydrated with llmRevealed already true (no modal). */
export function applyLlmRevealedUi() {
    if (!state.llmRevealed) return;
    document.querySelectorAll('.llm-judge-section').forEach((section) => {
        section.style.display = 'block';
    });
    document.querySelectorAll('.slot-compact-card').forEach((card) => {
        card.classList.add('revealed');
        const btn = card.querySelector('.slot-open-btn');
        if (btn) btn.textContent = 'View LLM Judgment';
    });
    if (elements.proceedToQCBtn) {
        elements.proceedToQCBtn.disabled = false;
        elements.proceedToQCBtn.style.opacity = '1';
    }
    if (elements.submitColabBtn) {
        elements.submitColabBtn.disabled = false;
        elements.submitColabBtn.style.opacity = '1';
        elements.submitColabBtn.title = 'Save session data to Colab notebook';
    }
    syncAlignmentSlotDisplays();
}

export async function revealLLMJudgments() {
    const selectedRowNumbers = state.selectedRowNumbers || [];
    const requiredReviews = selectedRowNumbers.length;

    if (!(state.adminMode && adminBypass('all_grades_before_reveal'))) {
        if (selectedRowNumbers.length === 0) {
            showToast('Please select hunts first', 'error');
            return;
        }

        const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
        const reviews = reviewKeys.map(key => state.humanReviews && state.humanReviews[key]).filter(Boolean);

        if (reviews.length < requiredReviews) {
            showToast(`Only ${reviews.length}/${requiredReviews} review(s) complete. Please complete all reviews before revealing.`, 'error');
            return;
        }

        const incompleteReviews = getIncompleteReviewIssues(reviews);
        if (incompleteReviews.length > 0) {
            showToast('Complete all reviews (criteria + minimum 10 words) before revealing.', 'error');
            await showAppModal({
                title: 'Please complete all reviews before revealing',
                message: getIncompleteReviewsModalMessage(incompleteReviews),
                buttons: [{ label: 'OK', primary: true, value: true }]
            });
            return;
        }
    }

    if (!revealAllowedByAlignment()) {
        showToast('Click Refresh alignment and meet the target before showing AI evaluation.', 'error');
        return;
    }

    const confirmed = await showAppModal({
        title: 'Reveal LLM judgments?',
        message: 'After revealing, you cannot edit or change your human reviews—everything will be locked. Continue to reveal and lock, or Cancel to edit your human reviews.',
        buttons: [
            { label: 'Cancel', primary: false, value: false },
            { label: 'Continue', primary: true, value: true }
        ]
    });
    if (!confirmed) {
        showToast('You can edit your reviews, then reveal when ready.', 'info');
        return;
    }

    state.llmRevealed = true;

    document.querySelectorAll('.llm-judge-section').forEach(section => {
        section.style.display = 'block';
    });

    document.querySelectorAll('.human-review-section').forEach(section => {
        section.querySelectorAll('button').forEach(btn => {
            btn.disabled = true;
            btn.style.opacity = '0.5';
        });
        section.querySelectorAll('textarea').forEach(ta => {
            ta.disabled = true;
            ta.style.background = 'var(--bg-tertiary)';
        });
        const lockIndicator = document.createElement('div');
        lockIndicator.style.cssText = 'padding: 0.5rem; background: var(--warning); color: black; border-radius: 4px; margin-top: 0.5rem; text-align: center; font-weight: 600;';
        lockIndicator.textContent = 'Review Locked';
        section.appendChild(lockIndicator);
    });

    document.querySelectorAll('.slot-compact-card').forEach(card => {
        card.classList.add('revealed');
        const btn = card.querySelector('.slot-open-btn');
        if (btn) btn.textContent = 'View LLM Judgment';
    });

    if (elements.proceedToQCBtn) {
        elements.proceedToQCBtn.disabled = false;
        elements.proceedToQCBtn.style.opacity = '1';
    }
    if (state.adminMode && adminBypass('reviews_complete_before_save') && elements.saveDriveBtn) {
        elements.saveDriveBtn.disabled = false;
        elements.saveDriveBtn.style.opacity = '1';
    }

    if (elements.submitColabBtn) {
        elements.submitColabBtn.disabled = false;
        elements.submitColabBtn.style.opacity = '1';
        elements.submitColabBtn.title = 'Save session data to Colab notebook';
    }

    updateReviewProgress();
    void persistTrainerUi();

    showToast('LLM Judgments revealed! Click any slot to view details. Reviews are locked.', 'success');
}

export async function displayBreakingResults() {
    try {
        const response = await fetch(`api/review-results/${state.sessionId}`);
        if (!response.ok) throw new Error(`Failed to fetch review results: ${response.status}`);
        const data = await response.json();

        elements.breakingResults.innerHTML = '';

        if (data.count === 0) {
            elements.noBreaksMessage.classList.remove('hidden');
            return;
        }

        elements.noBreaksMessage.classList.add('hidden');

        const summaryHtml = `
            <div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px;">
                <strong>Human Review Selection:</strong>
                ${data.summary.failed_count} failed (score 0) + ${data.summary.passed_count} passed (score 1+)
            </div>
        `;
        elements.breakingResults.innerHTML = summaryHtml;

        data.results.forEach((result, index) => {
            const card = createResultCard(result, index);
            elements.breakingResults.appendChild(card);
        });
    } catch (error) {
        console.error('Error fetching review results:', error);
    }
}

export function createResultCard(result, slotIndex, rowNumber) {
    const card = document.createElement('div');
    card.className = 'slot-compact-card';
    card.dataset.huntId = result.hunt_id;
    card.dataset.slotIndex =
        slotIndex !== undefined && slotIndex !== null ? String(slotIndex) : '0';
    const rn = normalizeReviewRowNumber(rowNumber);
    if (rn !== null) {
        card.dataset.rowNumber = String(rn);
    }

    const modelDisplay = getModelDisplayName(result.model);
    const score = result.judge_score ?? 0;
    const isFailed = score === 0;
    const slotNum = slotIndex !== undefined ? slotIndex + 1 : result.hunt_id;

    const huntId = result.hunt_id;
    const rowKey = rn !== null ? `row_${rn}` : null;
    const isReviewed = (rowKey && state.humanReviews?.[rowKey])
        || (state.humanReviews?.[huntId]?.submitted === true);

    if (isReviewed) {
        card.classList.add('reviewed');
    }

    card.innerHTML = `
        <div class="slot-compact-badge">Slot ${slotNum}</div>
        <div class="slot-compact-align-center">
            <div class="slot-alignment-pct" aria-live="polite"></div>
        </div>
        <div class="slot-compact-info">
            <div class="slot-compact-model">${modelDisplay}</div>
            <div class="slot-compact-status ${isReviewed ? 'reviewed' : ''}">
                ${isReviewed ? 'Review Submitted' : `<span style="color: ${isFailed ? 'var(--success)' : 'var(--danger)'};">${isFailed ? 'BREAK' : 'PASS'}</span> - Click to Review`}
            </div>
        </div>
        <div class="slot-compact-action">
            <button class="slot-open-btn">
                ${isReviewed ? 'Edit' : 'Grade'}
            </button>
        </div>
    `;

    card.addEventListener('click', () => {
        openGradingSlideout(result, slotIndex, rowNumber);
    });

    return card;
}

export function createResultCardFull(result, slotIndex, rowNumber) {
    return createResultCard(result, slotIndex, rowNumber);
}

export function handleHumanReview(huntId, judgment, card, slotNum) {
    const notes = card.querySelector(`.human-review-notes[data-hunt-id="${huntId}"]`).value;
    const statusEl = card.querySelector(`.human-review-status[data-hunt-id="${huntId}"]`);

    if (!state.humanReviews) state.humanReviews = {};
    state.humanReviews[huntId] = {
        judgment: judgment,
        notes: notes,
        slotNum: slotNum,
        timestamp: new Date().toISOString()
    };

    const passBtn = card.querySelector('.human-pass-btn');
    const failBtn = card.querySelector('.human-fail-btn');

    passBtn.classList.remove('active');
    failBtn.classList.remove('active');

    if (judgment === 'pass') {
        passBtn.classList.add('active');
        statusEl.innerHTML = 'Marked as <strong>PASS</strong>';
        statusEl.style.color = 'var(--success)';
    } else {
        failBtn.classList.add('active');
        statusEl.innerHTML = 'Marked as <strong>FAIL</strong>';
        statusEl.style.color = 'var(--danger)';
    }

    let revealBtn = card.querySelector('.reveal-llm-btn');
    if (!revealBtn) {
        revealBtn = card.querySelector(`.reveal-llm-btn[data-hunt-id="${huntId}"]`);
    }

    if (revealBtn) {
        revealBtn.disabled = false;
        revealBtn.style.opacity = '1';
        revealBtn.textContent = 'Reveal LLM Judge';
    } else {
        console.error('Could not find reveal button for hunt', huntId);
    }

    showToast(`Slot ${slotNum} marked as ${judgment.toUpperCase()}. Click to reveal LLM Judge.`, 'success');

    checkAllReviewsComplete();
}

export async function submitHumanReview(huntId, card, slotNum, rowNumber) {
    const notesEl = card.querySelector(`.human-review-notes[data-hunt-id="${huntId}"]`);
    const notes = notesEl ? (notesEl.value || notesEl.textContent || '') : '';
    const statusEl = card.querySelector(`.human-review-status[data-hunt-id="${huntId}"]`);
    const criteriaGrading = card.querySelector(`.criteria-grading[data-hunt-id="${huntId}"]`);

    const reviewKey = rowNumber !== null && rowNumber !== undefined ? `row_${rowNumber}` : `hunt_${huntId}`;

    const criterionRows = criteriaGrading ? criteriaGrading.querySelectorAll('.criterion-row') : [];
    const grading = {};
    let allGraded = true;

    criterionRows.forEach(row => {
        const criterionId = row.dataset.criterionId;
        const grade = row.dataset.grade;
        if (!grade) {
            allGraded = false;
        } else {
            grading[criterionId] = grade.toUpperCase();
        }
    });

    if (!allGraded) {
        showToast('Please grade all criteria before submitting', 'error');
        return;
    }
    const explanationErr = getExplanationValidationError(notes);
    if (explanationErr) {
        showToast(explanationErr, 'error');
        return;
    }

    const passThreshold = state.config?.pass_threshold ?? 0.5;
    const totalCriteria = Object.keys(grading).length;
    const passCount = Object.values(grading).filter(v => v.toUpperCase() === 'PASS').length;
    const passRate = totalCriteria > 0 ? passCount / totalCriteria : 0;
    const overallJudgment = (passRate >= 1.0) || (passThreshold < 1.0 && passRate >= passThreshold) ? 'pass' : 'fail';

    if (!state.humanReviews) state.humanReviews = {};
    state.humanReviews[reviewKey] = {
        hunt_id: huntId,
        row_number: rowNumber,
        judgment: overallJudgment,
        grading_basis: grading,
        explanation: notes,
        slotNum: slotNum,
        timestamp: new Date().toISOString()
    };

    const submitBtn = card.querySelector('.submit-human-review-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = overallJudgment === 'pass' ? 'Submitted: PASS' : 'Submitted: FAIL';
    submitBtn.style.background = overallJudgment === 'pass' ? 'var(--success)' : 'var(--danger)';

    const gradingDisplay = Object.entries(grading).map(([k, v]) =>
        `${k}: ${v.toUpperCase() === 'PASS' ? 'PASS' : 'FAIL'}`
    ).join(' | ');
    statusEl.innerHTML = `<strong>${overallJudgment.toUpperCase()}</strong> - ${gradingDisplay}`;
    statusEl.style.color = overallJudgment === 'pass' ? 'var(--success)' : 'var(--danger)';

    showToast(`Slot ${slotNum} submitted as ${overallJudgment.toUpperCase()}`, 'success');

    updateReviewProgress();

    try {
        const reviewForBackend = {
            [huntId]: {
                judgment: overallJudgment,
                grading_basis: grading,
                explanation: notes,
                slotNum: slotNum,
                timestamp: new Date().toISOString()
            }
        };

        const saveResponse = await fetch(`api/save-reviews/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviews: reviewForBackend, auto_save: true })
        });

        if (!saveResponse.ok) {
            console.warn(`Failed to auto-save review for hunt ${huntId}:`, await saveResponse.text());
        }
    } catch (error) {
        console.warn(`Error auto-saving review for hunt ${huntId}:`, error);
    }

    checkAllReviewsComplete();
}

export function revealLLMJudge(huntId, card) {
    const llmSection = card.querySelector(`.llm-judge-section[data-hunt-id="${huntId}"]`);
    const revealSection = card.querySelector(`.reveal-section[data-hunt-id="${huntId}"]`);

    if (llmSection) {
        llmSection.style.display = 'block';
        setTimeout(() => {
            llmSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
    }
    if (revealSection) {
        revealSection.style.display = 'none';
    }
}

export function checkAllReviewsComplete() {
    const selectedRowNumbers = state.selectedRowNumbers || [];
    if (selectedRowNumbers.length === 0) return;

    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const completedReviews = reviewKeys.filter(key => state.humanReviews && state.humanReviews[key]);
    const reviewCount = completedReviews.length;
    const totalSlots = selectedRowNumbers.length;

    if (reviewCount >= totalSlots && totalSlots >= 1) {
        showToast(`All ${totalSlots} review(s) complete! Ready to export.`, 'success');
        const _pulseReveal =
            !alignmentGateActive() ||
            revealAllowedByAlignment() ||
            (state.adminMode && adminBypass('all_grades_before_reveal'));
        if (elements.revealLLMBtn && _pulseReveal) {
            elements.revealLLMBtn.classList.add('pulse');
        }
        import('../reviewSync.js').then(({ refreshReviewSync }) => {
            refreshReviewSync(state.sessionId);
        }).catch(() => {});
    } else if (totalSlots >= 1 && reviewCount < totalSlots) {
        if (state.adminMode && adminBypass('all_grades_before_reveal')) {
            if (elements.revealLLMBtn && !state.llmRevealed) {
                elements.revealLLMBtn.disabled = false;
                elements.revealLLMBtn.style.opacity = '1';
            }
            if (elements.saveDriveBtn) {
                elements.saveDriveBtn.disabled = false;
                elements.saveDriveBtn.style.opacity = '1';
            }
        } else {
            if (elements.revealLLMBtn) {
                elements.revealLLMBtn.disabled = true;
                elements.revealLLMBtn.style.opacity = '0.5';
            }
            if (elements.saveDriveBtn) {
                elements.saveDriveBtn.disabled = true;
                elements.saveDriveBtn.style.opacity = '0.5';
            }
        }
    }
}
