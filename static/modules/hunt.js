/**
 * hunt.js — Hunt Execution, SSE Progress, Hunt Limits
 * 
 * Handles hunt configuration, execution via SSE, progress tracking,
 * hunt limit enforcement, and response fetching.
 * 
 * Dependencies: config.js, utils.js, state.js, dom.js, results.js
 */

import { elements } from './dom.js';
import { MAX_HUNTS_PER_NOTEBOOK, getJudgeModels, getConfigValue } from './config.js';
import { 
    loadHuntCount, 
    saveHuntCount, 
    getModelDisplayName, 
    startTipRotation,
    getTurnColor,
    escapeHtml 
} from './utils.js';
import { state } from './state.js';
import { showToast } from './celebrations.js';
import { 
    handleHuntComplete, 
    fetchAllResponses, 
    openResponseSlideout 
} from './results.js';
import { showMultiTurnDecision, updateTurnAwareUI } from './multiturn.js';
import { showUpdatePrompt, hasPendingUpdate } from './api.js';
import { syncActiveRunToNotebook } from './testbed.js';



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
    const presetBtns = document.querySelectorAll('.hunt-parallel-btn');
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
    
    // Disable Start Hunt button if per-turn limit reached — bypass in admin mode or bypass_hunt_criteria
    if (elements.startHuntBtn && state.huntLimitReached && !state.adminMode && !getConfigValue('bypass_hunt_criteria', false)) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Turn hunt limit reached. Continue to next turn or end session.';
    }
}

/**
 * Show a warning confirmation dialog when hunts will cross 12 this turn.
 * Returns a Promise that resolves to true (continue) or false (cancel).
 */
