/**
 * results/selectionConfirmAndProgress.js — Selection confirm, review display, progress updates,
 * change-selection flow, alignment refresh.
 */

import { elements } from '../dom.js';
import { state, setActivePhase } from '../state.js';
import { renderInsightTip } from '../utils.js';
import { showToast } from '../celebrations.js?v=43';
import { showAppModal } from '../api.js';
import { adminBypass, getHuntModeById, getSelectionSlots } from '../config.js';
import {
    recalculateAlignmentGateFromTrainer,
    revealAllowedByAlignment,
    updateAlignmentBanner,
    persistTrainerUi,
    alignmentGateActive,
    resetAlignmentGateState,
    syncAlignmentSlotDisplays,
} from '../alignment.js';
import { validateSelectionForMode } from './resultModel.js';
import {
    setReviewModeButtonsDisabled,
    collapseSelectionSectionCard,
    expandSelectionSectionCard,
} from './selectionSection.js';
import {
    displaySelectionCards,
} from './selectionTable.js';
import { createResultCard } from './llmRevealAndReviewCards.js';

export async function confirmSelection() {
    if (state.selectedRowNumbers.length === 0) {
        showToast('Please select at least 1 hunt to review', 'error');
        return;
    }

    const selectedResults = state.selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r);

    if (selectedResults.length === 0) {
        showToast(`Error: Could not find selected hunts.`, 'error');
        return;
    }

    const huntMode = state.config?.hunt_mode || 'break_50';

    const _bypassSelCount = state.adminMode && adminBypass('selection_count');
    const saveMode = getHuntModeById(huntMode);
    const saveSlots = getSelectionSlots();
    if (!_bypassSelCount && saveMode.type === 'breaking' && !saveMode.count_based && selectedResults.length !== saveSlots) {
        showToast(`Must select exactly ${saveSlots} hunts. Currently selected: ${selectedResults.length}`, 'error');
        return;
    }
    if (_bypassSelCount && selectedResults.length < 1) {
        showToast(`Select at least 1 hunt for review.`, 'error');
        return;
    }

    const validation = validateSelectionForMode(selectedResults, huntMode, state.adminMode);
    if (!validation.valid) {
        showToast(`${validation.message}`, 'error');
        return;
    }

    const n = selectedResults.length;
    const confirmed = await showAppModal({
        title: `Move these ${n} to human review?`,
        message: _bypassSelCount
            ? `These ${n} response(s) will go to the review step. Admin mode: you can save without completing all reviews.`
            : `These ${n} response(s) will go to the review step. You won't be able to change which are selected until you finish all reviews or refresh the page.`,
        buttons: [
            { label: 'Cancel', primary: false, value: false },
            { label: 'OK', primary: true, value: true }
        ]
    });
    if (!confirmed) {
        showToast('You can adjust your selection and try again.', 'info');
        return;
    }

    state.selectionConfirmed = true;
    setActivePhase('grading', {
        selected_row_numbers: state.selectedRowNumbers,
        selection_confirmed: true,
    });

    elements.resultsSection.classList.remove('hidden');

    renderInsightTip('resultsTipContainer', 'results');

    displaySelectedForReview();

    setReviewModeButtonsDisabled(true);

    disableSelectionCheckboxes();

    collapseSelectionSectionCard(selectedResults.length);

    showToast(`Selection confirmed and locked! ${selectedResults.length} hunt(s) moved to human review. Complete all ${selectedResults.length} reviews to proceed.`, 'success');
}

export function displaySelectedForReview() {
    elements.breakingResults.innerHTML = '';
    elements.noBreaksMessage.classList.add('hidden');

    const selectedResponses = state.selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r !== undefined);

    if (selectedResponses.length === 0) {
        elements.noBreaksMessage.classList.remove('hidden');
        elements.noBreaksMessage.textContent = 'No hunts selected. Select hunts from the table above to review them.';
        return;
    }

    selectedResponses.forEach((result, index) => {
        const rowNumber = state.selectedRowNumbers[index];
        const card = createResultCard(result, index, rowNumber);
        elements.breakingResults.appendChild(card);
    });

    updateReviewProgress();

    document.querySelectorAll('.llm-judge-section').forEach(section => {
        section.style.display = 'none';
    });

    elements.saveDriveContainer.classList.remove('hidden');
    if (state.adminMode && adminBypass('all_grades_before_reveal')) {
        if (elements.revealLLMBtn) {
            elements.revealLLMBtn.disabled = false;
            elements.revealLLMBtn.style.opacity = '1';
        }
    } else {
        if (elements.revealLLMBtn) {
            elements.revealLLMBtn.disabled = true;
            elements.revealLLMBtn.style.opacity = '0.5';
        }
    }
}

