import { state } from '../state.js';
import { adminBypass } from '../config.js';
import { getIncompleteReviewIssues, getIncompleteReviewsModalMessage, parseCriteriaToJSON } from '../utils.js';
import { showToast, showError, triggerColabConfetti } from '../celebrations.js?v=43';
import { showAppModal } from '../api.js';
export async function saveCurrentCellsToColab() {
    if (!state.sessionId) return { success: false, message: 'No active session' };

    const notebookUrl = state.notebook?.url || document.getElementById('colabUrlInput')?.value || '';
    if (!notebookUrl) return { success: false, message: 'No Colab URL' };

    const nb = state.notebook || {};
    const prompt        = nb.prompt || '';
    const idealResponse = nb.response || '';
    const criteria      = nb.response_reference || '';
    const judgePrompt   = nb.judge_system_prompt || '';

    const turnNum = state.currentTurn || 1;
    const cells = [];
    if (prompt)        cells.push({ heading: `Turn-${turnNum}: Prompt`,             content: prompt });
    if (idealResponse) cells.push({ heading: `Turn-${turnNum}: Ideal Response`,     content: idealResponse });
    if (criteria)      cells.push({ heading: `Turn-${turnNum}: Criteria`,           content: parseCriteriaToJSON(criteria) });

    if (judgePrompt) {
        const prevTurn = (state.turns || []).slice().reverse().find(t => (t.turnNumber || t.turn_number) === turnNum - 1);
        const prevJSP = prevTurn?.judge_system_prompt || '';
        const isFirstTurn = turnNum === 1;
        if (isFirstTurn || judgePrompt !== prevJSP) {
            cells.push({ heading: `Turn-${turnNum}: Judge System Prompt`, content: judgePrompt });
        }
    }

    if (cells.length === 0) return { success: false, message: 'Nothing to save' };

    return progressiveSaveToColab(cells);
}


// ============== Progressive Colab Save ==============

/**
 * Save arbitrary cells to the Colab notebook via the progressive-save endpoint.
 * Always fetches the live notebook from Drive, patches cells by heading, writes back.
 *
 * @param {Array<{heading: string, content: string}>} cells
 *        Each heading is WITHOUT the **[...]** wrapper, e.g. "Turn-1: Prompt".
 * @returns {{ success: boolean, message: string }}
 */
