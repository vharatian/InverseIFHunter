/**
 * results.js — Response Slideouts, Selection, Review, Grading, Export
 * 
 * Handles response display panels, hunt selection UI, human review,
 * LLM judgment reveal, criteria formatting, and notebook export.
 * 
 * Dependencies: config.js, utils.js, state.js, dom.js, celebrations.js, editors.js
 */

import { elements } from './dom.js';
import { state, getCumulativeStats } from './state.js';
import { 
    escapeHtml, 
    countWords, 
    getWordCountLabel, 
    getExplanationValidationError, 
    getModelDisplayName,
    renderInsightTip,
    getIncompleteReviewIssues,
    getIncompleteReviewsModalMessage 
} from './utils.js';
import { showToast, showError, showNextBlindJudge } from './celebrations.js';
import { hideModelLockedIndicator } from './editors.js';
import { showMultiTurnDecision } from './multiturn.js';
import { showAppModal } from './api.js';
import { scheduleLiveExportUpdate } from './notebook.js';
import { MIN_EXPLANATION_WORDS, getConfigValue } from './config.js';

// ============== Hunt Result Classification Helpers ==============

/** Check if a hunt result is breaking (score === 0). */
export function isResultBreaking(result) {
    const judgeScore = result.judge_score !== undefined && result.judge_score !== null ? Number(result.judge_score) : null;
    const score = result.score !== undefined && result.score !== null ? Number(result.score) : null;
    return (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
}

/** Check if a hunt result is passing (score > 0). */
export function isResultPassing(result) {
    const judgeScore = result.judge_score !== undefined && result.judge_score !== null ? Number(result.judge_score) : null;
    const score = result.score !== undefined && result.score !== null ? Number(result.score) : null;
    return (judgeScore !== null && judgeScore > 0) || (score !== null && score > 0);
}

/** Count breaking and passing results in an array. */
export function countBreakingPassing(results) {
    const breakingCount = results.filter(isResultBreaking).length;
    const passingCount = results.filter(isResultPassing).length;
    return { breakingCount, passingCount };
}

/**
 * Validate a selection of hunts against the current hunt mode's rules.
 * Returns { valid: boolean, message: string }.
 */
export function validateSelectionForMode(selectedResults, huntMode, isAdmin = false) {
    if (isAdmin) return { valid: true, message: 'Admin: any combination allowed' };

    const { breakingCount, passingCount } = countBreakingPassing(selectedResults);
    const total = selectedResults.length;

    switch (huntMode) {
        case 'all_passing':
            if (breakingCount > 0) {
                return { valid: false, message: 'Only passing (non-breaking) hunts can be selected in All Passing mode.' };
            }
            if (total === 0) {
                return { valid: false, message: 'Select at least one passing hunt.' };
            }
            return { valid: true, message: `${passingCount} passing selected` };

        case 'break_all':
            if (passingCount > 0) {
                return { valid: false, message: 'Only breaking (all-criteria-fail) hunts can be selected in All Breaking mode.' };
            }
            if (total === 0) {
                return { valid: false, message: 'Select at least one breaking hunt.' };
            }
            return { valid: true, message: `${breakingCount} breaking selected` };

        case '1_breaking':
            if (breakingCount > 1) {
                return { valid: false, message: 'Only 1 breaking hunt is allowed in 1 Breaking mode.' };
            }
            if (breakingCount === 0 && total > 0) {
                return { valid: false, message: 'You must include the 1 breaking hunt in your selection.' };
            }
            return { valid: true, message: `${breakingCount} breaking, ${passingCount} passing selected` };

        default: {
            // break_50 — require exactly 4 with 4B or 3B+1P
            if (total !== 4) {
                return { valid: total < 4, message: `Select ${4 - total} more hunt(s). Must be exactly 4 total.` };
            }
            const isValid = (breakingCount === 4) || (breakingCount === 3 && passingCount === 1);
            if (!isValid) {
                return { valid: false, message: `Invalid combination! Must be 4 breaking OR 3 breaking + 1 passing. Current: ${breakingCount} breaking, ${passingCount} passing.` };
            }
            return { valid: true, message: `Valid: ${breakingCount} breaking, ${passingCount} passing` };
        }
    }
}

// ============== Mode-Aware Selection Instructions ==============

/** Render selection instructions into #selectionInstructions based on active hunt mode. */
function renderSelectionInstructions() {
    const container = document.getElementById('selectionInstructions');
    if (!container) return;

    const huntMode = state.config?.hunt_mode || 'break_50';
    let instructionHtml = '';
    let validHtml = '';

    switch (huntMode) {
        case 'all_passing':
            instructionHtml = 'Select only <strong>passing</strong> (non-breaking) hunts for review.';
            validHtml = '<span class="valid-combo">Any number of passing hunts</span> — no breaking allowed.';
            break;
        case '1_breaking':
            instructionHtml = 'Select the <strong>1 breaking</strong> hunt and any number of <strong>passing</strong> hunts.';
            validHtml = 'Must include exactly <span class="valid-combo">1 breaking</span> hunt. Remaining can be any passing hunts.';
            break;
        case 'break_all':
            instructionHtml = 'Select only <strong>breaking</strong> (all-criteria-fail) hunts for review.';
            validHtml = '<span class="valid-combo">Any number of breaking hunts</span> — no passing allowed.';
            break;
        case 'break_50':
        default:
            instructionHtml = 'Select exactly <strong>4 responses</strong> for human review.';
            validHtml = '<span class="valid-combo">4 breaking</span> OR <span class="valid-combo">3 breaking + 1 passing</span>';
            break;
    }

    const tipContainer = document.getElementById('selectionTipContainer');
    const tipHtml = tipContainer ? tipContainer.outerHTML : '<div id="selectionTipContainer"></div>';

    container.innerHTML = `
        <p><strong>Instructions:</strong> ${instructionHtml}</p>
        <p><strong>Valid:</strong> ${validHtml}</p>
        ${tipHtml}
    `;
}

// ============== Selection Section Collapse ==============
export function toggleSelectionSectionCard() {
    state.selectionSectionCollapsed = !state.selectionSectionCollapsed;
    applySelectionSectionCollapse();
}

function applySelectionSectionCollapse() {
    const card = elements.selectionSectionCard;
    if (!card) return;
    if (state.selectionSectionCollapsed) {
        card.classList.add('collapsed');
    } else {
        card.classList.remove('collapsed');
    }
}

export function collapseSelectionSectionCard(slotCount) {
    state.selectionSectionCollapsed = true;
    const summary = elements.selectionSectionCollapsedSummary;
    if (summary) {
        summary.textContent = `${slotCount || 4} slots selected – click to expand`;
    }
    applySelectionSectionCollapse();
}

export function expandSelectionSectionCard() {
    state.selectionSectionCollapsed = false;
    applySelectionSectionCollapse();
}

export function initSelectionSectionCollapse() {
    const header = elements.selectionSectionCardHeader;
    const summary = elements.selectionSectionCollapsedSummary;
    const handler = () => toggleSelectionSectionCard();
    if (header) header.addEventListener('click', handler);
    if (summary) summary.addEventListener('click', handler);
    applySelectionSectionCollapse(); // Apply initial state (e.g. collapsed)
}

// ============== Review Mode Button Lock ==============
/**
 * When selection is confirmed and reviews are in progress (or completed), disable all action buttons
 * except view buttons (Expand/Collapse, etc.). Bypassed in admin mode.
 */
export function setReviewModeButtonsDisabled(disabled) {
    if (disabled && (state.adminMode || getConfigValue('bypass_hunt_criteria', false))) return; // Admin/bypass: keep buttons enabled for testing
    const title = disabled ? 'Complete reviews or refresh page to unlock' : '';
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = false;
        elements.startHuntBtn.title = elements.startHuntBtn.title || '';
    }
    if (elements.judgeBeforeHuntBtn) {
        elements.judgeBeforeHuntBtn.disabled = disabled;
        elements.judgeBeforeHuntBtn.title = disabled ? title : (elements.judgeBeforeHuntBtn.title || 'Validate the ideal response before starting hunt');
    }
    if (elements.judgeReferenceBtn) {
        elements.judgeReferenceBtn.disabled = disabled;
        elements.judgeReferenceBtn.title = disabled ? title : (elements.judgeReferenceBtn.title || '');
    }
    if (elements.saveAllBtn) {
        elements.saveAllBtn.disabled = disabled;
        if (disabled) elements.saveAllBtn.title = title;
    }
    if (elements.confirmSelectionBtn) {
        elements.confirmSelectionBtn.disabled = disabled;
        elements.confirmSelectionBtn.title = disabled ? 'Selection locked. Complete reviews or refresh.' : '';
    }
}

// ============== Response Slide-out Panel ==============

export function openResponseSlideout(rowNum) {
    
    const data = state.huntResponseData[rowNum];
    if (!data) {
        console.warn(`No response data found for row ${rowNum}`);
        showToast('Response data not available yet', 'warning');
        return;
    }
    
    
    // Get elements directly from DOM (backup in case elements object not updated)
    const slideout = document.getElementById('responseSlideout');
    const backdrop = document.getElementById('responseSlideoutBackdrop');
    const titleEl = document.getElementById('slideoutTitle');
    const modelEl = document.getElementById('slideoutModel');
    const statusEl = document.getElementById('slideoutStatus');
    const scoreEl = document.getElementById('slideoutScore');
    const responseTextEl = document.getElementById('slideoutResponseText');
    
    if (!slideout) {
        console.error('Slideout panel element not found!');
        showToast('Error: Panel not found', 'error');
        return;
    }
    
    // Update slide-out content
    if (titleEl) {
        titleEl.textContent = `Hunt #${data.huntNum} Response`;
    }
    
    if (modelEl) {
        modelEl.textContent = getModelDisplayName(data.model);
    }
    
    if (statusEl) {
        statusEl.textContent = data.status;
        statusEl.className = 'response-slideout-meta-value';
        if (data.status === 'completed') {
            // is_breaking = true means model broke = GOOD for hunt = 'pass' styling
            statusEl.classList.add(data.is_breaking ? 'pass' : 'fail');
        }
    }
    
    if (scoreEl) {
        if (data.score !== null && data.score !== undefined) {
            scoreEl.textContent = data.score === 0 ? 'BREAKING' : 'PASSING';
            scoreEl.className = 'response-slideout-meta-value';
            // Score 0 = breaking = GOOD for hunt = 'pass' styling
            // Score 1-4 = passing = BAD for hunt = 'fail' styling
            scoreEl.classList.add(data.score === 0 ? 'pass' : 'fail');
        } else {
            scoreEl.textContent = '-';
            scoreEl.className = 'response-slideout-meta-value';
        }
    }
    
    if (responseTextEl) {
        responseTextEl.textContent = data.response || 'No response';
    }
    
    // Open the slide-out (reset right position for opening)
    slideout.style.right = '0';
    slideout.classList.add('open');
    if (backdrop) {
        backdrop.classList.add('visible');
    }
    
    // Prevent body scroll when panel is open
    document.body.style.overflow = 'hidden';
    
}

export function closeResponseSlideout() {
    const slideout = document.getElementById('responseSlideout');
    const backdrop = document.getElementById('responseSlideoutBackdrop');
    
    if (slideout) {
        // Set right position to fully hide based on current width
        const currentWidth = slideout.offsetWidth;
        slideout.style.right = `-${currentWidth + 10}px`;
        slideout.classList.remove('open');
    }
    if (backdrop) {
        backdrop.classList.remove('visible');
    }
    
    // Restore body scroll
    document.body.style.overflow = '';
}