export function handleRefreshAlignmentClick() {
    if (!alignmentGateActive() || state.llmRevealed) {
        showToast('Alignment is not active for this step.', 'info');
        return;
    }
    const selected = state.selectedRowNumbers || [];
    const reviewKeys = selected.map((rn) => `row_${rn}`);
    if (selected.length === 0 || !reviewKeys.every((k) => state.humanReviews[k])) {
        showToast('Complete all human reviews first.', 'info');
        return;
    }
    const r = recalculateAlignmentGateFromTrainer();
    if (!r.ok) {
        showToast('Complete all human reviews first.', 'info');
        return;
    }
    updateReviewProgress();
    void persistTrainerUi();
    showToast('Alignment updated.', 'success');
}

export function disableSelectionCheckboxes() {
    const checkboxes = document.querySelectorAll('.hunt-selection-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.disabled = true;
        checkbox.style.cursor = 'not-allowed';
        checkbox.style.opacity = '0.6';
    });
}

export function enableSelectionCheckboxes() {
    const checkboxes = document.querySelectorAll('.hunt-selection-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.disabled = false;
        checkbox.style.cursor = 'pointer';
        checkbox.style.opacity = '1';
    });
}

/**
 * Change selection: go back to pick different responses. Disabled after Reveal LLM Judgments.
 */
export function handleChangeSelection() {
    if (state.llmRevealed) return;

    state.selectionConfirmed = false;
    state.diversityCheckPassed = false;
    state.selectedRowNumbers = [];

    if (state.humanReviews) {
        Object.keys(state.humanReviews).forEach(key => delete state.humanReviews[key]);
    }

    resetAlignmentGateState();
    void persistTrainerUi();

    enableSelectionCheckboxes();
    setReviewModeButtonsDisabled(false);

    const changeBtn = elements.changeSelectionBtn;
    if (changeBtn) changeBtn.style.display = 'none';

    elements.breakingResults.innerHTML = '';
    elements.saveDriveContainer.classList.add('hidden');
    syncAlignmentSlotDisplays();

    elements.selectionSection?.classList.remove('hidden');
    expandSelectionSectionCard();
    displaySelectionCards();
    elements.selectionSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    showToast('Selection cleared. Pick 4 responses again.', 'info');
}

