/**
 * results/resultModel.js — Hunt result classification + mode-aware selection validation.
 */

import { state } from '../state.js';
import { adminBypass, getHuntModeById, getSelectionSlots } from '../config.js';

/** Check if a hunt result is breaking. */
export function isResultBreaking(result) {
    if (result.sample_label) return result.sample_label === 'BREAK';
    if (result.is_breaking === true) return true;
    const s = result.judge_score ?? result.score;
    return s !== null && s !== undefined && Number(s) === 0;
}

/** Check if a hunt result is passing. */
export function isResultPassing(result) {
    if (result.sample_label) return result.sample_label === 'PASS';
    if (result.is_breaking === true) return false;
    const s = result.judge_score ?? result.score;
    return s !== null && s !== undefined && Number(s) > 0;
}

/** Check if a hunt result has missing/error criteria (unreliable score). */
export function isResultError(result) {
    if (result.sample_label) return result.sample_label === 'ERROR';
    return false;
}

/** Count breaking, passing, and error results in an array. */
export function countBreakingPassing(results) {
    const breakingCount = results.filter(isResultBreaking).length;
    const passingCount = results.filter(isResultPassing).length;
    const errorCount = results.filter(isResultError).length;
    return { breakingCount, passingCount, errorCount };
}

/**
 * SINGLE display helper for hunt result status.
 * @returns {{ label: string, cssClass: string, wanted: boolean }}
 */
export function getStatusDisplay(result, passingMode = false) {
    if (isResultError(result)) {
        return { label: 'Missing Criteria', cssClass: 'warning', wanted: false };
    }
    const breaking = isResultBreaking(result);
    if (breaking) {
        return { label: 'Break', cssClass: 'break', wanted: !passingMode };
    }
    return { label: 'Pass', cssClass: 'pass', wanted: !!passingMode };
}

/**
 * Display helper for a single criterion status (PASS / FAIL / MISSING).
 */
export function getCriterionDisplay(status) {
    const s = (status || '').toUpperCase();
    if (s === 'PASS')    return { marker: 'PASS',    cssClass: 'pass',    color: 'var(--success, #22c55e)' };
    if (s === 'MISSING') return { marker: 'MISSING', cssClass: 'warning', color: 'var(--warning, #f59e0b)' };
    return                       { marker: 'FAIL',    cssClass: 'fail',    color: 'var(--danger, #ef4444)' };
}

/**
 * Validate a selection of hunts against the current hunt mode's rules.
 */
export function validateSelectionForMode(selectedResults, huntMode, isAdmin = false) {
    if (isAdmin && adminBypass('selection_mode_rules')) return { valid: true, message: 'Admin: any combination allowed' };

    const { breakingCount, passingCount } = countBreakingPassing(selectedResults);
    const total = selectedResults.length;
    const slots = getSelectionSlots();
    const mode = getHuntModeById(huntMode);
    const minBreaking = state.config?.min_breaking_required ?? 0;

    if (mode.type === 'passing') {
        if (breakingCount > 0) {
            return { valid: false, message: `Only passing (non-breaking) hunts can be selected in ${mode.name} mode.` };
        }
        if (total === 0) {
            return { valid: false, message: 'Select at least one passing hunt.' };
        }
        return { valid: true, message: `${passingCount} passing selected` };
    }

    if (mode.count_based) {
        const req = mode.required_breaking ?? 1;
        if (breakingCount > req) {
            return { valid: false, message: `Only ${req} breaking hunt(s) allowed in ${mode.name} mode.` };
        }
        if (breakingCount < req && total > 0) {
            return { valid: false, message: `You must include exactly ${req} breaking hunt(s) in ${mode.name} mode.` };
        }
        return { valid: true, message: `${breakingCount} breaking, ${passingCount} passing selected` };
    }

    if (isAdmin && adminBypass('selection_count')) {
        if (breakingCount >= minBreaking) return { valid: true, message: `Admin: ${breakingCount} breaking, ${passingCount} passing` };
    }
    if (total !== slots) {
        return { valid: total < slots, message: `Select ${slots - total} more hunt(s). ${mode.name} requires exactly ${slots} total.` };
    }
    if (breakingCount < minBreaking) {
        return { valid: false, message: `Need at least ${minBreaking} breaking in ${mode.name} mode. Current: ${breakingCount} breaking, ${passingCount} passing.` };
    }
    return { valid: true, message: `Valid: ${breakingCount} breaking, ${passingCount} passing` };
}

/** Render selection instructions into #selectionInstructions based on active hunt mode. */
export function renderSelectionInstructions() {
    const container = document.getElementById('selectionInstructions');
    if (!container) return;

    const huntMode = state.config?.hunt_mode || 'break_50';
    const mode = getHuntModeById(huntMode);
    const slots = getSelectionSlots();
    const minBreaking = state.config?.min_breaking_required ?? 0;
    let instructionHtml = '';
    let validHtml = '';

    if (mode.type === 'passing') {
        instructionHtml = `Select only <strong>passing</strong> (non-breaking) hunts for review.`;
        validHtml = '<span class="valid-combo">Any number of passing hunts</span> — no breaking allowed.';
    } else if (mode.type === 'breaking' && !mode.count_based && minBreaking === 0) {
        instructionHtml = `Select exactly <strong>${slots} responses</strong> for human review (no minimum breaking — any mix of breaking and passing).`;
        validHtml = `Exactly <span class="valid-combo">${slots}</span> total — at least 0 breaking required.`;
    } else if (mode.count_based) {
        const req = mode.required_breaking ?? 1;
        instructionHtml = `Select the <strong>${req} breaking</strong> hunt(s) and any number of <strong>passing</strong> hunts.`;
        validHtml = `Must include exactly <span class="valid-combo">${req} breaking</span> hunt(s). Remaining can be passing.`;
    } else {
        const remaining = slots - minBreaking;
        instructionHtml = `Select exactly <strong>${slots} responses</strong> for human review (at least <strong>${minBreaking} breaking</strong>).`;
        validHtml = `<span class="valid-combo">${minBreaking}+ breaking</span>${remaining > 0 ? ` + up to <span class="valid-combo">${remaining} passing</span>` : ''}`;
    }

    const tipContainer = document.getElementById('selectionTipContainer');
    const tipHtml = tipContainer ? tipContainer.outerHTML : '<div id="selectionTipContainer"></div>';

    container.innerHTML = `
        <p><strong>Instructions:</strong> ${instructionHtml}</p>
        <p><strong>Valid:</strong> ${validHtml}</p>
        ${tipHtml}
    `;
}
