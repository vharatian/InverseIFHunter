/**
 * multiturn.js — Turn-Aware UI, Multi-Turn Flow, Calibration
 * 
 * Handles turn journey bar, conversation thread, multi-turn decisions,
 * calibration mode, turn history, and turn advancement.
 * 
 * Dependencies: config.js, utils.js, state.js, dom.js (+ celebrations, results, notebook, editors, hunt)
 */

import { elements } from './dom.js';
import { state, resetTurnState } from './state.js';
import { 
    escapeHtml, 
    renderInsightTip,
    getTurnColor,
    getTurnColorClass,
    getModelDisplayName
} from './utils.js';
import { showToast, showError } from './celebrations.js';
import { fetchAllResponses, fetchAllResponsesAndShowSelection } from './results.js';
import { renderPriorConversationBanner, enableNavTestbedButton, resetTestbed, showTestbed } from './testbed.js';
import { progressiveSaveToColab } from './notebook.js';
import { validatePromptLength } from './editors.js';
// It uses showCalibrationPanel internally, so no import needed if it's in the same file.
// It uses startHunt (for calibration).
import { updateHuntLimitUI, resetHuntNumberToDefault } from './hunt.js';
import { getConfigValue, adminBypass } from './config.js';
// This circular dependency is fine as long as they are not used at top-level.
// startHunt is called inside handleCalibrationGenerate -> fine.
// showMultiTurnDecision is called inside handleHuntComplete -> fine.

// ============== Turn-Aware UI Functions (Journey Bar, Thread, Badges) ==============

/**
 * Activate a specific turn's tab in the turn history panel.
 * Scrolls to the multi-turn section and clicks the correct tab.
 */
