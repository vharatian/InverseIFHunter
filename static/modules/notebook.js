/**
 * notebook.js — File Upload, Notebook Loading, Preview & Save
 * 
 * Handles notebook upload/fetch, preview tab population, metadata display,
 * save handlers, criteria parsing, and Drive integration.
 * 
 * Dependencies: config.js, utils.js, state.js, dom.js (+ editors, results, auth, api, hunt)
 */

import { elements } from './dom.js';
import { state } from './state.js';
import { PROVIDER_MODELS, ADMIN_MODE_PASSWORD, getConfigValue, fetchConfigFromAPI, adminBypass, getHuntModeById } from './config.js';
import { 
    escapeHtml, 
    loadHuntCount, 
    saveHuntCount, 
    clearHuntCount,
    renderInsightTip,
    startTipRotation,
    getIncompleteReviewIssues,
    getIncompleteReviewsModalMessage,
    getModelDisplayName,
    parseCriteriaToJSON
} from './utils.js';
import { showToast, showError, triggerColabConfetti } from './celebrations.js';
import { clearPreviousResults, formatJudgeCriteriaDisplay, warmupConnections, setReviewModeButtonsDisabled } from './results.js';
import { 
    validateModelMatch, 
    updateModelOptions, 
    validatePromptLength,
    showModelLockedIndicator,
    hideModelLockedIndicator
} from './editors.js';
import { showAppModal, showPasswordPrompt } from './api.js';
import { playFetchSuccess, playFetchError, playFinalSubmission, playFinalSubmissionError } from './sounds.js';
import { activateAdminMode } from './adminMode.js';
import { runQualityCheckOverlay } from './qualityCheckOverlay.js';
import { renderQCPersistentSection } from './qcPersistentSection.js';
import { runQualityCheckInline } from './qcInline.js';
import { enableNavTestbedButton, validateJudgeOutputFormat, syncActiveRunToNotebook } from './testbed.js';

function _appendNbStreamCriterion(containerId, event) {
    const body = document.getElementById(containerId);
    if (!body) return;
    const isPass = event.status === 'PASS';
    const isMissing = event.status === 'MISSING';
    const icon = isMissing ? '⚠️' : isPass ? '✅' : '❌';
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

/**
 * Enable/disable the Colab save button based on review_status.
 * Save is only allowed when review_status is "approved" (post-reviewer-approval)
 * or in admin mode.
 */
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
        const res = await fetch(`/api/session/${state.sessionId}`, { cache: 'no-store' });
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

/**
 * Run quality check inline (below grading section, no modal).
 * Enables Save button when complete.
 */
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
        btn.textContent = '⏳ Running QC…';
    }

    try {
        await runQualityCheckInline(parent, state.sessionId, selectedHuntIds, humanReviewsForApi, async (result) => {
            state.qcLastResult = result;
            if (result.overridden) showToast('Save proceeded with human override.', 'info');
            // Mark QC done so Submit for review becomes available
            try {
                await fetch(`/api/session/${state.sessionId}/mark-qc-done`, { method: 'POST' });
                const { refreshReviewSync } = await import('./reviewSync.js');
                refreshReviewSync(state.sessionId);
            } catch (_) { /* ignore */ }
            // Colab save stays locked until reviewer approves — refresh will handle it
            await _refreshSaveBtnFromStatus();
        }, storeEvaluation);
    } catch (err) {
        showToast(err.message || 'Quality check failed.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '✓ Proceed to Quality Check';
        }
    }
}

/**
 * Run quality check with full-screen overlay (live rule-by-rule display).
 * @param {number[]} selectedHuntIds
 * @param {Record<string, { grades: Record<string, string>, explanation: string, submitted: boolean }>} humanReviews
 * @returns {Promise<{ passed: boolean, issues: Array, evaluation?: object }>}
 */
async function runQualityCheckBeforeSave(selectedHuntIds, humanReviews) {
    const storeEvaluation = async (payload) => {
        const storageKey = `quality_check_evaluation_${state.sessionId}`;
        sessionStorage.setItem(storageKey, JSON.stringify(payload));
        const parent = document.getElementById('qcPersistentParent');
        if (parent) renderQCPersistentSection(parent, payload, state.sessionId);
        try {
            await fetch(`/api/session/${state.sessionId}/mark-qc-done`, { method: 'POST' });
            const { refreshReviewSync } = await import('./reviewSync.js');
            refreshReviewSync(state.sessionId);
        } catch (_) { /* ignore */ }
    };
    const openEvaluationSameWindow = () => {
        const evalUrl = `${window.location.origin}/evaluation-results?session_id=${encodeURIComponent(state.sessionId)}`;
        window.location.href = evalUrl;
    };
    return runQualityCheckOverlay(state.sessionId, selectedHuntIds, humanReviews, storeEvaluation, openEvaluationSameWindow);
}
import { getTrainerInfo, startHeartbeat } from './auth.js';
import { updateHuntLimitUI, unlockHuntMode } from './hunt.js';
import { resetAllStatuses } from './autosave.js';

// ============== Turn Status Sync (Multi-Turn Restore) ==============

/**
 * Fetch turn-status from backend and restore state.turns + conversationHistory.
 * Call when loading a notebook or on session restore (page refresh) so Turn 2+ history displays correctly.
 */
