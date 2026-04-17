/**
 * results/huntCompleteAndFetch.js — post-hunt handling, fetch-all, criteria gate, selection bootstrap.
 */

import { elements } from '../dom.js';
import { state, getCumulativeStats, setActivePhase } from '../state.js';
import { renderInsightTip } from '../utils.js';
import { showToast, showError } from '../celebrations.js?v=43';
import { showMultiTurnDecision, updateTurnAwareUI } from '../multiturn.js';
import { showAppModal } from '../api.js';
import { adminBypass, getHuntModeById, getSelectionSlots } from '../config.js';
import { playHuntComplete, playHuntCompleteEmpty } from '../sounds.js?v=43';
import { countBreakingPassing } from './resultModel.js';
import { expandSelectionSectionCard } from './selectionSection.js';
import { displaySelectionCards } from './selectionTable.js';

export function handleHuntComplete(data) {
    state.isHunting = false;
    setActivePhase('reviewing');

    elements.startHuntBtn.classList.remove('loading');
    elements.startHuntBtn.disabled = false;
    elements.startHuntBtn.title = '';

    // NOTE: do NOT unhide the first `.section` here — that element is the
    // Load Notebook upload card and it must stay hidden for the entire
    // task lifecycle. Load Notebook is only ever shown by the "+ New Task"
    // flow in app.js. Re-showing it after each hunt was a bug that let
    // trainers swap the notebook mid-task.
    elements.configSection?.classList.remove('hidden');
    elements.progressSection?.classList.remove('hunt-active');

    if (elements.modelSelect) {
        elements.modelSelect.disabled = false;
        elements.modelSelect.title = '';
    }
    if (elements.providerSelect) {
        elements.providerSelect.disabled = false;
        elements.providerSelect.title = '';
    }
    document.getElementById('modelPillGrid')?.classList.remove('hc-locked');
    document.getElementById('providerSegment')?.classList.remove('hc-locked');

    const { breaks_found } = data;
    if (breaks_found > 0) {
        playHuntComplete();
    } else {
        playHuntCompleteEmpty();
    }

    const _aurora = document.getElementById('auroraCanvas');
    if (_aurora) {
        _aurora.classList.remove('hunting');
        _aurora.classList.add('complete');
        setTimeout(() => _aurora.classList.remove('complete'), 2500);
    }

    elements.huntStatus.querySelector('.status-dot').className = 'status-dot completed';
    const turnSuffix = (state.isMultiTurn || state.currentTurn > 1) ? ` — Turn ${state.currentTurn}` : '';
    elements.statusText.textContent = `Completed${turnSuffix}`;

    state.llmRevealed = false;
    state.humanReviews = {};

    if (state.isMultiTurn || state.currentTurn > 1) {
        updateTurnAwareUI();
    }

    fetchAllResponses().then(() => {
        showMultiTurnDecision();
    });
}

/**
 * Fetch all responses from the session and accumulate them in state.
 * Does NOT show selection UI — that's triggered separately.
 */
export async function fetchAllResponses(options = {}) {
    try {
        const response = await fetch(`api/results/${state.sessionId}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to fetch results: ${response.status}`);
        const data = await response.json();
        const rawResults = data.results || [];

        const newResponses = rawResults.filter(r => !state.previousTurnHuntIds.has(r.hunt_id));

        if (options.replace) {
            state.allResponses = newResponses.map((r, idx) => ({ ...r, rowNumber: idx }));
        } else {
            newResponses.forEach(newResponse => {
                const existingIndex = state.allResponses.findIndex(r => r.hunt_id === newResponse.hunt_id);
                if (existingIndex >= 0) {
                    state.allResponses[existingIndex] = {
                        ...newResponse,
                        rowNumber: state.allResponses[existingIndex].rowNumber
                    };
                } else {
                    const newRowNumber = state.allResponses.length;
                    state.allResponses.push({ ...newResponse, rowNumber: newRowNumber });
                }
            });
        }

        const cumul = getCumulativeStats();
        elements.summarySection?.classList.remove('hidden');
        const summaryTotal = document.getElementById('summaryTotal');
        const summaryBreaks = document.getElementById('summaryBreaks');
        if (summaryTotal) summaryTotal.textContent = cumul.totalHunts;
        if (summaryBreaks) summaryBreaks.textContent = cumul.totalBreaks;
    } catch (error) {
        console.error('Error fetching results:', error);
        showError(error, { operation: 'Fetch results' });
    }
}