export function updateReviewProgress() {
    if (state.selectionConfirmed) setReviewModeButtonsDisabled(true);

    const selectedRowNumbers = state.selectedRowNumbers || [];
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const reviewCount = reviewKeys.filter(key => state.humanReviews && state.humanReviews[key]).length;
    const selectedCount = selectedRowNumbers.length;

    if (elements.reviewProgressText) {
        elements.reviewProgressText.textContent = `${reviewCount} / ${selectedCount} completed`;
        elements.reviewProgressText.style.color = reviewCount === selectedCount ? 'var(--success)' : 'var(--text-primary)';
    }

    const allComplete = reviewCount >= selectedCount && selectedCount > 0;
    const _alignmentOk = revealAllowedByAlignment();

    if (allComplete && !state.llmRevealed && elements.revealLLMBtn && _alignmentOk) {
        elements.revealLLMBtn.classList.add('pulse');
    }

    const _bypassReveal = state.adminMode && adminBypass('all_grades_before_reveal');
    if (elements.revealLLMBtn) {
        if (_bypassReveal) {
            elements.revealLLMBtn.disabled = state.llmRevealed;
            elements.revealLLMBtn.style.opacity = state.llmRevealed ? '0.5' : '1';
        } else {
            elements.revealLLMBtn.disabled = !allComplete || state.llmRevealed || !_alignmentOk;
            elements.revealLLMBtn.style.opacity = (!allComplete || state.llmRevealed || !_alignmentOk) ? '0.5' : '1';
        }
        if (state.llmRevealed) {
            elements.revealLLMBtn.textContent = 'AI Evaluation Shown';
            elements.revealLLMBtn.disabled = true;
        } else if (allComplete || _bypassReveal) {
            elements.revealLLMBtn.textContent = 'Show AI Evaluation';
            if (_bypassReveal) elements.revealLLMBtn.disabled = false;
        }
    }

    const changeBtn = elements.changeSelectionBtn;
    if (changeBtn) {
        if (allComplete && !state.llmRevealed) {
            changeBtn.style.display = 'inline-block';
        } else if (state.llmRevealed) {
            changeBtn.style.display = 'none';
        }
    }

    if (elements.saveDriveBtn) {
        if (state.adminMode && adminBypass('reviews_complete_before_save')) {
            elements.saveDriveBtn.disabled = false;
            elements.saveDriveBtn.style.opacity = '1';
        } else if (allComplete && selectedCount === 4) {
            // Keep save disabled until reveal (handled in revealLLMJudgments)
        }
    }

    if (elements.submitColabBtn && !state.llmRevealed) {
        elements.submitColabBtn.disabled = true;
        elements.submitColabBtn.style.opacity = '0.5';
        if (alignmentGateActive() && allComplete && !_alignmentOk) {
            elements.submitColabBtn.title =
                'Meet the alignment target (Refresh alignment), then reveal AI evaluation to enable.';
        } else {
            elements.submitColabBtn.title = 'Reveal AI Evaluation first to enable';
        }
    }

    if (elements.reviewInstructions) {
        if (state.llmRevealed) {
            elements.reviewInstructions.textContent = 'Reviews locked. Scroll down to save.';
            elements.reviewInstructions.style.color = 'var(--success)';
        } else if (allComplete && alignmentGateActive() && state.alignmentPhase === 'idle') {
            elements.reviewInstructions.textContent =
                'All reviews complete. Click Refresh alignment to verify, then you can show AI evaluation.';
            elements.reviewInstructions.style.color = 'var(--warning)';
        } else if (allComplete && alignmentGateActive() && state.alignmentPhase === 're_review') {
            elements.reviewInstructions.textContent =
                'Alignment is below target. Edit reviews as needed, then click Refresh alignment again.';
            elements.reviewInstructions.style.color = 'var(--warning)';
        } else if (reviewCount >= selectedCount && selectedCount > 0) {
            elements.reviewInstructions.textContent = 'All reviews complete! Scroll down to show AI evaluation.';
            elements.reviewInstructions.style.color = 'var(--success)';
        } else {
            elements.reviewInstructions.textContent = `Complete all 4 human reviews, then scroll down to show AI evaluation and save.`;
        }
    }

    if (elements.bottomInstructions) {
        if (state.llmRevealed) {
            elements.bottomInstructions.textContent = 'AI Evaluation shown. Click "Proceed to Quality Check" (runs below), then Save.';
            elements.bottomInstructions.style.color = 'var(--success)';
        } else if (allComplete && alignmentGateActive() && state.alignmentPhase === 'idle') {
            elements.bottomInstructions.textContent =
                'All reviews complete. Use Refresh alignment, then "Show AI Evaluation" when it unlocks.';
            elements.bottomInstructions.style.color = 'var(--warning)';
        } else if (allComplete && alignmentGateActive() && state.alignmentPhase === 're_review') {
            elements.bottomInstructions.textContent =
                'Below alignment target — adjust grades if needed, then Refresh alignment again.';
            elements.bottomInstructions.style.color = 'var(--warning)';
        } else if (reviewCount >= selectedCount && selectedCount > 0) {
            elements.bottomInstructions.textContent = 'All reviews complete! Click "Show AI Evaluation" → then "Proceed to Quality Check".';
            elements.bottomInstructions.style.color = 'var(--success)';
        } else {
            elements.bottomInstructions.textContent = `Complete all 4 human reviews → Show AI Evaluation → Proceed to Quality Check → Save`;
            elements.bottomInstructions.style.color = 'var(--text-muted)';
        }
    }

    updateAlignmentBanner();
    syncAlignmentSlotDisplays();

    if (elements.refreshAlignmentBtn) {
        const showAlignUi =
            alignmentGateActive() && !state.llmRevealed && selectedCount > 0;
        elements.refreshAlignmentBtn.style.display = showAlignUi ? 'inline-flex' : 'none';
        const canRefresh = allComplete && showAlignUi;
        elements.refreshAlignmentBtn.disabled = !canRefresh;
    }
}