export async function syncTurnStatusFromBackend(sessionId) {
    try {
        const res = await fetch(`/api/turn-status/${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.is_multi_turn || !data.turns?.length) return;
        const sessionJudgeModel = data.judge_model || '';
        state.turns = (data.turns || []).map(t => ({
            turnNumber: t.turn_number ?? t.turnNumber,
            turn_number: t.turn_number ?? t.turnNumber,
            prompt: t.prompt ?? '',
            response_reference: t.response_reference ?? t.criteria ?? '',
            criteria: t.response_reference ?? t.criteria ?? '',
            response: t.selected_response ?? t.selectedResponse ?? t.response ?? null,
            selectedResponse: t.selected_response ?? t.selectedResponse ?? null,
            selected_response: t.selected_response ?? t.selectedResponse ?? null,
            judgeResult: t.judge_result ?? t.judgeResult ?? null,
            judge_result: t.judge_result ?? t.judgeResult ?? null,
            judgeModel: sessionJudgeModel,
            results: t.results ?? []
        }));
        state.conversationHistory = data.conversation_history || [];
        state.currentTurn = data.current_turn ?? 1;
        state.isMultiTurn = !!data.is_multi_turn;
        state.multiTurnTotalHunts = state.turns.reduce((sum, t) => sum + (t.results?.length || 0), 0);
        // Defer UI update to avoid circular import
        const { renderTurnHistoryTabs, updateTurnAwareUI } = await import('./multiturn.js');
        renderTurnHistoryTabs();
        updateTurnAwareUI();

        // Hide Turn 1 Test Prompt panel when in Turn 2+
        updateTurn1TestPromptVisibility();
    } catch (e) {
        console.debug('Turn status sync skipped:', e);
    }
}

// ============== Original Notebook JSON Update Helper ==============
/**
 * Update originalNotebookJson with a saved cell.
 * This ensures that when we later save the snapshot, all previously saved cells are included.
 * 
 * @param {string} cellHeading - The heading/marker for the cell (e.g., 'prompt', 'response', 'response_reference')
 * @param {string} content - The new content for the cell
 */
export function updateOriginalNotebookWithCell(cellHeading, content) {
    if (!state.originalNotebookJson) {
        console.warn('Cannot update originalNotebookJson: not set');
        return;
    }
    
    try {
        const notebook = JSON.parse(state.originalNotebookJson);
        const cells = notebook.cells || [];
        
        // Format the cell heading to match notebook format (e.g., **[prompt]**)
        const headingPattern = new RegExp(`\\*\\*\\[${cellHeading}\\]\\*\\*`, 'i');
        
        // Find existing cell with this heading
        let cellIndex = cells.findIndex(cell => {
            const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
            return headingPattern.test(source);
        });
        
        // Format the new cell content
        const formattedContent = `**[${cellHeading}]**\n\n${content}`;
        
        if (cellIndex >= 0) {
            // Update existing cell
            cells[cellIndex].source = [formattedContent];
        } else {
            // Find insertion point - after metadata, before any model slots
            // Look for judge_system_prompt or judge_prompt_template as anchor
            let insertIndex = cells.length;
            
            // Try to insert before model slots or at the end of setup cells
            for (let i = 0; i < cells.length; i++) {
                const source = Array.isArray(cells[i].source) ? cells[i].source.join('') : (cells[i].source || '');
                // Insert before any model slot cells
                if (/\*\*\[(qwen|nemotron|model)_\d\]\*\*/i.test(source)) {
                    insertIndex = i;
                    break;
                }
                // Insert before number_of_attempts_made
                if (/\*\*\[number_of_attempts_made\]\*\*/i.test(source)) {
                    insertIndex = i;
                    break;
                }
            }
            
            // Create new cell
            const newCell = {
                cell_type: 'markdown',
                id: `auto_${cellHeading}_${Date.now()}`,
                metadata: {},
                source: [formattedContent]
            };
            
            cells.splice(insertIndex, 0, newCell);
        }
        
        notebook.cells = cells;
        state.originalNotebookJson = JSON.stringify(notebook, null, 2);
        
    } catch (e) {
        console.error('Failed to update originalNotebookJson:', e);
    }
}

// ============== File Upload ==============

export function initFileUpload() {
    const dropzone = elements.fileDropzone;
    const input = elements.fileInput;
    
    // Only setup file upload if elements exist (may have been removed)
    if (dropzone && input) {
        dropzone.addEventListener('click', () => input.click());
        
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });
        
        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });
        
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            
            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.ipynb')) {
                uploadFile(file);
            } else {
                showToast('Please upload a .ipynb file', 'error');
            }
        });
        
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                uploadFile(file);
            }
        });
    }
    
    // URL Fetch button - ensure it's properly set up
    const setupFetchButton = () => {
        // Get button element (try elements first, then DOM)
        let fetchBtn = elements.fetchUrlBtn || document.getElementById('fetchUrlBtn');
        
        if (fetchBtn) {
            // Update elements reference
            elements.fetchUrlBtn = fetchBtn;
            
            // Remove any existing listeners
            fetchBtn.onclick = null;
            
            // Create a new handler function
            const handleFetchClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                fetchFromUrl();
            };
            
            // Add click event listener with capture phase to ensure it fires
            fetchBtn.addEventListener('click', handleFetchClick, true);
            
            // Also add onclick as fallback
            fetchBtn.onclick = handleFetchClick;
            
            // Ensure button is enabled and has correct type
            fetchBtn.disabled = false;
            fetchBtn.type = 'button'; // Ensure it doesn't submit forms
            
            // Make sure button is not hidden or has pointer-events disabled
            fetchBtn.style.pointerEvents = 'auto';
            fetchBtn.style.cursor = 'pointer';
            
        } else {
            console.error('fetchUrlBtn element not found during initialization');
            // Retry after a short delay in case DOM isn't ready
            setTimeout(() => {
                const retryBtn = document.getElementById('fetchUrlBtn');
                if (retryBtn) {
                    setupFetchButton();
                } else {
                    console.error('❌ Fetch button still not found after retry');
                }
            }, 100);
        }
    };
    
    setupFetchButton();
    
    // "New Notebook" button
    const createBtn = document.getElementById('createNotebookBtn');
    if (createBtn) {
        createBtn.addEventListener('click', (e) => {
            e.preventDefault();
            createNotebook();
        });
    }

    // Enter key in URL input
    if (elements.colabUrlInput) {
        elements.colabUrlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                fetchFromUrl();
            }
        });
    }
}

export async function uploadFile(file, forceNew = false) {
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        showToast('Uploading notebook...', 'info');
        
        const trainerInfo = getTrainerInfo();
        const headers = {};
        if (trainerInfo) {
            headers['X-Trainer-Email'] = trainerInfo.email;
            headers['X-Trainer-Name'] = trainerInfo.name;
        }
        let url = '/api/upload-notebook';
        if (forceNew) url += '?force_new=true';
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: formData
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Upload failed');
        }
        
        const data = await response.json();

        if (data.duplicate_found) {
            const choice = await _showDuplicateModal(data.task_id, data.existing_sessions);
            if (choice === 'resume') {
                document.dispatchEvent(new CustomEvent('open-existing-session', { detail: { sessionId: data.existing_sessions[0].session_id } }));
                return;
            }
            if (choice === 'new') {
                return uploadFile(file, true);
            }
            return;
        }

        handleNotebookLoaded(data, false);
        
    } catch (error) {
        showError(error, { operation: 'Upload' });
    }
}

async function _showDuplicateModal(taskId, existingSessions) {
    const sess = existingSessions[0];
    const statusLabel = sess.review_status || sess.hunt_status || 'in-progress';
    return showAppModal({
        title: 'Task already exists',
        message: `A session for task "${taskId}" already exists (status: ${statusLabel}, session: ${sess.session_id}).\n\nWould you like to resume the existing session or start a new one?`,
        buttons: [
            { label: 'Resume existing', primary: true, value: 'resume' },
            { label: 'Start fresh', value: 'new' },
            { label: 'Cancel', value: 'cancel' },
        ],
    });
}

export async function fetchFromUrl(forceNew = false) {
    
    // Re-get elements in case they changed
    if (!elements.colabUrlInput) {
        elements.colabUrlInput = document.getElementById('colabUrlInput');
    }
    if (!elements.fetchUrlBtn) {
        elements.fetchUrlBtn = document.getElementById('fetchUrlBtn');
    }
    
    if (!elements.colabUrlInput) {
        console.error('colabUrlInput element not found');
        showToast('URL input field not found', 'error');
        return;
    }
    
    if (!elements.fetchUrlBtn) {
        console.error('fetchUrlBtn element not found');
        showToast('Fetch button not found', 'error');
        return;
    }
    
    const url = elements.colabUrlInput.value?.trim();
    if (!url) {
        showToast('Please enter a Colab URL', 'error');
        return;
    }
    
    try {
        showToast('Fetching notebook from URL...', 'info');
        elements.fetchUrlBtn.disabled = true;
        elements.fetchUrlBtn.textContent = '⏳ Fetching...';
        
        const trainerInfo = getTrainerInfo();
        const response = await fetch('/api/fetch-notebook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, trainer_email: trainerInfo?.email, trainer_name: trainerInfo?.name, force_new: forceNew })
        });
        
        
        if (!response.ok) {
            let errorMessage = 'Fetch failed';
            try {
            const error = await response.json();
                errorMessage = error.detail || error.message || 'Fetch failed';
            } catch (e) {
                errorMessage = `HTTP ${response.status}: ${response.statusText}`;
            }
            throw new Error(errorMessage);
        }
        
        const data = await response.json();

        if (data.duplicate_found) {
            const choice = await _showDuplicateModal(data.task_id, data.existing_sessions);
            if (choice === 'resume') {
                document.dispatchEvent(new CustomEvent('open-existing-session', { detail: { sessionId: data.existing_sessions[0].session_id } }));
                return;
            }
            if (choice === 'new') {
                return fetchFromUrl(true);
            }
            return;
        }

        handleNotebookLoaded(data, true);
        playFetchSuccess();
        
    } catch (error) {
        console.error('Error fetching notebook:', error);
        playFetchError();
        showError(error, { operation: 'Fetch notebook', retry: fetchFromUrl });
    } finally {
        if (elements.fetchUrlBtn) {
            elements.fetchUrlBtn.disabled = false;
            elements.fetchUrlBtn.textContent = '📥 Fetch';
        }
    }
}

export async function createNotebook() {
    const btn = document.getElementById('createNotebookBtn');
    const titleInput = document.getElementById('newNotebookTitleInput');
    const title = titleInput?.value?.trim() || 'Trainer Notebook';

    try {
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating...'; }
        showToast('Creating notebook in Google Drive...', 'info');

        const trainerInfo = getTrainerInfo();
        const response = await fetch('/api/create-notebook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title,
                trainer_email: trainerInfo?.email || null,
                trainer_name: trainerInfo?.name || null,
            }),
        });

        if (!response.ok) {
            let errorMessage = 'Failed to create notebook';
            try {
                const err = await response.json();
                errorMessage = err.detail || err.message || errorMessage;
            } catch (_) { /* ignore */ }
            throw new Error(errorMessage);
        }

        const data = await response.json();

        // Stash the Drive URL and file_id so saves work immediately
        data.notebook_url = data.notebook_url || null;
        data._file_id = data.file_id || null;

        showToast(
            data.shared_with
                ? `Notebook created and shared with ${data.shared_with}`
                : 'Notebook created in Drive',
            'success'
        );

        handleNotebookLoaded(data, true, data.notebook_url);

    } catch (error) {
        console.error('Error creating notebook:', error);
        showError(error, { operation: 'Create notebook' });
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '+ New Notebook'; }
    }
}

export function handleNotebookLoaded(data, isUrl = false, overrideUrl = null) {
    // Clear any previous results when loading a new notebook
    clearPreviousResults();
    
    // Reset testbed (new notebook = fresh slate) then auto-open it
    import('./testbed.js').then(({ resetTestbed, hideTestbed, showTestbed }) => {
        hideTestbed();
        resetTestbed();
        // Auto-open testbed so user lands there first
        showTestbed();
    }).catch(() => {/* testbed not loaded yet, no-op */});
    
    // Warm up API connections in background for faster hunt execution
    warmupConnections();
    
    state.sessionId = data.session_id;
    state.notebook = data.notebook;
    
    // Start heartbeat now that we have a session
    startHeartbeat();
    // Store original notebook JSON for WYSIWYG snapshot
    state.originalNotebookJson = data.original_notebook_json || null;
    // Store URL if this was fetched/created from URL
    if (isUrl && data.notebook) {
        state.notebook.url = overrideUrl || elements.colabUrlInput?.value || null;
    }
    
    // Set notebook ID for hunt limit tracking (use file_id if available, or generate from URL/session)
    const notebookUrl = overrideUrl || elements.colabUrlInput?.value || '';
    const fileIdMatch = notebookUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || notebookUrl.match(/drive\/([a-zA-Z0-9_-]+)/);
    state.notebookId = fileIdMatch ? fileIdMatch[1] : data.session_id;
    
    // Reset hunt count for new session (new notebook load = fresh start)
    clearHuntCount(state.notebookId);
    state.totalHuntsCount = 0;
    state.huntsThisTurn = 0;
    state.huntLimitReached = false;
    
    // Unlock hunt mode for fresh notebook (was locked during previous session)
    unlockHuntMode();
    
    updateHuntLimitUI();
    
    // Save sessionId to localStorage for restoration on refresh
    if (data.session_id) {
        localStorage.setItem('modelHunter_sessionId', data.session_id);
        // Sync turn status from backend (restore turns and conversation history for multi-turn sessions)
        syncTurnStatusFromBackend(data.session_id);
    }

    // Show Turn 1 Test Prompt panel when in Turn 1 (will be updated when syncTurnStatusFromBackend completes)
    updateTurn1TestPromptVisibility();
    
    // Toggle UI sections
    // Keep URL section visible (don't hide uploadSection)
    elements.configSection.classList.remove('hidden');
    
    // Handle Save to Drive visibility (Container)
    if (elements.saveDriveContainer) {
        if (isUrl) {
            elements.saveDriveContainer.classList.remove('hidden');
        } else {
            elements.saveDriveContainer.classList.add('hidden');
        }
    }
    
    // Auto-collapse the upload section (notebook is loaded, no need to show it)
    const uploadBody = document.getElementById('uploadBody');
    const uploadChevron = document.getElementById('uploadChevron');
    const uploadHeaderText = document.getElementById('uploadHeaderText');
    if (uploadBody && uploadChevron) {
        uploadBody.classList.add('collapsed');
        uploadChevron.classList.add('collapsed');
    }
    if (uploadHeaderText) {
        uploadHeaderText.textContent = 'Notebook Loaded ✓';
    }
    
    // Config section is shown after testbed "Use as Ideal Response" commit
    // (was previously shown here — now deferred to promoteResponse in testbed.js)
    elements.configSection.classList.add('hidden');
    
    // Show a contextual config tip
    renderInsightTip('configTipContainer', 'config');
    
    // Preselect model based on notebook metadata or model_slots
    let modelPrefix = null;
    let modelSource = null; // Track where we got the model from
    
    // First, try to get model from metadata (most explicit) - PRIORITY 1
    if (data.notebook.metadata) {
        const metadata = data.notebook.metadata;
        
        // Try multiple variations: Model, model, MODEL, and case-insensitive search
        let rawModel = metadata.Model || metadata.model || metadata['Model'] || metadata['model'];
        
        // Also try case-insensitive search
        if (!rawModel) {
            const modelKey = Object.keys(metadata).find(k => k.toLowerCase() === 'model');
            if (modelKey) {
                rawModel = metadata[modelKey];
            }
        }
        
        if (rawModel) {
            // Clean the value: remove leading dashes, spaces, colons, trim
            // Handles cases like "Model: - qwen" -> "qwen", " - qwen" -> "qwen"
            modelPrefix = rawModel.toString().trim().replace(/^[-:\s]+/, '').trim();
            if (modelPrefix) {
                modelSource = 'metadata';
            } else {
                console.warn(`⚠️ Model value in metadata was empty after cleaning: "${rawModel}"`);
            }
        } else {
        }
    } else {
    }
    
    // Fallback: extract from model_slots ONLY if metadata didn't provide a model - PRIORITY 2
    if (!modelPrefix && data.notebook.model_prefix) {
        modelPrefix = data.notebook.model_prefix;
        modelSource = 'model_slots';
    }
    
    // Warn if there's a conflict between metadata and model_slots
    if (modelSource === 'metadata' && data.notebook.model_prefix && 
        modelPrefix.toLowerCase() !== data.notebook.model_prefix.toLowerCase()) {
        console.warn(`⚠️ CONFLICT: Metadata says "${modelPrefix}" but model_slots say "${data.notebook.model_prefix}". Using metadata (PRIORITY).`);
    }
    
    // If still no model, check if default should be used
    if (!modelPrefix) {
        modelPrefix = 'qwen'; // Set default
        modelSource = 'default';
    }
    
    
    // Map model prefix to model ID
    if (modelPrefix) {
        const modelPrefixLower = modelPrefix.toLowerCase().trim();
        let modelId = null;
        let provider = 'openrouter'; // Default provider
        
        
        if (modelPrefixLower === 'nemotron' || modelPrefixLower.includes('nemotron')) {
            modelId = 'nvidia/nemotron-3-nano-30b-a3b';
            provider = 'openrouter';
        } else if (modelPrefixLower === 'qwen' || modelPrefixLower.includes('qwen')) {
            // Prefer openrouter if available, fallback to fireworks
            if (PROVIDER_MODELS['openrouter']?.some(m => m.id.includes('qwen'))) {
                modelId = 'qwen/qwen3-235b-a22b-thinking-2507';
                provider = 'openrouter';
            } else if (PROVIDER_MODELS['fireworks']?.some(m => m.id.includes('qwen'))) {
                modelId = 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507';
                provider = 'fireworks';
            }
        } else if (modelPrefixLower === 'sonnet' || modelPrefixLower.includes('sonnet')) {
            modelId = 'anthropic/claude-sonnet-4.5';
            provider = 'openrouter';
        } else if (modelPrefixLower === 'opus' || modelPrefixLower.includes('opus')) {
            modelId = 'anthropic/claude-opus-4.5';
            provider = 'openrouter';
        } else {
            console.warn(`⚠️ Unknown model prefix: "${modelPrefix}". Will use default (Qwen).`);
            // Default to Qwen if unknown
            modelId = 'qwen/qwen3-235b-a22b-thinking-2507';
            provider = 'openrouter';
        }
        
        // Set the provider and model if found
        if (modelId && elements.providerSelect && elements.modelSelect) {
            // Store the intended model BEFORE any dropdown rebuilds
            state._preselectedModelId = modelId;
            state.config.models = [modelId];
            // Set provider
            elements.providerSelect.value = provider;
            // Rebuild dropdown — will honor _preselectedModelId
            updateModelOptions(false);
            // Force-set again after dropdown is built (belt and suspenders)
            elements.modelSelect.value = modelId;
            showToast(`Model preselected: ${modelPrefix}`, 'info');
        } else {
            console.warn('⚠️ Provider or model select elements not found');
        }
    } else {
        // No model detected - use default (Qwen)
        if (elements.providerSelect && elements.modelSelect) {
            elements.providerSelect.value = 'openrouter';
            updateModelOptions();
            setTimeout(() => {
                const defaultModel = 'qwen/qwen3-235b-a22b-thinking-2507';
                if (elements.modelSelect.querySelector(`option[value="${defaultModel}"]`)) {
                    elements.modelSelect.value = defaultModel;
                    state.config.models = [defaultModel];
                }
            }, 100);
        }
    }
    
    // Find Breaking Responses: always enabled when notebook is loaded
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = false;
        elements.startHuntBtn.title = '';
    }
    
    // Populate preview tabs
    populatePreviewTabs(data.notebook);
    
    // Always show success notification (load silently, no warning toasts)
    showToast('Notebook loaded successfully', 'success');
}

// ============== Lightweight pre-hunt save ==============

/**
 * Save current notebook content (prompt, ideal response, criteria, judge prompts)
 * to the Colab notebook using the progressive save endpoint with turn-aware headings.
 * Returns { success: boolean, message: string }.
 */
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
        const res = await fetch(`/api/progressive-save/${state.sessionId}`, {
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
            const statusRes = await fetch(`/api/session/${state.sessionId}`, { cache: 'no-store' });
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
        console.warn('⚠️ Diversity check not passed at confirmation. This should not happen if user confirmed selection properly.');
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
    btn.textContent = '⏳ Saving...';
    
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
            console.warn('⚠️ originalNotebookJson missing, attempting to fetch from session storage...');
            try {
                const response = await fetch(`/api/get-original-notebook/${state.sessionId}`);
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
        const response = await fetch('/api/save-snapshot', {
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
            ? `✅ Saved to Google Drive! (Note: ${missingReviews.length} hunt(s) saved without reviews)`
            : '✅ Successfully saved to Colab notebook!';
        
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

// ============== Submit to Colab (trainer-initiated, post-LLM-reveal) ==============

/**
 * Build a markdown cell in .ipynb format.
 */
function _makeCell(heading, content, cellId) {
    return {
        cell_type: 'markdown',
        id: cellId || `cell_${heading.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`,
        metadata: {},
        source: [`**[${heading}]**\n\n${content}`]
    };
}

/**
 * Format helpers for the four per-slot cells.
 */
function _slotModelResponse(result) {
    return result.response || '(no response)';
}

function _slotLlmJudge(result) {
    const lines = [];
    const llmScore = result.judge_score !== undefined && result.judge_score !== null
        ? result.judge_score : '(n/a)';
    const llmCriteria = result.judge_criteria || {};
    const llmExplanation = result.judge_explanation || '(no explanation)';
    if (Object.keys(llmCriteria).length > 0) {
        lines.push(`**Criteria Grades:**\n\`\`\`json\n${JSON.stringify(llmCriteria, null, 2)}\n\`\`\``);
    }
    lines.push(`\n**Score:** ${llmScore}`);
    lines.push(`\n**Explanation:**\n${llmExplanation}`);
    return lines.join('\n');
}

function _slotHumanJudge(review) {
    if (!review) return '(no human review)';
    const lines = [];
    const grading = review.grading_basis || {};
    const gradingJson = JSON.stringify(
        Object.fromEntries(Object.entries(grading).map(([k, v]) => [k, String(v).toUpperCase()])),
        null, 2
    );
    const total = Object.keys(grading).length;
    const passCount = Object.values(grading).filter(v => String(v).toUpperCase() === 'PASS').length;
    const score = total > 0 && passCount > total / 2 ? 1 : 0;
    lines.push(`**Grading Basis:**\n\`\`\`json\n${gradingJson}\n\`\`\``);
    lines.push(`\n**Score:** ${score} point(s) — \`{"answer_score": ${score}}\``);
    lines.push(`\n**Explanation:**\n${review.explanation || '(no explanation)'}`);
    return lines.join('\n');
}

function _slotReasoningTrace(result) {
    return result.reasoning_trace || '(no reasoning trace)';
}

/**
 * Sanitise a model name/id for use as a cell label prefix.
 * e.g. "anthropic/claude-opus-4-6" → "ClaudeOpus46"
 *      "gpt-5.2"                    → "GPT5.2"
 */
function _modelCellName(modelId) {
    const display = getModelDisplayName(modelId);
    // Remove spaces, keep dots so "GPT 5.2" → "GPT5.2", "Claude Opus 4 6" → "ClaudeOpus46"
    return display.replace(/\s+/g, '');
}

/**
 * Build the full notebook JSON for a single turn (or the current turn if no multi-turn).
 * turnLabel: e.g. "Turn-1"
 * @param {number} turnNumber — 1-based turn number
 * @param {string} prevJudgeSystemPrompt — the previous turn's judge system prompt (empty for turn 1)
 */
function _buildTurnCells(turnLabel, turnData, selectedResults, reviews, selectedRowNumbers, totalAttempts, turnNumber = 1, prevJudgeSystemPrompt = '') {
    const cells = [];

    // Prompt
    cells.push(_makeCell(
        `${turnLabel}: Prompt`,
        turnData.prompt || '',
        `cell_${turnLabel}_prompt`
    ));

    // Ideal Response — the testbed-generated response (state.notebook.response)
    cells.push(_makeCell(
        `${turnLabel}: Ideal Response`,
        turnData.response || '',
        `cell_${turnLabel}_ideal_response`
    ));

    // Criteria — response_reference normalised to JSON array format
    cells.push(_makeCell(
        `${turnLabel}: Criteria`,
        parseCriteriaToJSON(turnData.response_reference || ''),
        `cell_${turnLabel}_criteria`
    ));

    // Judge Prompt Template — only saved on the first turn
    if (turnNumber === 1) {
        const judgePromptTemplate = `Question\n{prompt}\n\nStudent Response\n{model_response}\n\nStandard Response\n{standard_response}\n\nEvaluation Criteria\n{criteria}`;
        cells.push(_makeCell(
            `${turnLabel}: judge_prompt_template`,
            judgePromptTemplate,
            `cell_${turnLabel}_judge_prompt_template`
        ));
    }

    // Judge System Prompt — saved on turn 1 (mandatory) or if changed from previous turn
    const judgePrompt = turnData.judge_system_prompt || '';
    if (turnNumber === 1 || judgePrompt !== prevJudgeSystemPrompt) {
        cells.push(_makeCell(
            `${turnLabel}: Judge System Prompt`,
            judgePrompt,
            `cell_${turnLabel}_judge_system_prompt`
        ));
    }

    // 4 selected slots — each slot produces 4 consecutive cells:
    // ModelName_N, llm_judge_N, human_judge_N, reasoning_trace_N
    selectedResults.forEach((result, idx) => {
        const slotNum = idx + 1;
        const rowNum = selectedRowNumbers[idx];
        const review = reviews[`row_${rowNum}`] || null;
        const modelName = _modelCellName(result.model);

        cells.push(_makeCell(
            `${modelName}_${slotNum}`,
            _slotModelResponse(result),
            `cell_${turnLabel}_slot${slotNum}_response`
        ));
        cells.push(_makeCell(
            `llm_judge_${slotNum}`,
            _slotLlmJudge(result),
            `cell_${turnLabel}_slot${slotNum}_llm_judge`
        ));
        cells.push(_makeCell(
            `human_judge_${slotNum}`,
            _slotHumanJudge(review),
            `cell_${turnLabel}_slot${slotNum}_human_judge`
        ));
        cells.push(_makeCell(
            `reasoning_trace_${slotNum}`,
            _slotReasoningTrace(result),
            `cell_${turnLabel}_slot${slotNum}_reasoning_trace`
        ));
    });

    // Number of Attempts Made (only on last/breaking turn)
    if (totalAttempts !== null && totalAttempts !== undefined) {
        cells.push(_makeCell(
            `${turnLabel}: Number of Attempts Made`,
            String(totalAttempts),
            `cell_${turnLabel}_attempts`
        ));
    }

    return cells;
}

/**
 * Submit to Colab: progressively save slot content, judge_prompt_template,
 * and number_of_attempts_made into the existing Colab notebook.
 *
 * Turn content (prompt, ideal response, criteria, JSP) is already saved
 * progressively at testbed completion (Trigger 1) and turn advance (Trigger 2).
 * This function (Trigger 3) only adds the final-save cells.
 *
 * Handles variable slot count: iterates over selectedResults.length, not
 * a hard-coded 4.
 */
export async function submitToColab() {
    const btn = elements.submitColabBtn;
    if (!btn) return;

    if (!state.llmRevealed) {
        showToast('Reveal AI Evaluation first before submitting to Colab.', 'error');
        return;
    }

    const notebookUrl = state.notebook?.url || document.getElementById('colabUrlInput')?.value || '';
    if (!notebookUrl) {
        showToast('No Colab URL found. Please fetch notebook from URL first.', 'error');
        return;
    }

    const selectedRowNumbers = state.selectedRowNumbers || [];
    if (selectedRowNumbers.length === 0) {
        showToast('No responses selected. Please select and confirm responses first.', 'error');
        return;
    }

    const selectedResults = selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r);
    if (selectedResults.length === 0) {
        showToast('Could not resolve selected responses.', 'error');
        return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Saving...';

    try {
        const cells = [];

        const validResponseCount = state.allResponses.filter(r => r.response && r.response.trim() && !r.error).length;
        const totalAttempts = state.isMultiTurn
            ? state.multiTurnTotalHunts + validResponseCount
            : validResponseCount;

        const judgeSystemPrompt = state.notebook?.judge_system_prompt || '';

        const judgePromptTemplate = `Question\n{prompt}\n\nStudent Response\n{model_response}\n\nStandard Response\n{standard_response}\n\nEvaluation Criteria\n{criteria}`;

        // judge_prompt_template — only saved for Turn-1
        cells.push({ heading: `Turn-1: judge_prompt_template`, content: judgePromptTemplate });

        const breakingTurnNum = state.currentTurn || 1;

        // Slot cells for breaking turn (variable count)
        selectedResults.forEach((result, idx) => {
            const slotNum = idx + 1;
            const rowNum = selectedRowNumbers[idx];
            const review = state.humanReviews[`row_${rowNum}`] || null;
            const modelName = _modelCellName(result.model);

            cells.push({ heading: `${modelName}_${slotNum}`, content: _slotModelResponse(result) });
            cells.push({ heading: `llm_judge_${slotNum}`,     content: _slotLlmJudge(result) });
            cells.push({ heading: `human_judge_${slotNum}`,   content: _slotHumanJudge(review) });
            cells.push({ heading: `reasoning_trace_${slotNum}`, content: _slotReasoningTrace(result) });
        });

        // ── Hunt metadata cells ────────────────────────────────────────────────
        // Collect config for every completed turn (previous + current breaking turn).
        // If all turns share the same hunt model, judge model, and hunt mode → save
        // flat (no prefix). Otherwise save per-turn with Turn_N_ prefix.

        const _curHuntModelId  = state.config.models?.[0] || '';
        const _curJudgeModelId = state.config.judge_model  || '';
        const _curHuntModeId   = state.config.hunt_mode    || '';

        const _allTurnConfigs = [
            ...state.turns.map(t => ({
                turnNumber:    t.turnNumber,
                huntModelId:   t.huntModelId   || '',
                huntModelName: t.huntModelName || getModelDisplayName(t.huntModelId || ''),
                judgeModelId:  t.judgeModelId  || '',
                judgeModelName:t.judgeModel    || getModelDisplayName(t.judgeModelId || ''),
                huntModeId:    t.huntModeId    || '',
                huntModeName:  t.huntModeName  || t.huntModeId || '',
                results:       t.results       || [],
                huntCount:     t.huntCount     || (t.results || []).length,
            })),
            {
                turnNumber:    breakingTurnNum,
                huntModelId:   _curHuntModelId,
                huntModelName: getModelDisplayName(_curHuntModelId),
                judgeModelId:  _curJudgeModelId,
                judgeModelName:getModelDisplayName(_curJudgeModelId),
                huntModeId:    _curHuntModeId,
                huntModeName:  getHuntModeById(_curHuntModeId)?.name || _curHuntModeId,
                results:       state.allResponses,
                huntCount:     validResponseCount,
            },
        ];

        const _calcPassRate = (results) => {
            const total   = (results || []).length;
            if (total === 0) return '0% (0/0)';
            const passing = results.filter(r => {
                const s = r.judge_score ?? r.score ?? null;
                return s !== null && Number(s) > 0;
            }).length;
            return `${Math.round((passing / total) * 100)}% (${passing}/${total})`;
        };

        const _allSame = _allTurnConfigs.length <= 1 || _allTurnConfigs.every(t =>
            t.huntModelId  === _allTurnConfigs[0].huntModelId  &&
            t.judgeModelId === _allTurnConfigs[0].judgeModelId &&
            t.huntModeId   === _allTurnConfigs[0].huntModeId
        );

        if (_allSame) {
            const _cfg         = _allTurnConfigs[0];
            const _allResults  = _allTurnConfigs.flatMap(t => t.results || []);
            cells.push({ heading: 'Total_Hunts',  content: String(totalAttempts) });
            cells.push({ heading: 'Pass_Rate',    content: _calcPassRate(_allResults) });
            cells.push({ heading: 'Hunt_Mode',    content: _cfg.huntModeName });
            cells.push({ heading: 'Hunt_Model',   content: _cfg.huntModelName });
            cells.push({ heading: 'Judge_Model',  content: _cfg.judgeModelName });
        } else {
            _allTurnConfigs.forEach(t => {
                const _p = `Turn_${t.turnNumber}_`;
                cells.push({ heading: `${_p}Total_Hunts`,  content: String(t.huntCount) });
                cells.push({ heading: `${_p}Pass_Rate`,    content: _calcPassRate(t.results) });
                cells.push({ heading: `${_p}Hunt_Mode`,    content: t.huntModeName });
                cells.push({ heading: `${_p}Hunt_Model`,   content: t.huntModelName });
                cells.push({ heading: `${_p}Judge_Model`,  content: t.judgeModelName });
            });
        }

        const result = await progressiveSaveToColab(cells);

        if (!result.success) {
            throw new Error(result.message || 'Progressive save failed');
        }

        playFinalSubmission();
        showToast(`✅ Submitted to Colab! (${cells.length} cells saved)`, 'success');
        triggerColabConfetti();

        btn.textContent = '✅ Submitted';
        btn.disabled = true;

    } catch (error) {
        console.error('submitToColab error:', error);
        playFinalSubmissionError();
        showError(error, { operation: 'Submit to Colab', retry: () => submitToColab() });
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

export function populatePreviewTabs(notebook) {
    if (!(state.adminMode && adminBypass('reference_validation')) && !getConfigValue('bypass_hunt_criteria', false)) {
        state.referenceValidated = false;
    }

    state.unsavedChanges.prompt = false;
    state.unsavedChanges.response = false;
    state.unsavedChanges.judge = false;

    // Display metadata
    const metadataToDisplay = (notebook.metadata && typeof notebook.metadata === 'object')
        ? notebook.metadata : {};
    displayMetadata(metadataToDisplay);

    // Validate Model Reference JSON format
    const modelRefValidation = validateModelReferenceJSON(notebook.response_reference || '');
    state.modelRefValid = modelRefValidation.valid;

    if (!modelRefValidation.valid && (notebook.response_reference || '').trim()) {
        console.warn('Model Reference not valid JSON at load time — user can edit in testbed');
    }

    // Parse and store criteria
    let parsedCriteria;
    try {
        const rawRef = notebook.response_reference || '';
        if (!rawRef.trim()) {
            state.criteria = null;
        } else {
            parsedCriteria = parseCriteria(rawRef);
            state.criteria = parsedCriteria;
        }
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showError(error, { operation: 'Parse criteria' });
        state.criteria = null;
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }
    }

    if (parsedCriteria && Array.isArray(parsedCriteria)) {
        if (!state.initialCriteria || !Array.isArray(state.initialCriteria) || state.initialCriteria.length === 0) {
            state.initialCriteria = JSON.parse(JSON.stringify(parsedCriteria));
        }
        validateModelReferenceAndCriteria(notebook.response_reference || '');
    }

    resetAllStatuses();
}

// ============== Admin Mode ==============

/**
 * Re-apply all validation when admin mode is turned OFF.
 * Restores normal lock behavior (disabled button if conditions not met).
 */
export function refreshValidationState() {
    const responseRef = state.notebook?.response_reference || '';
    validateModelReferenceAndCriteria(responseRef);
    updateHuntLimitUI();
    // Re-check review mode: disable all action buttons when selection confirmed
    if (state.selectionConfirmed) setReviewModeButtonsDisabled(true);
}

export function updateAdminModeIndicator(on) {
    const el = document.getElementById('adminModeIndicator');
    if (!el) return;
    if (on) {
        el.classList.remove('hidden');
        el.style.cursor = 'pointer';
    } else {
        el.classList.add('hidden');
    }
}

// ============== Metadata Display ==============

export function displayMetadata(metadata) {
    
    if (!elements.metadataSidebar || !elements.metadataGrid) {
        console.error('❌ Metadata sidebar elements not found!', {
            sidebar: !!elements.metadataSidebar,
            grid: !!elements.metadataGrid
        });
        return;
    }
    
    
    state.metadata = metadata || {};
    
    // Don't return early if metadata is empty - still try to display what we can
    if (!metadata || (typeof metadata === 'object' && Object.keys(metadata).length === 0)) {
        console.warn('⚠️ No metadata to display or empty object, but will still try to show sidebar if elements exist');
        // Don't return - continue to try to display fields
    }
    
    // Parse prompt length range - try multiple key variations
    const promptLengthStr = (metadata && metadata['User Prompt Length']) || 
                           (metadata && metadata['User Prompt length']) || 
                           (metadata && metadata['user prompt length']) ||
                           (metadata && metadata['UserPromptLength']) || '';
    if (promptLengthStr) {
        const match = promptLengthStr.match(/(\d+)\s*-\s*(\d+)/);
        if (match) {
            state.promptLengthRange = {
                min: parseInt(match[1]),
                max: parseInt(match[2])
            };
            // Update word count display after range is set
            setTimeout(() => validatePromptLength(), 100);
        }
    }
    
    // Extract model from metadata - check multiple possible keys
    const modelKeys = ['Model', 'Model:', 'model', 'Target Model', 'target_model', 'target model'];
    let modelStr = '';
    if (metadata && typeof metadata === 'object') {
        for (const key of modelKeys) {
            if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '') {
                modelStr = String(metadata[key]).trim();
                break;
            }
        }
    }
    if (modelStr) {
        // Clean the model string (remove dashes at start, trim)
        const cleanedModel = modelStr.replace(/^[-:\s]+/, '').trim();
        state.metadataModel = cleanedModel;
        
        // Show locked indicator
        showModelLockedIndicator(cleanedModel);
        
        // Refresh model options to disable non-matching models
        setTimeout(() => {
            updateModelOptions(true); // Skip default - preserve existing selection
            validateModelMatch();
        }, 300);
    } else {
        // No model in metadata - clear state
        state.metadataModel = null;
        hideModelLockedIndicator();
    }
    
    // Clear existing content
    elements.metadataGrid.innerHTML = '';
    
    // Helper function to find value by multiple possible keys
    const getValue = (possibleKeys) => {
        if (!metadata || typeof metadata !== 'object') return null;
        for (const key of possibleKeys) {
            if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '') {
                return String(metadata[key]).trim();
            }
        }
        return null;
    };
    
    // Define metadata fields to display with multiple key variations
    const fields = [
        { 
            keys: ['Task ID', 'Task ID:', 'task id', 'TaskID'], 
            icon: '🆔', 
            label: 'Task ID',
            badge: true 
        },
        { 
            keys: ['Domain', 'Domain:', 'domain'], 
            icon: '🌐', 
            label: 'Domain' 
        },
        { 
            keys: ['Use Case', 'Use Case:', 'use case', 'UseCase'], 
            icon: '💼', 
            label: 'Use Case' 
        },
        { 
            keys: ['L1 Taxonomy', 'L1 Taxonomy:', 'l1 taxonomy', 'L1Taxonomy'], 
            icon: '📚', 
            label: 'L1 Taxonomy' 
        },
        { 
            keys: ['User Prompt Length', 'User Prompt length', 'User Prompt Length:', 'user prompt length'], 
            icon: '📏', 
            label: 'User Prompt Length' 
        },
        { 
            keys: ['Model', 'Model:', 'model'], 
            icon: '🤖', 
            label: 'Model' 
        }
    ];
    
    let hasAnyData = false;
    let itemsAdded = 0;
    
    fields.forEach(field => {
        const value = getValue(field.keys);
        
        // Always show the field, even if value is null (will show N/A)
        const displayValue = value || 'N/A';
        
        // Always show Task ID (even when N/A) — used for admin mode trigger (5-click)
        if (value) hasAnyData = true;
        
        const item = document.createElement('div');
        item.className = 'metadata-item';
        
        const label = document.createElement('div');
        label.className = 'metadata-label';
        // Create icon span and text separately for better styling
        const iconSpan = document.createElement('span');
        iconSpan.textContent = field.icon;
        iconSpan.style.fontSize = '1rem';
        const textSpan = document.createElement('span');
        textSpan.textContent = field.label;
        label.appendChild(iconSpan);
        label.appendChild(textSpan);
        
        const valueDiv = document.createElement('div');
        valueDiv.className = 'metadata-value';
        
        if (field.label === 'Task ID') {
            // Task ID: no copy. 5-click triggers admin mode password prompt.
            const badge = document.createElement('span');
            badge.className = 'metadata-badge';
            badge.textContent = displayValue;
            badge.style.cursor = 'default';
            badge.title = '';
            badge.dataset.adminClickCount = '0';
            badge.addEventListener('click', (async () => {
                if (state.adminMode) return;
                await fetchConfigFromAPI();
                if (!getConfigValue('admin_mode_enabled', true)) {
                    showToast('Admin mode is disabled in config', 'info');
                    badge.dataset.adminClickCount = '0';
                    return;
                }
                let count = parseInt(badge.dataset.adminClickCount || '0', 10);
                count++;
                badge.dataset.adminClickCount = String(count);
                if (count >= 5) {
                    badge.dataset.adminClickCount = '0';
                    const expectedPassword = getConfigValue('admin_mode_password', ADMIN_MODE_PASSWORD);
                    const password = await showPasswordPrompt({
                        title: 'Admin Mode',
                        message: 'Enter password to enable admin mode (all locks disabled for testing).'
                    });
                    if (password === expectedPassword) {
                        activateAdminMode();
                    } else if (password !== null) {
                        showToast('Wrong password', 'error');
                    }
                } else {
                    clearTimeout(badge._adminClickReset);
                    badge._adminClickReset = setTimeout(() => { badge.dataset.adminClickCount = '0'; }, 2000);
                }
            }));
            valueDiv.appendChild(badge);
        } else if (field.badge && value) {
            const badge = document.createElement('span');
            badge.className = 'metadata-badge';
            badge.textContent = displayValue;
            badge.style.cursor = 'pointer';
            badge.title = 'Click to copy';
            badge.addEventListener('click', () => {
                navigator.clipboard.writeText(displayValue);
                showToast('✅ Copied to clipboard!', 'success');
            });
            valueDiv.appendChild(badge);
        } else {
            valueDiv.textContent = displayValue;
        }
        
        item.appendChild(label);
        item.appendChild(valueDiv);
        elements.metadataGrid.appendChild(item);
        itemsAdded++;
    });
    
    // Always populate the navbar chip with the same fields
    _populateTaskInfoChip(fields, getValue);

    // Show metadata sidebar if we have any data OR if we added any items
    // This ensures sidebar shows even if some fields are missing
    const shouldShow = hasAnyData || itemsAdded > 0 || elements.metadataGrid.children.length > 0;
    
    if (shouldShow) {
        if (elements.metadataSidebar) {
            elements.metadataSidebar.style.display = 'block';
            elements.metadataSidebar.classList.remove('collapsed');
            document.body.classList.add('sidebar-visible');
        } else {
            console.error('❌ Metadata sidebar element not found!');
        }
    } else {
        if (elements.metadataSidebar) {
            elements.metadataSidebar.style.display = 'none';
            elements.metadataSidebar.classList.remove('collapsed');
            document.body.classList.remove('sidebar-visible');
            console.warn('⚠️ No metadata items to display, hiding sidebar');
        }
    }
}