export function activateTurnTab(turnNumber) {
    const section = document.getElementById('multiTurnSection');
    if (!section) return;
    
    // Make the section visible if hidden
    section.classList.remove('hidden');
    
    // Find the correct tab button
    const tabBar = document.getElementById('turnHistoryTabs');
    if (tabBar) {
        const tabs = tabBar.querySelectorAll('button');
        tabs.forEach(tab => {
            // Tab text is like "Turn 1 ✓" or "Turn 2 (current)"
            const match = tab.textContent.match(/Turn\s+(\d+)/);
            if (match && parseInt(match[1]) === turnNumber) {
                tab.click();  // Programmatically click to trigger the render
            }
        });
    }
    
    // Scroll to the turn history card
    const historyCard = document.getElementById('turnHistoryCard');
    if (historyCard) {
        historyCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

/**
 * Render the Turn Journey Bar — horizontal stepper showing all turns.
 */
export function renderJourneyBar() {
    const bar = document.getElementById('turnJourneyBar');
    if (!bar) return;
    
    bar.innerHTML = '';
    
    // Build list: completed turns + current turn + one future placeholder
    const steps = [];
    state.turns.forEach(t => {
        steps.push({ turnNumber: t.turnNumber || t.turn_number, status: 'completed' });
    });
    steps.push({ turnNumber: state.currentTurn, status: 'active' });
    steps.push({ turnNumber: state.currentTurn + 1, status: 'future' });
    
    steps.forEach((step, idx) => {
        // Add connector before each step (except the first)
        if (idx > 0) {
            const connector = document.createElement('div');
            connector.className = 'journey-connector';
            if (step.status === 'completed' || step.status === 'active') {
                connector.classList.add('completed');
            } else {
                connector.classList.add('dashed');
            }
            bar.appendChild(connector);
        }
        
        const node = document.createElement('div');
        node.className = `journey-node ${step.status}`;
        
        const circle = document.createElement('div');
        circle.className = 'journey-circle';
        const color = getTurnColor(step.turnNumber);
        
        if (step.status === 'completed') {
            circle.style.background = color;
            circle.innerHTML = '&#10003;';
        } else if (step.status === 'active') {
            circle.style.background = color;
            circle.textContent = step.turnNumber;
        } else {
            circle.textContent = '?';
        }
        
        const label = document.createElement('div');
        label.className = 'journey-label';
        if (step.status === 'completed') {
            label.textContent = `Turn ${step.turnNumber}`;
        } else if (step.status === 'active') {
            label.textContent = state.isHunting ? 'Hunting' : 'Active';
        } else {
            label.textContent = 'Next';
        }
        
        node.appendChild(circle);
        node.appendChild(label);
        
        // Click any turn to show its content in the turn history panel
        if (step.status === 'completed' || step.status === 'active') {
            node.addEventListener('click', () => {
                activateTurnTab(step.turnNumber);
            });
        }
        
        bar.appendChild(node);
    });
    
    // Show the bar
    bar.classList.add('visible');
}

/**
 * Render the Conversation Thread — left-rail timeline.
 */
export function renderConversationThread() {
    const thread = document.getElementById('conversationThread');
    if (!thread) return;
    
    // Keep the title, clear the rest
    const title = thread.querySelector('.thread-title');
    thread.innerHTML = '';
    if (title) thread.appendChild(title);
    else {
        const t = document.createElement('div');
        t.className = 'thread-title';
        t.textContent = 'Conversation';
        thread.appendChild(t);
    }
    
    // Completed turns
    state.turns.forEach(t => {
        const turnNum = t.turnNumber || t.turn_number;
        const node = document.createElement('div');
        node.className = 'thread-node completed thread-node-enter';
        node.dataset.turn = turnNum;
        
        const color = getTurnColor(turnNum);
        node.style.setProperty('--node-color', color);
        
        const turnHuntCount = t.huntCount || (t.results || []).length;
        node.innerHTML = `
            <div class="thread-turn-label">
                <span class="turn-badge ${getTurnColorClass(turnNum)}" style="font-size:0.6rem; padding:0.1rem 0.4rem;">T${turnNum}</span>
            </div>
            <div class="thread-prompt-preview">${escapeHtml((t.prompt || '').substring(0, 80))}</div>
            ${t.selectedResponse ? `<div class="thread-response-preview" style="border-left-color:${color};">${escapeHtml(t.selectedResponse.substring(0, 80))}</div>` : ''}
            <div class="thread-status done">&#10003; ${turnHuntCount} hunts</div>
        `;
        
        node.addEventListener('click', () => {
            activateTurnTab(turnNum);
        });
        
        thread.appendChild(node);
    });
    
    // Current turn
    const currentNode = document.createElement('div');
    currentNode.className = 'thread-node active thread-node-enter';
    currentNode.dataset.turn = state.currentTurn;
    const currentColor = getTurnColor(state.currentTurn);
    currentNode.style.setProperty('--node-color', currentColor);
    
    const currentPrompt = state.notebook?.prompt || '';
    const huntCount = state.huntsThisTurn || 0;
    
    currentNode.innerHTML = `
        <div class="thread-turn-label">
            <span class="turn-badge ${getTurnColorClass(state.currentTurn)}" style="font-size:0.6rem; padding:0.1rem 0.4rem;">T${state.currentTurn}</span>
        </div>
        <div class="thread-prompt-preview">${escapeHtml(currentPrompt.substring(0, 80))}</div>
        <div class="thread-status hunting">${state.isHunting ? '● Hunting...' : (huntCount > 0 ? `${huntCount} hunts` : 'Ready')}</div>
    `;
    
    thread.appendChild(currentNode);
    
    // Activate the two-column layout and show thread
    const container = document.getElementById('mainContainer');
    if (container) container.classList.add('multi-turn-layout');
    thread.classList.add('visible');
    
    // Hide metadata sidebar to avoid overlap with conversation thread
    if (elements.metadataSidebar) {
        elements.metadataSidebar.style.display = 'none';
        document.body.classList.remove('sidebar-visible');
    }
}

/**
 * Update all turn-aware section headers, progress info, and badges.
 */
export function updateTurnAwareUI() {
    const turn = state.currentTurn;
    const color = getTurnColor(turn);
    const colorClass = getTurnColorClass(turn);
    
    // Add class to body/main for CSS-based visibility
    document.body.classList.toggle('multi-turn-active', state.isMultiTurn || turn > 1);
    
    // Update progress section header badge
    const progressBadge = document.getElementById('progressTurnBadge');
    const progressTitle = document.getElementById('progressTitleText');
    if (progressBadge && (state.isMultiTurn || turn > 1)) {
        progressBadge.textContent = `Turn ${turn}`;
        progressBadge.className = `turn-badge section-turn-badge ${colorClass}`;
        progressBadge.style.display = 'inline-flex';
        if (progressTitle) progressTitle.textContent = 'Hunt Progress';
    }
    
    // Update preview section header badge
    const previewBadge = document.getElementById('previewTurnBadge');
    const previewTitle = document.getElementById('previewTitleText');
    if (previewBadge && (state.isMultiTurn || turn > 1)) {
        previewBadge.textContent = `Turn ${turn}`;
        previewBadge.className = `turn-badge section-turn-badge ${colorClass}`;
        previewBadge.style.display = 'inline-flex';
        if (previewTitle) previewTitle.textContent = 'Prompt & Criteria';
    }
    
    // Update per-turn progress info
    const turnInfo = document.getElementById('progressTurnInfo');
    const turnScope = document.getElementById('progressTurnScope');
    const cumulative = document.getElementById('progressCumulative');
    if (turnInfo && (state.isMultiTurn || turn > 1)) {
        turnInfo.style.display = 'flex';
        if (turnScope) turnScope.textContent = `Turn ${turn}`;
        if (cumulative) {
            const globalTotal = state.multiTurnTotalHunts + (state.allResponses?.length || 0);
            cumulative.textContent = globalTotal > 0 ? `${globalTotal} total across ${turn} turns` : '';
        }
    }
    
    // Update progress bar color
    const progressFill = document.getElementById('progressFill');
    if (progressFill && (state.isMultiTurn || turn > 1)) {
        progressFill.style.background = color;
    }
    
    // Update the decision fork "next turn" number
    const decisionNextTurn = document.getElementById('decisionNextTurn');
    if (decisionNextTurn) decisionNextTurn.textContent = turn + 1;
    
    // Render journey bar and thread if multi-turn
    if (state.isMultiTurn || turn > 1) {
        renderJourneyBar();
        renderConversationThread();
    }
}

// ============== Multi-Turn Functions ==============

/**
 * Show the multi-turn decision panel after a hunt completes.
 * Trainer chooses: "This turn is breaking" or "Select good response & continue".
 */
export function showMultiTurnDecision() {
    const section = document.getElementById('multiTurnSection');
    if (!section) return;
    
    // Update turn title
    const title = document.getElementById('multiTurnTitle');
    if (title) {
        title.textContent = `Turn ${state.currentTurn} Complete — What Next?`;
    }
    
    // Populate decision summary stats
    const hunts = state.allResponses?.length || 0;
    const breaks = (state.allResponses || []).filter(r => (r.judge_score === 0 || r.score === 0)).length;
    const passes = (state.allResponses || []).filter(r => {
        const s = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : (r.score !== undefined && r.score !== null ? Number(r.score) : null);
        return s !== null && s > 0;
    }).length;
    const turnStat = document.getElementById('decisionTurnStat');
    const huntStat = document.getElementById('decisionHuntStat');
    const breakStat = document.getElementById('decisionBreakStat');
    const turnColor = getTurnColor(state.currentTurn);
    
    const passingMode = state.config?.passing_mode === true;
    if (turnStat) turnStat.innerHTML = `<span class="turn-badge ${getTurnColorClass(state.currentTurn)}">Turn ${state.currentTurn}</span> Complete`;
    if (huntStat) huntStat.textContent = `${hunts} hunts`;
    if (breakStat) breakStat.innerHTML = passingMode ? `${passes} pass${passes !== 1 ? 'es' : ''} found` : `${breaks} break${breaks !== 1 ? 's' : ''} found`;
    
    // Update "Continue to Turn X" button text
    const nextTurnSpan = document.getElementById('decisionNextTurn');
    if (nextTurnSpan) nextTurnSpan.textContent = state.currentTurn + 1;
    
    // --- Review Readiness Check ---
    const huntMode = state.config?.hunt_mode || 'break_50';
    const _bypassSelRules = state.adminMode && adminBypass('selection_mode_rules');
    let canReview = _bypassSelRules;
    let readinessMsg = '';

    if (!_bypassSelRules) {
        if (huntMode === 'all_passing') {
            canReview = passes >= 1;
            if (!canReview) readinessMsg = `Need at least 1 passing response (currently ${passes}). Run more hunts!`;
        } else if (huntMode === 'break_all') {
            canReview = breaks >= 1;
            if (!canReview) readinessMsg = `Need at least 1 breaking response (currently ${breaks}). Run more hunts!`;
        } else if (huntMode === '1_breaking') {
            canReview = breaks >= 1;
            if (!canReview) readinessMsg = `Need at least 1 breaking response (currently ${breaks}). Run more hunts!`;
        } else {
            canReview = (breaks >= 4) || (breaks >= 3 && passes >= 1);
            if (!canReview) {
                if (breaks < 3) readinessMsg = `Need at least 3 breaking responses (currently ${breaks}). Run more hunts!`;
                else readinessMsg = `Have 3 breaking but need at least 1 passing response (currently ${passes}). Run more hunts, or get 1 more breaking for 4 total.`;
            }
        }
    }

    const markBreakingBtn = document.getElementById('markBreakingBtn');
    const reviewWarning = document.getElementById('reviewReadinessWarning');
    
    if (canReview) {
        if (markBreakingBtn) {
            markBreakingBtn.disabled = false;
            markBreakingBtn.title = _bypassSelRules ? 'Admin mode — proceed without failures' : '';
        }
        if (reviewWarning) reviewWarning.classList.add('hidden');
    } else {
        if (markBreakingBtn) {
            markBreakingBtn.disabled = true;
            markBreakingBtn.title = readinessMsg;
        }
        if (reviewWarning) {
            reviewWarning.innerHTML = `<span style="margin-right: 0.5rem;">⚠️</span>${readinessMsg}`;
            reviewWarning.classList.remove('hidden');
        }
    }
    
    // Render the tabbed turn history (shows all completed turns + current)
    renderTurnHistoryTabs();
    
    // Reset panels — show decision card and decision panel
    document.getElementById('multiTurnDecisionCard')?.classList.remove('hidden');
    document.getElementById('multiTurnDecisionPanel').classList.remove('hidden');
    document.getElementById('goodResponsePicker').classList.add('hidden');
    document.getElementById('nextTurnEditor').classList.add('hidden');
    
    // Update turn-aware UI elements
    updateTurnAwareUI();
    
    // Show a multi-turn decision tip
    renderInsightTip('multiTurnTipContainer', 'multiTurn');
    
    // Show the section
    section.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Render the tabbed turn history panel.
 * Only shows completed turns (previous turns). The current turn is configured in the main editor area.
 */
export function renderTurnHistoryTabs() {
    const tabBar = document.getElementById('turnHistoryTabs');
    const contentArea = document.getElementById('turnHistoryContent');
    if (!tabBar || !contentArea) return;
    
    tabBar.innerHTML = '';
    
    // Build list of completed turns only (no current turn)
    const allTurns = [];
    state.turns.forEach(t => {
        allTurns.push({
            turnNumber: t.turnNumber || t.turn_number,
            prompt: t.prompt,
            criteria: t.response_reference || t.criteria,
            selectedResponse: t.selectedResponse || t.selected_response || null,
            judgeResult: t.judgeResult || t.judge_result || null,
            status: 'completed',
            results: t.results || []
        });
    });
    
    // No completed turns? Hide the history card
    if (allTurns.length === 0) {
        document.getElementById('turnHistoryCard').style.display = 'none';
        return;
    }
    document.getElementById('turnHistoryCard').style.display = '';
    
    // Create tab buttons (only completed turns)
    allTurns.forEach((turn, idx) => {
        const tab = document.createElement('button');
        const isActive = idx === allTurns.length - 1; // Default: show latest completed turn
        const turnColor = getTurnColor(turn.turnNumber);
        
        tab.style.cssText = `
            padding: 0.6rem 1.2rem;
            border: none;
            background: transparent;
            cursor: pointer;
            font-size: 0.85rem;
            font-weight: 600;
            color: ${isActive ? turnColor : 'var(--text-muted)'};
            border-bottom: 3px solid ${isActive ? turnColor : 'transparent'};
            white-space: nowrap;
            transition: all 0.2s;
        `;
        tab.textContent = `Turn ${turn.turnNumber} ✓`;
        
        tab.addEventListener('mouseenter', () => {
            if (!tab.classList.contains('active-turn-tab')) {
                tab.style.color = 'var(--text-primary)';
                tab.style.borderBottomColor = 'var(--border)';
            }
        });
        tab.addEventListener('mouseleave', () => {
            if (!tab.classList.contains('active-turn-tab')) {
                tab.style.color = 'var(--text-muted)';
                tab.style.borderBottomColor = 'transparent';
            }
        });
        
        tab.addEventListener('click', () => {
            // Update active tab styling
            tabBar.querySelectorAll('button').forEach(b => {
                b.style.color = 'var(--text-muted)';
                b.style.borderBottomColor = 'transparent';
                b.classList.remove('active-turn-tab');
            });
            tab.style.color = turnColor;
            tab.style.borderBottomColor = turnColor;
            tab.classList.add('active-turn-tab');
            
            // Render this turn's content
            renderTurnContent(contentArea, turn);
        });
        
        if (isActive) {
            tab.classList.add('active-turn-tab');
        }
        
        tabBar.appendChild(tab);
    });
    
    // Show the latest turn by default
    renderTurnContent(contentArea, allTurns[allTurns.length - 1]);
}

/**
 * Render the content for a single turn tab.
 */
export function renderTurnContent(container, turn) {
    // Count breaks/passes in results
    const breaks = (turn.results || []).filter(r => 
        (r.judge_score === 0 || r.score === 0)
    ).length;
    const passes = (turn.results || []).filter(r => {
        const s = r.judge_score ?? r.score;
        return s !== null && s !== undefined && s > 0;
    }).length;
    
    let html = '';
    
    // Turn status badge (with per-turn color)
    const turnColor = getTurnColor(turn.turnNumber);
    html += `<div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap;">`;
    html += `<span class="turn-badge ${getTurnColorClass(turn.turnNumber)}">Turn ${turn.turnNumber}</span>`;
    if (turn.results && turn.results.length > 0) {
        html += `<span style="font-size: 0.8rem; color: var(--text-muted);">${turn.results.length} hunts &mdash; ${breaks} breaks, ${passes} passes</span>`;
    }
    if (turn.selectedResponse) {
        html += `<span style="padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; background: rgba(16, 185, 129, 0.15); color: var(--success, #10b981);">Response selected ✓</span>`;
    }
    html += `</div>`;
    
    // Prompt section (border color matches turn color)
    html += `<div style="margin-bottom: 1rem;">`;
    html += `<div style="font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.4rem;">Prompt</div>`;
    html += `<div style="padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px; border-left: 3px solid ${turnColor}; font-size: 0.9rem; white-space: pre-wrap; max-height: 200px; overflow-y: auto;">${escapeHtml(turn.prompt || '')}</div>`;
    html += `</div>`;
    
    // Criteria section
    html += `<div style="margin-bottom: 1rem;">`;
    html += `<div style="font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.4rem;">Criteria / Rubrics</div>`;
    html += `<div style="padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px; border-left: 3px solid ${turnColor}; font-size: 0.9rem; white-space: pre-wrap; max-height: 200px; overflow-y: auto; opacity: 0.9;">${escapeHtml(turn.criteria || '')}</div>`;
    html += `</div>`;
    
    // Selected response (for completed turns)
    if (turn.selectedResponse) {
        html += `<div style="margin-bottom: 1rem;">`;
        html += `<div style="font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.4rem;">Selected Response (carried forward)</div>`;
        html += `<div style="padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px; border-left: 3px solid var(--success, #10b981); font-size: 0.9rem; white-space: pre-wrap; max-height: 300px; overflow-y: auto;">${escapeHtml(turn.selectedResponse)}</div>`;
        html += `</div>`;
    }
    
    // Judge result for the selected response (skip if no real judging occurred)
    if (turn.judgeResult && turn.judgeResult.score != null) {
        const score = turn.judgeResult.score;
        const criteria = turn.judgeResult.criteria || {};
        const explanation = turn.judgeResult.explanation || '';
        const judgeModelName = turn.judgeModel || state.notebook?.judge_model || 'Evaluation Model';
        
        html += `<div style="margin-bottom: 1rem;">`;
        html += `<div style="font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.4rem;">Auto-Judge Result for Selected Response <span style="font-weight:400;text-transform:none;letter-spacing:0;">(judged by ${escapeHtml(judgeModelName)})</span></div>`;
        html += `<div style="padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px; border-left: 3px solid ${score > 0 ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'}; font-size: 0.9rem;">`;
        html += `<div style="font-weight: 600; margin-bottom: 0.5rem;">Score: ${score} ${score > 0 ? '(PASS)' : '(BREAK)'}</div>`;
        
        if (Object.keys(criteria).length > 0) {
            html += `<div style="margin-bottom: 0.5rem;">`;
            for (const [k, v] of Object.entries(criteria)) {
                const isPassing = String(v).toUpperCase() === 'PASS';
                html += `<span style="display: inline-block; margin: 0.15rem 0.25rem; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; background: ${isPassing ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${isPassing ? 'var(--success,#10b981)' : 'var(--danger,#ef4444)'};">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`;
            }
            html += `</div>`;
        }
        
        if (explanation) {
            html += `<div style="font-size: 0.85rem; color: var(--text-secondary); white-space: pre-wrap; max-height: 100px; overflow-y: auto;">${escapeHtml(explanation)}</div>`;
        }
        html += `</div></div>`;
    }
    
    container.innerHTML = html;
}

// escapeHtml — imported from utils.js

/**
 * Handle "This Turn is Breaking" button click.
 * Marks the turn as breaking and proceeds to the standard selection/review flow.
 */
export async function handleMarkBreaking() {
    try {
        // Call mark-breaking API
        const response = await fetch(`/api/mark-breaking/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error(`Mark breaking failed: ${response.statusText}`);
        }
        
        const data = await response.json();
        state.isMultiTurn = data.is_multi_turn;
        
        // Hide multi-turn section
        document.getElementById('multiTurnSection').classList.add('hidden');
        
        // Count total hunts across all turns
        state.multiTurnTotalHunts = state.turns.reduce((sum, t) => sum + (t.results?.length || 0), 0) + state.allResponses.length;
        
        // Proceed to standard selection flow
        const completedHunts = state.allResponses.length;
        const breaksFound = state.allResponses.filter(r => (r.judge_score === 0 || r.score === 0)).length;
        fetchAllResponsesAndShowSelection(completedHunts, breaksFound);
        
    } catch (error) {
        console.error('Error marking breaking:', error);
        showError(error, { operation: `Turn ${state.currentTurn} — Mark breaking` });
    }
}

/**
 * Handle "Select Good Response & Continue" button click.
 * Shows the response picker for selecting a passing response.
 */
export async function handleContinueToNextTurn() {
    // Hide decision panel, show response picker
    document.getElementById('multiTurnDecisionPanel').classList.add('hidden');
    const picker = document.getElementById('goodResponsePicker');
    picker.classList.remove('hidden');

    // Always fetch fresh from API when opening picker (handles empty, race conditions, failed hunts)
    await fetchAllResponses({ replace: true });

    // Populate response list with ALL responses from current turn
    const list = document.getElementById('goodResponseList');
    if (!list) {
        console.error('goodResponseList element not found');
        return;
    }
    list.innerHTML = '';
    
    // Show conversation context (prior turns) if multi-turn
    if (state.conversationHistory.length > 0) {
        const contextDiv = document.createElement('div');
        contextDiv.className = 'response-picker-context';
        let contextHtml = '<div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);margin-bottom:0.4rem;">Conversation so far</div>';
        state.conversationHistory.forEach(msg => {
            const roleClass = msg.role === 'user' ? 'user' : 'assistant';
            contextHtml += `
                <div class="context-message ${roleClass}">
                    <div class="context-message-role">${msg.role}</div>
                    <div class="context-message-text">${escapeHtml((msg.content || '').substring(0, 150))}</div>
                </div>
            `;
        });
        contextDiv.innerHTML = contextHtml;
        list.appendChild(contextDiv);
    }
    
    if (state.allResponses.length === 0) {
        console.warn('[handleContinueToNextTurn] allResponses is empty after fetch');
        const emptyMsg = document.createElement('p');
        emptyMsg.style.color = 'var(--text-muted)';
        emptyMsg.textContent = 'No responses available. Run a hunt first, or refresh the page. Check browser console (F12) for details.';
        list.appendChild(emptyMsg);
        picker.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
    }
    
    
    state.allResponses.forEach((r, idx) => {
        const score = r.judge_score ?? r.score ?? '?';
        const isPassing = score > 0;
        const modelDisplay = getModelDisplayName(r.model);
        const displayNum = idx + 1;
        
        // Build criteria badges if available
        const judgeCriteria = r.judge_criteria || {};
        let criteriaBadgesHtml = '';
        if (Object.keys(judgeCriteria).length > 0) {
            criteriaBadgesHtml = '<div style="display: flex; flex-wrap: wrap; gap: 0.25rem; margin-bottom: 0.5rem;">';
            for (const [k, v] of Object.entries(judgeCriteria)) {
                const isPass = String(v).toUpperCase() === 'PASS';
                criteriaBadgesHtml += `<span style="display: inline-block; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; background: ${isPass ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)'}; color: ${isPass ? 'var(--success,#10b981)' : 'var(--danger,#ef4444)'};">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`;
            }
            criteriaBadgesHtml += '</div>';
        }
        
        const card = document.createElement('div');
        card.style.cssText = `
            padding: 0.75rem 1rem;
            border-radius: 8px;
            border: 1.5px solid ${isPassing ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'};
            background: ${isPassing ? 'rgba(16, 185, 129, 0.04)' : 'rgba(239, 68, 68, 0.04)'};
            cursor: pointer;
            transition: all 0.2s;
        `;
        card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-1px)'; card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'; });
        card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.boxShadow = ''; });
        
        // Show FULL response content (scrollable) — display turn-local number
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <span style="font-weight: 600;">Hunt #${displayNum} — ${modelDisplay}</span>
                <span style="font-weight: 700; color: ${isPassing ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'};">
                    Score: ${score} ${isPassing ? '(PASS)' : '(BREAK)'}
                </span>
            </div>
            ${criteriaBadgesHtml}
            <div style="font-size: 0.85rem; color: var(--text-secondary); white-space: pre-wrap; max-height: 300px; overflow-y: auto; padding-right: 0.25rem;">${escapeHtml(r.response || '')}</div>
        `;
        
        card.addEventListener('click', () => selectGoodResponse(r));
        list.appendChild(card);
    });

    // Add "Skip — No Response Selected" button at the bottom
    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn btn-secondary';
    skipBtn.style.cssText = 'width: 100%; margin-top: 0.75rem; padding: 0.65rem; font-size: 0.88rem; border: 1.5px dashed var(--border); background: transparent; color: var(--text-muted); cursor: pointer;';
    skipBtn.textContent = 'Skip — No Response Selected';
    skipBtn.title = 'Advance to the next turn without selecting a response';
    skipBtn.addEventListener('click', () => skipAndAdvanceToNextTurn());
    list.appendChild(skipBtn);

    // Scroll picker into view so options are visible
    picker.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Advance to next turn without selecting any response.
 */
async function skipAndAdvanceToNextTurn() {
    showToast(`Advancing to Turn ${state.currentTurn + 1} without selecting a response...`, 'info');

    const { prompt: currentPrompt, criteria: currentCriteria } = _readPromptAndCriteriaFromDOM();

    try {
        const res = await fetch(`/api/advance-turn/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selected_hunt_id: null,
                next_prompt: currentPrompt,
                next_criteria: currentCriteria,
                current_prompt: currentPrompt,
                current_criteria: typeof currentCriteria === 'string' ? currentCriteria : (currentCriteria ? JSON.stringify(currentCriteria) : '')
            })
        });

        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.detail || 'Failed to advance turn');
        }

        const data = await res.json();

        const noResp = {
            response: 'No response selected',
            hunt_id: null,
            judge_score: null,
            judge_criteria: {},
            judge_explanation: ''
        };

        await _applyTurnAdvance(data, noResp, currentPrompt, currentCriteria, {
            prompt: currentPrompt,
            response_reference: currentCriteria,
            response: 'No response selected',
        });

    } catch (error) {
        console.error('Error advancing turn (skip):', error);
        showError(error, { operation: 'Advance turn (skip)' });
    }
}

/**
 * Shared post-advance-turn setup: update local state, save turn history,
 * reset for new turn, and open testbed for validation.
 *
 * @param {object} apiData       — response from /api/advance-turn
 * @param {object} selectedResp  — the selected good response object
 * @param {string} completedPrompt   — prompt of the just-completed turn (for history)
 * @param {string} completedCriteria — criteria of the just-completed turn (for history)
 * @param {{ prompt: string, response_reference: string, response: string, judge_system_prompt?: string }} newNotebook
 *   — notebook fields for the NEW turn
 */
async function _applyTurnAdvance(apiData, selectedResp, completedPrompt, completedCriteria, newNotebook) {
    state.currentTurn = apiData.current_turn;
    state.isMultiTurn = true;

    state.conversationHistory.push(
        { role: 'user', content: completedPrompt },
        { role: 'assistant', content: selectedResp.response }
    );

    const judgeModelEl = document.getElementById('judgeModel');
    const judgeModelName = judgeModelEl?.options?.[judgeModelEl.selectedIndex]?.text || judgeModelEl?.value || '';

    state.turns.push({
        turnNumber: state.currentTurn - 1,
        prompt: completedPrompt,
        response_reference: completedCriteria,
        response: selectedResp.response,
        selectedResponse: selectedResp.response,
        selectedHuntId: selectedResp.hunt_id,
        huntCount: state.huntsThisTurn || state.allResponses.length,
        judge_system_prompt: state.notebook?.judge_system_prompt || '',
        judgeModel: judgeModelName,
        judgeResult: {
            score: selectedResp.judge_score,
            criteria: selectedResp.judge_criteria || {},
            explanation: selectedResp.judge_explanation || ''
        },
        results: state.allResponses.map(r => ({
            hunt_id: r.hunt_id,
            response: r.response,
            judge_score: r.judge_score,
            is_breaking: r.is_breaking
        }))
    });

    state.multiTurnTotalHunts += state.huntsThisTurn || state.allResponses.length;

    state.notebook.prompt = newNotebook.prompt;
    state.notebook.response_reference = newNotebook.response_reference;
    state.notebook.response = newNotebook.response;
    if (newNotebook.judge_system_prompt) {
        state.notebook.judge_system_prompt = newNotebook.judge_system_prompt;
    }

    state.allResponses.forEach(r => {
        if (r.hunt_id) state.previousTurnHuntIds.add(r.hunt_id);
    });

    resetTurnState();

    if (elements.resultsTableBody) {
        elements.resultsTableBody.innerHTML = '';
    }

    document.getElementById('multiTurnDecisionCard')?.classList.add('hidden');
    document.getElementById('goodResponsePicker')?.classList.add('hidden');
    document.getElementById('nextTurnEditor')?.classList.add('hidden');
    document.getElementById('selectionSection')?.classList.add('hidden');
    document.getElementById('resultsSection')?.classList.add('hidden');
    document.getElementById('summarySection')?.classList.add('hidden');
    document.getElementById('progressSection')?.classList.add('hidden');

    renderTurnHistoryTabs();
    document.getElementById('multiTurnSection').classList.remove('hidden');

    validatePromptLength();

    const { hideTurn1TestPromptPanel } = await import('./notebook.js');
    hideTurn1TestPromptPanel();
    enableNavTestbedButton();

    state.referenceValidated = false;
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Complete testbed validation before hunting';
    }

    if (elements.referenceJudgeResult) {
        elements.referenceJudgeResult.innerHTML = '';
    }
    state.initialCriteria = null;

    updateTurnAwareUI();
    resetHuntNumberToDefault();
    updateHuntLimitUI();

    renderPriorConversationBanner();
    resetTestbed();
    elements.configSection?.classList.remove('hidden');
    showTestbed();

    // --- Trigger 2: progressively save the just-completed turn's Selected Response ---
    // Skip if no response was selected (hunt_id is null)
    const completedTurnNum = state.currentTurn - 1;
    if (selectedResp?.hunt_id != null && selectedResp?.response) {
        progressiveSaveToColab([
            { heading: `Turn-${completedTurnNum}: Selected Response`, content: selectedResp.response }
        ]).then(r => {
            if (r.success) showToast(`Turn ${completedTurnNum} selected response saved to Colab`, 'success');
            else console.warn('Progressive save (selected response) failed:', r.message);
        }).catch(e => console.error('Progressive save error:', e));
    }

    showToast(`Turn ${state.currentTurn} — Fill in your prompt, criteria, and ideal response in the Testbed. Judge before hunting.`, 'success');
}

/**
 * Read current prompt and criteria from state.notebook (single source of truth).
 * @returns {{ prompt: string, criteria: string }}
 */
function _readPromptAndCriteriaFromDOM() {
    const prompt = state.notebook?.prompt || '';
    const criteria = state.notebook?.response_reference || '';
    return { prompt, criteria };
}

/**
 * Select a good response to carry forward to the next turn.
 */
export async function selectGoodResponse(response) {
    state._selectedGoodResponse = response;

    const cards = document.querySelectorAll('#goodResponseList > div');
    cards.forEach(card => { card.style.opacity = '0.5'; card.style.pointerEvents = 'none'; });
    const selectedIdx = state.allResponses.findIndex(r => r.hunt_id === response.hunt_id);
    if (selectedIdx >= 0 && cards[selectedIdx]) {
        cards[selectedIdx].style.opacity = '1';
        cards[selectedIdx].style.border = '3px solid var(--primary)';
    }

    showToast(`Advancing to Turn ${state.currentTurn + 1}...`, 'info');

    const { prompt: currentPrompt, criteria: currentCriteria } = _readPromptAndCriteriaFromDOM();

    try {
        const res = await fetch(`/api/advance-turn/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selected_hunt_id: response.hunt_id,
                next_prompt: currentPrompt,
                next_criteria: currentCriteria,
                current_prompt: currentPrompt,
                current_criteria: typeof currentCriteria === 'string' ? currentCriteria : (currentCriteria ? JSON.stringify(currentCriteria) : '')
            })
        });

        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.detail || 'Failed to advance turn');
        }

        const data = await res.json();

        const currentJudgePrompt = state.notebook?.judge_system_prompt || '';
        await _applyTurnAdvance(data, response, currentPrompt, currentCriteria, {
            prompt: currentPrompt,
            response_reference: currentCriteria,
            response: response.response,
            judge_system_prompt: currentJudgePrompt,
        });

    } catch (error) {
        console.error('Error advancing turn:', error);
        showError(error, { operation: 'Advance turn' });
        cards.forEach(card => { card.style.opacity = '1'; card.style.pointerEvents = 'auto'; });
    }
}