export async function progressiveSaveToColab(cells) {
    if (!state.sessionId) return { success: false, message: 'No active session' };
    if (!cells || cells.length === 0) return { success: false, message: 'Nothing to save' };

    const colabUrl = (state.notebook?.url || document.getElementById('colabUrlInput')?.value || '').trim();
    if (!colabUrl) return { success: false, message: 'No Colab URL' };

    try {
        const res = await fetch(`api/progressive-save/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cells, colab_url: colabUrl }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { success: false, message: err.detail || err.error || `HTTP ${res.status}` };
        }
        const data = await res.json();
        return { success: true, message: data.message || 'Saved' };
    } catch (e) {
        return { success: false, message: e.message || 'Network error' };
    }
}


export async function saveToDrive() {
    if (!state.sessionId) return;

    // ===== VALIDATION: Reviewer must have approved before Colab save =====
    if (!(state.adminMode && adminBypass('reviewer_approval'))) {
        try {
            const statusRes = await fetch(`api/session/${state.sessionId}`, { cache: 'no-store' });
            if (statusRes.ok) {
                const statusData = await statusRes.json();
                const reviewStatus = statusData.review_status || 'draft';
                if (reviewStatus !== 'approved') {
                    const msg = {
                        draft: 'Submit this task for review first. Colab save is only available after reviewer approval.',
                        submitted: 'This task is still under review. Colab save is available after the reviewer approves.',
                        returned: 'Address the reviewer feedback and resubmit. Colab save is available after the reviewer approves.',
                        rejected: 'This task was rejected by the reviewer. Colab save is not available.',
                    }[reviewStatus] || 'Colab save is only available after reviewer approval.';
                    showToast(msg, 'error');
                    return;
                }
            }
        } catch (_) { /* network error — proceed with remaining validations */ }
    }

    // ===== VALIDATION 0: Check LLM revealed =====
    if (!(state.adminMode && adminBypass('llm_revealed_before_save')) && !state.llmRevealed) {
        showToast('Complete all reviews and reveal LLM judgments before saving.', 'error');
        return;
    }
    
    const selectedRowNumbers = state.selectedRowNumbers || [];
    if (!(state.adminMode && adminBypass('selection_required_before_save')) && selectedRowNumbers.length === 0) {
        showToast('Please select hunts for review.', 'error');
        return;
    }
    
    // Get selected results and their hunt_ids
    const selectedResults = selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r);
    const selectedHuntIds = selectedResults.map(r => r.hunt_id);
    
    // Check that reviews exist for all selected row numbers
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const missingReviews = reviewKeys.filter(key => !state.humanReviews || !state.humanReviews[key]);
    if (!(state.adminMode && adminBypass('review_count_matches')) && missingReviews.length > 0) {
        showToast(`Missing reviews for ${missingReviews.length} selected hunt(s). Please complete all reviews first.`, 'error');
        console.error('Missing reviews for row numbers:', missingReviews);
        console.error('Available review keys:', Object.keys(state.humanReviews || {}));
        return;
    }
    
    // Get reviews only for selected row numbers
    const reviews = reviewKeys.map(key => state.humanReviews[key]).filter(r => r);
    
    if (!(state.adminMode && adminBypass('review_count_matches')) && reviews.length !== selectedRowNumbers.length) {
        showToast(`Only ${reviews.length}/${selectedRowNumbers.length} review(s) found for selected hunts. Please complete all reviews.`, 'error');
        return;
    }
    
    // ===== VALIDATION 1b: Check each review has criteria grading and explanation =====
    const incompleteReviews = getIncompleteReviewIssues(reviews);
    if (!(state.adminMode && adminBypass('reviews_complete_before_save')) && incompleteReviews.length > 0) {
        showToast(`${incompleteReviews.length} review(s) incomplete.`, 'error');
        await showAppModal({
            title: 'Please complete all reviews before saving',
            message: getIncompleteReviewsModalMessage(incompleteReviews),
            buttons: [ { label: 'OK', primary: true, value: true } ]
        });
        return;
    }
    
    // ===== VALIDATION 2: Removed - no longer require specific combination =====
    const failCount = reviews.filter(r => r.judgment === 'bad' || r.judgment === 'fail').length;
    const passCount = reviews.filter(r => r.judgment === 'good' || r.judgment === 'pass').length;
    
    // ===== VALIDATION: Check if diversity check was already passed at confirmation =====
    if (!(state.adminMode && adminBypass('diversity_check')) && !state.diversityCheckPassed) {
        console.warn('Diversity check not passed at confirmation. This should not happen if user confirmed selection properly.');
        showToast('Diversity check was not completed. Please confirm your selection again.', 'error');
        return;
    }
    
    
    // ===== All validations passed - proceed with save =====
    const btn = document.getElementById('saveDriveBtn');
    if (!btn) {
        console.error("Save button not found");
        return;
    }
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    
    try {
        // Convert row-based review keys back to hunt_id-based keys for backend compatibility
        const selectedRowNumbers = state.selectedRowNumbers || [];
        const selectedResults = selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r);
        const reviewsForBackend = {};
        const missingReviews = [];
        
        
        selectedRowNumbers.forEach((rn, index) => {
            const reviewKey = `row_${rn}`;
            const review = state.humanReviews[reviewKey];
            const currentSlotNum = index + 1;
            
            
            if (review && selectedResults[index]) {
                // CRITICAL FIX: Use slotNum as part of the key to handle duplicate hunt_ids
                // Format: "hunt_id:slotNum" to ensure uniqueness
                const uniqueKey = `${selectedResults[index].hunt_id}:${currentSlotNum}`;
                reviewsForBackend[uniqueKey] = {
                    hunt_id: selectedResults[index].hunt_id,  // Keep hunt_id for reference
                    judgment: review.judgment,
                    grading_basis: review.grading_basis,
                    explanation: review.explanation,
                    slotNum: currentSlotNum,  // Use current position, not the old slotNum from review
                    timestamp: review.timestamp
                };
            } else if (selectedResults[index]) {
                // Review missing for this hunt
                missingReviews.push({
                    hunt_id: selectedResults[index].hunt_id,
                    row_number: rn,
                    slot_num: currentSlotNum
                });
            }
        });
        
        // VALIDATION: No save without reviews — bypass in admin mode (save without reviewing all)
        if (!(state.adminMode && adminBypass('reviews_complete_before_save')) && missingReviews.length > 0) {
            showToast('Cannot save: all 4 slots must have a review. Please complete reviews for every selected slot.', 'error');
            btn.disabled = false;
            btn.textContent = originalText;
            return;
        }
        
        // ===== QUALITY CHECK: QC now runs via "Proceed to Quality Check" (inline below). =====
        // Save is enabled only after QC completes. No QC gate here.
        
        // ===== WYSIWYG SNAPSHOT APPROACH =====
        if (selectedResults.length === 0 && !(state.adminMode && adminBypass('selection_required_before_save'))) {
            throw new Error(`No selected results to save. Please select at least 1 hunt.`);
        }
        
        // Validate each result has required fields
        selectedResults.forEach((result, index) => {
            if (!result || typeof result !== 'object') {
                throw new Error(`Invalid result at index ${index}: must be an object`);
            }
            if (!result.hunt_id) {
                throw new Error(`Result at index ${index} missing 'hunt_id' field`);
            }
            if (result.response === undefined && result.response !== null) {
                throw new Error(`Result at index ${index} missing 'response' field`);
            }
        });
        
        // Count only valid responses (exclude empty response errors)
        const validResponseCount = state.allResponses.filter(r => 
            r.response && r.response.trim() && !r.error
        ).length;
        
        // Validate we have original notebook
        // Get URL from notebook (stored when fetched)
        const notebookUrl = state.notebook?.url || document.getElementById('colabUrlInput')?.value;
        if (!notebookUrl) {
            throw new Error('No Colab URL found. Please fetch notebook from URL.');
        }
        
        // If original_notebook_json is missing, try to fetch it from the backend session storage
        let originalNotebookJson = state.originalNotebookJson;
        if (!originalNotebookJson && state.sessionId) {
            console.warn('originalNotebookJson missing, attempting to fetch from session storage...');
            try {
                const response = await fetch(`api/get-original-notebook/${state.sessionId}`);
                if (response.ok) {
                    const data = await response.json();
                    originalNotebookJson = data.original_notebook_json;
                    // Cache it in state for future use
                    state.originalNotebookJson = originalNotebookJson;
                } else {
                    console.error('Failed to fetch original notebook:', await response.text());
                }
            } catch (e) {
                console.error('Failed to fetch original content from session:', e);
            }
        }
        
        if (!originalNotebookJson) {
            throw new Error('Original notebook content not available. Please reload the notebook from URL or file.');
        }
        
        // Create snapshot
        // Note: selected_results order determines slots 1-4 (index 0 = slot 1, index 1 = slot 2, etc.)
        const totalHunts = state.isMultiTurn 
            ? state.multiTurnTotalHunts + validResponseCount 
            : validResponseCount;
        
        const snapshot = {
            original_notebook_json: originalNotebookJson,
            url: notebookUrl,
            selected_results: selectedResults,  // Order preserved - determines slot assignment
            human_reviews: reviewsForBackend,
            total_hunts_ran: totalHunts,
            include_reasoning: true,
            metadata: {
                parsed_notebook: {
                    filename: state.notebook?.filename || 'notebook.ipynb',
                    metadata: state.notebook?.metadata || {},
                    prompt: state.notebook?.prompt || '',
                    response: state.notebook?.response || '',
                    response_reference: state.notebook?.response_reference || '',
                    judge_system_prompt: state.notebook?.judge_system_prompt || '',
                    judge_prompt_template: state.notebook?.judge_prompt_template || '',
                    model_slots: state.notebook?.model_slots || []
                },
                // Multi-turn data (included when applicable)
                is_multi_turn: state.isMultiTurn,
                turns: state.isMultiTurn ? [...state.turns, {
                    turn_number: state.currentTurn,
                    prompt: state.notebook?.prompt || '',
                    response_reference: state.notebook?.response_reference || '',
                    status: 'breaking',
                    results: selectedResults
                }] : [],
                conversation_history: state.isMultiTurn ? state.conversationHistory : []
            }
        };
        
        // Send snapshot to new endpoint
        const response = await fetch('api/save-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snapshot)
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || err.error || 'Save failed');
        }
        
        const result = await response.json();
        
        const successMessage = missingReviews.length > 0
            ? `Saved to Google Drive! (Note: ${missingReviews.length} hunt(s) saved without reviews)`
            : 'Successfully saved to Colab notebook!';
        
        showToast(successMessage, missingReviews.length > 0 ? 'warning' : 'success');
        triggerColabConfetti();
        
    } catch (error) {
        console.error('Drive Save Error:', error);
        showError(error, { operation: 'Save to Colab', retry: () => saveToDrive() });
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}