// ============== Task Info Navbar Chip ==============

function _populateTaskInfoChip(fields, getValue) {
    const chip = document.getElementById('taskInfoChip');
    const chipLabel = document.getElementById('taskInfoChipLabel');
    const chipBtn = document.getElementById('taskInfoChipBtn');
    const dropdown = document.getElementById('taskInfoDropdown');
    const grid = document.getElementById('taskInfoDropdownGrid');
    if (!chip || !grid) return;

    grid.innerHTML = '';

    // Field icon map
    const icons = { 'Task ID': '🆔', 'Domain': '🌐', 'Use Case': '💼', 'L1 Taxonomy': '📚', 'User Prompt Length': '📏', 'Model': '🤖' };

    fields.forEach(field => {
        const value = getValue(field.keys);
        const displayValue = value || 'N/A';

        const row = document.createElement('div');
        row.className = 'task-info-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'task-info-row-label';
        labelEl.textContent = (icons[field.label] || '') + ' ' + field.label;

        const valueEl = document.createElement('span');
        valueEl.className = 'task-info-row-value';

        // Task ID gets a copyable badge
        if (field.label === 'Task ID') {
            const badge = document.createElement('span');
            badge.className = 'task-info-badge';
            badge.textContent = displayValue;
            badge.title = 'Click to copy';
            // Reuse 5-click admin mode from the badge if it's the Task ID
            badge.dataset.adminClickCount = '0';
            badge.addEventListener('click', async () => {
                if (value && value !== 'N/A') {
                    navigator.clipboard.writeText(value);
                    showToast('✅ Copied Task ID!', 'success');
                }
            });
            valueEl.appendChild(badge);
        } else {
            valueEl.textContent = displayValue;
        }

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        grid.appendChild(row);
    });

    // Set chip label to Task ID if available, else "Task Info"
    const taskId = getValue(['Task ID', 'Task ID:', 'task id', 'TaskID']);
    if (chipLabel) chipLabel.textContent = taskId ? taskId : 'Task Info';

    // Show the chip
    chip.classList.remove('hidden');

    // Wire toggle (once)
    if (!chipBtn._taskInfoWired) {
        chipBtn._taskInfoWired = true;
        chipBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = dropdown.classList.contains('open');
            dropdown.classList.toggle('open', !isOpen);
            chip.classList.toggle('open', !isOpen);
        });
        document.addEventListener('click', (e) => {
            if (!chip.contains(e.target)) {
                dropdown.classList.remove('open');
                chip.classList.remove('open');
            }
        });
    }
}