// Open slide-out for selection table details
export function openSelectionDetailSlideout(rowNumber, result) {
    
    const slideout = document.getElementById('responseSlideout');
    const backdrop = document.getElementById('responseSlideoutBackdrop');
    const titleEl = document.getElementById('slideoutTitle');
    const modelEl = document.getElementById('slideoutModel');
    const statusEl = document.getElementById('slideoutStatus');
    const scoreEl = document.getElementById('slideoutScore');
    const responseTextEl = document.getElementById('slideoutResponseText');
    
    if (!slideout) {
        console.error('Slideout panel element not found!');
        return;
    }
    
    // Determine if breaking
    const judgeScore = result.judge_score !== undefined && result.judge_score !== null ? Number(result.judge_score) : null;
    const score = result.score !== undefined && result.score !== null ? Number(result.score) : null;
    const isBreaking = (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
    
    // Update slide-out content
    if (titleEl) {
        titleEl.textContent = `Hunt #${rowNumber + 1} Response`;
    }
    
    if (modelEl) {
        modelEl.textContent = getModelDisplayName(result.model);
    }
    
    if (statusEl) {
        statusEl.textContent = isBreaking ? 'BREAK' : 'PASS';
        statusEl.className = 'response-slideout-meta-value';
        statusEl.classList.add(isBreaking ? 'pass' : 'fail');
    }
    
    if (scoreEl) {
        const displayScore = judgeScore !== null ? judgeScore : (score !== null ? score : '-');
        scoreEl.textContent = displayScore;
        scoreEl.className = 'response-slideout-meta-value';
        if (displayScore !== '-') {
            scoreEl.classList.add(displayScore === 0 ? 'pass' : 'fail');
        }
    }
    
    if (responseTextEl) {
        responseTextEl.textContent = result.response || 'No response available';
    }
    
    // Open the slide-out (reset right position for opening)
    slideout.style.right = '0';
    slideout.classList.add('open');
    if (backdrop) {
        backdrop.classList.add('visible');
    }
    
    document.body.style.overflow = 'hidden';
}

// ============== Grading Slide-out Panel ==============

const GRADING_SPLIT_STORAGE_KEY = 'modelhunter_grading_split_percent';

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
    
    // Check if we're in read-only mode (after LLM reveal)
    const isReadOnly = state.llmRevealed;
    
    const modelDisplay = getModelDisplayName(result.model);
    const slotNum = slotIndex !== undefined ? slotIndex + 1 : result.hunt_id;
    const responseText = result.response || 'No response available';
    const reasoningTrace = result.reasoning_trace || '';
    const huntId = result.hunt_id;
    
    // DEBUG: Log hunt IDs to verify uniqueness across slots
    
    // Get existing review data ONLY if it was previously submitted
    // Prevents cross-contamination between slots when huntId is shared or undefined
    const existingReview = state.humanReviews?.[huntId];
    const hasSubmittedReview = existingReview && existingReview.submitted;
    const existingNotes = (existingReview?.notes || existingReview?.explanation || '');
    const rawGrades = existingReview?.grades || {};
    const fromGradingBasis = (gb) => {
        const out = {};
        Object.entries(gb || {}).forEach(([k, v]) => { out[k] = String(v).toUpperCase() === 'PASS' ? 1 : 0; });
        return out;
    };
    const existingGrades = Object.keys(rawGrades).length ? rawGrades : fromGradingBasis(existingReview?.grading_basis);
    
    // Update header
    slotBadge.textContent = `Slot ${slotNum}`;
    slotModel.textContent = modelDisplay;
    updateGradingProgressHeader(huntId);
    
    // Build body content
    const disabledAttr = isReadOnly ? 'disabled' : '';
    const disabledStyle = isReadOnly ? 'opacity: 0.6; cursor: not-allowed; pointer-events: none;' : '';
    const textareaStyle = isReadOnly ? 'background: var(--bg-tertiary); opacity: 0.7;' : '';
    
    body.innerHTML = `
        ${isReadOnly ? `
        <!-- Locked Banner -->
        <div class="grading-locked-banner">
            <span style="font-size: 1.2rem;">🔒</span>
            <span style="color: var(--warning); font-weight: 600;">Reviews are locked - View only mode</span>
        </div>
        ` : ''}
        
        <!-- Split View: Left = Response, Right = Grading -->
        <div class="grading-split-view">
            <!-- Left: Model Response (always visible while grading) -->
            <div class="grading-split-left">
                <div class="grading-section">
                    <div class="grading-section-title">📄 Model Response</div>
                    <div class="grading-response-box grading-response-scroll">${escapeHtml(responseText)}</div>
                </div>
                <div class="grading-section">
                    <button class="reasoning-toggle-btn" style="width: 100%; padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; justify-content: space-between;">
                        <span>🧠 Model Reasoning (Reference)</span>
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
                        <div class="grading-section-title" style="font-size: 0.9rem;">📋 Reviewer feedback for slot ${slotNum}</div>
                        <div style="font-size: 0.9rem; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(slotComment)}</div>
                    </div>`;
                })()}
            </div>
            
            <div class="grading-split-divider" title="Drag to resize"></div>
            
            <!-- Right: Grading criteria + explanation -->
            <div class="grading-split-right">
                <div class="grading-section">
                    <div class="grading-section-title">✅ Grade Each Criterion ${isReadOnly ? '<span style="color: var(--warning); font-size: 0.8rem;">(Locked)</span>' : ''}</div>
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
                                            ✅ Pass
                                        </button>
                                        <button class="grading-btn grading-btn-fail ${failActive}" data-hunt-id="${huntId}" data-criterion="${c.id}" ${disabledAttr}>
                                            ❌ Fail
                                        </button>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
                <div class="grading-section">
                    <div class="grading-section-title">📝 Explanation ${isReadOnly ? '<span style="color: var(--warning); font-size: 0.8rem;">(Locked)</span>' : ''}${!isReadOnly ? '<span class="autosave-status autosave-saved" data-field="grading-' + huntId + '" style="margin-left: 0.25rem;">✓ Saved</span>' : ''}</div>
                    <textarea class="grading-notes-textarea" data-hunt-id="${huntId}" 
                        placeholder="Explain your grading decisions (minimum ${MIN_EXPLANATION_WORDS} words required)..." ${disabledAttr} style="${textareaStyle}">${escapeHtml(existingNotes)}</textarea>
                    ${isReadOnly ? '' : `
                    <div class="grading-word-count" data-hunt-id="${huntId}" style="margin-top: 0.5rem; font-size: 0.9rem; font-weight: 600; color: var(--text-muted);">${getWordCountLabel(countWords(existingNotes))}</div>
                    `}
                </div>
                <div class="grading-section">
                    ${isReadOnly ? `
                        <div style="padding: 0.75rem 1rem; background: var(--bg-tertiary); border-radius: 8px; text-align: center; color: var(--text-muted);">
                            🔒 Review submitted and locked
                        </div>
                    ` : `
                        <button class="btn btn-primary grading-submit-btn" data-hunt-id="${huntId}" data-slot-index="${slotIndex}" data-row-number="${rowNumber}" disabled style="opacity: 0.7;">
                            ✅ Submit Review
                        </button>
                    `}
                    <div class="grading-status" data-hunt-id="${huntId}"></div>
                </div>
                <!-- LLM Judge Section (Hidden until revealed) -->
                <div class="llm-judge-section grading-section" data-hunt-id="${huntId}" style="display: ${state.llmRevealed ? 'block' : 'none'}; margin-top: 1.5rem; padding: 1.5rem; background: var(--bg-tertiary); border-radius: 12px; border: 2px solid var(--accent-primary);">
            <div class="grading-section-title" style="color: var(--accent-primary);">🤖 LLM Judge Result</div>
            <div style="margin-top: 0.75rem;">
                <span class="score-badge score-${result.judge_score || 0}" style="padding: 0.5rem 1rem;">
                    ${result.judge_score === 0 ? '🟢' : '🔴'} Score: ${result.judge_score ?? '-'}
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
    
    // Set up event listeners
    setupGradingSlideoutEvents(body, huntId, result, slotIndex, rowNumber);
    
    // Open the slideout (reset right position for opening)
    slideout.style.right = '0';
    slideout.style.visibility = 'visible';
    slideout.classList.add('open');
    if (backdrop) {
        backdrop.classList.add('visible');
    }
    document.body.style.overflow = 'hidden';
    
    // Store current slot for reference
    state.currentGradingSlot = { result, slotIndex, rowNumber, huntId };
}

function setupGradingSplitResize(container) {
    const splitView = container.querySelector('.grading-split-view');
    const divider = container.querySelector('.grading-split-divider');
    const leftPanel = container.querySelector('.grading-split-left');
    if (!splitView || !divider || !leftPanel) return;

    let isResizing = false;
    let startX = 0;
    let startLeftPercent = 0;

    // Restore persisted divider position
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
        try {
            localStorage.setItem(GRADING_SPLIT_STORAGE_KEY, String(pct));
        } catch (_) {}
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

    // Focus first criterion so P/F works immediately (when not read-only)
    if (!state.llmRevealed) {
        requestAnimationFrame(() => {
            const first = container.querySelector('.grading-criterion');
            if (first) first.focus();
        });
    }
}

export function submitGradingReview(huntId, result, slotIndex, rowNumber) {
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
    
    // Calculate overall judgment based on grades (all pass = 1, any fail = 0)
    const allPass = Object.values(grades).every(g => g === 1);
    const overallJudgment = allPass ? 1 : 0;
    
    // Convert grades to grading_basis format (PASS/FAIL strings)
    const gradingBasis = {};
    Object.entries(grades).forEach(([key, value]) => {
        gradingBasis[key] = value === 1 ? 'PASS' : 'FAIL';
    });
    
    // Mark as submitted with huntId key (for backwards compatibility)
    state.humanReviews[huntId] = {
        ...review,
        submitted: true
    };
    
    // CRITICAL FIX: Also store with row_number key format for updateReviewProgress()
    const rowKey = `row_${rowNumber}`;
    state.humanReviews[rowKey] = {
        hunt_id: huntId,
        row_number: rowNumber,
        judgment: overallJudgment,
        grading_basis: gradingBasis,
        explanation: notes,
        slotNum: slotIndex + 1,
        timestamp: new Date().toISOString(),
        submitted: true
    };
    
    
    // Update status in slideout
    const statusEl = document.querySelector(`.grading-status[data-hunt-id="${huntId}"]`);
    if (statusEl) {
        statusEl.innerHTML = '<span style="color: var(--success);">✅ Review Submitted!</span>';
    }
    
    // Update the compact card
    const card = document.querySelector(`.slot-compact-card[data-hunt-id="${huntId}"]`);
    if (card) {
        card.classList.add('reviewed');
        const statusDiv = card.querySelector('.slot-compact-status');
        if (statusDiv) {
            statusDiv.textContent = '✅ Review Submitted';
            statusDiv.classList.add('reviewed');
        }
        const btn = card.querySelector('.slot-open-btn');
        if (btn) {
            btn.textContent = '📝 Edit';
        }
    }
    
    // Update review progress and check if all reviews are now complete
    updateReviewProgress();
    checkAllReviewsComplete();
    
    showToast(`Review for Slot ${slotIndex + 1} submitted!`, 'success');
    
    // Close slideout after a short delay
    setTimeout(() => {
        closeGradingSlideout();
    }, 500);
}

export function closeGradingSlideout() {
    const slideout = document.getElementById('gradingSlideout');
    const backdrop = document.getElementById('gradingSlideoutBackdrop');
    const progressEl = document.getElementById('gradingProgressText');
    
    if (slideout) {
        // Set right position to fully hide based on current width
        const currentWidth = slideout.offsetWidth;
        slideout.style.right = `-${currentWidth + 10}px`;
        slideout.classList.remove('open');
    }
    if (backdrop) {
        backdrop.classList.remove('visible');
    }
    if (progressEl) {
        progressEl.textContent = '';
        progressEl.classList.add('hidden');
    }
    document.body.style.overflow = '';
    state.currentGradingSlot = null;
}

// Toggle response expansion in selection table
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

export function handleHuntComplete(data) {
    state.isHunting = false;
    
    // Remove loading state from button
    elements.startHuntBtn.classList.remove('loading');
    
    // Find Breaking Responses: always enabled after hunt completes (except when hunt limit reached, see updateHuntLimitUI)
    elements.startHuntBtn.disabled = false;
    elements.startHuntBtn.title = '';
    
    // Show upload and config sections again
    document.querySelector('.section')?.classList.remove('hidden');
    elements.configSection?.classList.remove('hidden');
    
    // Remove centering from progress section (hunt is done)
    elements.progressSection?.classList.remove('hunt-active');
    
    // Re-enable model/provider so trainer can change for next hunt (any turn)
    if (elements.modelSelect) {
        elements.modelSelect.disabled = false;
        elements.modelSelect.title = '';
    }
    if (elements.providerSelect) {
        elements.providerSelect.disabled = false;
        elements.providerSelect.title = '';
    }
    
    const { completed_hunts, breaks_found } = data;
    
    // NOTE: totalHuntsCount is now the single source of truth (already incremented before hunt started)
    // No need to update accumulatedHuntOffset separately
    
    // Update status (with turn context)
    elements.huntStatus.querySelector('.status-dot').className = 'status-dot completed';
    const turnSuffix = (state.isMultiTurn || state.currentTurn > 1) ? ` — Turn ${state.currentTurn}` : '';
    elements.statusText.textContent = `Completed${turnSuffix}`;
    
    // Reset reveal state for new hunt
    state.llmRevealed = false;
    state.humanReviews = {};
    
    // Update turn-aware UI (journey bar label changes from "Hunting" to "Reviewing")
    if (state.isMultiTurn || state.currentTurn > 1) {
        updateTurnAwareUI();
    }
    
    // Fetch all responses first (we need them for both flows)
    fetchAllResponses().then(() => {
        // Show multi-turn decision panel
        // Trainer chooses: "breaking" (standard flow) or "continue" (multi-turn)
        showMultiTurnDecision();
    });
}

