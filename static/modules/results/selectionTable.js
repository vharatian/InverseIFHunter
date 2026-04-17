/**
 * results/selectionTable.js — Selection grid table render + row toggling + selection-count status.
 */

import { elements } from '../dom.js';
import { state } from '../state.js';
import { escapeHtml, getModelDisplayName } from '../utils.js';
import { showToast } from '../celebrations.js?v=43';
import { adminBypass, getHuntModeById, getSelectionSlots } from '../config.js';
import {
    isResultBreaking,
    validateSelectionForMode,
    countBreakingPassing,
    renderSelectionInstructions,
} from './resultModel.js';
import { openSelectionDetailSlideout } from './responseSlideout.js';
import { displaySelectedForReview } from './selectionConfirmAndProgress.js';

export function displaySelectionCards() {
    const grid = elements.selectionGrid;
    grid.innerHTML = '';

    renderSelectionInstructions();

    if (state.allResponses.length === 0) {
        grid.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No hunts found. Run hunts first.</div>';
        return;
    }

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

    const sortMode = getHuntModeById(huntMode);
    const sortedHunts = [...state.allResponses].sort((a, b) => {
        const aBreaking = isResultBreaking(a);
        const bBreaking = isResultBreaking(b);
        if (sortMode.type === 'passing') {
            if (!aBreaking && bBreaking) return -1;
            if (aBreaking && !bBreaking) return 1;
        } else {
            if (aBreaking && !bBreaking) return -1;
            if (!aBreaking && bBreaking) return 1;
        }
        return 0;
    });

    sortedHunts.forEach((result) => {
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
                    ${isBreaking ? 'BREAK' : 'PASS'}
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

        row.querySelector('.view-details-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openSelectionDetailSlideout(rowNumber, result);
        });

        tbody.appendChild(row);
    });

    grid.appendChild(table);
    updateSelectionCount();
}