// ============== Save Handlers ==============

export async function saveCell(cellType) {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    // Validate prompt length if saving prompt
    if (cellType === 'prompt' && !validatePromptLength()) {
        showToast('⚠️ Cannot save: Prompt length is outside the required range', 'error');
        return;
    }
    
    let content = '';
    let cellHeading = '';
    
    syncActiveRunToNotebook();
    const nb = state.notebook || {};
    switch (cellType) {
        case 'prompt':
            content = nb.prompt || '';
            cellHeading = 'prompt';
            break;
        case 'response':
            content = nb.response || '';
            cellHeading = 'response';
            break;
        case 'response_reference':
            content = (nb.response_reference || '').trim();
            if (!content) {
                showToast('⚠️ Please ensure Model Reference is in valid format', 'error');
                return;
            }
            cellHeading = 'response_reference';
            break;
        case 'judge_system_prompt':
            content = nb.judge_system_prompt || '';
            cellHeading = 'judge_system_prompt';
            break;
        default:
            showToast('Unknown cell type', 'error');
            return;
    }
    
    if (!content.trim()) {
        showToast(`${cellType} cannot be empty`, 'error');
        return;
    }
    
    try {
        let btn = null;
        if (cellType === 'prompt') {
            btn = elements.savePromptBtn;
        } else if (cellType === 'response') {
            btn = elements.saveResponseBtn;
        } else if (cellType === 'response_reference') {
            btn = elements.saveModelRefBtn;
        } else if (cellType === 'judge_system_prompt') {
            btn = elements.saveJudgeBtn;
        }
        
        const originalText = btn ? btn.textContent : '';
        
        if (btn) {
            btn.disabled = true;
            btn.textContent = '💾 Saving...';
        }
        
        const response = await fetch(`/api/update-notebook-cell/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cell_type: cellHeading,
                content: content
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to save');
        }
        
        const data = await response.json();
        showToast(`✅ ${cellType} saved to Colab!`, 'success');
        
        // Mark as saved
        state.unsavedChanges[cellType === 'response_reference' ? 'modelRef' : cellType] = false;
        
        // CRITICAL: Update originalNotebookJson so snapshot saves include this cell
        updateOriginalNotebookWithCell(cellHeading, content);
        
        // If saving response, also re-judge
        if (cellType === 'response') {
            await judgeReferenceResponse();
        }
        
    } catch (error) {
        showError(error, { operation: `Save ${cellType}` });
    } finally {
        let btn = null;
        let originalText = '';
        if (cellType === 'prompt') {
            btn = elements.savePromptBtn;
            originalText = '💾 Save Prompt';
        } else if (cellType === 'response') {
            btn = elements.saveResponseBtn;
            originalText = '💾 Save Response';
        } else if (cellType === 'response_reference') {
            btn = elements.saveModelRefBtn;
            originalText = '💾 Save Criteria';
        } else if (cellType === 'judge_system_prompt') {
            btn = elements.saveJudgeBtn;
            originalText = '💾 Save Judge';
        }
        
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

export async function saveAllCells() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }

    syncActiveRunToNotebook();
    
    // Validate prompt length (skip validation in multi-turn — turn 2+ prompts don't have metadata length constraints)
    if (!state.isMultiTurn && !validatePromptLength()) {
        showToast('⚠️ Cannot save: Prompt length is outside the required range', 'error');
        return;
    }
    
    const nb = state.notebook || {};
    const cellsToSave = [];
    
    if ((nb.prompt || '').trim()) {
        cellsToSave.push({ cell_type: 'prompt', content: nb.prompt });
    }
    
    if ((nb.response || '').trim()) {
        cellsToSave.push({ cell_type: 'response', content: nb.response });
    }
    
    const criteriaContent = (nb.response_reference || '').trim();
    if (criteriaContent) {
        cellsToSave.push({ cell_type: 'response_reference', content: criteriaContent });
    }
    
    if ((nb.judge_system_prompt || '').trim()) {
        cellsToSave.push({ cell_type: 'judge_system_prompt', content: nb.judge_system_prompt });
    }
    
    if (cellsToSave.length === 0) {
        showToast('No changes to save', 'info');
        return;
    }
    
    try {
        if (elements.saveAllBtn) {
            elements.saveAllBtn.disabled = true;
            elements.saveAllBtn.textContent = '💾 Saving…';
        }
        
        const response = await fetch(`/api/update-notebook-cells/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cells: cellsToSave })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to save');
        }
        
        const data = await response.json();
        showToast(`✅ All changes saved to Colab! (${cellsToSave.length} cells)`, 'success');
        
        // Mark all as saved
        Object.keys(state.unsavedChanges).forEach(key => {
            state.unsavedChanges[key] = false;
        });
        resetAllStatuses();
        
        // CRITICAL: Update originalNotebookJson for each saved cell so snapshot saves include them
        cellsToSave.forEach(cell => {
            updateOriginalNotebookWithCell(cell.cell_type, cell.content);
        });
        
        // Re-judge if response was saved
        if (cellsToSave.some(c => c.cell_type === 'response')) {
            await judgeReferenceResponse();
        }
        
    } catch (error) {
        showError(error, { operation: 'Save' });
    } finally {
        if (elements.saveAllBtn) {
            elements.saveAllBtn.disabled = false;
            elements.saveAllBtn.textContent = '💾 Save All & Judge';
        }
    }
}