export async function fetchAllResponsesAndShowSelection(completedHunts, breaksFound) {
    try {
        const response = await fetch(`api/results/${state.sessionId}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to fetch results: ${response.status}`);
        const data = await response.json();

        const newResponses = (data.results || []).filter(r =>
            !state.previousTurnHuntIds.has(r.hunt_id)
        );

        newResponses.forEach(newResponse => {
            const existingIndex = state.allResponses.findIndex(r => r.hunt_id === newResponse.hunt_id);
            if (existingIndex >= 0) {
                state.allResponses[existingIndex] = {
                    ...newResponse,
                    rowNumber: state.allResponses[existingIndex].rowNumber
                };
            } else {
                const newRowNumber = state.allResponses.length;
                state.allResponses.push({ ...newResponse, rowNumber: newRowNumber });
            }
        });

        const { breakingCount: totalBreaks, passingCount: totalPasses } = countBreakingPassing(state.allResponses);
        const huntMode = state.config?.hunt_mode || 'break_50';

        const cumulative = getCumulativeStats();
        elements.summarySection.classList.remove('hidden');
        document.getElementById('summaryTotal').textContent = cumulative.totalHunts;
        document.getElementById('summaryBreaks').textContent = cumulative.totalBreaks;

        const successRate = cumulative.totalHunts > 0 ? Math.round((cumulative.totalBreaks / cumulative.totalHunts) * 100) : 0;
        document.getElementById('summarySuccess').textContent = `${successRate}% (${cumulative.totalBreaks}/${cumulative.totalHunts} breaks)`;
        const summaryMinBreaking = state.config?.min_breaking_required ?? 0;
        const summaryMode = getHuntModeById(huntMode);
        let criteriaMet_display;
        if (summaryMode.type === 'passing') {
            criteriaMet_display = cumulative.totalPasses >= 1;
        } else if (summaryMinBreaking === 0 && !summaryMode.count_based) {
            criteriaMet_display = cumulative.totalHunts >= 1;
        } else if (summaryMode.count_based) {
            criteriaMet_display = cumulative.totalBreaks >= (summaryMode.required_breaking ?? 1);
        } else {
            criteriaMet_display = cumulative.totalBreaks >= summaryMinBreaking;
        }
        document.getElementById('summaryMet').textContent = criteriaMet_display ? 'Yes' : 'No';

        const _bypassSel = state.adminMode && adminBypass('selection_mode_rules');
        let criteriaMet = _bypassSel;
        let gateFailTitle = '';
        let gateFailMessage = '';

        if (!_bypassSel) {
            const gateMode = getHuntModeById(huntMode);
            const minBreaking = state.config?.min_breaking_required ?? 0;

            if (gateMode.type === 'passing') {
                criteriaMet = totalPasses >= 1;
                gateFailTitle = 'No passing responses found';
                gateFailMessage = `You need at least 1 passing (non-breaking) response to proceed. Currently ${totalPasses} passing, ${totalBreaks} breaking. Run more hunts!`;
            } else if (gateMode.count_based) {
                const req = gateMode.required_breaking ?? 1;
                criteriaMet = totalBreaks >= req;
                gateFailTitle = `At least ${req} breaking response(s) required`;
                gateFailMessage = `You need at least ${req} breaking response(s) in ${gateMode.name} mode. Currently ${totalBreaks} breaking, ${totalPasses} passing. Run more hunts!`;
            } else if (minBreaking === 0) {
                criteriaMet = totalPasses + totalBreaks >= 1;
                gateFailTitle = 'No responses found';
                gateFailMessage = `You need at least 1 hunt result to proceed. Currently ${totalPasses} passing, ${totalBreaks} breaking. Run more hunts!`;
            } else {
                criteriaMet = totalBreaks >= minBreaking;
                gateFailTitle = `You need at least ${minBreaking} breaking responses to continue`;
                gateFailMessage = `${gateMode.name} mode with Min Breaking ${minBreaking}. You have ${totalBreaks} breaking right now. Run more hunts, then try again.`;
            }
        }

        if (!criteriaMet) {
            elements.selectionSection.classList.add('hidden');
            showToast(gateFailMessage, 'warning');
            await showAppModal({
                title: gateFailTitle,
                message: gateFailMessage,
                buttons: [{ label: 'OK', primary: true, value: true }]
            });
            return;
        }

        elements.selectionSection.classList.remove('hidden');
        expandSelectionSectionCard();

        renderInsightTip('selectionTipContainer', 'selection');

        displaySelectionCards();

        const slots = getSelectionSlots();
        const activeMode = getHuntModeById(huntMode);
        const hintMinBreaking = state.config?.min_breaking_required ?? 0;
        let modeHint;
        if (activeMode.type === 'passing' || hintMinBreaking === 0) modeHint = 'Select passing hunts for review.';
        else if (activeMode.count_based) modeHint = `Select the ${activeMode.required_breaking ?? 1} breaking hunt(s) + any passing hunts.`;
        else modeHint = `Select exactly ${slots} (at least ${hintMinBreaking} breaking).`;
        showToast(`Criteria met! ${totalBreaks} breaks, ${totalPasses} passes. ${modeHint}`, 'success');
    } catch (error) {
        console.error('Error fetching results:', error);
        showError(error, { operation: 'Fetch results' });
    }
}