/**
 * Fetch all responses from the session and accumulate them in state.
 * Does NOT show selection UI — that's triggered separately.
 * @param {Object} [options]
 * @param {boolean} [options.replace=false] — If true, replace allResponses with API data instead of merging.
 */
export async function fetchAllResponses(options = {}) {
    try {
        const response = await fetch(`/api/results/${state.sessionId}`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Failed to fetch results: ${response.status}`);
        }
        const data = await response.json();
        const rawResults = data.results || [];
        
        // Always filter out results from previous turns (they're saved in state.turns).
        // previousTurnHuntIds contains hunt_ids from all completed turns.
        const newResponses = rawResults.filter(r => !state.previousTurnHuntIds.has(r.hunt_id));
        
        if (options.replace) {
            // Replace entirely — ensures picker always has fresh data
            state.allResponses = newResponses.map((r, idx) => ({
                ...r,
                rowNumber: idx
            }));
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
                    state.allResponses.push({
                        ...newResponse,
                        rowNumber: newRowNumber
                    });
                }
            });
        }
        
        // Update summary with CUMULATIVE stats
        const cumul = getCumulativeStats();
        
        elements.summarySection?.classList.remove('hidden');
        const summaryTotal = document.getElementById('summaryTotal');
        const summaryBreaks = document.getElementById('summaryBreaks');
        if (summaryTotal) summaryTotal.textContent = cumul.totalHunts;
        if (summaryBreaks) summaryBreaks.textContent = cumul.totalBreaks;
        
        scheduleLiveExportUpdate();
    } catch (error) {
        console.error('Error fetching results:', error);
        showError(error, { operation: 'Fetch results' });
    }
}

export async function fetchAllResponsesAndShowSelection(completedHunts, breaksFound) {
    try {
        // Fetch all results from the session
        const response = await fetch(`/api/results/${state.sessionId}`);
        const data = await response.json();
        
        // Filter out results from previous turns, then accumulate current turn
        const newResponses = (data.results || []).filter(r => 
            !state.previousTurnHuntIds.has(r.hunt_id)
        );
        
        // Add new responses, avoiding duplicates by hunt_id
        newResponses.forEach(newResponse => {
            const existingIndex = state.allResponses.findIndex(r => r.hunt_id === newResponse.hunt_id);
            if (existingIndex >= 0) {
                // Update existing response, preserve row number
                state.allResponses[existingIndex] = {
                    ...newResponse,
                    rowNumber: state.allResponses[existingIndex].rowNumber
                };
            } else {
                // Add new response with correct row number (index in array)
                const newRowNumber = state.allResponses.length;
                state.allResponses.push({
                    ...newResponse,
                    rowNumber: newRowNumber
                });
            }
        });
        
        const { breakingCount: totalBreaks, passingCount: totalPasses } = countBreakingPassing(state.allResponses);
        const huntMode = state.config?.hunt_mode || 'break_50';
        
        // Populate summary with CUMULATIVE stats across all turns
        const cumulative = getCumulativeStats();
        elements.summarySection.classList.remove('hidden');
        document.getElementById('summaryTotal').textContent = cumulative.totalHunts;
        document.getElementById('summaryBreaks').textContent = cumulative.totalBreaks;
        
        const successRate = cumulative.totalHunts > 0 ? Math.round((cumulative.totalBreaks / cumulative.totalHunts) * 100) : 0;
        document.getElementById('summarySuccess').textContent = `${successRate}% (${cumulative.totalBreaks}/${cumulative.totalHunts} breaks)`;
        document.getElementById('summaryMet').textContent = cumulative.totalBreaks >= 3 ? '✅ Yes' : '❌ No';
        
        // VALIDATION: Gate logic depends on hunt mode
        let criteriaMet = state.adminMode;
        let gateFailTitle = '';
        let gateFailMessage = '';

        if (!state.adminMode) {
            if (huntMode === 'all_passing') {
                criteriaMet = totalPasses >= 1;
                gateFailTitle = 'No passing responses found';
                gateFailMessage = `You need at least 1 passing (non-breaking) response to proceed. Currently ${totalPasses} passing, ${totalBreaks} breaking. Run more hunts!`;
            } else if (huntMode === 'break_all') {
                criteriaMet = totalBreaks >= 1;
                gateFailTitle = 'No breaking responses found';
                gateFailMessage = `You need at least 1 breaking (all-criteria-fail) response to proceed. Currently ${totalBreaks} breaking, ${totalPasses} passing. Run more hunts!`;
            } else if (huntMode === '1_breaking') {
                criteriaMet = totalBreaks >= 1;
                gateFailTitle = 'At least 1 breaking response is required';
                gateFailMessage = `You need at least 1 breaking response in 1 Breaking mode. Currently ${totalBreaks} breaking, ${totalPasses} passing. Run more hunts!`;
            } else {
                criteriaMet = totalBreaks >= 3;
                gateFailTitle = 'You need at least 3 breaking responses to continue';
                gateFailMessage = `You have ${totalBreaks} right now. Run more hunts, then try again.`;
            }
        }
        
        if (!criteriaMet) {
            elements.selectionSection.classList.add('hidden');
            showToast(gateFailMessage, 'warning');
            await showAppModal({
                title: gateFailTitle,
                message: gateFailMessage,
                buttons: [ { label: 'OK', primary: true, value: true } ]
            });
            return;
        }
        
        // Show selection section - criteria met!
        elements.selectionSection.classList.remove('hidden');
        expandSelectionSectionCard();
        
        renderInsightTip('selectionTipContainer', 'selection');
        
        displaySelectionCards();
        
        const modeHintMap = {
            'all_passing': 'Select any number of passing hunts for review.',
            'break_all': 'Select only breaking hunts for review.',
            '1_breaking': 'Select the 1 breaking hunt + any passing hunts for review.',
        };
        const modeHint = modeHintMap[huntMode] || 'Select exactly 4 for review.';
        showToast(`✅ Criteria met! ${totalBreaks} breaks, ${totalPasses} passes. ${modeHint}`, 'success');
    } catch (error) {
        console.error('Error fetching results:', error);
        showError(error, { operation: 'Fetch results' });
    }
}


// ============== Export ==============

export async function exportNotebook() {
    if (!state.sessionId) {
        showToast('No session to export. Please upload a notebook first.', 'error');
        return;
    }
    
    // Check if there are results to export
    if (!state.results || state.results.length === 0) {
        showToast('No hunt results to export. Run a hunt first.', 'warning');
        return;
    }
    
    const selectedRowNumbers = state.selectedRowNumbers || [];
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const reviews = reviewKeys.map(key => state.humanReviews[key]).filter(r => r);
    const reviewCount = reviews.length;
    const requiredCount = selectedRowNumbers.length;
    
    if (requiredCount === 0) {
        showToast('No hunts selected for export.', 'error');
        return;
    }
    
    if (reviewCount < requiredCount) {
        showToast(`Cannot export: Only ${reviewCount}/${requiredCount} reviews completed. Please complete all reviews before exporting.`, 'error');
        return;
    }
    
    try {
        showToast('Preparing export with human reviews...', 'info');
        
        // Send human reviews to backend first
        const reviewData = await fetch(`/api/save-reviews/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviews: state.humanReviews || {} })
        });
        
        if (!reviewData.ok) {
            const err = await reviewData.json();
            throw new Error(err.detail || 'Failed to save reviews');
        }
        
        // Now export the notebook with all data
        const exportUrl = `/api/export-notebook/${state.sessionId}?include_reasoning=true`;
        
        // Create a temporary link and click it
        const a = document.createElement('a');
        a.href = exportUrl;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        
        // Clean up
        setTimeout(() => {
            document.body.removeChild(a);
            showToast('Download started. The notebook includes all reviews!', 'success');
        }, 1000);
        
    } catch (error) {
        console.error('Export error:', error);
        showError(error, { operation: 'Export' });
    }
}


// ============== Utilities ==============

export function clearPreviousResults() {
    // Reset state
    state.results = [];
    state.diversityCheckPassed = false;  // Reset diversity check flag
    state.isHunting = false;
    state.humanReviews = {};  // Reset human reviews
    state.allResponses = [];  // Reset accumulated responses
    state.selectedRowNumbers = [];  // Reset selection
    state.selectionConfirmed = false;  // FIX 2: Reset selection lock
    state.llmRevealed = false;  // Reset reveal state
    // NOTE: totalHuntsCount is the single source of truth, no separate offset to reset
    state.currentRunStartOffset = 0;  // Reset run offset (will be set correctly in initProgressUI)
    state.originalNotebookJson = null;  // Reset original notebook
    state.blindJudging = {
        queue: [],
        currentResult: null,
        humanJudgments: {}
    };
    state.huntResponseData = {};  // Reset response data for slide-out panel
    
    // Reset validation states (prevents carrying over from previous task)
    state.referenceValidated = false;  // Must re-validate new notebook
    state.criteria = null;  // Will be set from new notebook
    state.initialCriteria = null;  // Will be set from new notebook
    state.metadata = null;  // Will be set from new notebook
    state.metadataModel = null;  // Will be set from new notebook
    state.unsavedChanges = {
        prompt: false,
        response: false,
        modelRef: false,
        judge: false
    };
    state.modelMismatchWarning = false;  // Reset warning flag
    
    // Hide model locked indicator (will be shown again if new notebook has model in metadata)
    hideModelLockedIndicator();
    
    // Model lock disabled — no need to refresh model options here
    // (was resetting the dropdown selection back to Qwen)
    
    // FIX 4: Re-enable model/provider selects when clearing (e.g., on model change before hunt)
    if (elements.modelSelect) {
        elements.modelSelect.disabled = false;
        elements.modelSelect.title = '';
    }
    if (elements.providerSelect) {
        elements.providerSelect.disabled = false;
        elements.providerSelect.title = '';
    }
    
    // Hide progress, results, selection, and summary sections
    elements.progressSection?.classList.add('hidden');
    elements.resultsSection?.classList.add('hidden');
    elements.summarySection?.classList.add('hidden');
    elements.selectionSection?.classList.add('hidden');
    
    // Clear hunt table
    if (elements.huntTableBody) {
        elements.huntTableBody.innerHTML = '';
    }
    
    // Clear breaking results
    if (elements.breakingResults) {
        elements.breakingResults.innerHTML = '';
    }
    
    // Reset progress bar
    if (elements.progressFill) {
        elements.progressFill.style.width = '0%';
    }
    if (elements.progressText) {
        elements.progressText.textContent = '0 / 0 hunts complete';
    }
    if (elements.progressPercent) {
        elements.progressPercent.textContent = '0%';
    }
    
    // Reset breaks indicator
    const dots = elements.breaksIndicator?.querySelectorAll('.break-dot');
    dots?.forEach(dot => dot.classList.remove('found'));
    
}

/**
 * Format LLM Judge criteria breakdown for display
 * Shows each criterion (C1, C2, etc.) with pass/fail status and explanation
 */
