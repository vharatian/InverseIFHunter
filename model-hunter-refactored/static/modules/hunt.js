/**
 * hunt.js — Hunt Execution, SSE Progress, Hunt Limits
 * 
 * Handles hunt configuration, execution via SSE, progress tracking,
 * hunt limit enforcement, and response fetching.
 * 
 * Dependencies: config.js, utils.js, state.js, dom.js, results.js
 */

import { elements } from './dom.js';
import { MAX_HUNTS_PER_NOTEBOOK, PROVIDER_MODELS, REASONING_MODEL_IDS } from './config.js';
import { 
    loadHuntCount, 
    saveHuntCount, 
    getModelDisplayName, 
    renderInsightTip, 
    startTipRotation,
    getTurnColor,
    debugLog,
    escapeHtml
} from './utils.js';
import { state } from './state.js';
import { showToast } from './celebrations.js';
import { 
    handleHuntComplete, 
    fetchAllResponses, 
    fetchAllResponsesAndShowSelection,
    openResponseSlideout 
} from './results.js';
import { showMultiTurnDecision, updateTurnAwareUI } from './multiturn.js';
import { showUpdatePrompt, hasPendingUpdate } from './api.js';

// Imports from moved modules (formerly window.* aliases)
import { initTheme, toggleTheme, updateThemeIcon, initTabs } from './theme.js';
import { 
    initFileUpload, 
    uploadFile, 
    fetchFromUrl, 
    handleNotebookLoaded, 
    saveToDrive, 
    populatePreviewTabs, 
    displayMetadata 
} from './notebook.js';
import { 
    initMarkdownEditors, 
    initRichTextEditors, 
    initResizablePanels, 
    initStructuredInput, 
    convertStructuredToJSON, 
    initPromptLengthValidation, 
    validatePromptLength, 
    showModelLockedIndicator, 
    hideModelLockedIndicator, 
    validateModelMatch, 
    clearModelMismatchWarning, 
    showModelMismatchWarning, 
    disableSaveButtons, 
    insertMarkdown, 
    updateMarkdownPreview, 
    updateToolbarState 
} from './editors.js';
// notebook.js exports specific save handlers? No, they were window.* in hunt.js?
// hunt.js lines 176-180: setupSaveHandlers, saveCell, saveAllCells...
// these seem to be missing from notebook.js export list in my previous specific check?
// Let's assume they are there or I need to add them.
import { 
    validateModelReferenceAndCriteria, 
    validateModelReferenceJSON, 
    parseCriteria, 
    getDefaultCriteria, 
    initPreviewTabs 
} from './notebook.js';

// ============== Hunt Limit Functions ==============
// Helper functions moved to utils.js


export function incrementHuntCount(notebookId, addCount) {
    const current = loadHuntCount(notebookId);
    const newCount = current + addCount;
    saveHuntCount(notebookId, newCount);
    state.totalHuntsCount = newCount;
    state.huntsThisTurn += addCount;  // Track per-turn hunts
    updateHuntLimitUI();
    return newCount;
}

export function canStartMoreHunts(requestedHunts = 1) {
    // Per-turn limit: check huntsThisTurn against MAX_HUNTS_PER_NOTEBOOK
    const projected = state.huntsThisTurn + requestedHunts;
    return projected <= MAX_HUNTS_PER_NOTEBOOK;
}

export function getRemainingHunts() {
    return Math.max(0, MAX_HUNTS_PER_NOTEBOOK - state.huntsThisTurn);
}