/**
 * Invalidate the reference judge result — call when user edits criteria, response, or judge prompt.
 * Ensures hunt button is disabled until user re-judges.
 */
export function invalidateReferenceJudge() {
    if ((state.adminMode && adminBypass('reference_validation')) || getConfigValue('bypass_hunt_criteria', false)) return;
    state.referenceValidated = false;
    const responseRef = state.notebook?.response_reference || '';
    validateModelReferenceAndCriteria(responseRef);
}

// Validate Model Reference: JSON format AND criteria completeness
export function validateModelReferenceAndCriteria(responseReference) {
    if (state.adminMode && adminBypass('reference_validation')) {
        if (elements.startHuntBtn) { elements.startHuntBtn.disabled = false; elements.startHuntBtn.title = 'Admin mode'; }
        return;
    }
    // Step 1: Check JSON format
    const jsonValidation = validateModelReferenceJSON(responseReference);
    state.modelRefValid = jsonValidation.valid;
    
    if (!jsonValidation.valid) {
        // JSON is invalid - show error and disable hunt
        if (elements.modelrefPreview) {
            elements.modelrefPreview.innerHTML = `
                <div style="color: var(--danger); margin-bottom: 1rem; padding: 0.75rem; background: var(--danger-bg); border-radius: 8px;">
                    <strong>❌ Invalid JSON Format</strong><br>
                    ${escapeHtml(jsonValidation.error)}
                </div>
                <pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(responseReference || 'No content')}</pre>
            `;
        }
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }
        return;
    }
    
    // Step 2: JSON is valid, now check criteria completeness
    let currentCriteria;
    try {
        currentCriteria = parseCriteria(responseReference);
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showError(error, { operation: 'Parse criteria' });
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }
        return;
    }
    const currentCriteriaIds = new Set(currentCriteria.map(c => c.id));
    const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
    const missingCriteriaIds = [...initialCriteriaIds].filter(id => !currentCriteriaIds.has(id));
    
    if (missingCriteriaIds.length > 0) {
        // Criteria are missing - show warning and disable hunt
        const missingList = missingCriteriaIds.map(id => {
            const criterion = (state.initialCriteria || []).find(c => c.id === id);
            return `• ${id}: ${criterion ? criterion.criteria.substring(0, 60) + '...' : 'Description not available'}`;
        }).join('<br>');
        
        if (elements.modelrefPreview) {
            elements.modelrefPreview.innerHTML = `
                <div style="color: var(--warning); margin-bottom: 1rem; padding: 0.75rem; background: var(--warning-bg); border-radius: 8px;">
                    <strong>⚠️ Missing Criteria</strong><br>
                    The following criteria from the original notebook are missing from Model Reference:<br>
                    ${missingList}
                </div>
                <pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(responseReference || 'No content')}</pre>
            `;
        }
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }
        showToast(`⚠️ Missing criteria: ${missingCriteriaIds.join(', ')}`, 'warning');
        return;
    }
    
    // Step 3: JSON is valid AND all criteria are present
    // Check if reference was already validated (judged and passed)
    // If already validated, enable the button; otherwise keep it disabled until judging
    if (elements.modelrefPreview) {
        elements.modelrefPreview.textContent = responseReference || 'No model reference criteria found';
    }
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = false;
        elements.startHuntBtn.title = '';
    }
}