export function formatLLMCriteria(criteria, fullExplanation) {
    if (!criteria || Object.keys(criteria).length === 0) {
        return '<div style="padding: 0.5rem; color: var(--text-muted); font-style: italic;">No criteria breakdown available</div>';
    }
    
    // Try to extract per-criterion explanations from the full explanation
    const explanationText = fullExplanation || '';
    const criteriaExplanations = {};
    
    // Try multiple patterns to extract explanations for each criterion
    for (const [key] of Object.entries(criteria)) {
        const patterns = [
            // Pattern: "Failed Criteria Details: C1: explanation..." or "Passing Criteria: C1: explanation..."
            new RegExp(`(?:Failed|Passing)\\s+Criteria\\s+Details?:\\s*${key}[:\\-]?\\s*(.+?)(?=\\s*C\\d|$)`, 'gi'),
            // Pattern: "C1: explanation..." or "C1 - explanation..."
            new RegExp(`${key}[:\\-]\\s+(.+?)(?=\\s*C\\d|$)`, 'gi'),
            // Pattern: "C1 PASS: explanation..." or "C1 FAIL: explanation..."
            new RegExp(`${key}\\s+(?:PASS|FAIL)[:\\-]?\\s*(.+?)(?=\\s*C\\d|$)`, 'gi'),
            // Pattern: "**C1**: explanation..."
            new RegExp(`\\*\\*${key}\\*\\*[:\\-]?\\s*(.+?)(?=\\*\\*C\\d|$)`, 'gi'),
            // Pattern: Line starting with C1
            new RegExp(`^\\s*${key}[.:\\-]?\\s*(.+)`, 'gim')
        ];
        
        for (const pattern of patterns) {
            const match = pattern.exec(explanationText);
            if (match && match[1]) {
                let explanation = match[1].trim();
                // Clean up the explanation (remove bullet points, extra whitespace, etc.)
                explanation = explanation.replace(/^[•\-\*]\s*/, '');
                explanation = explanation.replace(/\s+/g, ' ').trim();
                if (explanation && explanation.length > 5) {  // Only use if meaningful
                    criteriaExplanations[key] = explanation;
                    break;
                }
            }
        }
        
        // Fallback: look for the criterion in any line
        if (!criteriaExplanations[key]) {
            const explanationLines = explanationText.split('\n');
            for (const line of explanationLines) {
                if (line.toUpperCase().includes(key.toUpperCase()) && line.length > key.length + 10) {
                    // Extract text after the criterion ID
                    const match = line.match(new RegExp(`${key}[:\\-]?\\s*(.+)`, 'i'));
                    if (match && match[1]) {
                        let explanation = match[1].trim();
                        explanation = explanation.replace(/^[•\-\*]\s*/, '');
                        if (explanation && explanation.length > 5) {
                            criteriaExplanations[key] = explanation;
                            break;
                        }
                    }
                }
            }
        }
    }
    
    // Build HTML for each criterion
    const criteriaHtml = Object.entries(criteria).map(([key, value]) => {
        const isPassing = String(value).toUpperCase() === 'PASS';
        const statusEmoji = isPassing ? '✅' : '❌';
        const statusText = isPassing ? 'PASS' : 'FAIL';
        const statusColor = isPassing ? 'var(--success)' : 'var(--danger)';
        const explanation = criteriaExplanations[key] || '';
        
        // Find matching criteria description from state.criteria
        const criteriaDesc = (state.criteria || []).find(c => c.id === key);
        const criteriaText = criteriaDesc ? criteriaDesc.criteria : '';
        
        return `
            <div style="display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.5rem; padding: 0.5rem; margin-bottom: 0.5rem; background: var(--bg-primary); border-radius: 6px; border-left: 3px solid ${statusColor};">
                <span style="font-weight: 600; min-width: 35px;">${key}:</span>
                <span style="color: ${statusColor}; font-weight: 600;">${statusEmoji} ${statusText}</span>
                ${criteriaText ? `<span style="flex: 1; font-size: 0.85rem; color: var(--text-secondary); word-break: break-word;">(${escapeHtml(criteriaText)})</span>` : ''}
                ${explanation ? `<div style="width: 100%; margin-top: 0.25rem; padding-left: 40px; font-size: 0.85rem; color: var(--text-muted);">${escapeHtml(explanation)}</div>` : ''}
            </div>
        `;
    }).join('');
    
    return criteriaHtml;
}


/**
 * Render an "Independent Judging Results" explanation string as structured HTML.
 * Parses the header line, passing-criteria summary, and per-criterion lines.
 */
function renderJudgeExplanation(explanationText) {
    if (!explanationText) return `<span style="color: var(--text-muted); font-style: italic;">No explanation available</span>`;

    const lines = explanationText.split('\n');
    let headerHtml = '';
    let summaryHtml = '';
    let criteriaHtml = '';
    let otherHtml = '';

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // Header: "Independent Judging Results:"
        if (line.startsWith('Independent Judging Results')) {
            headerHtml = `<div style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary); margin-bottom: 0.35rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--border-color, #e5e7eb);">${escapeHtml(line)}</div>`;

        // Summary: "- Passing Criteria: 2/3"
        } else if (line.startsWith('- Passing Criteria:') || line.startsWith('Passing Criteria:')) {
            summaryHtml = `<div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.6rem;">${escapeHtml(line)}</div>`;

        // Warning line
        } else if (line.startsWith('⚠️') || line.toLowerCase().startsWith('missing criteria')) {
            otherHtml += `<div style="font-size: 0.82rem; color: var(--warning, #f59e0b); margin-top: 0.4rem;">${escapeHtml(line)}</div>`;

        // Criterion line: "✅ C1 (PASS): reason" or "❌ C2 (FAIL): reason"
        } else if (line.startsWith('✅') || line.startsWith('❌')) {
            const isPassing = line.startsWith('✅');
            const statusColor = isPassing ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
            const colonIdx = line.indexOf('): ');
            let badge, reason;
            if (colonIdx !== -1) {
                badge = line.slice(0, colonIdx + 1).trim();
                reason = line.slice(colonIdx + 2).trim();
            } else {
                badge = line;
                reason = '';
            }
            criteriaHtml += `
                <div style="display: flex; align-items: baseline; gap: 0.5rem; padding: 0.45rem 0.6rem; margin-bottom: 0.3rem; background: var(--bg-primary); border-left: 3px solid ${statusColor}; border-radius: 4px; font-size: 0.875rem; line-height: 1.5;">
                    <span style="font-weight: 700; color: ${statusColor}; white-space: nowrap; flex-shrink: 0;">${escapeHtml(badge)}</span>
                    ${reason ? `<span style="color: var(--text-secondary);">${escapeHtml(reason)}</span>` : ''}
                </div>`;

        } else {
            otherHtml += `<div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 0.2rem;">${escapeHtml(line)}</div>`;
        }
    }

    const result = headerHtml + summaryHtml + criteriaHtml + otherHtml;
    return result || `<span style="color: var(--text-muted); font-style: italic;">No explanation available</span>`;
}


/**
 * Format judge criteria for the reference judge display (simpler format)
 * Shows each criterion with pass/fail status
 */
export function formatJudgeCriteriaDisplay(criteria) {
    // Ensure ALL criteria from initialCriteria are shown, even if not in judge result
    // This ensures missing criteria are always displayed
    const allCriteriaIds = new Set(Object.keys(criteria || {}));
    const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
    
    // Add missing criteria from initialCriteria that aren't in the judge result
    for (const initialId of initialCriteriaIds) {
        if (!(initialId in criteria)) {
            criteria[initialId] = 'MISSING';
        }
    }
    
    // Sort criteria by ID (C1, C2, C3, etc.) for consistent display
    const entries = Object.entries(criteria).sort(([a], [b]) => {
        const aNum = parseInt(a.match(/C(\d+)/)?.[1] || '0');
        const bNum = parseInt(b.match(/C(\d+)/)?.[1] || '0');
        return aNum - bNum;
    });
    
    if (entries.length === 0) {
        return '<div style="padding: 0.5rem; color: var(--text-muted); font-style: italic;">No criteria breakdown available</div>';
    }
    
    // Build HTML for each criterion
    const criteriaHtml = entries.map(([key, value]) => {
        const statusUpper = String(value).toUpperCase();
        const isPassing = statusUpper === 'PASS';
        const isMissing = statusUpper === 'MISSING';
        
        let statusEmoji, statusText, statusColor, bgColor;
        
        if (isMissing) {
            // Missing criteria = warning/error (not a failure)
            statusEmoji = '⚠️';
            statusText = 'MISSING';
            statusColor = 'var(--warning)';
            bgColor = 'var(--warning-bg)';
        } else if (isPassing) {
            statusEmoji = '✅';
            statusText = 'PASS';
            statusColor = 'var(--success)';
            bgColor = 'var(--bg-tertiary)';
        } else {
            statusEmoji = '❌';
            statusText = 'FAIL';
            statusColor = 'var(--danger)';
            bgColor = 'var(--bg-tertiary)';
        }
        
        // Find matching criteria description from state.criteria or state.initialCriteria
        // This ensures missing criteria (from initialCriteria) can still be displayed
        let criteriaDesc = (state.criteria || []).find(c => c.id === key);
        if (!criteriaDesc) {
            // If not in current criteria, check initial criteria (for missing criteria)
            criteriaDesc = (state.initialCriteria || []).find(c => c.id === key);
        }
        const criteriaText = criteriaDesc ? criteriaDesc.criteria : '';
        
        const warningMsg = isMissing ? '<span style="font-size: 0.8rem; color: var(--warning); font-style: italic;">(Not evaluated - does not count as failure)</span>' : '';
        
        return `
            <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; margin: 0.25rem 0; background: ${bgColor}; border-radius: 6px; border-left: 3px solid ${statusColor};">
                <span style="font-weight: 600; min-width: 35px;">${key}:</span>
                <span style="color: ${statusColor}; font-weight: 600;">${statusEmoji} ${statusText}</span>
                ${criteriaText ? `<span style="flex: 1; font-size: 0.85rem; color: var(--text-secondary);">${escapeHtml(criteriaText)}</span>` : ''}
                ${warningMsg}
            </div>
        `;
    }).join('');
    
    return criteriaHtml;
}

// escapeHtml — imported from utils.js

/**
 * Convert HTML content from contentEditable to plain text while preserving line breaks.
 * Browsers insert <br>, <div>, or <p> tags when user presses Enter.
 * This function converts those back to \n for proper notebook formatting.
 */
export function htmlToPlainText(element) {
    if (!element) return '';
    
    // Clone the element to avoid modifying the original
    const clone = element.cloneNode(true);
    
    // Replace <br> tags with newline markers
    clone.querySelectorAll('br').forEach(br => {
        br.replaceWith('\n');
    });
    
    // Replace block elements (div, p, li) with newline + content
    // These elements create new lines in contentEditable
    clone.querySelectorAll('div, p').forEach(block => {
        // Add newline before block content (unless it's the first element)
        const text = block.textContent || '';
        if (block.previousSibling) {
            block.replaceWith('\n' + text);
        } else {
            block.replaceWith(text);
        }
    });
    
    // Handle list items
    clone.querySelectorAll('li').forEach(li => {
        const text = li.textContent || '';
        li.replaceWith('\n• ' + text);
    });
    
    // Get the text content and clean up
    let text = clone.textContent || '';
    
    // Clean up multiple consecutive newlines (but keep double newlines for paragraphs)
    text = text.replace(/\n{3,}/g, '\n\n');
    
    // Trim leading/trailing whitespace but preserve internal structure
    text = text.trim();
    
    return text;
}

// ============== Connection Warm-up ==============

/**
 * Warm up API connections in background for faster hunt execution.
 * Called automatically when notebook is loaded.
 */
export async function warmupConnections() {
    try {
        const response = await fetch('/api/warmup-connections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.ok) {
        }
    } catch (error) {
        // Silent fail - warm-up is optional optimization
    }
}

// ============== Selection & Review Functions (Missed in initial extraction) ==============

export function displaySelectionCards() {
    const grid = elements.selectionGrid;
    grid.innerHTML = '';
    
    renderSelectionInstructions();
    
    if (state.allResponses.length === 0) {
        grid.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No hunts found. Run hunts first.</div>';
        return;
    }
    
    // Create a cleaner table with better column order
    const table = document.createElement('table');
    table.className = 'selection-table';
    table.innerHTML = `
        <thead>
            <tr>
                <th class="col-select">Select</th>
                <th class="col-response">Response</th>
                <th class="col-model">Model</th>
                <th class="col-status">Status</th>
                <th class="col-hunt">Hunt</th>
                <th class="col-slot">Slot</th>
            </tr>
        </thead>
        <tbody id="huntSelectionTableBody">
        </tbody>
    `;
    
    const tbody = table.querySelector('#huntSelectionTableBody');
    
    const huntMode = state.config?.hunt_mode || 'break_50';

    // Sort: in all_passing mode show passing first; otherwise breaking first
    const sortedHunts = [...state.allResponses].sort((a, b) => {
        const aBreaking = isResultBreaking(a);
        const bBreaking = isResultBreaking(b);
        if (huntMode === 'all_passing') {
            if (!aBreaking && bBreaking) return -1;
            if (aBreaking && !bBreaking) return 1;
        } else {
            if (aBreaking && !bBreaking) return -1;
            if (!aBreaking && bBreaking) return 1;
        }
        return 0;
    });
    
    sortedHunts.forEach((result, index) => {
        const rowNumber = state.allResponses.indexOf(result);
        const isSelected = state.selectedRowNumbers.includes(rowNumber);
        
        const slotIndex = isSelected ? state.selectedRowNumbers.indexOf(rowNumber) : -1;
        const slotNumber = slotIndex >= 0 ? slotIndex + 1 : null;
        
        const isBreaking = isResultBreaking(result);
        
        const modelDisplay = getModelDisplayName(result.model);
        const responsePreview = (result.response || 'No response').substring(0, 120) + (result.response?.length > 120 ? '...' : '');
        
        const row = document.createElement('tr');
        row.className = isSelected ? 'selected' : '';
        row.dataset.rowNumber = rowNumber;
        
        const checkboxDisabled = state.selectionConfirmed ? 'disabled' : '';
        
        row.innerHTML = `
            <td class="col-select">
                <input type="checkbox" class="selection-checkbox hunt-selection-checkbox" 
                       ${isSelected ? 'checked' : ''} ${checkboxDisabled}
                       data-row-number="${rowNumber}">
            </td>
            <td class="col-response">
                <div class="response-preview-text">${escapeHtml(responsePreview)}</div>
                <button class="view-details-btn" data-row-number="${rowNumber}">
                    View Full
                </button>
            </td>
            <td class="col-model">
                <span class="model-name">${modelDisplay}</span>
            </td>
            <td class="col-status">
                <span class="status-badge ${isBreaking ? 'break' : 'pass'}">
                    ${isBreaking ? '✅ BREAK' : '❌ PASS'}
                </span>
            </td>
            <td class="col-hunt">
                <span class="hunt-number">#${rowNumber + 1}</span>
            </td>
            <td class="col-slot">
                ${slotNumber 
                    ? `<span class="slot-badge assigned">Slot ${slotNumber}</span>` 
                    : `<span class="slot-badge empty">-</span>`}
            </td>
        `;
        
        // Click handler for row selection (except buttons)
        row.addEventListener('click', (e) => {
            if (e.target.closest('.view-details-btn')) return;
            if (e.target.type !== 'checkbox') {
                const checkbox = row.querySelector('.selection-checkbox');
                if (!checkbox.disabled) checkbox.checked = !checkbox.checked;
            }
            if (!state.selectionConfirmed) {
                toggleHuntSelection(rowNumber, row);
            }
        });
        
        // View button opens slide-out panel
        row.querySelector('.view-details-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openSelectionDetailSlideout(rowNumber, result);
        });
        
        tbody.appendChild(row);
    });
    
    grid.appendChild(table);
    updateSelectionCount();
}