export function refreshSelectionTable() {
    const tbody = document.getElementById('huntSelectionTableBody');
    if (!tbody) return;

    tbody.querySelectorAll('tr').forEach(row => {
        const rowNumber = parseInt(row.dataset.rowNumber);
        if (isNaN(rowNumber)) return;

        const isSelected = state.selectedRowNumbers.includes(rowNumber);
        const slotIndex = isSelected ? state.selectedRowNumbers.indexOf(rowNumber) : -1;
        const slotNumber = slotIndex >= 0 ? slotIndex + 1 : null;

        const slotCell = row.querySelector('td.col-slot');
        if (slotCell) {
            if (slotNumber) {
                slotCell.innerHTML = `<span class="slot-badge assigned">Slot ${slotNumber}</span>`;
            } else {
                slotCell.innerHTML = `<span class="slot-badge empty">-</span>`;
            }
        }

        if (isSelected) {
            row.classList.add('selected');
        } else {
            row.classList.remove('selected');
        }

        const checkbox = row.querySelector('.hunt-selection-checkbox');
        if (checkbox) {
            checkbox.checked = isSelected;
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
        console.error(`CRITICAL: No result found at row number ${rowNumber}`);
        return;
    }

    const huntMode = state.config?.hunt_mode || 'break_50';
    const isBreaking = isResultBreaking(result);

    if (checkbox.checked) {
        const selMode = getHuntModeById(huntMode);
        const slots = getSelectionSlots();

        if (selMode.type === 'passing' && isBreaking) {
            checkbox.checked = false;
            showToast(`Only passing hunts can be selected in ${selMode.name} mode.`, 'warning');
            return;
        }
        if (selMode.count_based) {
            const req = selMode.required_breaking ?? 1;
            const currentBreaking = state.selectedRowNumbers
                .map(rn => state.allResponses[rn]).filter(r => r && isResultBreaking(r)).length;
            if (isBreaking && currentBreaking >= req) {
                checkbox.checked = false;
                showToast(`Only ${req} breaking hunt(s) allowed in ${selMode.name} mode. Unselect one first.`, 'warning');
                return;
            }
        }

        if (selMode.type === 'breaking' && !selMode.count_based && state.selectedRowNumbers.length >= slots) {
            checkbox.checked = false;
            showToast(`Maximum ${slots} hunts allowed. Unselect one first.`, 'warning');
            return;
        }

        const tempSelection = [...state.selectedRowNumbers];
        if (!tempSelection.includes(rowNumber)) tempSelection.push(rowNumber);
        if (selMode.type === 'breaking' && !selMode.count_based && tempSelection.length === slots) {
            const tempResults = tempSelection.map(rn => state.allResponses[rn]).filter(r => r);
            const validation = validateSelectionForMode(tempResults, huntMode, state.adminMode);
            if (!validation.valid) {
                checkbox.checked = false;
                showToast(`${validation.message}`, 'error');
                return;
            }
        }

        if (!state.selectedRowNumbers.includes(rowNumber)) state.selectedRowNumbers.push(rowNumber);
        row.classList.add('selected');
        row.style.background = 'rgba(var(--accent-primary-rgb), 0.1)';
        row.style.borderLeft = '4px solid var(--accent-primary)';
        state.diversityCheckPassed = false;

        refreshSelectionTable();
    } else {
        state.selectedRowNumbers = state.selectedRowNumbers.filter(rn => rn !== rowNumber);
        row.classList.remove('selected');
        row.style.background = 'transparent';
        row.style.borderLeft = 'none';
        state.diversityCheckPassed = false;

        refreshSelectionTable();
    }

    updateSelectionCount();

    if (state.selectedRowNumbers.length > 0 && !elements.resultsSection.classList.contains('hidden')) {
        displaySelectedForReview();
    }
}

export function toggleDetailsRow(rowNumber, row, result) {
    const detailRowId = `detail-row-${rowNumber}`;
    let detailRow = document.getElementById(detailRowId);
    const detailsBtn = row.querySelector('.details-toggle-btn');
    const detailsIcon = detailsBtn.querySelector('.details-icon');
    const detailsText = detailsBtn.querySelector('.details-text');

    if (detailRow && detailRow.style.display !== 'none') {
        detailRow.style.display = 'none';
        detailsIcon.textContent = '▼';
        detailsText.textContent = 'Details';
        detailsBtn.style.background = 'var(--bg-tertiary)';
        detailsBtn.style.color = 'var(--text-primary)';
        detailsBtn.style.borderColor = 'var(--border)';
    } else {
        if (!detailRow) {
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

            row.parentNode.insertBefore(detailRow, row.nextSibling);
        } else {
            detailRow.style.display = 'table-row';
            detailRow.style.animation = 'slideDown 0.3s ease-out';
        }

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
        console.error(`CRITICAL: Expected ${count} results but found ${selectedResults.length}`);
        console.error('   Selected row numbers:', state.selectedRowNumbers);
        console.error('   allResponses length:', state.allResponses.length);
    }

    if (elements.selectionCount) {
        let statusText = '';
        let statusColor = 'var(--text-muted)';

        if (count === 0) {
            statusText = 'No hunts selected';
        } else if (state.adminMode && adminBypass('selection_mode_rules')) {
            statusText = `Admin: ${count} selected — any combination allowed`;
            statusColor = 'var(--text-primary)';
        } else {
            const countMode = getHuntModeById(huntMode);
            const countSlots = getSelectionSlots();
            if (countMode.type === 'passing' || countMode.count_based) {
                statusText = validation.valid
                    ? `${breakingCount} breaking, ${passingCount} passing selected`
                    : `${validation.message}`;
                statusColor = validation.valid ? 'var(--success)' : 'var(--danger)';
            } else if (count < countSlots) {
                statusText = `Selected: ${count}/${countSlots} hunts (${breakingCount} breaking, ${passingCount} passing) — Select ${countSlots - count} more`;
                statusColor = 'var(--text-primary)';
            } else if (count === countSlots) {
                statusText = validation.valid
                    ? `Valid: ${breakingCount} breaking, ${passingCount} passing`
                    : `${validation.message}`;
                statusColor = validation.valid ? 'var(--success)' : 'var(--danger)';
            } else {
                statusText = `Too many selected: ${count}/${countSlots}`;
                statusColor = 'var(--danger)';
            }
        }

        elements.selectionCount.textContent = statusText;
        elements.selectionCount.style.color = statusColor;
    }

    let shouldEnable = false;
    if (state.adminMode && adminBypass('selection_count')) {
        shouldEnable = count >= 1;
    } else {
        const enableMode = getHuntModeById(huntMode);
        const enableSlots = getSelectionSlots();
        if (enableMode.type === 'passing' || enableMode.count_based) {
            shouldEnable = count >= 1 && validation.valid;
        } else {
            shouldEnable = count === enableSlots && validation.valid;
        }
    }

    const confirmBtn = document.getElementById('confirmSelectionBtn') || elements.confirmSelectionBtn;
    if (confirmBtn) {
        confirmBtn.disabled = !shouldEnable;
        confirmBtn.title = !shouldEnable && !(state.adminMode && adminBypass('selection_count')) ? validation.message : '';
    }
}
