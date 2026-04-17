/**
 * results/clearAndFormat.js — Results reset + judge-explanation/criteria formatting helpers.
 */

import { elements } from '../dom.js';
import { state } from '../state.js';
import { escapeHtml } from '../utils.js';
import { hideModelLockedIndicator, clearModelMismatchWarning } from '../editors.js';
import { resetAlignmentGateState } from '../alignment.js';

export function clearPreviousResults() {
    state.results = [];
    state.diversityCheckPassed = false;
    state.isHunting = false;
    state.humanReviews = {};
    state.allResponses = [];
    state.selectedRowNumbers = [];
    state.selectionConfirmed = false;
    state.llmRevealed = false;
    resetAlignmentGateState();
    state.currentRunStartOffset = 0;
    state.originalNotebookJson = null;
    state.blindJudging = {
        queue: [],
        currentResult: null,
        humanJudgments: {}
    };
    state.huntResponseData = {};

    state.currentTurn = 1;
    state.isMultiTurn = false;
    state.turns = [];
    state.conversationHistory = [];
    state.multiTurnTotalHunts = 0;
    state.previousTurnHuntIds = new Set();
    state.huntsThisTurn = 0;
    document.getElementById('multiTurnSection')?.classList.add('hidden');
    document.getElementById('multiTurnDecisionCard')?.classList.add('hidden');
    document.getElementById('multiTurnDecisionPanel')?.classList.add('hidden');
    document.getElementById('turnJourneyBar')?.classList.remove('visible');
    document.getElementById('mainContainer')?.classList.remove('multi-turn-layout');

    state.referenceValidated = false;
    state.criteria = null;
    state.initialCriteria = null;
    state.metadata = null;
    state.metadataModel = null;
    state.unsavedChanges = {
        prompt: false,
        response: false,
        modelRef: false,
        judge: false
    };
    clearModelMismatchWarning();

    hideModelLockedIndicator();

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

    elements.progressSection?.classList.add('hidden');
    elements.resultsSection?.classList.add('hidden');
    elements.summarySection?.classList.add('hidden');
    elements.selectionSection?.classList.add('hidden');

    if (elements.huntTableBody) elements.huntTableBody.innerHTML = '';
    if (elements.breakingResults) elements.breakingResults.innerHTML = '';

    if (elements.progressFill)    elements.progressFill.style.width = '0%';
    if (elements.progressText)    elements.progressText.textContent = '0 / 0 hunts complete';
    if (elements.progressPercent) elements.progressPercent.textContent = '0%';

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

    const explanationText = fullExplanation || '';
    const criteriaExplanations = {};

    for (const [key] of Object.entries(criteria)) {
        const patterns = [
            new RegExp(`(?:Failed|Passing)\\s+Criteria\\s+Details?:\\s*${key}[:\\-]?\\s*(.+?)(?=\\s*C\\d|$)`, 'gi'),
            new RegExp(`${key}[:\\-]\\s+(.+?)(?=\\s*C\\d|$)`, 'gi'),
            new RegExp(`${key}\\s+(?:PASS|FAIL)[:\\-]?\\s*(.+?)(?=\\s*C\\d|$)`, 'gi'),
            new RegExp(`\\*\\*${key}\\*\\*[:\\-]?\\s*(.+?)(?=\\*\\*C\\d|$)`, 'gi'),
            new RegExp(`^\\s*${key}[.:\\-]?\\s*(.+)`, 'gim')
        ];

        for (const pattern of patterns) {
            const match = pattern.exec(explanationText);
            if (match && match[1]) {
                let explanation = match[1].trim();
                explanation = explanation.replace(/^[•\-\*]\s*/, '');
                explanation = explanation.replace(/\s+/g, ' ').trim();
                if (explanation && explanation.length > 5) {
                    criteriaExplanations[key] = explanation;
                    break;
                }
            }
        }

        if (!criteriaExplanations[key]) {
            const explanationLines = explanationText.split('\n');
            for (const line of explanationLines) {
                if (line.toUpperCase().includes(key.toUpperCase()) && line.length > key.length + 10) {
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

    const criteriaHtml = Object.entries(criteria).map(([key, value]) => {
        const isPassing = String(value).toUpperCase() === 'PASS';
        const statusText = isPassing ? 'PASS' : 'FAIL';
        const statusColor = isPassing ? 'var(--success)' : 'var(--danger)';
        const explanation = criteriaExplanations[key] || '';

        const criteriaDesc = (state.criteria || []).find(c => c.id === key);
        const criteriaText = criteriaDesc ? criteriaDesc.criteria : '';

        return `
            <div style="display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.5rem; padding: 0.5rem; margin-bottom: 0.5rem; background: var(--bg-primary); border-radius: 6px; border-left: 3px solid ${statusColor};">
                <span style="font-weight: 600; min-width: 35px;">${key}:</span>
                <span style="color: ${statusColor}; font-weight: 600;">${statusText}</span>
                ${criteriaText ? `<span style="flex: 1; font-size: 0.85rem; color: var(--text-secondary); word-break: break-word;">(${escapeHtml(criteriaText)})</span>` : ''}
                ${explanation ? `<div style="width: 100%; margin-top: 0.25rem; padding-left: 40px; font-size: 0.85rem; color: var(--text-muted);">${escapeHtml(explanation)}</div>` : ''}
            </div>
        `;
    }).join('');

    return criteriaHtml;
}

/** Collapse "[FAIL] C4 (FAIL)" → "[FAIL] C4" (LLM output repeats status after the id). */
function compactJudgeCriterionBadge(badge) {
    if (typeof badge !== 'string') return badge;
    return badge.replace(
        /^(\[(?:PASS|FAIL|MISSING)\]\s*C\d+)\s*\((?:PASS|FAIL|MISSING)\)/i,
        '$1'
    );
}

/**
 * Render an "Independent Judging Results" explanation string as structured HTML.
 */
export function renderJudgeExplanation(explanationText) {
    if (!explanationText) return `<span style="color: var(--text-muted); font-style: italic;">No explanation available</span>`;

    const lines = explanationText.split('\n');
    let headerHtml = '';
    let summaryHtml = '';
    let criteriaHtml = '';
    let otherHtml = '';

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('Independent Judging Results')) {
            headerHtml = `<div style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary); margin-bottom: 0.35rem; padding-bottom: 0.35rem; border-bottom: 1px solid var(--border-color, #e5e7eb);">${escapeHtml(line)}</div>`;
        } else if (line.startsWith('- Passing Criteria:') || line.startsWith('Passing Criteria:')) {
            summaryHtml = `<div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.6rem;">${escapeHtml(line)}</div>`;
        } else if (line.startsWith('[MISSING]') || line.toLowerCase().startsWith('missing criteria')) {
            otherHtml += `<div style="font-size: 0.82rem; color: var(--warning, #f59e0b); margin-top: 0.4rem;">${escapeHtml(line)}</div>`;
        } else if (line.startsWith('[PASS]') || line.startsWith('[FAIL]') || line.startsWith('[MISSING]')) {
            const isPassing = line.startsWith('[PASS]');
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
            badge = compactJudgeCriterionBadge(badge);
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
 */
export function formatJudgeCriteriaDisplay(criteria) {
    const allCriteriaIds = new Set(Object.keys(criteria || {}));
    const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));

    for (const initialId of initialCriteriaIds) {
        if (!(initialId in criteria)) {
            criteria[initialId] = 'MISSING';
        }
    }

    const entries = Object.entries(criteria).sort(([a], [b]) => {
        const aNum = parseInt(a.match(/C(\d+)/)?.[1] || '0');
        const bNum = parseInt(b.match(/C(\d+)/)?.[1] || '0');
        return aNum - bNum;
    });

    if (entries.length === 0) {
        return '<div style="padding: 0.5rem; color: var(--text-muted); font-style: italic;">No criteria breakdown available</div>';
    }

    const criteriaHtml = entries.map(([key, value]) => {
        const statusUpper = String(value).toUpperCase();
        const isPassing = statusUpper === 'PASS';
        const isMissing = statusUpper === 'MISSING';

        let statusMarker, statusColor, bgColor;

        if (isMissing) {
            statusMarker = '[MISSING]';
            statusColor = 'var(--warning)';
            bgColor = 'var(--warning-bg)';
        } else if (isPassing) {
            statusMarker = '[PASS]';
            statusColor = 'var(--success)';
            bgColor = 'var(--bg-tertiary)';
        } else {
            statusMarker = '[FAIL]';
            statusColor = 'var(--danger)';
            bgColor = 'var(--bg-tertiary)';
        }

        let criteriaDesc = (state.criteria || []).find(c => c.id === key);
        if (!criteriaDesc) {
            criteriaDesc = (state.initialCriteria || []).find(c => c.id === key);
        }
        const criteriaText = criteriaDesc ? criteriaDesc.criteria : '';

        const warningMsg = isMissing ? '<span style="font-size: 0.8rem; color: var(--warning); font-style: italic;">(Not evaluated - does not count as failure)</span>' : '';

        return `
            <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; margin: 0.25rem 0; background: ${bgColor}; border-radius: 6px; border-left: 3px solid ${statusColor};">
                <span style="font-weight: 600; min-width: 35px;">${key}:</span>
                <span style="color: ${statusColor}; font-weight: 600;">${statusMarker}</span>
                ${criteriaText ? `<span style="flex: 1; font-size: 0.85rem; color: var(--text-secondary);">${escapeHtml(criteriaText)}</span>` : ''}
                ${warningMsg}
            </div>
        `;
    }).join('');

    return criteriaHtml;
}

/**
 * Convert HTML content from contentEditable to plain text while preserving line breaks.
 */
export function htmlToPlainText(element) {
    if (!element) return '';

    const clone = element.cloneNode(true);

    clone.querySelectorAll('br').forEach(br => { br.replaceWith('\n'); });

    clone.querySelectorAll('div, p').forEach(block => {
        const text = block.textContent || '';
        if (block.previousSibling) {
            block.replaceWith('\n' + text);
        } else {
            block.replaceWith(text);
        }
    });

    clone.querySelectorAll('li').forEach(li => {
        const text = li.textContent || '';
        li.replaceWith('\n• ' + text);
    });

    let text = clone.textContent || '';
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();

    return text;
}

/**
 * Warm up API connections in background for faster hunt execution.
 */
export async function warmupConnections() {
    try {
        const response = await fetch('api/warmup-connections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.ok) { /* ok */ }
    } catch (error) {
        // Silent fail - warm-up is optional optimization
    }
}