// Refresh selection table to update slot indicators without resetting selection
export function refreshSelectionTable() {
    const tbody = document.getElementById('huntSelectionTableBody');
    if (!tbody) {
        // Table doesn't exist yet, nothing to refresh
        return;
    }
    
    // Update slot indicators for all rows
    tbody.querySelectorAll('tr').forEach(row => {
        const rowNumber = parseInt(row.dataset.rowNumber);
        if (isNaN(rowNumber)) return;
        
        const isSelected = state.selectedRowNumbers.includes(rowNumber);
        const slotIndex = isSelected ? state.selectedRowNumbers.indexOf(rowNumber) : -1;
        const slotNumber = slotIndex >= 0 ? slotIndex + 1 : null;
        
        // Update slot cell (use class selector for correct column)
        const slotCell = row.querySelector('td.col-slot');
        if (slotCell) {
            if (slotNumber) {
                slotCell.innerHTML = `<span class="slot-badge assigned">Slot ${slotNumber}</span>`;
            } else {
                slotCell.innerHTML = `<span class="slot-badge empty">-</span>`;
            }
        }
        
        // Update row selection styling
        if (isSelected) {
            row.classList.add('selected');
        } else {
            row.classList.remove('selected');
        }
        
        // Update checkbox state
        const checkbox = row.querySelector('.hunt-selection-checkbox');
        if (checkbox) {
            checkbox.checked = isSelected;
            // FIX 2: Disable checkbox if selection is confirmed
            if (state.selectionConfirmed) {
                checkbox.disabled = true;
                checkbox.style.cursor = 'not-allowed';
                checkbox.style.opacity = '0.6';
            } else {
                checkbox.disabled = false;
                checkbox.style.cursor = 'pointer';
                checkbox.style.opacity = '1';
            }
        }
    });
}

export function toggleHuntSelection(rowNumber, row) {
    // FIX 2: Prevent selection changes after confirmation
    if (state.selectionConfirmed) {
        showToast('Selection is locked. You cannot change selection after confirming. Please complete reviews or refresh the page.', 'warning');
        const checkbox = row.querySelector('.hunt-selection-checkbox');
        if (checkbox) {
            checkbox.checked = state.selectedRowNumbers.includes(rowNumber);
        }
        return;
    }
    
    const checkbox = row.querySelector('.hunt-selection-checkbox');
    
    const result = state.allResponses[rowNumber];
    if (!result) {
        console.error(`❌ CRITICAL: No result found at row number ${rowNumber}`);
        return;
    }
    
    const huntMode = state.config?.hunt_mode || 'break_50';
    const isBreaking = isResultBreaking(result);
    
    if (checkbox.checked) {
        // Mode-specific per-item guards (block before adding to selection)
        if (huntMode === 'all_passing' && isBreaking) {
            checkbox.checked = false;
            showToast('⚠️ Only passing (non-breaking) hunts can be selected in All Passing mode.', 'warning');
            return;
        }
        if (huntMode === 'break_all' && !isBreaking) {
            checkbox.checked = false;
            showToast('⚠️ Only breaking (all-criteria-fail) hunts can be selected in All Breaking mode.', 'warning');
            return;
        }
        if (huntMode === '1_breaking') {
            const currentBreaking = state.selectedRowNumbers
                .map(rn => state.allResponses[rn]).filter(r => r && isResultBreaking(r)).length;
            if (isBreaking && currentBreaking >= 1) {
                checkbox.checked = false;
                showToast('⚠️ Only 1 breaking hunt is allowed in 1 Breaking mode. Unselect the current one first.', 'warning');
                return;
            }
        }

        // break_50: fixed 4-slot selection
        if (huntMode === 'break_50' && state.selectedRowNumbers.length >= 4) {
            checkbox.checked = false;
            showToast('Maximum 4 hunts allowed. Unselect one first.', 'warning');
            return;
        }
        
        // For break_50, validate combination at exactly 4
        const tempSelection = [...state.selectedRowNumbers];
        if (!tempSelection.includes(rowNumber)) {
            tempSelection.push(rowNumber);
        }
        if (huntMode === 'break_50' && tempSelection.length === 4) {
            const tempResults = tempSelection.map(rn => state.allResponses[rn]).filter(r => r);
            const validation = validateSelectionForMode(tempResults, huntMode, state.adminMode);
            if (!validation.valid) {
                checkbox.checked = false;
                showToast(`❌ ${validation.message}`, 'error');
                return;
            }
        }
        
        if (!state.selectedRowNumbers.includes(rowNumber)) {
            state.selectedRowNumbers.push(rowNumber);
        }
        row.classList.add('selected');
        row.style.background = 'rgba(var(--accent-primary-rgb), 0.1)';
        row.style.borderLeft = '4px solid var(--accent-primary)';
        // Reset diversity check flag when selection changes
        state.diversityCheckPassed = false;
        
        // Refresh the selection table to show updated slot assignments
        refreshSelectionTable();
    } else {
        // Remove from selection
        state.selectedRowNumbers = state.selectedRowNumbers.filter(rn => rn !== rowNumber);
        row.classList.remove('selected');
        row.style.background = 'transparent';
        row.style.borderLeft = 'none';
        // Reset diversity check flag when selection changes
        state.diversityCheckPassed = false;
        
        // Refresh the selection table to show updated slot assignments
        refreshSelectionTable();
    }
    
    updateSelectionCount();
    
    // If we're in review mode, update the review display
    if (state.selectedRowNumbers.length > 0 && !elements.resultsSection.classList.contains('hidden')) {
        displaySelectedForReview();
    }
}

export function toggleDetailsRow(rowNumber, row, result) {
    const tbody = row.parentElement;
    const detailRowId = `detail-row-${rowNumber}`;
    let detailRow = document.getElementById(detailRowId);
    const detailsBtn = row.querySelector('.details-toggle-btn');
    const detailsIcon = detailsBtn.querySelector('.details-icon');
    const detailsText = detailsBtn.querySelector('.details-text');
    
    if (detailRow && detailRow.style.display !== 'none') {
        // Collapse: hide the detail row
        detailRow.style.display = 'none';
        detailsIcon.textContent = '▼';
        detailsText.textContent = 'Details';
        detailsBtn.style.background = 'var(--bg-tertiary)';
        detailsBtn.style.color = 'var(--text-primary)';
        detailsBtn.style.borderColor = 'var(--border)';
    } else {
        // Expand: show or create the detail row
        if (!detailRow) {
            // Create new detail row
            detailRow = document.createElement('tr');
            detailRow.id = detailRowId;
            detailRow.className = 'detail-row';
            detailRow.style.cssText = `
                display: table-row;
                background: var(--bg-secondary);
                border-top: 2px solid var(--border);
                animation: slideDown 0.3s ease-out;
            `;
            
            const fullResponse = result.response || 'No response available';
            
            detailRow.innerHTML = `
                <td colspan="7" style="padding: 0;">
                    <div style="padding: 1.5rem; background: var(--bg-secondary);">
                        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
                            <span style="font-size: 1.1rem;">📄</span>
                            <h3 style="margin: 0; font-size: 1rem; font-weight: 600; color: var(--text-primary);">
                                Model Response - Hunt #${rowNumber + 1}
                            </h3>
                        </div>
                        <div style="background: var(--bg-primary); border: 1px solid var(--border); 
                                    border-radius: 8px; padding: 1.25rem; max-height: 600px; 
                                    overflow-y: auto; overflow-x: auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                            <pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word; 
                                       font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 
                                       'Helvetica Neue', Arial, sans-serif; font-size: 0.9rem; 
                                       line-height: 1.6; color: var(--text-primary);">${escapeHtml(fullResponse)}</pre>
                        </div>
                    </div>
                </td>
            `;
            
            // Insert after the main row
            row.parentNode.insertBefore(detailRow, row.nextSibling);
        } else {
            // Show existing detail row with animation
            detailRow.style.display = 'table-row';
            detailRow.style.animation = 'slideDown 0.3s ease-out';
        }
        
        // Update button state
        detailsIcon.textContent = '▲';
        detailsText.textContent = 'Hide';
        detailsBtn.style.background = 'var(--accent-primary)';
        detailsBtn.style.color = 'white';
        detailsBtn.style.borderColor = 'var(--accent-primary)';
    }
}

export function updateSelectionCount() {
    const count = state.selectedRowNumbers.length;
    const huntMode = state.config?.hunt_mode || 'break_50';
    
    const selectedResults = state.selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r !== undefined);
    const { breakingCount, passingCount } = countBreakingPassing(selectedResults);
    
    const validation = validateSelectionForMode(selectedResults, huntMode, state.adminMode);
    
    if (selectedResults.length !== count) {
        console.error(`❌ CRITICAL: Expected ${count} results but found ${selectedResults.length}`);
        console.error('   Selected row numbers:', state.selectedRowNumbers);
        console.error('   allResponses length:', state.allResponses.length);
    }
    
    if (elements.selectionCount) {
        let statusText = '';
        let statusColor = 'var(--text-muted)';
        
        if (count === 0) {
            statusText = 'No hunts selected';
        } else if (state.adminMode) {
            statusText = `Admin: ${count} selected — any combination allowed`;
            statusColor = 'var(--text-primary)';
        } else if (huntMode === 'all_passing') {
            statusText = validation.valid
                ? `✅ ${passingCount} passing hunt${passingCount !== 1 ? 's' : ''} selected`
                : `❌ ${validation.message}`;
            statusColor = validation.valid ? 'var(--success)' : 'var(--danger)';
        } else if (huntMode === 'break_all') {
            statusText = validation.valid
                ? `✅ ${breakingCount} breaking hunt${breakingCount !== 1 ? 's' : ''} selected`
                : `❌ ${validation.message}`;
            statusColor = validation.valid ? 'var(--success)' : 'var(--danger)';
        } else if (huntMode === '1_breaking') {
            const needsBreak = breakingCount === 0;
            statusText = needsBreak
                ? `⚠️ ${passingCount} passing selected — must include the 1 breaking hunt`
                : `✅ ${breakingCount} breaking, ${passingCount} passing selected`;
            statusColor = needsBreak ? 'var(--warning)' : 'var(--success)';
        } else if (count < 4) {
            statusText = `Selected: ${count}/4 hunts (${breakingCount} breaking, ${passingCount} passing) — Select ${4 - count} more`;
            statusColor = 'var(--text-primary)';
        } else if (count === 4) {
            statusText = validation.valid
                ? `✅ Valid: ${breakingCount} breaking, ${passingCount} passing`
                : `❌ ${validation.message}`;
            statusColor = validation.valid ? 'var(--success)' : 'var(--danger)';
        } else {
            statusText = `Too many selected: ${count}/4`;
            statusColor = 'var(--danger)';
        }
        
        elements.selectionCount.textContent = statusText;
        elements.selectionCount.style.color = statusColor;
    }
    
    // Enable confirm button based on mode-specific validation
    let shouldEnable = false;
    if (state.adminMode) {
        shouldEnable = count >= 1;
    } else if (huntMode === 'all_passing' || huntMode === 'break_all') {
        shouldEnable = count >= 1 && validation.valid;
    } else if (huntMode === '1_breaking') {
        shouldEnable = count >= 1 && breakingCount === 1 && validation.valid;
    } else {
        shouldEnable = count === 4 && validation.valid;
    }

    const confirmBtn = document.getElementById('confirmSelectionBtn') || elements.confirmSelectionBtn;
    if (confirmBtn) {
        confirmBtn.disabled = !shouldEnable;
        confirmBtn.title = !shouldEnable && !state.adminMode ? validation.message : '';
    }
}

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

    // break_50 requires exactly 4; other modes are flexible
    if (!state.adminMode && huntMode === 'break_50' && selectedResults.length !== 4) {
        showToast(`❌ Must select exactly 4 hunts. Currently selected: ${selectedResults.length}`, 'error');
        return;
    }
    if (state.adminMode && selectedResults.length < 1) {
        showToast(`Select at least 1 hunt for review.`, 'error');
        return;
    }
    
    // Mode-aware validation
    const validation = validateSelectionForMode(selectedResults, huntMode, state.adminMode);
    if (!validation.valid) {
        showToast(`❌ ${validation.message}`, 'error');
        return;
    }

    const n = selectedResults.length;
    const confirmed = await showAppModal({
        title: `Move these ${n} to human review?`,
        message: state.adminMode
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
    
    // Lock selection after confirmation
    state.selectionConfirmed = true;
    
    // Keep selection section visible, but selection is now locked
    elements.resultsSection.classList.remove('hidden');
    
    // Show a results tip
    renderInsightTip('resultsTipContainer', 'results');
    
    // Display the selected responses for review (blind mode)
    displaySelectedForReview();
    
    // Disable all action buttons when in review mode (except view buttons)
    setReviewModeButtonsDisabled(true);
    
    // FIX 2: Disable all checkboxes in selection table
    disableSelectionCheckboxes();
    
    // Auto-collapse the selection section when moved to review
    collapseSelectionSectionCard(selectedResults.length);
    
    showToast(`Selection confirmed and locked! ${selectedResults.length} hunt(s) moved to human review. Complete all ${selectedResults.length} reviews to proceed.`, 'success');
}

export function displaySelectedForReview() {
    elements.breakingResults.innerHTML = '';
    elements.noBreaksMessage.classList.add('hidden');
    
    // Get selected results directly by row numbers - NO LOOKUP!
    const selectedResponses = state.selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r !== undefined);
    
    
    if (selectedResponses.length === 0) {
        elements.noBreaksMessage.classList.remove('hidden');
        elements.noBreaksMessage.textContent = 'No hunts selected. Select hunts from the table above to review them.';
        return;
    }
    
    // Create result cards for each selected response (blind mode - LLM hidden)
    selectedResponses.forEach((result, index) => {
        const rowNumber = state.selectedRowNumbers[index]; // Get the row number for this result
        const card = createResultCard(result, index, rowNumber); // Pass row number
        elements.breakingResults.appendChild(card);
    });
    
    // Update review progress
    updateReviewProgress();
    
    // Ensure LLM sections are hidden (blind mode)
    document.querySelectorAll('.llm-judge-section').forEach(section => {
        section.style.display = 'none';
    });
    
    // Show save container (QC + review sync buttons)
    elements.saveDriveContainer.classList.remove('hidden');
    if (state.adminMode) {
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

// FIX 2: Helper function to disable all selection checkboxes
export function disableSelectionCheckboxes() {
    const checkboxes = document.querySelectorAll('.hunt-selection-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.disabled = true;
        checkbox.style.cursor = 'not-allowed';
        checkbox.style.opacity = '0.6';
    });
}

// FIX 2: Helper function to enable all selection checkboxes (for future use)
export function enableSelectionCheckboxes() {
    const checkboxes = document.querySelectorAll('.hunt-selection-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.disabled = false;
        checkbox.style.cursor = 'pointer';
        checkbox.style.opacity = '1';
    });
}

