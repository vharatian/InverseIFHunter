/**
 * results/selectionSection.js — Selection section card collapse + review-mode button lock.
 */

import { state } from '../state.js';
import { elements } from '../dom.js';
import { adminBypass, getConfigValue } from '../config.js';

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
    applySelectionSectionCollapse();
}

/**
 * When selection is confirmed and reviews are in progress (or completed), disable all action buttons
 * except view buttons (Expand/Collapse, etc.). Bypassed in admin mode.
 */
export function setReviewModeButtonsDisabled(disabled) {
    if (disabled && ((state.adminMode && adminBypass('post_confirmation_lock')) || getConfigValue('bypass_hunt_criteria', false))) return;
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