export function updateHuntLimitUI() {
    // Per-turn limit: use huntsThisTurn for limit checks
    const remaining = getRemainingHunts();
    const thisTurn = state.huntsThisTurn;
    const totalGlobal = state.totalHuntsCount;
    
    const numberInput = document.getElementById('parallelWorkers');
    const maxAllowed = Math.min(6, remaining);
    
    if (numberInput) {
        const val = parseInt(numberInput.value) || 4;
        if (val > maxAllowed) {
            numberInput.value = maxAllowed > 0 ? maxAllowed : 1;
        }
    }
    
    // Update preset buttons - disable those above remaining limit
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
        const btnValue = parseInt(btn.dataset.value);
        if (btnValue > remaining) {
            btn.disabled = true;
            btn.style.opacity = '0.4';
            btn.title = `Only ${remaining} hunts remaining this turn`;
        } else {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.title = '';
        }
    });
    
    // Find or create the hunt limit indicator
    let indicator = document.getElementById('huntLimitIndicator');
    
    if (thisTurn > 0 || totalGlobal > 0) {
        if (!indicator) {
            const huntSection = document.querySelector('.hunt-action-section');
            if (huntSection) {
                indicator = document.createElement('div');
                indicator.id = 'huntLimitIndicator';
                indicator.style.cssText = 'margin-top: 0.75rem; font-size: 0.85rem; text-align: center;';
                huntSection.appendChild(indicator);
            }
        }
        
        if (indicator) {
            const turnLabel = state.currentTurn > 1 ? ` (Turn ${state.currentTurn})` : '';
            if (remaining === 0) {
                indicator.innerHTML = `
                    <span style="color: var(--danger); font-weight: 600;">
                        ⛔ Turn limit reached (${thisTurn}/${MAX_HUNTS_PER_NOTEBOOK} this turn)
                    </span>
                    <br>
                    <span style="color: var(--text-muted); font-size: 0.8rem;">
                        Continue to the next turn or end the session.
                    </span>
                `;
                state.huntLimitReached = true;
            } else if (remaining <= 4) {
                indicator.innerHTML = `
                    <span style="color: var(--warning);">
                        ⚠️ ${remaining} hunts remaining this turn${turnLabel} (${thisTurn}/${MAX_HUNTS_PER_NOTEBOOK})
                    </span>
                    ${totalGlobal > thisTurn ? `<br><span style="color: var(--text-muted); font-size: 0.75rem;">${totalGlobal} total across all turns</span>` : ''}
                `;
            } else {
                indicator.innerHTML = `
                    <span style="color: var(--text-muted);">
                        📊 ${thisTurn}/${MAX_HUNTS_PER_NOTEBOOK} hunts this turn${turnLabel}
                    </span>
                    ${totalGlobal > thisTurn ? `<br><span style="color: var(--text-muted); font-size: 0.75rem;">${totalGlobal} total across all turns</span>` : ''}
                `;
            }
        }
    } else if (indicator) {
        indicator.innerHTML = '';
    }
    
    // Disable Start Hunt button if per-turn limit reached — bypass in admin mode
    if (elements.startHuntBtn && !state.adminMode && state.huntLimitReached) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Turn hunt limit reached. Continue to next turn or end session.';
    }
}

export function showHuntLimitReachedError() {
    const turnLabel = state.currentTurn > 1 ? ` for Turn ${state.currentTurn}` : '';
    showToast(
        `⛔ Maximum ${MAX_HUNTS_PER_NOTEBOOK} hunts reached${turnLabel}. ` +
        `Continue to the next turn or end the session.`,
        'error'
    );
}


// ============== Theme ==============
// Imported from modules/theme.js

// ============== File Upload ==============
// Imported from features/notebook.js

// ============== Markdown Split Editor ==========================
// Imported from features/editors.js

// ============== Save Handlers ==============
// Imported from features/notebook.js


// ============== Hunt Configuration ==============

export function getConfig() {
    const model = elements.modelSelect?.value || 'qwen/qwen3-235b-a22b-thinking-2507';
    const huntCount = parseInt(elements.parallelWorkers.value) || 4;
    
    // Create array with same model for all hunts
    const models = Array(huntCount).fill(model);
    
    return {
        parallel_workers: huntCount,
        target_breaks: huntCount, // All hunts should run (no early stop based on target)
        models: models,
        provider: elements.providerSelect ? elements.providerSelect.value : 'openrouter', // NEW
        reasoning_budget_percent: 0.9,
        max_retries: 3, // Hardcoded to 3 retries
        judge_model: 'gpt-5', // Always GPT-5
        independent_judging: true, // Mandatory per user request
        custom_judge_system_prompt: null
    };
}