/**
 * Change selection: go back to pick different 4 responses. Disabled after Reveal LLM Judgments.
 */
export function handleChangeSelection() {
    if (state.llmRevealed) return;

    state.selectionConfirmed = false;
    state.diversityCheckPassed = false;
    state.selectedRowNumbers = [];

    if (state.humanReviews) {
        Object.keys(state.humanReviews).forEach(key => delete state.humanReviews[key]);
    }

    enableSelectionCheckboxes();
    setReviewModeButtonsDisabled(false);

    const changeBtn = elements.changeSelectionBtn;
    if (changeBtn) changeBtn.style.display = 'none';

    elements.breakingResults.innerHTML = '';
    elements.saveDriveContainer.classList.add('hidden');

    elements.selectionSection?.classList.remove('hidden');
    expandSelectionSectionCard();
    displaySelectionCards();
    elements.selectionSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    showToast('Selection cleared. Pick 4 responses again.', 'info');
}

export function updateReviewProgress() {
    // Re-apply review mode lock (in case another handler re-enabled buttons)
    if (state.selectionConfirmed) setReviewModeButtonsDisabled(true);

    // Count reviews for SELECTED row numbers only
    const selectedRowNumbers = state.selectedRowNumbers || [];
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const reviewCount = reviewKeys.filter(key => state.humanReviews && state.humanReviews[key]).length;
    const selectedCount = selectedRowNumbers.length;
    
    
    if (elements.reviewProgressText) {
        elements.reviewProgressText.textContent = `${reviewCount} / ${selectedCount} completed`;
        elements.reviewProgressText.style.color = reviewCount === selectedCount ? 'var(--success)' : 'var(--text-primary)';
    }
    
    // Enable reveal button only when all selected reviews are complete — always enable in admin mode
    const allComplete = reviewCount >= selectedCount && selectedCount > 0;
    
    if (elements.revealLLMBtn) {
        if (state.adminMode) {
            elements.revealLLMBtn.disabled = state.llmRevealed;
            elements.revealLLMBtn.style.opacity = state.llmRevealed ? '0.5' : '1';
        } else {
            elements.revealLLMBtn.disabled = !allComplete || state.llmRevealed;
            elements.revealLLMBtn.style.opacity = (!allComplete || state.llmRevealed) ? '0.5' : '1';
        }
        if (state.llmRevealed) {
            elements.revealLLMBtn.textContent = '✅ AI Evaluation Shown';
            elements.revealLLMBtn.disabled = true;
        } else if (allComplete || state.adminMode) {
            elements.revealLLMBtn.textContent = '👁️ Show AI Evaluation';
            if (state.adminMode) elements.revealLLMBtn.disabled = false;
        }
    }

    // Show Change selection button when reviews complete but before LLM revealed
    const changeBtn = elements.changeSelectionBtn;
    if (changeBtn) {
        if (allComplete && !state.llmRevealed) {
            changeBtn.style.display = 'inline-block';
        } else if (state.llmRevealed) {
            changeBtn.style.display = 'none';
        }
    }
    
    // Enable save button when all reviews complete (or always in admin mode)
    if (elements.saveDriveBtn) {
        if (state.adminMode) {
            elements.saveDriveBtn.disabled = false;
            elements.saveDriveBtn.style.opacity = '1';
        } else if (allComplete && selectedCount === 4) {
            // Keep save disabled until reveal (handled in revealLLMJudgments)
        }
    }
    
    // Update top instructions
    if (elements.reviewInstructions) {
        if (state.llmRevealed) {
            elements.reviewInstructions.textContent = '✅ Reviews locked. Scroll down to save.';
            elements.reviewInstructions.style.color = 'var(--success)';
        } else if (reviewCount >= 4) {
            elements.reviewInstructions.textContent = '✅ All reviews complete! Scroll down to show AI evaluation.';
            elements.reviewInstructions.style.color = 'var(--success)';
        } else {
            elements.reviewInstructions.textContent = `Complete all 4 human reviews, then scroll down to show AI evaluation and save.`;
        }
    }
    
    // Update bottom instructions
    if (elements.bottomInstructions) {
        if (state.llmRevealed) {
            elements.bottomInstructions.textContent = '✅ AI Evaluation shown. Click "Proceed to Quality Check" (runs below), then Save.';
            elements.bottomInstructions.style.color = 'var(--success)';
        } else if (reviewCount >= 4) {
            elements.bottomInstructions.textContent = '✅ All reviews complete! Click "Show AI Evaluation" → then "Proceed to Quality Check".';
            elements.bottomInstructions.style.color = 'var(--success)';
        } else {
            elements.bottomInstructions.textContent = `Complete all 4 human reviews → Show AI Evaluation → Proceed to Quality Check → Save`;
            elements.bottomInstructions.style.color = 'var(--text-muted)';
        }
    }
    
    scheduleLiveExportUpdate();
}

export async function revealLLMJudgments() {
    const selectedRowNumbers = state.selectedRowNumbers || [];
    
    const requiredReviews = selectedRowNumbers.length;

    if (!state.adminMode) {
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
                buttons: [ { label: 'OK', primary: true, value: true } ]
            });
            return;
        }
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
    
    // Show all LLM judge sections
    document.querySelectorAll('.llm-judge-section').forEach(section => {
        section.style.display = 'block';
    });
    
    // Lock all human review inputs (legacy sections)
    document.querySelectorAll('.human-review-section').forEach(section => {
        // Disable all buttons
        section.querySelectorAll('button').forEach(btn => {
            btn.disabled = true;
            btn.style.opacity = '0.5';
        });
        // Disable all textareas
        section.querySelectorAll('textarea').forEach(ta => {
            ta.disabled = true;
            ta.style.background = 'var(--bg-tertiary)';
        });
        // Add locked indicator
        const lockIndicator = document.createElement('div');
        lockIndicator.style.cssText = 'padding: 0.5rem; background: var(--warning); color: black; border-radius: 4px; margin-top: 0.5rem; text-align: center; font-weight: 600;';
        lockIndicator.textContent = '🔒 Review Locked';
        section.appendChild(lockIndicator);
    });
    
    // Update slot cards to show "View LLM Judgment" (clearly indicates AI evaluation)
    document.querySelectorAll('.slot-compact-card').forEach(card => {
        card.classList.add('revealed');
        const btn = card.querySelector('.slot-open-btn');
        if (btn) {
            btn.textContent = 'View LLM Judgment';
        }
    });
    
    // Enable Proceed to QC button (Save stays disabled until QC completes, except in admin mode)
    if (elements.proceedToQCBtn) {
        elements.proceedToQCBtn.disabled = false;
        elements.proceedToQCBtn.style.opacity = '1';
    }
    if (state.adminMode && elements.saveDriveBtn) {
        elements.saveDriveBtn.disabled = false;
        elements.saveDriveBtn.style.opacity = '1';
    }

    // Enable Submit to Colab button now that LLM judgment is revealed
    if (elements.submitColabBtn) {
        elements.submitColabBtn.disabled = false;
        elements.submitColabBtn.style.opacity = '1';
        elements.submitColabBtn.title = 'Save session data to Colab notebook';
    }
    
    // Update progress display
    updateReviewProgress();
    
    showToast('👁️ LLM Judgments revealed! Click any slot to view details. Reviews are locked.', 'success');
}

