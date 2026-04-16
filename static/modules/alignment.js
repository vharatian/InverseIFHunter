/**
 * Criterion alignment — single module for trainer-facing behavior.
 *
 * Sections:
 *   1. Pure comparison math (no `state` / DOM)
 *   2. Gate, re-review, banner, persistence (uses `state` + `elements`)
 *
 * Server mirror + export helper: `services/alignment.py`
 * Regression tests: `tests/unit/test_alignment.py`
 */
import { state } from './state.js';
import { elements } from './dom.js';
import { getAlignmentConfig, adminBypass } from './config.js';

// =============================================================================
// 1. Pure comparison (PASS/FAIL only; MISSING / unknown excluded)
// =============================================================================

export function normalizeCriterionGrade(val) {
    if (val === undefined || val === null) return null;
    const s = String(val).trim().toUpperCase();
    if (s === 'PASS') return 'PASS';
    if (s === 'FAIL') return 'FAIL';
    return null;
}

/**
 * @param {Array<{ humanBasis: Record<string,string>, llmCriteria: Record<string,string> }>} slots
 */
export function computeAlignment(slots) {
    const perSlot = {};
    let totalAgreed = 0;
    let totalCompared = 0;

    slots.forEach((slot, i) => {
        const hb = slot.humanBasis && typeof slot.humanBasis === 'object' ? slot.humanBasis : {};
        const lc = slot.llmCriteria && typeof slot.llmCriteria === 'object' ? slot.llmCriteria : {};
        const keys = new Set([...Object.keys(hb), ...Object.keys(lc)]);
        let agreed = 0;
        let total = 0;
        keys.forEach((k) => {
            const hg = normalizeCriterionGrade(hb[k]);
            const lg = normalizeCriterionGrade(lc[k]);
            if (hg === null || lg === null) return;
            total += 1;
            if (hg === lg) agreed += 1;
        });
        totalAgreed += agreed;
        totalCompared += total;
        const key = `slot_${i + 1}`;
        perSlot[key] = total > 0 ? agreed / total : 1.0;
    });

    const overallRate = totalCompared > 0 ? totalAgreed / totalCompared : 1.0;

    let worstSlotIndex = 1;
    let worstRate = null;
    slots.forEach((slot, i) => {
        const hb = slot.humanBasis && typeof slot.humanBasis === 'object' ? slot.humanBasis : {};
        const lc = slot.llmCriteria && typeof slot.llmCriteria === 'object' ? slot.llmCriteria : {};
        const keys = new Set([...Object.keys(hb), ...Object.keys(lc)]);
        let total = 0;
        keys.forEach((k) => {
            const hg = normalizeCriterionGrade(hb[k]);
            const lg = normalizeCriterionGrade(lc[k]);
            if (hg !== null && lg !== null) total += 1;
        });
        if (total === 0) return;
        const slotNum = i + 1;
        const rate = perSlot[`slot_${slotNum}`];
        if (
            worstRate === null ||
            rate < worstRate - 1e-15 ||
            (Math.abs(rate - worstRate) < 1e-15 && slotNum < worstSlotIndex)
        ) {
            worstRate = rate;
            worstSlotIndex = slotNum;
        }
    });

    return {
        overall_rate: overallRate,
        per_slot: perSlot,
        total_agreed: totalAgreed,
        total_criteria_compared: totalCompared,
        worst_slot_index: worstSlotIndex,
    };
}

/**
 * @param {number[]} selectedRowNumbers
 * @param {object[]} allResponses
 * @param {object} humanReviews
 */
export function buildAlignmentSlotsFromState(selectedRowNumbers, allResponses, humanReviews) {
    const slots = [];
    (selectedRowNumbers || []).forEach((rowNum) => {
        const result = allResponses[rowNum];
        const rowKey = `row_${rowNum}`;
        const review = humanReviews[rowKey] || {};
        const gb = review.grading_basis && typeof review.grading_basis === 'object' ? { ...review.grading_basis } : {};
        const llm =
            result && result.judge_criteria && typeof result.judge_criteria === 'object'
                ? { ...result.judge_criteria }
                : {};
        slots.push({ humanBasis: gb, llmCriteria: llm });
    });
    return slots;
}

// =============================================================================
// 2. Gate, UI, persistence (depends on trainer session state)
// =============================================================================

/** Stable row index for comparisons (dataset / JSON often use strings). */
export function normalizeReviewRowNumber(row) {
    if (row === undefined || row === null || row === '') return null;
    const n = Number(row);
    return Number.isNaN(n) ? null : n;
}

export function alignmentRowsEqual(a, b) {
    const na = normalizeReviewRowNumber(a);
    const nb = normalizeReviewRowNumber(b);
    return na !== null && nb !== null && na === nb;
}

export function alignmentGateActive() {
    const { enabled } = getAlignmentConfig();
    if (!enabled) return false;
    if (state.adminMode && adminBypass('alignment_check')) return false;
    return true;
}

export function resetAlignmentGateState() {
    state.alignmentPhase = 'idle';
    state.alignmentReReviewRounds = 0;
    state.alignmentFlaggedRowNumber = null;
    state.alignmentLastSnapshot = null;
}