function showHuntWarningDialog(remainingAfter) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:var(--bg-secondary,#1e1e2e);border-radius:12px;padding:1.5rem 2rem;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);border:1px solid var(--border,#333);">
                <div style="font-size:1.5rem;text-align:center;margin-bottom:0.75rem;">⚠️</div>
                <div style="font-weight:700;font-size:1.05rem;text-align:center;margin-bottom:0.75rem;color:var(--warning,#f59e0b);">
                    Hunt Limit Warning
                </div>
                <div style="font-size:0.9rem;color:var(--text-secondary,#a0a0b0);text-align:center;margin-bottom:1.25rem;line-height:1.5;">
                    After this run, only <strong style="color:var(--warning,#f59e0b);">${Math.max(0, remainingAfter)}</strong> hunt${remainingAfter !== 1 ? 's' : ''} will remain for this turn (max ${MAX_HUNTS_PER_NOTEBOOK} per turn).<br>
                    Are you sure you want to continue?
                </div>
                <div style="display:flex;gap:0.75rem;justify-content:center;">
                    <button id="huntWarnNo" style="padding:0.5rem 1.25rem;border-radius:8px;border:1px solid var(--border,#444);background:transparent;color:var(--text-primary,#e0e0e0);cursor:pointer;font-weight:600;">No, go back</button>
                    <button id="huntWarnYes" style="padding:0.5rem 1.25rem;border-radius:8px;border:none;background:var(--warning,#f59e0b);color:#000;cursor:pointer;font-weight:600;">Yes, continue</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#huntWarnYes').addEventListener('click', () => { overlay.remove(); resolve(true); });
        overlay.querySelector('#huntWarnNo').addEventListener('click', () => { overlay.remove(); resolve(false); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    });
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

export function getHuntMode() {
    const sel = document.getElementById('huntModeSelect');
    return sel?.value || 'break_50';
}

/** Map hunt mode to {passing_mode, pass_threshold} for backend config.
 *
 * pass_threshold controls when the judge scores a response as passing (1) vs breaking (0):
 *   0.0 → only pass_rate > 0 gives score=1  → breaking requires ALL criteria to fail
 *   0.5 → pass_rate > 0.5 gives score=1     → breaking when >50% criteria fail
 *   1.0 → only pass_rate == 1.0 gives score=1 → breaking when ANY 1 criterion fails
 */
function getHuntModeConfig(huntMode) {
    switch (huntMode) {
        case 'all_passing':
            return { passing_mode: true, pass_threshold: 1.0 };
        case 'break_all':
            return { passing_mode: false, pass_threshold: 0.0 };
        case '1_breaking':
            return { passing_mode: false, pass_threshold: 1.0 };
        case 'break_50':
        default:
            return { passing_mode: false, pass_threshold: 0.5 };
    }
}

export function getConfig() {
    const model = elements.modelSelect?.value || 'qwen/qwen3-235b-a22b-thinking-2507';
    const huntCount = parseInt(elements.parallelWorkers.value) || 4;
    
    // Create array with same model for all hunts
    const models = Array(huntCount).fill(model);
    
    const provider = elements.providerSelect?.value || 'openrouter';
    const judgeModels = getJudgeModels(provider);
    const defaultJudge = judgeModels[0]?.id || 'openai/gpt-5.2';

    const huntMode = getHuntMode();
    const { passing_mode, pass_threshold } = getHuntModeConfig(huntMode);

    return {
        parallel_workers: huntCount,
        target_breaks: huntCount, // All hunts should run (no early stop based on target)
        models: models,
        provider: provider,
        reasoning_budget_percent: 0.9,
        max_retries: 3, // Hardcoded to 3 retries
        judge_model: elements.judgeModel?.value || defaultJudge,
        independent_judging: true, // Mandatory per user request
        custom_judge_system_prompt: null,
        pass_threshold,
        passing_mode,
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
    
    // MANDATORY: Testbed validation check — must pass ideal response judge before hunting
    if (!state.referenceValidated && !state.adminMode && !getConfigValue('bypass_hunt_criteria', false)) {
        showToast('❌ Please complete testbed validation first. Judge your ideal response in the Testbed before hunting.', 'error');
        return;
    }
    
    // Check for pending update before starting new hunt
    if (hasPendingUpdate()) {
        await showUpdatePrompt();
        // If user chose "Continue Anyway", we proceed
        // If user chose "Refresh Now", page reloads (won't reach here)
    }
    
    // TESTING FLAG: bypass_hunt_criteria in global.yaml skips the 3 criteria checks below
    const bypassCriteria = getConfigValue('bypass_hunt_criteria', false);

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
    
    // WARNING: Show confirmation when hunts will cross 12 this turn (only 4 remaining)
    if (!state.adminMode) {
        const projectedTotal = state.huntsThisTurn + requestedHunts;
        if (projectedTotal > 12) {
            const remainingAfter = MAX_HUNTS_PER_NOTEBOOK - projectedTotal;
            const confirmed = await showHuntWarningDialog(remainingAfter);
            if (!confirmed) return;
        }
    }
    
    // CRITICAL: Calculate hunt offset BEFORE incrementing count
    // This is the starting hunt_id for this run (previous total hunts)
    const huntOffset = state.totalHuntsCount;
    
    // CRITICAL FIX: Capture config BEFORE incrementing count
    // incrementHuntCount calls updateHuntLimitUI which modifies the UI input values!
    // If we call getConfig() after, it reads the modified (lower) values.
    state.config = getConfig();

    // Persist the raw hunt mode string for selection-stage logic
    state.config.hunt_mode = getHuntMode();

    // Lock mode dropdown after first hunt — cannot switch modes within a session
    lockHuntMode();
    
    // Increment hunt count immediately (before the hunt starts)
    // This will update UI but we already captured the config
    incrementHuntCount(state.notebookId, requestedHunts);
    
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
    
    // Sync current notebook fields to backend before hunt starts.
    // Covers the case where the user edited prompt/criteria in the testbed
    // (saveRunToTurn updates state.notebook but not Redis).
    // Always read prompt from the DOM editor first — it is the authoritative source.
    syncActiveRunToNotebook();  // pull latest testbed run → state.notebook (no-op if no active run)
    {
        const promptEl = document.getElementById('promptMarkdown');
        const livePrompt = (promptEl?.value ?? '').trim() || (state.notebook?.prompt ?? '').trim();
        const liveRef   = state.notebook?.response_reference ?? '';
        const liveJsp   = state.notebook?.judge_system_prompt ?? '';

        const cells = [];
        if (livePrompt) cells.push({ cell_type: 'prompt',            content: livePrompt });
        if (liveRef)    cells.push({ cell_type: 'response_reference', content: liveRef });
        if (liveJsp)    cells.push({ cell_type: 'judge_system_prompt', content: liveJsp });

        if (cells.length > 0) {
            await fetch(`/api/update-notebook-cells/${state.sessionId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cells, session_only: true })
            });
        }
    }

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
}

export function updateTableRow(huntId, data) {
    // hunt_id from backend is already globally unique (no offset needed)
    const row = document.getElementById(`hunt-row-${huntId}`);
    if (!row) {
        console.warn(`Row hunt-row-${huntId} not found`);
        return;
    }
    
    if (data.model) {
        row.querySelector('.model-cell').textContent = getModelDisplayName(data.model);
    }
    
    if (data.status === 'running') {
        row.querySelector('.status-cell').innerHTML = `
            <span class="score-badge pending">
                <span class="spinner"></span> Model thinking
            </span>
        `;
    }
}

export function handleHuntProgress(data) {
    const { hunt_id, step, message } = data;
    
    // Find the row by hunt_id (already globally unique)
    const row = document.getElementById(`hunt-row-${hunt_id}`);
    if (!row) return;
    
    // Map step to display text (no emojis except score column)
    // "calling_model" deprecated - if received, show "Model thinking" instead
    const stepDisplay = {
        'calling_model': { text: 'Model thinking', color: 'var(--info)' },
        'model_thinking': { text: 'Model thinking', color: 'var(--info)' },
        'received_response': { text: 'Response received', color: 'var(--info)' },
        'judging': { text: 'Judging', color: 'var(--accent-primary)' }
    };
    
    const display = stepDisplay[step] || { text: (step === 'running' ? 'Model thinking' : (step || 'Model thinking')), color: 'var(--text-muted)' };
    
    // Update status cell with detailed progress
    row.querySelector('.status-cell').innerHTML = `
        <span class="score-badge pending" style="font-size: 0.75rem;">
            <span class="spinner"></span> ${display.text}
        </span>
    `;
    
}

export function handleHuntResult(data) {
    const { hunt_id, status, score, is_breaking, error, completed, total, breaks, response, model } = data;
    
    // hunt_id from backend is already globally unique (no offset calculation needed)
    const globalRowNum = hunt_id;
    
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
            
            // Score - SHOW IMMEDIATELY
            // Breaking mode: score 0 = wanted (green), score 1 = not wanted (red)
            // Passing mode: score 1 = wanted (green), score 0 = not wanted (red)
            const passingMode = state.config?.passing_mode === true;
            if (score !== null && score !== undefined) {
                const wanted = passingMode ? score === 1 : score === 0;
                row.querySelector('.score-cell').innerHTML = `
                    <span class="score-badge score-${score}" title="${passingMode ? (score === 1 ? 'Pass' : 'Fail') : (score === 0 ? 'Break' : 'Pass')}">
                        ${wanted ? '✅' : '❌'} ${score}
                    </span>
                `;
            } else {
                // Score is null - display warning
                row.querySelector('.score-cell').innerHTML = `
                    <span class="score-badge" style="background: var(--warning-bg); color: var(--warning);">?</span>
                `;
            }
        }
        
        // Result - SHOW IMMEDIATELY (no emojis)
        const resultCell = row.querySelector('.result-cell') || row.querySelector('.issues-cell');
        const passingMode = state.config?.passing_mode === true;
        if (resultCell) {
            if (error) {
                resultCell.textContent = error.substring(0, 50) + '...';
            } else if (passingMode && score === 1) {
                resultCell.textContent = 'Passing';
            } else if (is_breaking) {
                resultCell.textContent = 'Breaking';
            } else {
                resultCell.textContent = '-';
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

function updateHuntButtonLabel() {
    const label = document.getElementById('startHuntBtnLabel');
    if (!label) return;
    const mode = getHuntMode();
    label.textContent = mode === 'all_passing' ? 'Find Passing Responses' : 'Find Breaking Responses';
}

/** Sync hunt mode from state.config (e.g. when hydrating session). */
export function syncHuntModeFromConfig() {
    const cfg = state.config || {};
    const passing = cfg.passing_mode === true;
    const threshold = cfg.pass_threshold ?? 0.5;
    const huntMode = cfg.hunt_mode;

    let value = 'break_50';
    if (huntMode && huntMode !== 'break_50') {
        value = huntMode;
    } else if (passing) {
        value = 'all_passing';
    }

    const sel = document.getElementById('huntModeSelect');
    if (sel && sel.value !== value) {
        sel.value = value;
        updateHuntButtonLabel();
    }
}

/** Lock the hunt mode dropdown so it cannot be changed during the session. */
export function lockHuntMode() {
    const sel = document.getElementById('huntModeSelect');
    if (sel) {
        sel.disabled = true;
        sel.title = 'Hunt mode is locked after the first hunt. Reload the notebook to change.';
    }
    state._huntModeLocked = true;
}

/** Unlock the hunt mode dropdown (e.g. on fresh notebook load). */
export function unlockHuntMode() {
    const sel = document.getElementById('huntModeSelect');
    if (sel) {
        sel.disabled = false;
        sel.title = '';
    }
    state._huntModeLocked = false;
}

export function initHuntNumberControls() {
    const numberInput = document.getElementById('parallelWorkers');
    const presetBtns = document.querySelectorAll('.hunt-parallel-btn');
    
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

    // Hunt mode: update button label when mode changes
    const huntModeSel = document.getElementById('huntModeSelect');
    if (huntModeSel) {
        huntModeSel.addEventListener('change', updateHuntButtonLabel);
    }
    updateHuntButtonLabel();
}