export async function displayBreakingResults() {
    try {
        // Use new review-results endpoint that selects 4 responses
        const response = await fetch(`/api/review-results/${state.sessionId}`);
        const data = await response.json();
        
        elements.breakingResults.innerHTML = '';
        
        if (data.count === 0) {
            elements.noBreaksMessage.classList.remove('hidden');
            return;
        }
        
        elements.noBreaksMessage.classList.add('hidden');
        
        // Show summary of selected responses
        const summaryHtml = `
            <div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px;">
                <strong>📋 Human Review Selection:</strong> 
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
    card.dataset.slotIndex = slotIndex || 0;
    card.dataset.rowNumber = rowNumber !== undefined ? rowNumber : null;
    
    const modelDisplay = getModelDisplayName(result.model);
    const score = result.judge_score ?? 0;
    const isFailed = score === 0;
    const slotNum = slotIndex !== undefined ? slotIndex + 1 : result.hunt_id;
    
    // Check if this slot has been reviewed
    const huntId = result.hunt_id;
    const isReviewed = state.humanReviews && state.humanReviews[huntId] && state.humanReviews[huntId].submitted;
    
    if (isReviewed) {
        card.classList.add('reviewed');
    }
    
    card.innerHTML = `
        <div class="slot-compact-badge">Slot ${slotNum}</div>
        <div class="slot-compact-info">
            <div class="slot-compact-model">${modelDisplay}</div>
            <div class="slot-compact-status ${isReviewed ? 'reviewed' : ''}">
                ${isReviewed ? '✅ Review Submitted' : `${isFailed ? '🟢 BREAK' : '🔴 PASS'} - Click to Review`}
            </div>
        </div>
        <div class="slot-compact-action">
            <button class="slot-open-btn">
                ${isReviewed ? '📝 Edit' : '⚖️ Grade'}
            </button>
        </div>
    `;
    
    // Click handler - open grading slide-out
    card.addEventListener('click', () => {
        openGradingSlideout(result, slotIndex, rowNumber);
    });
    
    return card;
}

// Legacy createResultCard function for full expandable card (keeping for reference)
export function createResultCardFull(result, slotIndex, rowNumber) {
    const card = document.createElement('div');
    card.className = 'expandable-card';
    card.dataset.huntId = result.hunt_id;
    card.dataset.slotIndex = slotIndex || 0;
    card.dataset.rowNumber = rowNumber !== undefined ? rowNumber : null;
    
    const modelDisplay = getModelDisplayName(result.model);
    const score = result.judge_score ?? 0;
    const isFailed = score === 0;
    const scoreEmoji = isFailed ? '🟢' : '🔴';
    const scoreClass = isFailed ? 'score-0' : 'score-1';
    const responseText = result.response || 'No response available';
    const slotNum = slotIndex !== undefined ? slotIndex + 1 : result.hunt_id;
    
    // Frontend deduplication: hide trace if similar to response
    let reasoningTrace = result.reasoning_trace || '';
    const responseClean = responseText.trim().toLowerCase();
    const traceClean = reasoningTrace.trim().toLowerCase();
    
    // Check for duplicates in UI only - export still gets full trace
    // Only hide if trace is EXACTLY the same as response (not if one contains the other)
    // This is less aggressive - thinking models often have reasoning that overlaps with response
    if (reasoningTrace && traceClean.length > 0) {
        const isExactDuplicate = traceClean === responseClean;
        if (isExactDuplicate) {
            reasoningTrace = ''; // Hide from UI only
        } else {
        }
    } else if (!reasoningTrace) {
    }
    
    // Store LLM judge data as JSON in data attribute
    const llmJudgeData = JSON.stringify({
        score: result.judge_score,
        criteria: result.judge_criteria || {},
        explanation: result.judge_explanation || '',
        output: result.judge_output || ''
    });
    
    card.innerHTML = `
        <div class="expandable-header">
            <div class="flex items-center gap-1">
                <span class="slot-badge" style="background: var(--accent-primary); color: white; padding: 0.25rem 0.5rem; border-radius: 4px; font-weight: 600;">Slot ${slotNum}</span>
                <span style="margin-left: 0.5rem; color: var(--text-secondary);">
                    ${modelDisplay}
                </span>
            </div>
            <span class="expandable-arrow">▼</span>
        </div>
        <div class="expandable-content">
            <!-- Split-Panel Layout -->
            <div class="slot-split-container" data-hunt-id="${result.hunt_id}">
                <!-- Left Panel: Response (Larger, Scrollable) -->
                <div class="slot-response-panel">
                            <label style="font-weight: 600; display: block; margin-bottom: 0.75rem; color: var(--text-primary);">
                        📄 Model Response (${modelDisplay}_${slotNum}):
                            </label>
                    <div class="code-block response-content" style="white-space: pre-wrap; line-height: 1.6; font-size: 0.9rem; max-height: 600px; overflow-y: auto;">${escapeHtml(responseText)}</div>
                    </div>
                    
                <!-- Right Panel: Grade + Explanation -->
                <div class="slot-grading-panel">
                    <!-- Grade Section (Top) -->
                    <div class="slot-grade-section">
                            <label style="font-weight: 600; display: block; margin-bottom: 1rem; color: var(--text-primary);">
                            ✅ Grading Basis - Per Criterion:
                            </label>
                        <div class="criteria-grading" data-hunt-id="${result.hunt_id}" style="max-height: 400px; overflow-y: auto;">
                    ${(state.criteria || []).map(c => `
                                    <div class="criterion-row" data-criterion-id="${c.id}" style="display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.75rem; padding: 1rem; margin-bottom: 0.75rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid var(--border); transition: all var(--transition-fast);">
                                        <span style="font-weight: 700; min-width: 40px; font-size: 1rem; color: var(--accent-primary);">${c.id}:</span>
                                        <span style="flex: 1; font-size: 0.9rem; color: var(--text-secondary); word-break: break-word; min-width: 200px; line-height: 1.5;">${escapeHtml(c.criteria)}</span>
                                        <div class="criterion-buttons" style="display: flex; gap: 0.5rem; flex-shrink: 0;">
                                            <button class="btn btn-small criterion-pass" data-hunt-id="${result.hunt_id}" data-criterion="${c.id}" style="padding: 0.5rem 1rem; font-size: 0.85rem; font-weight: 600; background: transparent; border: 2px solid var(--success); color: var(--success); border-radius: 6px; transition: all var(--transition-fast);">
                                                ✅ PASS
                                            </button>
                                            <button class="btn btn-small criterion-fail" data-hunt-id="${result.hunt_id}" data-criterion="${c.id}" style="padding: 0.5rem 1rem; font-size: 0.85rem; font-weight: 600; background: transparent; border: 2px solid var(--danger); color: var(--danger); border-radius: 6px; transition: all var(--transition-fast);">
                                                ❌ FAIL
                                            </button>
                            </div>
                        </div>
                    `).join('')}
                        </div>
                </div>
                
                    <!-- Explanation Section (Bottom) -->
                    <div class="slot-explanation-section">
                            <label style="font-weight: 600; display: block; margin-bottom: 0.75rem; color: var(--text-primary);">
                                📝 Human Review (human_judge_${slotNum}):
                            </label>
                            
                            <div style="margin-bottom: 1rem;">
                                <label style="font-weight: 500; font-size: 0.9rem; display: block; margin-bottom: 0.5rem; color: var(--text-secondary);">
                                    Explanation:
                                </label>
                            <textarea class="human-review-notes" data-hunt-id="${result.hunt_id}" placeholder="Explain your grading decisions (which criteria failed and why)..." style="width: 100%; min-height: 150px; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-primary); color: var(--text-primary); font-size: 0.9rem; resize: vertical; font-family: inherit; line-height: 1.5;"></textarea>
                                <div class="human-review-word-count" data-hunt-id="${result.hunt_id}" style="margin-top: 0.35rem; font-size: 0.8rem; color: var(--text-muted);">${getWordCountLabel(0)}</div>
                </div>
                
                            <button class="btn btn-primary submit-human-review-btn" data-hunt-id="${result.hunt_id}" disabled style="width: 100%; padding: 0.875rem; font-weight: 600; font-size: 0.95rem; border-radius: 8px; opacity: 0.7;">
                                ✅ Submit Human Review
                            </button>
                            <div class="human-review-status" data-hunt-id="${result.hunt_id}" style="margin-top: 0.75rem; font-size: 0.85rem; color: var(--text-muted); text-align: center;"></div>
                        </div>
                    </div>
            </div>
            
            <!-- Reasoning Section (Collapsible, Reference Only) -->
            <div class="slot-reasoning-section" style="margin-top: 1.5rem;">
                <button class="reasoning-toggle-btn" style="width: 100%; padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; justify-content: space-between; transition: all var(--transition-fast);">
                    <span>🧠 Model Reasoning Trace (Reference Only)</span>
                    <span class="reasoning-toggle-arrow">▼</span>
                </button>
                <div class="reasoning-content" style="display: none; margin-top: 1rem; padding: 1rem; background: var(--bg-tertiary); border-radius: 8px; border: 1px solid var(--border);">
                ${reasoningTrace ? `
                                <div class="code-block" style="font-size: 0.85rem; background: var(--bg-primary); white-space: pre-wrap; line-height: 1.6; max-height: 400px; overflow-y: auto; padding: 1rem; border-radius: 8px;">
                        ${escapeHtml(reasoningTrace)}
                    </div>
                ` : `
                                <div style="padding: 1.5rem; background: var(--bg-primary); border-radius: 8px; border: 1px dashed var(--border); color: var(--text-muted); font-style: italic; text-align: center;">
                                    ⚠️ No reasoning trace available.<br>
                                    <span style="font-size: 0.85rem;">The model either doesn't support chain-of-thought reasoning, or the reasoning was empty for this response.</span>
                    </div>
                `}
                </div>
            </div>
            
            <!-- LLM Judge Section - Hidden until human submits -->
            <div class="llm-judge-section" data-hunt-id="${result.hunt_id}" style="margin-top: 1.5rem; display: none;" data-llm-judge='${llmJudgeData.replace(/'/g, "&#39;")}'>
                <div style="padding: 1.5rem; background: var(--bg-tertiary); border-radius: 12px; border: 2px solid var(--accent-primary);">
                    <label style="font-weight: 600; display: block; margin-bottom: 1rem; color: var(--accent-primary); font-size: 1.05rem;">
                        🤖 LLM Judge (llm_judge_${slotNum}):
                    </label>
                    <div class="llm-judge-score" style="margin-bottom: 1rem;">
                        <span class="score-badge ${scoreClass}" style="font-size: 1rem; padding: 0.5rem 1rem;">${scoreEmoji} Score: ${score}</span>
                    </div>
                    
                    <!-- Criteria Breakdown -->
                    <div class="llm-criteria-breakdown" style="margin-bottom: 1rem;">
                        <label style="font-weight: 500; font-size: 0.9rem; display: block; margin-bottom: 0.75rem; color: var(--text-secondary);">📋 Grading Basis:</label>
                        ${formatLLMCriteria(result.judge_criteria, result.judge_explanation)}
                    </div>
                    
                      <!-- Full Explanation -->
                      <div class="llm-judge-explanation" style="font-size: 0.9rem; background: var(--bg-card); padding: 1rem; border-radius: 8px; line-height: 1.6;">
                          <label style="font-weight: 500; display: block; margin-bottom: 0.75rem; color: var(--text-primary);">📝 Full Explanation:</label>
                          ${renderJudgeExplanation(result.judge_explanation)}
                      </div>
                </div>
            </div>
        </div>
    `;
    
    // Toggle expand
    card.querySelector('.expandable-header').addEventListener('click', () => {
        card.classList.toggle('open');
    });
    
    // Reasoning toggle functionality
    const reasoningToggle = card.querySelector('.reasoning-toggle-btn');
    const reasoningContent = card.querySelector('.reasoning-content');
    const reasoningArrow = card.querySelector('.reasoning-toggle-arrow');
    
    if (reasoningToggle && reasoningContent) {
        reasoningToggle.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent card toggle
            const isHidden = reasoningContent.style.display === 'none';
            reasoningContent.style.display = isHidden ? 'block' : 'none';
            reasoningArrow.textContent = isHidden ? '▲' : '▼';
            reasoningToggle.style.borderBottomLeftRadius = isHidden ? '0' : '8px';
            reasoningToggle.style.borderBottomRightRadius = isHidden ? '0' : '8px';
        });
    }
    
    const submitBtn = card.querySelector('.submit-human-review-btn');
    const notesTextarea = card.querySelector('.human-review-notes');
    const wordCountEl = card.querySelector('.human-review-word-count');
    const criteriaGradingEl = card.querySelector('.criteria-grading[data-hunt-id="' + result.hunt_id + '"]');
    
    function updateReviewSubmitButtonState() {
        const notes = notesTextarea ? (notesTextarea.value || '').trim() : '';
        const words = countWords(notes);
        if (wordCountEl) {
            wordCountEl.textContent = getWordCountLabel(words);
            wordCountEl.style.color = words >= MIN_EXPLANATION_WORDS ? 'var(--success)' : 'var(--text-muted)';
        }
        const rows = criteriaGradingEl ? criteriaGradingEl.querySelectorAll('.criterion-row') : [];
        const allGraded = rows.length > 0 && Array.from(rows).every(row => row.dataset.grade);
        const canSubmit = allGraded && words >= MIN_EXPLANATION_WORDS;
        if (submitBtn && !submitBtn.textContent.includes('Submitted')) {
            submitBtn.disabled = !canSubmit;
            submitBtn.style.opacity = canSubmit ? '1' : '0.7';
        }
    }
    
    // Criterion pass/fail button handlers
    card.querySelectorAll('.criterion-pass').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const row = btn.closest('.criterion-row');
            row.querySelector('.criterion-pass').classList.add('active');
            row.querySelector('.criterion-pass').style.background = 'var(--success)';
            row.querySelector('.criterion-pass').style.color = 'white';
            row.querySelector('.criterion-fail').classList.remove('active');
            row.querySelector('.criterion-fail').style.background = 'transparent';
            row.querySelector('.criterion-fail').style.color = 'var(--danger)';
            row.dataset.grade = 'pass';
            updateReviewSubmitButtonState();
        });
    });
    
    card.querySelectorAll('.criterion-fail').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const row = btn.closest('.criterion-row');
            row.querySelector('.criterion-fail').classList.add('active');
            row.querySelector('.criterion-fail').style.background = 'var(--danger)';
            row.querySelector('.criterion-fail').style.color = 'white';
            row.querySelector('.criterion-pass').classList.remove('active');
            row.querySelector('.criterion-pass').style.background = 'transparent';
            row.querySelector('.criterion-pass').style.color = 'var(--success)';
            row.dataset.grade = 'fail';
            updateReviewSubmitButtonState();
        });
    });
    
    notesTextarea.addEventListener('input', () => {
        updateReviewSubmitButtonState();
        if (submitBtn && submitBtn.disabled && submitBtn.textContent.includes('Submitted')) {
            submitBtn.disabled = false;
            submitBtn.textContent = '✅ Submit Human Review';
            submitBtn.style.background = '';
            updateReviewSubmitButtonState();
        }
    });
    
    card.querySelector('.submit-human-review-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const rowNum = card.dataset.rowNumber !== null && card.dataset.rowNumber !== undefined
            ? Number(card.dataset.rowNumber)
            : null;
        submitHumanReview(result.hunt_id, card, slotNum, rowNum);
    });
    
    // Also re-enable on any criteria button click if already submitted
    // (Note: Criteria buttons already enable submit button in their handlers above)
    const criteriaRows = card.querySelectorAll('.criteria-rating-row');
    criteriaRows.forEach(row => {
        row.querySelectorAll('.criteria-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (submitBtn && submitBtn.disabled && submitBtn.textContent.includes('Submitted')) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '✅ Submit Human Review';
                    submitBtn.style.background = '';
                } else if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.style.opacity = '1';
                }
            });
        });
    });
    
    // Per-card reveal button removed - using main Reveal button at top
    
    return card;
}

export function handleHumanReview(huntId, judgment, card, slotNum) {
    const notes = card.querySelector(`.human-review-notes[data-hunt-id="${huntId}"]`).value;
    const statusEl = card.querySelector(`.human-review-status[data-hunt-id="${huntId}"]`);
    
    // Store human review in state with slot info
    if (!state.humanReviews) state.humanReviews = {};
    state.humanReviews[huntId] = {
        judgment: judgment,
        notes: notes,
        slotNum: slotNum,
        timestamp: new Date().toISOString()
    };
    
    // Update UI
    const passBtn = card.querySelector('.human-pass-btn');
    const failBtn = card.querySelector('.human-fail-btn');
    
    passBtn.classList.remove('active');
    failBtn.classList.remove('active');
    
    if (judgment === 'pass') {
        passBtn.classList.add('active');
        statusEl.innerHTML = '✅ Marked as <strong>PASS</strong>';
        statusEl.style.color = 'var(--success)';
    } else {
        failBtn.classList.add('active');
        statusEl.innerHTML = '❌ Marked as <strong>FAIL</strong>';
        statusEl.style.color = 'var(--danger)';
    }
    
    // Enable reveal button - Use scoped selector first for robustness
    let revealBtn = card.querySelector('.reveal-llm-btn');
    if (!revealBtn) {
        // Fallback to data attribute selector
        revealBtn = card.querySelector(`.reveal-llm-btn[data-hunt-id="${huntId}"]`);
    }
    
    if (revealBtn) {
        revealBtn.disabled = false;
        revealBtn.style.opacity = '1';
        revealBtn.textContent = '👁️ Reveal LLM Judge';
    } else {
        console.error('Could not find reveal button for hunt', huntId);
    }
    
    showToast(`Slot ${slotNum} marked as ${judgment.toUpperCase()}. Click to reveal LLM Judge.`, 'success');
    
    // Check if all 4 reviews are done
    checkAllReviewsComplete();
}

// New criteria-based human review submission
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
    
    // Calculate pass/fail using session pass_threshold (0.5 = 50% rule, 1.0 = all must pass)
    const passThreshold = state.config?.pass_threshold ?? 0.5;
    const totalCriteria = Object.keys(grading).length;
    const passCount = Object.values(grading).filter(v => v.toUpperCase() === 'PASS').length;
    const passRate = totalCriteria > 0 ? passCount / totalCriteria : 0;
    const overallJudgment = (passRate >= 1.0) || (passThreshold < 1.0 && passRate > passThreshold) ? 'pass' : 'fail';
    
    // Store human review in state with slot info and criteria
    // Use row number as key to ensure uniqueness across runs
    if (!state.humanReviews) state.humanReviews = {};
    state.humanReviews[reviewKey] = {
        hunt_id: huntId,  // Keep hunt_id for backend compatibility
        row_number: rowNumber,  // Store row number for reference
        judgment: overallJudgment,
        grading_basis: grading,  // {C1: 'pass', C2: 'fail', ...}
        explanation: notes,
        slotNum: slotNum,
        timestamp: new Date().toISOString()
    };
    
    // Update UI
    const submitBtn = card.querySelector('.submit-human-review-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = overallJudgment === 'pass' ? '✅ Submitted: PASS' : '❌ Submitted: FAIL';
    submitBtn.style.background = overallJudgment === 'pass' ? 'var(--success)' : 'var(--danger)';
    
    // Show detailed status (v is already uppercase 'PASS' or 'FAIL' from line 2264)
    const gradingDisplay = Object.entries(grading).map(([k, v]) => 
        `${k}: ${v.toUpperCase() === 'PASS' ? '✅' : '❌'}`
    ).join(' | ');
    statusEl.innerHTML = `<strong>${overallJudgment.toUpperCase()}</strong> - ${gradingDisplay}`;
    statusEl.style.color = overallJudgment === 'pass' ? 'var(--success)' : 'var(--danger)';
    
    showToast(`Slot ${slotNum} submitted as ${overallJudgment.toUpperCase()}`, 'success');
    
    // Update the progress display (NEW)
    updateReviewProgress();
    
    // AUTO-SAVE: Immediately save review to backend to prevent data loss
    try {
        // Convert to backend format (hunt_id as key)
        const reviewForBackend = {
            [huntId]: {
                judgment: overallJudgment,
                grading_basis: grading,
                explanation: notes,
                slotNum: slotNum,
                timestamp: new Date().toISOString()
            }
        };
        
        const saveResponse = await fetch(`/api/save-reviews/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviews: reviewForBackend, auto_save: true })
        });
        
        if (!saveResponse.ok) {
            console.warn(`Failed to auto-save review for hunt ${huntId}:`, await saveResponse.text());
        } else {
        }
    } catch (error) {
        console.warn(`Error auto-saving review for hunt ${huntId}:`, error);
        // Don't show error to user - it's auto-save, will be saved again on final save
    }
    
    // Check if all 4 reviews are done
    checkAllReviewsComplete();
}