function _alignmentThreshold() {
    return getAlignmentConfig().targetRate;
}

/** Clear per-slot alignment label (classes + text). */
function _clearAlignmentPctDisplay(el) {
    if (!el) return;
    el.textContent = '';
    el.classList.remove('alignment-pct-ok', 'alignment-pct-below');
}

/**
 * @param {HTMLElement} el
 * @param {number} rate 0..1
 * @param {number} thr target rate 0..1 (same as gate)
 */
function _setAlignmentPctDisplay(el, rate, thr) {
    if (!el) return;
    const pct = Math.round((rate ?? 0) * 1000) / 10;
    el.textContent = `${pct}% aligned`;
    el.classList.remove('alignment-pct-ok', 'alignment-pct-below');
    const meets = (rate ?? 0) + 1e-12 >= thr;
    el.classList.add(meets ? 'alignment-pct-ok' : 'alignment-pct-below');
}

function _buildSnapshot(comp, thr, rounds) {
    return {
        overall_rate: comp.overall_rate,
        per_slot: { ...comp.per_slot },
        re_review_rounds: rounds,
        threshold: thr,
        total_criteria_compared: comp.total_criteria_compared,
        total_agreed: comp.total_agreed,
    };
}

export function runAlignmentComputation() {
    return computeAlignment(
        buildAlignmentSlotsFromState(state.selectedRowNumbers, state.allResponses, state.humanReviews)
    );
}

/**
 * Row numbers (table indices) for slots strictly below alignment target.
 * Used for banner copy only (slots are never locked client-side).
 * @returns {Set<number>}
 */
function _reReviewEditableRowNumberSet() {
    const comp = runAlignmentComputation();
    const thr = _alignmentThreshold();
    const selected = state.selectedRowNumbers || [];
    const set = new Set();
    selected.forEach((rowRaw, i) => {
        const rate = comp.per_slot[`slot_${i + 1}`];
        if ((rate ?? 0) + 1e-12 < thr) {
            const n = normalizeReviewRowNumber(rowRaw);
            if (n !== null) set.add(n);
        }
    });
    return set;
}

/** 1-based slot indices (1..N) below alignment target, in order. */
function _slotNumbersBelowTarget() {
    const set = _reReviewEditableRowNumberSet();
    const selected = state.selectedRowNumbers || [];
    const out = [];
    selected.forEach((rowRaw, i) => {
        const n = normalizeReviewRowNumber(rowRaw);
        if (n !== null && set.has(n)) out.push(i + 1);
    });
    return out;
}

/** @param {number[]} slotNums 1-based */
function _formatSlotsLabelForBanner(slotNums) {
    if (slotNums.length === 0) return 'Some slots';
    if (slotNums.length === 1) return `Slot ${slotNums[0]}`;
    if (slotNums.length === 2) return `Slots ${slotNums[0]} and ${slotNums[1]}`;
    const last = slotNums[slotNums.length - 1];
    return `Slots ${slotNums.slice(0, -1).join(', ')}, and ${last}`;
}

/**
 * Trainer clicked "Refresh alignment". Recomputes phase + snapshot (not called automatically).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function recalculateAlignmentGateFromTrainer() {
    if (!alignmentGateActive() || state.llmRevealed) return { ok: false, reason: 'inactive' };
    const selected = state.selectedRowNumbers || [];
    const keys = selected.map((rn) => `row_${rn}`);
    if (!keys.length || !keys.every((k) => state.humanReviews[k])) {
        return { ok: false, reason: 'incomplete' };
    }

    state.alignmentReReviewRounds += 1;
    const comp = runAlignmentComputation();
    const thr = _alignmentThreshold();
    if (comp.total_criteria_compared === 0) {
        state.alignmentPhase = 'passed';
        state.alignmentLastSnapshot = _buildSnapshot(comp, thr, state.alignmentReReviewRounds);
    } else if (comp.overall_rate + 1e-12 >= thr) {
        state.alignmentPhase = 'passed';
        state.alignmentLastSnapshot = _buildSnapshot(comp, thr, state.alignmentReReviewRounds);
    } else {
        state.alignmentPhase = 're_review';
        state.alignmentLastSnapshot = _buildSnapshot(comp, thr, state.alignmentReReviewRounds);
    }
    state.alignmentFlaggedRowNumber = null;
    return { ok: true };
}

export function revealAllowedByAlignment() {
    if (!alignmentGateActive()) return true;
    const selected = state.selectedRowNumbers || [];
    const keys = selected.map((rn) => `row_${rn}`);
    const allDone = keys.length > 0 && keys.every((k) => state.humanReviews[k]);
    if (!allDone) return true;
    return state.alignmentPhase === 'passed';
}

export function updateAlignmentBanner() {
    let el = document.getElementById('alignmentGateBanner');
    if (!alignmentGateActive() || state.llmRevealed) {
        if (el) el.remove();
        return;
    }
    const parent = elements.breakingResults?.parentElement;
    if (!parent || !elements.breakingResults) return;

    if (!el) {
        el = document.createElement('div');
        el.id = 'alignmentGateBanner';
        el.setAttribute('role', 'status');
        el.style.cssText =
            'margin-bottom:1rem;padding:0.9rem 1rem;border-radius:8px;border:1px solid var(--border);font-size:0.95rem;line-height:1.45;';
        parent.insertBefore(el, elements.breakingResults);
    }
    el.style.display = '';

    if (state.alignmentPhase === 'passed') {
        el.style.background = 'var(--bg-tertiary)';
        el.style.borderColor = 'var(--success)';
        el.textContent = 'Alignment check passed. You can show AI evaluation when ready.';
    } else if (state.alignmentPhase === 're_review') {
        const slotsBelow = _slotNumbersBelowTarget();
        const label = _formatSlotsLabelForBanner(slotsBelow);
        const plural = slotsBelow.length !== 1;
        el.style.background = 'var(--bg-tertiary)';
        el.style.borderColor = 'var(--warning)';
        el.textContent = `${label} ${plural ? 'are' : 'is'} below the alignment target vs the judge. Edit any reviews you need, then click Refresh alignment to verify again.`;
    } else {
        el.style.display = 'none';
    }
}

export async function persistTrainerUi() {
    if (!state.sessionId) return;
    const trainer_ui = {
        llm_revealed: !!state.llmRevealed,
        alignment_phase: state.alignmentPhase,
        alignment_re_review_rounds: state.alignmentReReviewRounds,
        alignment_flagged_row: null,
        alignment_last_snapshot: state.alignmentLastSnapshot,
    };
    try {
        await fetch(`api/save-reviews/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviews: {}, trainer_ui, auto_save: true }),
        });
    } catch (_) {
        /* non-fatal */
    }
}