// Validate that Model Reference is valid JSON format with criteria
// Only validates the JSON array between [ and ], ignoring any text outside
export function validateModelReferenceJSON(responseReference) {
    if (!responseReference || !responseReference.trim()) {
        return { valid: false, error: 'Model Reference is empty' };
    }
    
    try {
        // Extract only the JSON array between [ and ]
        const arrayMatch = responseReference.match(/\[[\s\S]*?\]/);
        
        if (!arrayMatch) {
            return { valid: false, error: 'Model Reference must contain a JSON array between [ and ] brackets' };
        }
        
        const jsonArrayStr = arrayMatch[0];
        const arr = JSON.parse(jsonArrayStr);
        
        if (!Array.isArray(arr)) {
            return { valid: false, error: 'Content between [ and ] must be a JSON array' };
        }
        
        if (arr.length === 0) {
            return { valid: false, error: 'JSON array cannot be empty' };
        }
        
        // Validate each item has id and criteria fields
        for (let idx = 0; idx < arr.length; idx++) {
            const item = arr[idx];
            if (typeof item !== 'object' || item === null) {
                return { valid: false, error: `Criterion at index ${idx} must be a JSON object` };
            }
            if (!item.id) {
                return { valid: false, error: `Criterion at index ${idx} is missing 'id' field` };
            }
            // Check for criteria1, criteria2, etc. fields
            const hasCriteria = Object.keys(item).some(key => key.startsWith('criteria') && key !== 'id');
            if (!hasCriteria) {
                return { valid: false, error: `Criterion at index ${idx} (id: ${item.id}) is missing a 'criteria' field` };
            }
        }
        
        return { valid: true };
        
    } catch (e) {
        return { valid: false, error: `JSON parse error: ${e.message}` };
    }
}