// ============== Calibration Mode (Turn 2+) ==============

let _calibrationResponse = null;
let _calibrationJudged = false;

export function showCalibrationPanel() {
    const panel = document.getElementById('calibrationPanel');
    if (panel) {
        panel.classList.remove('hidden');
        const badge = document.getElementById('calibrationTurnBadge');
        if (badge) badge.textContent = `Turn ${state.currentTurn}`;
        _calibrationResponse = null;
        _calibrationJudged = false;
        document.getElementById('calibrationResponseArea')?.classList.add('hidden');
        document.getElementById('calibrationJudgeResult')?.classList.add('hidden');
        document.getElementById('calibrationLoading')?.classList.add('hidden');
        document.getElementById('regenerateBtn')?.classList.add('hidden');
        document.getElementById('judgeCalibrationBtn')?.classList.add('hidden');
        document.getElementById('generateOneBtn')?.classList.remove('hidden');
    }
}

export function hideCalibrationPanel() {
    const panel = document.getElementById('calibrationPanel');
    if (panel) panel.classList.add('hidden');
}

export async function calibrationGenerateOne() {
    if (!state.sessionId) return;

    const loadingEl = document.getElementById('calibrationLoading');
    const loadingText = document.getElementById('calibrationLoadingText');
    const genBtn = document.getElementById('generateOneBtn');
    const regenBtn = document.getElementById('regenerateBtn');

    if (loadingEl) { loadingEl.classList.remove('hidden'); loadingText.textContent = 'Generating response...'; }
    if (genBtn) genBtn.disabled = true;
    if (regenBtn) regenBtn.disabled = true;

    try {
        const res = await fetch(`/api/generate-single-stream/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Generation failed');
        }

        const responseArea = document.getElementById('calibrationResponseArea');
        const responseText = document.getElementById('calibrationResponseText');
        const modelInfo = document.getElementById('calibrationModelInfo');
        if (responseArea) responseArea.classList.remove('hidden');
        if (responseText) { responseText.textContent = ''; responseText.innerHTML = '<span class="tb-stream-cursor"></span>'; }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        _calibrationResponse = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ') && !line.startsWith('event: ')) continue;
                if (line.startsWith('event: ')) continue;
                let event;
                try { event = JSON.parse(line.slice(6)); } catch { continue; }

                if (event.type === 'content') {
                    _calibrationResponse += event.text;
                    if (responseText) {
                        responseText.textContent = _calibrationResponse;
                        const cursor = document.createElement('span');
                        cursor.className = 'tb-stream-cursor';
                        responseText.appendChild(cursor);
                    }
                }
                if (event.type === 'error') {
                    throw new Error(event.text || 'Generation failed');
                }
                if (event.type === 'done') {
                    _calibrationResponse = event.response || _calibrationResponse;
                    if (responseText) responseText.textContent = _calibrationResponse;
                    if (modelInfo) modelInfo.textContent = `Model: ${event.model || 'unknown'} | Provider: ${event.provider || 'unknown'}`;
                }
            }
        }

        if (responseText) responseText.textContent = _calibrationResponse;
        if (regenBtn) { regenBtn.classList.remove('hidden'); regenBtn.disabled = false; }
        document.getElementById('judgeCalibrationBtn')?.classList.remove('hidden');
        if (genBtn) genBtn.classList.add('hidden');

        showToast('Response generated. Review it, then judge when ready.', 'info');

    } catch (error) {
        showError(error, { operation: 'Generate response' });
    } finally {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (genBtn) genBtn.disabled = false;
        if (regenBtn) regenBtn.disabled = false;
    }
}

export async function calibrationJudge() {
    if (!state.sessionId || !_calibrationResponse) {
        showToast('No response to judge. Generate one first.', 'error');
        return;
    }

    const judgeBtn = document.getElementById('judgeCalibrationBtn');
    const loadingEl = document.getElementById('calibrationLoading');
    const loadingText = document.getElementById('calibrationLoadingText');

    if (judgeBtn) { judgeBtn.disabled = true; judgeBtn.textContent = 'Judging...'; }
    if (loadingEl) { loadingEl.classList.remove('hidden'); loadingText.textContent = 'Running judge...'; }

    try {
        const res = await fetch(`/api/judge-calibration-stream/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response_text: _calibrationResponse })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Judge failed');
        }

        _calibrationJudged = true;
        const resultDiv = document.getElementById('calibrationJudgeResult');
        if (resultDiv) {
            resultDiv.innerHTML = `
                <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid var(--border);">
                    <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                        <span class="tb-spinner" style="width:14px;height:14px;"></span>
                        <span style="font-weight: 700;" id="calJudgeScoreLabel">Evaluating…</span>
                    </div>
                    <div style="margin-bottom: 0.75rem;">
                        <label style="font-weight: 600; font-size: 0.85rem;">Criteria Breakdown:</label>
                        <div style="margin-top: 0.25rem;" id="calJudgeCriteriaBody"></div>
                    </div>
                </div>`;
            resultDiv.classList.remove('hidden');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalData = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let event;
                try { event = JSON.parse(line.slice(6)); } catch { continue; }
                if (event.type === 'error') throw new Error(event.message || 'Judge failed');
                if (event.type === 'start') {
                    const label = document.getElementById('calJudgeScoreLabel');
                    if (label) label.textContent = `0/${event.total} Passing…`;
                }
                if (event.type === 'criterion') {
                    const body = document.getElementById('calJudgeCriteriaBody');
                    if (body) {
                        const isPass = event.status === 'PASS';
                        const chip = document.createElement('span');
                        chip.className = 'tb-criterion-enter';
                        chip.style.cssText = `display: inline-block; padding: 0.15rem 0.5rem; margin: 0.15rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; background: ${isPass ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)'}; color: ${isPass ? 'var(--success,#10b981)' : 'var(--danger,#ef4444)'};`;
                        chip.textContent = `${event.id}: ${event.status}`;
                        body.appendChild(chip);
                    }
                    const label = document.getElementById('calJudgeScoreLabel');
                    if (label) label.textContent = `${event.passing}/${event.total} Passing…`;
                }
                if (event.type === 'done') {
                    finalData = event;
                }
            }
        }

        const score = finalData.score ?? 0;
        const isPassing = score >= 1;
        const scoreColor = isPassing ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)';
        const label = document.getElementById('calJudgeScoreLabel');
        if (label) {
            label.style.color = scoreColor;
            label.textContent = `Score: ${score} ${isPassing ? '(PASS)' : '(FAIL)'} — ${finalData.passing || 0}/${finalData.total || 0} Passing`;
            label.previousElementSibling?.remove();
        }

        if (resultDiv) {
            const container = resultDiv.querySelector('div');
            if (container) container.style.borderColor = scoreColor;
            const explanationEl = document.createElement('div');
            explanationEl.innerHTML = `
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.85rem;">Judge Explanation:</label>
                    <p style="margin-top: 0.25rem; font-size: 0.85rem; color: var(--text-secondary); white-space: pre-wrap;">${escapeHtml(finalData.explanation || 'No explanation')}</p>
                </div>
                <p style="margin-top: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">
                    You can tweak your criteria or judge prompt above, then click "Judge This Response" again to re-judge the same response.
                </p>`;
            const mainContainer = resultDiv.querySelector('div');
            if (mainContainer) mainContainer.appendChild(explanationEl);
        }

        state.referenceValidated = true;
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }

        showToast(isPassing ? 'Judge PASSED. You can start hunting or re-calibrate.' : 'Judge FAILED. Tweak criteria and re-judge, or start hunting.', isPassing ? 'success' : 'info');

    } catch (error) {
        showError(error, { operation: 'Judge calibration' });
    } finally {
        if (judgeBtn) { judgeBtn.disabled = false; judgeBtn.textContent = 'Judge This Response'; }
        if (loadingEl) loadingEl.classList.add('hidden');
    }
}