export function revealLLMJudge(huntId, card) {
    const llmSection = card.querySelector(`.llm-judge-section[data-hunt-id="${huntId}"]`);
    const revealSection = card.querySelector(`.reveal-section[data-hunt-id="${huntId}"]`);
    
    if (llmSection) {
        llmSection.style.display = 'block';
        // Auto-scroll to the revealed section
        setTimeout(() => {
            llmSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
    }
    if (revealSection) {
        revealSection.style.display = 'none';
    }
}

export function checkAllReviewsComplete() {
    // Check reviews for the SELECTED row numbers, not just any reviews
    const selectedRowNumbers = state.selectedRowNumbers || [];
    if (selectedRowNumbers.length === 0) {
        return; // No hunts selected yet
    }
    
    // Check if all selected hunts have reviews (using row number keys)
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const completedReviews = reviewKeys.filter(key => state.humanReviews && state.humanReviews[key]);
    const reviewCount = completedReviews.length;
    const totalSlots = selectedRowNumbers.length;
    
    if (reviewCount >= totalSlots && totalSlots >= 1) {
        showToast(`All ${totalSlots} review(s) complete! Ready to export.`, 'success');
        if (elements.revealLLMBtn) {
            elements.revealLLMBtn.disabled = false;
            elements.revealLLMBtn.style.opacity = '1';
            elements.revealLLMBtn.classList.add('pulse');
        }
        updateReviewProgress();
        import('./reviewSync.js').then(({ refreshReviewSync }) => {
            refreshReviewSync(state.sessionId);
        }).catch(() => {});
    } else if (totalSlots >= 1 && reviewCount < totalSlots) {
        if (state.adminMode) {
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


// ============== Slideout Resize Functionality ==============

export function initSlideoutResize() {
    // Response slideout resize
    const responseSlideout = document.getElementById('responseSlideout');
    const responseResizeHandle = document.getElementById('responseSlideoutResizeHandle');
    if (responseSlideout && responseResizeHandle) {
        setupSlideoutResize(responseSlideout, responseResizeHandle, 300, window.innerWidth * 0.95);
    }
    
    // Grading slideout resize
    const gradingSlideout = document.getElementById('gradingSlideout');
    const gradingResizeHandle = document.getElementById('gradingSlideoutResizeHandle');
    if (gradingSlideout && gradingResizeHandle) {
        setupSlideoutResize(gradingSlideout, gradingResizeHandle, 400, window.innerWidth * 0.95);
    }

    // Grading keyboard shortcuts: P = Pass, F = Fail (single listener)
    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('gradingSlideout')?.classList.contains('open')) return;
        if (document.activeElement?.closest('textarea, input')) return;
        const key = (e.key || '').toLowerCase();
        if (key !== 'p' && key !== 'f') return;
        const slot = state.currentGradingSlot;
        if (!slot || state.llmRevealed) return;
        const { huntId } = slot;
        const container = document.getElementById('gradingSlideoutBody');
        if (!container) return;
        const row = document.activeElement?.closest('.grading-criterion');
        if (!row) return;
        const criterionId = row.dataset.criterionId;
        const passBtn = row.querySelector('.grading-btn-pass');
        const failBtn = row.querySelector('.grading-btn-fail');
        if (!criterionId || !passBtn || !failBtn) return;
        e.preventDefault();
        if (key === 'p') {
            passBtn.classList.add('active');
            failBtn.classList.remove('active');
            if (!state.humanReviews[huntId]) state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            state.humanReviews[huntId].grades[criterionId] = 1;
        } else {
            failBtn.classList.add('active');
            passBtn.classList.remove('active');
            if (!state.humanReviews[huntId]) state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            state.humanReviews[huntId].grades[criterionId] = 0;
        }
        updateGradingProgressHeader(huntId);
        const notesTextarea = container.querySelector('.grading-notes-textarea');
        const wordCountEl = container.querySelector('.grading-word-count');
        const submitBtn = container.querySelector('.grading-submit-btn');
        const criteriaIds = (state.criteria || []).map(c => c.id);
        const grades = (state.humanReviews[huntId] || {}).grades || {};
        const words = countWords(notesTextarea?.value || '');
        const allGraded = criteriaIds.every(id => grades[id] !== undefined);
        const canSubmit = allGraded && words >= MIN_EXPLANATION_WORDS;
        if (wordCountEl) {
            wordCountEl.textContent = getWordCountLabel(words);
            wordCountEl.style.color = words >= MIN_EXPLANATION_WORDS ? 'var(--success)' : 'var(--text-muted)';
        }
        if (submitBtn) {
            submitBtn.disabled = !canSubmit;
            submitBtn.style.opacity = canSubmit ? '1' : '0.7';
        }
        const next = Array.from(container.querySelectorAll('.grading-criterion')).find(r => grades[r.dataset.criterionId] === undefined);
        if (next) next.focus();
    });
}

function setupSlideoutResize(slideout, resizeHandle, minWidth, maxWidth) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    // Mouse events
    resizeHandle.addEventListener('mousedown', startResize);
    
    // Touch events for mobile
    resizeHandle.addEventListener('touchstart', startResize, { passive: false });
    
    function startResize(e) {
        e.preventDefault();
        isResizing = true;
        
        // Get starting position (handle both mouse and touch)
        startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
        startWidth = slideout.offsetWidth;
        
        // Add resizing class to disable transitions
        slideout.classList.add('resizing');
        resizeHandle.classList.add('active');
        
        // Prevent text selection during resize
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'ew-resize';
        
        // Add move and end listeners
        document.addEventListener('mousemove', doResize);
        document.addEventListener('mouseup', stopResize);
        document.addEventListener('touchmove', doResize, { passive: false });
        document.addEventListener('touchend', stopResize);
    }
    
    function doResize(e) {
        if (!isResizing) return;
        e.preventDefault();
        
        // Get current position (handle both mouse and touch)
        const currentX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
        
        // Calculate new width (dragging left increases width since panel is on the right)
        const deltaX = startX - currentX;
        let newWidth = startWidth + deltaX;
        
        // Clamp to min/max
        newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
        
        // Apply new width
        slideout.style.width = `${newWidth}px`;
    }
    
    function stopResize() {
        if (!isResizing) return;
        isResizing = false;
        
        // Remove resizing class
        slideout.classList.remove('resizing');
        resizeHandle.classList.remove('active');
        
        // Restore body styles
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        
        // Remove listeners
        document.removeEventListener('mousemove', doResize);
        document.removeEventListener('mouseup', stopResize);
        document.removeEventListener('touchmove', doResize);
        document.removeEventListener('touchend', stopResize);
        
        // Save the width to localStorage for persistence
        const slideoutId = slideout.id;
        if (slideoutId) {
            localStorage.setItem(`${slideoutId}Width`, slideout.style.width);
        }
    }
    
    // Restore saved width on page load
    const savedWidth = localStorage.getItem(`${slideout.id}Width`);
    if (savedWidth) {
        slideout.style.width = savedWidth;
    }
}