// ============== Hunt Execution ==============

export async function startHunt() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    if (state.isHunting) {
        showToast('Hunt already in progress', 'warning');
        return;
    }
    
    // MANDATORY: Empty prompt check — no bypass (admin or normal)
    const promptEl = document.getElementById('promptMarkdown');
    const promptText = (promptEl?.value ?? state.notebook?.prompt ?? '').trim();
    if (!promptText) {
        showToast('❌ Prompt cannot be empty. Please enter a prompt before starting the hunt.', 'error');
        return;
    }
    
    // Check for pending update before starting new hunt
    if (hasPendingUpdate()) {
        await showUpdatePrompt();
        // If user chose "Continue Anyway", we proceed
        // If user chose "Refresh Now", page reloads (won't reach here)
    }
    
    // MANDATORY: Check if reference was judged and all criteria passed (100%) — bypass in admin mode
    if (!state.adminMode && !state.referenceValidated) {
        showToast('❌ You must judge the reference response first! All criteria must pass (100%) before starting hunt. Click "Judge Only" or "Save & Re-judge".', 'error');
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
        }
        return;
    }
    
    // FINAL CHECK: Validate model match before starting — bypass in admin mode
    if (!state.adminMode && state.metadataModel) {
        const selectedModel = elements.modelSelect?.value || '';
        const getKey = (s) => {
            const l = (s || '').toLowerCase();
            if (l.includes('nemotron')) return 'nemotron';
            if (l.includes('qwen')) return 'qwen';
            if (l.includes('opus')) return 'opus';      // Claude Opus (anthropic/claude-opus-4.5, etc.)
            if (l.includes('sonnet')) return 'sonnet';  // Claude Sonnet
            if (l.includes('claude')) return 'claude'; // Generic Claude (matches Opus or Sonnet)
            if (l.includes('llama')) return 'llama';
            if (l.includes('deepseek')) return 'deepseek';
            if (l.includes('mistral')) return 'mistral';
            return l.replace(/[^a-z0-9]/g, '');
        };
        
        if (getKey(selectedModel) !== getKey(state.metadataModel)) {
            showToast(`⛔ BLOCKED: Model mismatch! Required: ${state.metadataModel}, Selected: ${selectedModel}`, 'error');
            if (elements.startHuntBtn) {
                elements.startHuntBtn.disabled = true;
            }
            return;
        }
    }
    
    // CHECK HUNT LIMIT: Block if maximum hunts reached for this notebook — bypass in admin mode
    const requestedHunts = parseInt(elements.parallelWorkers?.value) || 4;
    if (!state.adminMode && state.huntLimitReached) {
        showHuntLimitReachedError();
        return;
    }
    
    if (!state.adminMode && !canStartMoreHunts(requestedHunts)) {
        const remaining = getRemainingHunts();
        const turnCtx = (state.isMultiTurn || state.currentTurn > 1) ? ` this turn` : '';
        if (remaining === 0) {
            showHuntLimitReachedError();
            state.huntLimitReached = true;
            updateHuntLimitUI();
            return;
        } else {
            showToast(
                `⚠️ Only ${remaining} hunts remaining${turnCtx}. Reduce hunt count to ${remaining} or less.`,
                'warning'
            );
            return;
        }
    }
    
    // CRITICAL: Calculate hunt offset BEFORE incrementing count
    // This is the starting hunt_id for this run (previous total hunts)
    const huntOffset = state.totalHuntsCount;
    
    // CRITICAL FIX: Capture config BEFORE incrementing count
    // incrementHuntCount calls updateHuntLimitUI which modifies the UI input values!
    // If we call getConfig() after, it reads the modified (lower) values.
    state.config = getConfig();
    debugLog(`📊 Config captured with ${state.config.parallel_workers} workers BEFORE increment`);
    
    // Increment hunt count immediately (before the hunt starts)
    // This will update UI but we already captured the config
    incrementHuntCount(state.notebookId, requestedHunts);
    debugLog(`📊 Hunt count incremented: ${state.totalHuntsCount}/${MAX_HUNTS_PER_NOTEBOOK}, offset for this run: ${huntOffset}`);
    
    state.isHunting = true;
    state.results = [];
    
    // Store the offset for this run (used in initProgressUI)
    state.currentRunStartOffset = huntOffset;
    
    // Add loading state to button
    elements.startHuntBtn.classList.add('loading');
    elements.startHuntBtn.disabled = true;
    
    // FIX 4: Lock model and provider selection once hunt starts
    if (elements.modelSelect) {
        elements.modelSelect.disabled = true;
        elements.modelSelect.title = 'Model selection locked during hunt. Refresh page to change.';
    }
    if (elements.providerSelect) {
        elements.providerSelect.disabled = true;
        elements.providerSelect.title = 'Provider selection locked during hunt. Refresh page to change.';
    }
    
    // Hide upload and config sections during hunt
    document.querySelector('.section')?.classList.add('hidden'); // Hide upload section
    elements.configSection?.classList.add('hidden'); // Hide config section
    
    // Start rotating hunting tips (model-aware)
    const selectedModel = elements.modelSelect?.value || '';
    startTipRotation('huntingTipContainer', 'hunting', 12000, { model: selectedModel });
    
    // Update config on server WITH hunt offset for unique hunt_id generation
    const configWithOffset = {
        ...state.config,
        hunt_offset: huntOffset  // Tell backend where to start hunt_ids
    };
    await fetch(`/api/update-config/${state.sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configWithOffset)
    });
    
    // Show progress section (centered) and reset it
    elements.progressSection.classList.remove('hidden');
    elements.progressSection.classList.add('hunt-active');
    elements.resultsSection.classList.add('hidden');
    elements.summarySection.classList.add('hidden');
    
    // Initialize progress UI (resets progress to 0%)
    initProgressUI();
    
    // Update turn-aware UI (journey bar shows "Hunting" for current turn)
    updateTurnAwareUI();
    
    // Scroll to progress section
    elements.progressSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    // Start SSE stream with auto-reconnection via Redis Streams
    // Server sends id: and retry: 500 with each event.
    // Browser's native EventSource auto-reconnects with Last-Event-ID header.
    // Server replays missed events from Redis Stream on reconnect.
    const seenEventIds = new Set();  // Dedup replayed events
    
    const eventSource = new EventSource(`/api/hunt-stream/${state.sessionId}`);
    
    eventSource.onmessage = (event) => {
        debugLog('SSE message:', event.data);
    };
    
    // Dedup helper — returns true if this event was already processed
    function isDuplicate(event) {
        if (event.lastEventId && seenEventIds.has(event.lastEventId)) {
            return true;
        }
        if (event.lastEventId) {
            seenEventIds.add(event.lastEventId);
        }
        return false;
    }
    
    eventSource.addEventListener('start', (event) => {
        if (isDuplicate(event)) return;
        const data = JSON.parse(event.data);
        debugLog('Hunt started:', data);
    });
    
    eventSource.addEventListener('hunt_start', (event) => {
        if (isDuplicate(event)) return;
        const data = JSON.parse(event.data);
        updateTableRow(data.hunt_id, { status: 'running', model: data.model });
    });
    
    eventSource.addEventListener('hunt_progress', (event) => {
        if (isDuplicate(event)) return;
        const data = JSON.parse(event.data);
        handleHuntProgress(data);
    });
    
    eventSource.addEventListener('hunt_result', (event) => {
        if (isDuplicate(event)) return;
        const data = JSON.parse(event.data);
        handleHuntResult(data);
    });
    
    eventSource.addEventListener('early_stop', (event) => {
        if (isDuplicate(event)) return;
        const data = JSON.parse(event.data);
        showToast(data.reason, 'info');
    });
    
    eventSource.addEventListener('complete', (event) => {
        if (isDuplicate(event)) return;
        const data = JSON.parse(event.data);
        handleHuntComplete(data);
        eventSource.close();
    });
    
    eventSource.addEventListener('error', (event) => {
        if (state.isHunting) {
            // EventSource may auto-reconnect, but if it enters CLOSED state
            // (e.g., 502 from nginx during deploy), we must reconnect manually.
            if (eventSource.readyState === EventSource.CLOSED) {
                debugLog('SSE connection closed during hunt, reconnecting manually...');
                eventSource.close();
                // Reconnect after brief delay — server will replay missed events
                setTimeout(() => {
                    if (state.isHunting) {
                        const newSource = new EventSource(`/api/hunt-stream/${state.sessionId}`);
                        // Re-attach all event listeners to the new source
                        newSource.addEventListener('hunt_result', (e) => {
                            if (isDuplicate(e)) return;
                            handleHuntResult(JSON.parse(e.data));
                        });
                        newSource.addEventListener('hunt_progress', (e) => {
                            if (isDuplicate(e)) return;
                            handleHuntProgress(JSON.parse(e.data));
                        });
                        newSource.addEventListener('hunt_start', (e) => {
                            if (isDuplicate(e)) return;
                            updateTableRow(JSON.parse(e.data).hunt_id, { status: 'running', model: JSON.parse(e.data).model });
                        });
                        newSource.addEventListener('complete', (e) => {
                            if (isDuplicate(e)) return;
                            handleHuntComplete(JSON.parse(e.data));
                            newSource.close();
                        });
                        newSource.addEventListener('error', () => {
                            // If still hunting and closed again, try once more after longer delay
                            if (state.isHunting && newSource.readyState === EventSource.CLOSED) {
                                setTimeout(() => {
                                    if (state.isHunting) {
                                        // Final fallback: poll for results
                                        fetch(`/api/results/${state.sessionId}`)
                                            .then(r => r.ok ? r.json() : Promise.reject())
                                            .then(data => {
                                                if (data.results && data.results.length > 0) {
                                                    showToast(`Recovered ${data.results.length} results after reconnect.`, 'info');
                                                    fetchAllResponses().then(() => showMultiTurnDecision());
                                                    state.isHunting = false;
                                                }
                                            }).catch(() => {});
                                    }
                                }, 5000);
                            }
                        });
                        newSource.addEventListener('ping', () => {});
                    }
                }, 2000);
            } else {
                // CONNECTING state — EventSource is auto-reconnecting, let it
                debugLog('SSE reconnecting (auto via Last-Event-ID)...');
            }
        } else {
            eventSource.close();
            fetch(`/api/results/${state.sessionId}`)
                .then(resp => resp.ok ? resp.json() : Promise.reject('not ok'))
                .then(recoveryData => {
                    const recoveredCount = (recoveryData.results || []).length;
                    if (recoveredCount > 0) {
                        showToast(`Recovered ${recoveredCount} results.`, 'info');
                        fetchAllResponses().then(() => showMultiTurnDecision());
                    }
                })
                .catch(() => {});
        }
    });
    
    eventSource.addEventListener('ping', () => {
        // Keepalive, ignore
    });
}

let _responseViewDelegationAttached = false;

function _attachResponseViewDelegation() {
    if (_responseViewDelegationAttached) return;
    const tbody = document.getElementById('resultsTableBody') || elements.resultsTableBody;
    if (!tbody) return;
    _responseViewDelegationAttached = true;
    tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('.response-view-btn');
        if (btn) {
            e.preventDefault();
            e.stopPropagation();
            const rowNum = parseInt(btn.dataset.rowNumber, 10);
            if (!isNaN(rowNum)) openResponseSlideout(rowNum);
        }
    });
}

export function initProgressUI() {
    _attachResponseViewDelegation();
    const { parallel_workers, target_breaks } = state.config;
    
    // Use the offset that was set BEFORE incrementing (in startHunt)
    const offset = state.currentRunStartOffset;
    
    debugLog(`📊 initProgressUI: totalHuntsCount=${state.totalHuntsCount}, parallel_workers=${parallel_workers}, offset=${offset}`);
    
    // Reset progress for THIS run only
    if (elements.progressFill) elements.progressFill.style.width = '0%';
    const turnLabel = (state.isMultiTurn || state.currentTurn > 1) ? ` (Turn ${state.currentTurn})` : '';
    if (elements.progressText) elements.progressText.textContent = `0 / ${parallel_workers} hunts complete${turnLabel}`;
    if (elements.progressPercent) elements.progressPercent.textContent = '0%';
    
    // Update turn-aware progress bar color
    if (state.isMultiTurn || state.currentTurn > 1) {
        const color = getTurnColor(state.currentTurn);
        if (elements.progressFill) elements.progressFill.style.background = color;
    }
    
    // Initialize breaks indicator for this run
    const breaksEl = elements.breaksIndicator;
    if (breaksEl) {
        breaksEl.innerHTML = '';
        for (let i = 0; i < target_breaks; i++) {
            const dot = document.createElement('span');
            dot.className = 'break-dot';
            dot.dataset.index = i;
            breaksEl.appendChild(dot);
        }
    }
    
    // APPEND table rows (don't clear!) - use offset for proper numbering
    const models = state.config.models;
    
    for (let i = 1; i <= parallel_workers; i++) {
        const globalRowNum = offset + i;
        const model = models[i - 1] || models[0];
        const modelDisplay = getModelDisplayName(model);
        
        const row = document.createElement('tr');
        row.id = `hunt-row-${globalRowNum}`;
        row.dataset.modelId = model || '';
        row.innerHTML = `
            <td>${globalRowNum}</td>
            <td class="model-cell" title="${model}">${modelDisplay}</td>
            <td class="response-cell" style="min-width: 180px; max-width: 360px;">
                <span class="response-placeholder" style="color: var(--text-muted);">-</span>
            </td>
            <td class="status-cell"><span class="score-badge pending">Pending</span></td>
            <td class="score-cell">-</td>
            <td class="result-cell">-</td>
        `;
        const tbodyForRows = document.getElementById('resultsTableBody') || elements.resultsTableBody;
        if (tbodyForRows) {
            tbodyForRows.appendChild(row);
        }
    }
    
    // Update status (with turn context)
    elements.huntStatus.querySelector('.status-dot').className = 'status-dot running';
    const runTurnLabel = (state.isMultiTurn || state.currentTurn > 1) ? ` — Turn ${state.currentTurn}` : '';
    elements.statusText.textContent = `Running...${runTurnLabel}`;
    
    // Ensure per-turn progress info is visible and up to date
    updateTurnAwareUI();
}

export function updateTableRow(huntId, data) {
    // hunt_id from backend is already globally unique (no offset needed)
    const row = document.getElementById(`hunt-row-${huntId}`);
    if (!row) {
        console.warn(`Row hunt-row-${huntId} not found`);
        return;
    }
    
    if (data.model) {
        row.dataset.modelId = data.model;
        row.querySelector('.model-cell').textContent = getModelDisplayName(data.model);
    }
    
    if (data.status === 'running') {
        const modelId = row.dataset.modelId || '';
        const isReasoning = isReasoningModel(modelId);
        const statusText = isReasoning ? 'Model is reasoning, this may take 1–2 minutes' : 'Model is generating, usually under 30 seconds';
        row.querySelector('.status-cell').innerHTML = `
            <span class="score-badge pending">
                <span class="spinner"></span> ${statusText}
            </span>
        `;
    }
}

function isReasoningModel(modelId) {
    if (!modelId) return false;
    const m = String(modelId).toLowerCase();
    return REASONING_MODEL_IDS.some(id => m === id.toLowerCase() || m.includes(id.toLowerCase()));
}

export function handleHuntProgress(data) {
    const { hunt_id, step, message } = data;
    
    // Find the row by hunt_id (already globally unique)
    const row = document.getElementById(`hunt-row-${hunt_id}`);
    if (!row) return;
    
    const modelId = row.dataset.modelId || '';
    const isReasoning = isReasoningModel(modelId);
    
    // Map step to display text; for model_thinking show time expectation (human language, no hyphen)
    const stepDisplay = {
        'calling_model': { text: isReasoning ? 'Model is reasoning, this may take 1–2 minutes' : 'Model is generating, usually under 30 seconds', color: 'var(--info)' },
        'model_thinking': { text: isReasoning ? 'Model is reasoning, this may take 1–2 minutes' : 'Model is generating, usually under 30 seconds', color: 'var(--info)' },
        'received_response': { text: 'Response received', color: 'var(--info)' },
        'judging': { text: 'Judging', color: 'var(--accent-primary)' }
    };
    
    const display = stepDisplay[step] || { text: (step === 'running' ? (isReasoning ? 'Model is reasoning, this may take 1–2 minutes' : 'Model is generating, usually under 30 seconds') : (step || 'Model thinking')), color: 'var(--text-muted)' };
    
    // Update status cell with detailed progress
    row.querySelector('.status-cell').innerHTML = `
        <span class="score-badge pending" style="font-size: 0.75rem;">
            <span class="spinner"></span> ${display.text}
        </span>
    `;
    
    debugLog(`Hunt ${hunt_id} progress: ${step} - ${message}`);
}

export function handleHuntResult(data) {
    const { hunt_id, status, score, is_breaking, error, completed, total, breaks, response, model } = data;
    
    // hunt_id from backend is already globally unique (no offset calculation needed)
    const globalRowNum = hunt_id;
    
    // Debug log
    debugLog('Hunt Result:', { 
        hunt_id, 
        status, 
        score, 
        is_breaking, 
        globalRowNum
    });
    
    // Store result with response data
    state.results.push(data);
    
    // Store in allResponses for selection phase (with row number for reference)
    if (response && status === 'completed' && !error) {
        const responseData = {
            ...data,
            rowNumber: globalRowNum - 1  // 0-based index for allResponses
        };
        // Only add if not already present (avoid duplicates on re-judging)
        const existingIndex = state.allResponses.findIndex(r => r.hunt_id === data.hunt_id);
        if (existingIndex >= 0) {
            state.allResponses[existingIndex] = responseData;
        } else {
            state.allResponses.push(responseData);
        }
    }
    
    // Add to blind judging queue if completed successfully (for criteria review later)
    if (status === 'completed' && !error) {
        state.blindJudging.queue.push(data);
    }
    
    // Update table row using global row number
    const row = document.getElementById(`hunt-row-${globalRowNum}`);
    if (row) {
        // Status
        if (status === 'failed') {
            row.querySelector('.status-cell').innerHTML = `
                <span class="score-badge" style="background: var(--danger-bg); color: var(--danger);">Failed</span>
            `;
            row.querySelector('.score-cell').innerHTML = '-';
        } else {
            row.querySelector('.status-cell').innerHTML = `
                <span class="score-badge" style="background: var(--success-bg); color: var(--success);">Done</span>
            `;
            
            // Score - SHOW IMMEDIATELY (score 0 = GREEN/wanted, score 1 = RED/not wanted)
            if (score !== null && score !== undefined) {
                row.querySelector('.score-cell').innerHTML = `
                    <span class="score-badge score-${score}">
                        ${score === 0 ? '✅ 0' : '❌ 1'}
                    </span>
                `;
            } else {
                // Score is null - display warning
                row.querySelector('.score-cell').innerHTML = `
                    <span class="score-badge" style="background: var(--warning-bg); color: var(--warning);">?</span>
                `;
            }
        }
        
        // Result - SHOW criteria summary (C1: ✓ C2: ✗) for completed hunts
        const resultCell = row.querySelector('.result-cell') || row.querySelector('.issues-cell');
        if (resultCell) {
            if (error) {
                resultCell.textContent = error.substring(0, 50) + '...';
            } else {
                const criteria = data.judge_criteria || data.grading_basis || {};
                const parts = Object.entries(criteria)
                    .filter(([, v]) => v && String(v).toUpperCase() in { PASS: 1, FAIL: 1 })
                    .map(([k, v]) => `${k}: ${String(v).toUpperCase() === 'PASS' ? '✓' : '✗'}`)
                    .slice(0, 5);
                resultCell.textContent = parts.length > 0 ? parts.join(' ') : (is_breaking ? 'Breaking' : '-');
            }
        }
        
        // Response - SHOW "View" BUTTON for all completed hunts (success or failed)
        const responseCell = row.querySelector('.response-cell');
        const isComplete = String(status || '').toLowerCase() === 'completed' || String(status || '').toLowerCase() === 'failed';
        if (responseCell && isComplete) {
            const responseText = (response && typeof response === 'string') ? response.trim() : '';
            
            // Store response data for slide-out panel (always, so View works)
            state.huntResponseData[globalRowNum] = {
                huntNum: globalRowNum,
                model: model || 'Unknown',
                status: status || 'pending',
                score: score,
                is_breaking: is_breaking,
                response: responseText || (error ? `Error: ${error}` : '(No response)'),
                error: error
            };
            
            // Render View button only (response shown in slideout on click)
            responseCell.innerHTML = `
                <button class="response-view-btn" type="button" data-row-number="${globalRowNum}">View</button>
            `;
        } else if (responseCell && error && !isComplete) {
            responseCell.innerHTML = `
                <span style="color: var(--danger); font-size: 0.85rem;">Error: ${escapeHtml(error.substring(0, 100))}</span>
            `;
        }
    }
    
    // Update progress (with turn context) - use optional chaining in case elements are null
    const totalVal = Number(total) || 0;
    const completedVal = Number(completed) || 0;
    const percent = totalVal > 0 ? Math.round((completedVal / totalVal) * 100) : 0;
    if (elements.progressFill) elements.progressFill.style.width = `${percent}%`;
    const turnCtx = (state.isMultiTurn || state.currentTurn > 1) ? ` (Turn ${state.currentTurn})` : '';
    if (elements.progressText) elements.progressText.textContent = `${completedVal} / ${totalVal} hunts complete${turnCtx}`;
    if (elements.progressPercent) elements.progressPercent.textContent = `${percent}%`;
    
    // Update breaks indicator
    const dots = elements.breaksIndicator?.querySelectorAll('.break-dot') || [];
    for (let i = 0; i < breaks && i < dots.length; i++) {
        dots[i].classList.add('found');
    }
}


// ============== Hunt Number Controls ==============

export function initHuntNumberControls() {
    const numberInput = document.getElementById('parallelWorkers');
    const presetBtns = document.querySelectorAll('.preset-btn');
    
    if (!numberInput) return;
    
    function updateValue(value) {
        const val = Math.max(1, Math.min(6, parseInt(value) || 4));
        numberInput.value = val;
        presetBtns.forEach(btn => {
            if (parseInt(btn.dataset.value) === val) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
    
    presetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            updateValue(btn.dataset.value);
            updateHuntLimitUI();
        });
    });
    
    updateValue(4);
}