export function applyTrainerUiAfterHydrate(trainerUi) {
    if (!trainerUi || typeof trainerUi !== 'object') return;
    if (typeof trainerUi.llm_revealed === 'boolean') state.llmRevealed = trainerUi.llm_revealed;
    if (trainerUi.alignment_phase) state.alignmentPhase = trainerUi.alignment_phase;
    if (typeof trainerUi.alignment_re_review_rounds === 'number') {
        state.alignmentReReviewRounds = trainerUi.alignment_re_review_rounds;
    }
    // Legacy alignment_flagged_row (single slot) is ignored — editability uses below-target set.
    state.alignmentFlaggedRowNumber = null;
    if (trainerUi.alignment_last_snapshot && typeof trainerUi.alignment_last_snapshot === 'object') {
        state.alignmentLastSnapshot = trainerUi.alignment_last_snapshot;
    }
    if (Array.isArray(trainerUi.selected_row_numbers)) {
        state.selectedRowNumbers = trainerUi.selected_row_numbers.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
    }
    if (typeof trainerUi.selection_confirmed === 'boolean') {
        state.selectionConfirmed = trainerUi.selection_confirmed;
    }
}

/**
 * Per-slot and overall alignment % (when gate on and all selected reviews exist).
 * Clears legacy post-reveal summary node if present.
 */
export function syncAlignmentSlotDisplays() {
    const overallEl = document.getElementById('alignmentOverallRow');
    const container = elements.breakingResults;
    document.getElementById('alignmentPostRevealSummary')?.remove();

    if (!container) return;

    if (!alignmentGateActive() || state.llmRevealed) {
        container.querySelectorAll('.slot-alignment-pct').forEach(_clearAlignmentPctDisplay);
        if (overallEl) {
            overallEl.classList.add('hidden');
            overallEl.textContent = '';
        }
        return;
    }

    const selected = state.selectedRowNumbers || [];
    const reviewKeys = selected.map((rn) => `row_${rn}`);
    const allComplete = selected.length > 0 && reviewKeys.every((k) => state.humanReviews[k]);

    if (!allComplete) {
        container.querySelectorAll('.slot-alignment-pct').forEach(_clearAlignmentPctDisplay);
        if (overallEl) {
            overallEl.classList.add('hidden');
            overallEl.textContent = '';
        }
        return;
    }

    const comp = runAlignmentComputation();
    const thr = _alignmentThreshold();
    const cards = container.querySelectorAll('.slot-compact-card');

    cards.forEach((card, i) => {
        const el = card.querySelector('.slot-alignment-pct');
        if (!el) return;
        const slotKey = `slot_${i + 1}`;
        const rate = comp.per_slot[slotKey];
        _setAlignmentPctDisplay(el, rate, thr);
    });

    if (overallEl) {
        overallEl.classList.remove('hidden');
        const overallPct = Math.round(comp.overall_rate * 1000) / 10;
        const targetPct = Math.round(thr * 1000) / 10;
        const overallMeets = comp.overall_rate + 1e-12 >= thr;
        const pctClass = overallMeets ? 'alignment-pct-ok' : 'alignment-pct-below';
        overallEl.innerHTML =
            `<strong>Overall alignment:</strong> ` +
            `<span class="alignment-overall-pct ${pctClass}">${overallPct}%</span> ` +
            `<span class="alignment-target-hint">· target ${targetPct}%</span>`;
    }
}