// Parse criteria from response_reference text
// Supports multiple formats:
// 1. JSON array: [{"id": "C1", "criteria1": "..."}, ...]
// 2. Plain text: "C1: ...\nC2: ...\nC3: ..."
export function parseCriteria(responseReference) {
    
    if (!responseReference || !responseReference.trim()) {
        const error = 'Empty response_reference - cannot parse criteria';
        console.error(error);
        throw new Error(error);
    }
    
    // Clean the input - remove any leading/trailing whitespace
    const cleaned = responseReference.trim();
    
    try {
        // First, try to parse the entire string as JSON (most common case)
        let criteriaArray = null;
        let jsonArrayStr = null;
        let isPlainTextFormat = false;
        
        try {
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) {
                criteriaArray = parsed;
                jsonArrayStr = cleaned;
            } else {
                // It's JSON but not an array
                throw new Error('Parsed JSON is not an array');
            }
        } catch (jsonParseError) {
            // Not pure JSON, try to extract JSON array from text
            
            // Try to find JSON array with balanced brackets (most robust method)
            let bracketCount = 0;
            let startIndex = -1;
            let arrayMatch = null;
            
            for (let i = 0; i < cleaned.length; i++) {
                if (cleaned[i] === '[') {
                    if (bracketCount === 0) startIndex = i;
                    bracketCount++;
                } else if (cleaned[i] === ']') {
                    bracketCount--;
                    if (bracketCount === 0 && startIndex >= 0) {
                        arrayMatch = cleaned.substring(startIndex, i + 1);
                        break;
                    }
                }
            }
            
            // If balanced bracket matching failed, try regex as fallback
            if (!arrayMatch) {
                // Try greedy match (captures full array including nested arrays)
                const greedyMatch = cleaned.match(/\[[\s\S]*\]/);
                if (greedyMatch) {
                    arrayMatch = greedyMatch[0];
                } else {
                    // Try non-greedy
                    const nonGreedyMatch = cleaned.match(/\[[\s\S]*?\]/);
                    if (nonGreedyMatch) {
                        arrayMatch = nonGreedyMatch[0];
                    }
                }
            }
            
            if (arrayMatch) {
                try {
                    jsonArrayStr = arrayMatch;
                    criteriaArray = JSON.parse(jsonArrayStr);
                } catch (parseError) {
                    console.error('Failed to parse extracted array:', parseError);
                    console.error('Extracted string:', arrayMatch.substring(0, 200));
                    // Fall through to try plain text format
                }
            }
            
              // If still no criteriaArray, try plain text format: "C1: ...\nC2: ..."
              if (!criteriaArray) {
                  const plainTextPattern = /^(C\d+)\s*[:：]\s*(.+)$/gim;
                  const matches = [...cleaned.matchAll(plainTextPattern)];
                  
                  if (matches.length > 0) {
                      criteriaArray = matches.map((match) => ({
                          id: match[1].toUpperCase(),
                          criteria: match[2].trim()
                      }));
                      isPlainTextFormat = true;
                } else {
                    // No format matched
                    const error = 'No JSON array or plain text criteria (C1:, C2:, etc.) found in response_reference';
                    console.error(error);
                    console.error('Response reference content (first 500 chars):', cleaned.substring(0, 500));
                    throw new Error(error);
                }
            }
        }
        
        if (!Array.isArray(criteriaArray) || criteriaArray.length === 0) {
            const error = 'JSON array is empty or invalid - must contain at least one criterion';
            console.error(error);
            throw new Error(error);
        }
        
        // Parse each criterion item
            const criteria = [];
        for (let idx = 0; idx < criteriaArray.length; idx++) {
            const item = criteriaArray[idx];
            
            if (typeof item !== 'object' || item === null) {
                continue;
            }
            
            const c_id = item.id || `C${idx + 1}`;
            
            // Look for criteria1, criteria2, etc. fields
            let criteriaText = null;
            for (const key of Object.keys(item)) {
                if (key.startsWith('criteria') && key !== 'id') {
                    criteriaText = item[key];
                    break;
                }
            }
            
            // Fallback to description or other fields
            if (!criteriaText) {
                criteriaText = item.description || item.criteria || item.text || JSON.stringify(item);
            }
            
            if (criteriaText) {
                criteria.push({ id: c_id, criteria: criteriaText });
            }
        }
        
        if (criteria.length > 0) {
            return criteria;
        }
        
        // Try alternative format: JSON object with C1, C2 keys
        const jsonObjMatch = responseReference.match(/\{[\s\S]*?"C\d+"[\s\S]*?\}/);
        if (jsonObjMatch) {
            try {
                const data = JSON.parse(jsonObjMatch[0]);
                const criteria = [];
                for (const key of Object.keys(data)) {
                    if (/^C\d+$/i.test(key)) {
                        const value = data[key];
                        const desc = typeof value === 'string' ? value : 
                                     (value?.description || value?.criteria || JSON.stringify(value));
                        criteria.push({ id: key.toUpperCase(), criteria: desc });
                    }
                }
                if (criteria.length > 0) {
                    return criteria;
                }
            } catch (e) {
                // Continue to throw error
            }
        }
        
        const error = 'Could not extract valid criteria from response_reference JSON array';
        console.error(error);
        throw new Error(error);
        
    } catch (e) {
        if (e instanceof SyntaxError || e.message.includes('JSON')) {
            const error = `JSON parse error in response_reference: ${e.message}`;
            console.error(error);
            throw new Error(error);
        }
        // Re-throw if it's already our custom error
        throw e;
    }
}