export function initCalibrationListeners() {
    const genBtn = document.getElementById('generateOneBtn');
    const regenBtn = document.getElementById('regenerateBtn');
    const judgeBtn = document.getElementById('judgeCalibrationBtn');

    if (genBtn) genBtn.addEventListener('click', calibrationGenerateOne);
    if (regenBtn) regenBtn.addEventListener('click', calibrationGenerateOne);
    if (judgeBtn) judgeBtn.addEventListener('click', calibrationJudge);
}

/**
 * @deprecated The primary flow now uses selectGoodResponse() which calls advance_turn
 *   immediately. This function is only called from the legacy "Start Turn N Hunt" button.
 */
export async function startNextTurn() {
    const nextPrompt = document.getElementById('nextTurnPrompt').value.trim();
    const nextCriteria = document.getElementById('nextTurnCriteria').value.trim();
    const nextJudgePrompt = document.getElementById('nextTurnJudgePrompt').value.trim() || null;

    if (!nextPrompt) {
        showToast('Please enter a prompt for the next turn.', 'error');
        return;
    }
    if (!nextCriteria) {
        showToast('Please enter criteria for the next turn.', 'error');
        return;
    }
    if (!state._selectedGoodResponse) {
        showToast('Please select a good response first.', 'error');
        return;
    }

    try {
        const response = await fetch(`/api/advance-turn/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selected_hunt_id: state._selectedGoodResponse.hunt_id,
                next_prompt: nextPrompt,
                next_criteria: nextCriteria,
                next_judge_prompt: nextJudgePrompt
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to advance turn');
        }

        const data = await response.json();

        const { prompt: completedPrompt, criteria: completedCriteria } = _readPromptAndCriteriaFromDOM();

        await _applyTurnAdvance(data, state._selectedGoodResponse, completedPrompt, completedCriteria, {
            prompt: nextPrompt,
            response_reference: nextCriteria,
            response: state._selectedGoodResponse.response,
            judge_system_prompt: nextJudgePrompt,
        });

    } catch (error) {
        console.error('Error advancing turn:', error);
        showError(error, { operation: 'Advance turn' });
    }
}

/**
 * Initialize multi-turn event listeners.
 */
export function initMultiTurnListeners() {
    const markBreakingBtn = document.getElementById('markBreakingBtn');
    if (markBreakingBtn) {
        markBreakingBtn.addEventListener('click', handleMarkBreaking);
    }
    
    const continueBtn = document.getElementById('continueToNextTurnBtn');
    if (continueBtn) {
        continueBtn.addEventListener('click', handleContinueToNextTurn);
    }
    
    const startNextBtn = document.getElementById('startNextTurnBtn');
    if (startNextBtn) {
        startNextBtn.addEventListener('click', startNextTurn);
    }
}