export function getDefaultCriteria() {
    return [
        { id: 'C1', criteria: 'Response meets formatting requirements' },
        { id: 'C2', criteria: 'Response follows exact instructions' },
        { id: 'C3', criteria: 'Response avoids violations' },
        { id: 'C4', criteria: 'Response maintains context' }
    ];
}

// Combined Save & Judge function for Response tab
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
        showToast(`❌ Minimum 3 criteria required. Currently have ${currentCriteria.length}. Please add more criteria before saving.`, 'error');
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
        btn.textContent = '💾 Saving...';
        // Don't hide result div - keep response editor visible
        if (resultDiv) {
            resultDiv.innerHTML = '';
            resultDiv.classList.add('hidden');
        }
        
        // Step 1: Save to Colab
        const saveResponse = await fetch(`/api/update-response/${state.sessionId}`, {
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
        
        showToast('✅ Saved to Colab!', 'success');
        btn.textContent = '⚖️ Judging...';

        // Step 2: Judge via streaming SSE
        const judgeResponse = await fetch(`/api/judge-reference-stream/${state.sessionId}`, { method: 'POST' });
        if (!judgeResponse.ok) {
            if (judgeResponse.status === 404) {
                showToast('⚠️ Session expired. Please reload the notebook.', 'error');
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
            lbl.textContent = `${isPassing ? '✅' : '❌'} Score: ${finalEvent.score ?? 0} — ${finalEvent.passing || 0}/${finalEvent.total || 0} Passing`;
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
        btn.textContent = '💾 Save & Verify';
    }
}

export async function judgeReferenceResponse() {
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
        showToast(`❌ Minimum 3 criteria required. Currently have ${currentCriteria.length}.`, 'error');
        if (elements.referenceJudgeResult) {
            elements.referenceJudgeResult.innerHTML = `<div style="padding:1rem;background:var(--bg-primary);border:2px solid var(--warning);border-radius:8px;color:var(--text-secondary);">⚠️ Minimum 3 Criteria Required. You have ${currentCriteria.length}.</div>`;
            elements.referenceJudgeResult.classList.remove('hidden');
        }
        return;
    }
    
    if (missingBeforeJudge.length > 0) {
        const missingIds = missingBeforeJudge.join(', ');
        showToast(`❌ Missing criteria: ${missingIds}`, 'error');
        if (elements.referenceJudgeResult) {
            elements.referenceJudgeResult.innerHTML = `<div style="padding:1rem;background:var(--bg-primary);border:2px solid var(--warning);border-radius:8px;color:var(--text-secondary);">⚠️ Missing criteria from original: ${missingIds}</div>`;
            elements.referenceJudgeResult.classList.remove('hidden');
        }
        return;
    }
    
    const btn = event?.target?.id === 'judgeBeforeHuntBtn' ? elements.judgeBeforeHuntBtn : elements.judgeReferenceBtn;
    const resultDiv = elements.referenceJudgeResult;
    
    try {
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ Judging...';
        }
        if (resultDiv) {
            resultDiv.innerHTML = '';
            resultDiv.classList.add('hidden');
        }
        
        const response = await fetch(`/api/judge-reference-stream/${state.sessionId}`, { method: 'POST' });
        if (!response.ok) {
            if (response.status === 404) {
                showToast('⚠️ Session expired. Please reload notebook.', 'error');
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
            lbl.innerHTML = `<span class="score-badge ${isPassing ? 'score-1' : 'score-0'}">${isPassing ? '✅' : '❌'} Score: ${finalEvent.score ?? 0}</span> ${escapeHtml(statusMsg)}`;
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
                    <label style="font-weight: 600; font-size: 0.9rem;">📝 Judge Explanation:</label>
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
            if (btn.id === 'judgeBeforeHuntBtn') btn.textContent = '⚖️ Check Ideal Response';
            else if (btn.id === 'judgeReferenceBtn') btn.textContent = '⚖️ Judge Only';
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
        btn.textContent = '💾 Saving...';
        
        const saveResponse = await fetch(`/api/update-response/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: newResponse })
        });
        
        if (!saveResponse.ok) {
            throw new Error('Failed to save to Colab');
        }
        
        updateOriginalNotebookWithCell('response', newResponse);
        showToast('✅ Saved to Colab!', 'success');
        
    } catch (error) {
        showError(error, { operation: 'Operation' });
    } finally {
        btn.disabled = false;
        btn.textContent = '💾 Save Response';
    }
}



// Turn 1 test prompt functions — deprecated stubs (HTML elements removed; Testbed handles generation now)
export function showTurn1TestPromptPanel() {}
export function hideTurn1TestPromptPanel() {}
export function updateTurn1TestPromptVisibility() {}
export function initTurn1TestPromptListeners() {}

// ============== Metadata Sidebar Toggle ==============

export function toggleMetadataSidebar() {
    if (!elements.metadataSidebar || !elements.metadataToggleBtn) return;
    
    const isCollapsed = elements.metadataSidebar.classList.contains('collapsed');
    
    if (isCollapsed) {
        // Expand
        elements.metadataSidebar.classList.remove('collapsed');
        elements.metadataToggleBtn.querySelector('.metadata-toggle-icon').textContent = '▼';
        document.body.classList.add('sidebar-visible');
    } else {
        // Collapse
        elements.metadataSidebar.classList.add('collapsed');
        elements.metadataToggleBtn.querySelector('.metadata-toggle-icon').textContent = '▶';
        document.body.classList.remove('sidebar-visible');
    }
}
