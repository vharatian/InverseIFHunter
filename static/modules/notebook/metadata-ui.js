import { elements } from '../dom.js';
import { state } from '../state.js';
import { adminBypass, getConfigValue, fetchConfigFromAPI, ADMIN_MODE_PASSWORD } from '../config.js';
import { escapeHtml } from '../utils.js';
import { showToast, showError } from '../celebrations.js?v=43';
import {
    validateModelMatch,
    updateModelOptions,
    validatePromptLength,
    showModelLockedIndicator,
    hideModelLockedIndicator
} from '../editors.js';
import { showAppModal, showPasswordPrompt } from '../api.js';
import { activateAdminMode } from '../adminMode.js';
import { resetAllStatuses } from '../autosave.js';
import { validateModelReferenceJSON, parseCriteria, validateModelReferenceAndCriteria } from './criteria.js';
import { setReviewModeButtonsDisabled } from '../results.js';
import { updateHuntLimitUI } from '../hunt.js';
export function populatePreviewTabs(notebook) {
    if (!(state.adminMode && adminBypass('reference_validation')) && !getConfigValue('bypass_hunt_criteria', false)) {
        state.referenceValidated = false;
    }

    state.unsavedChanges.prompt = false;
    state.unsavedChanges.response = false;
    state.unsavedChanges.judge = false;

    // Display metadata
    const metadataToDisplay = (notebook.metadata && typeof notebook.metadata === 'object')
        ? notebook.metadata : {};
    displayMetadata(metadataToDisplay);

    // Validate Model Reference JSON format
    const modelRefValidation = validateModelReferenceJSON(notebook.response_reference || '');
    state.modelRefValid = modelRefValidation.valid;

    if (!modelRefValidation.valid && (notebook.response_reference || '').trim()) {
        console.warn('Model Reference not valid JSON at load time — user can edit in testbed');
    }

    // Parse and store criteria
    let parsedCriteria;
    try {
        const rawRef = notebook.response_reference || '';
        if (!rawRef.trim()) {
            state.criteria = null;
        } else {
            parsedCriteria = parseCriteria(rawRef);
            state.criteria = parsedCriteria;
        }
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showError(error, { operation: 'Parse criteria' });
        state.criteria = null;
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }
    }

    if (parsedCriteria && Array.isArray(parsedCriteria)) {
        if (!state.initialCriteria || !Array.isArray(state.initialCriteria) || state.initialCriteria.length === 0) {
            state.initialCriteria = JSON.parse(JSON.stringify(parsedCriteria));
        }
        validateModelReferenceAndCriteria(notebook.response_reference || '');
    }

    resetAllStatuses();
}
// ============== Admin Mode ==============

/**
 * Re-apply all validation when admin mode is turned OFF.
 * Restores normal lock behavior (disabled button if conditions not met).
 */
export function refreshValidationState() {
    const responseRef = state.notebook?.response_reference || '';
    validateModelReferenceAndCriteria(responseRef);
    updateHuntLimitUI();
    // Re-check review mode: disable all action buttons when selection confirmed
    if (state.selectionConfirmed) setReviewModeButtonsDisabled(true);
}

export function updateAdminModeIndicator(on) {
    const el = document.getElementById('adminModeIndicator');
    if (!el) return;
    if (on) {
        el.classList.remove('hidden');
        el.style.cursor = 'pointer';
    } else {
        el.classList.add('hidden');
    }
}

// ============== Metadata Display ==============

export function displayMetadata(metadata) {
    
    if (!elements.metadataSidebar || !elements.metadataGrid) {
        console.error('Metadata sidebar elements not found!', {
            sidebar: !!elements.metadataSidebar,
            grid: !!elements.metadataGrid
        });
        return;
    }
    
    
    state.metadata = metadata || {};
    
    // Don't return early if metadata is empty - still try to display what we can
    if (!metadata || (typeof metadata === 'object' && Object.keys(metadata).length === 0)) {
        console.warn('No metadata to display or empty object, but will still try to show sidebar if elements exist');
        // Don't return - continue to try to display fields
    }
    
    // Parse prompt length range - try multiple key variations
    const promptLengthStr = (metadata && metadata['User Prompt Length']) || 
                           (metadata && metadata['User Prompt length']) || 
                           (metadata && metadata['user prompt length']) ||
                           (metadata && metadata['UserPromptLength']) || '';
    if (promptLengthStr) {
        const match = promptLengthStr.match(/(\d+)\s*-\s*(\d+)/);
        if (match) {
            state.promptLengthRange = {
                min: parseInt(match[1]),
                max: parseInt(match[2])
            };
            // Update word count display after range is set
            setTimeout(() => validatePromptLength(), 100);
        }
    }
    
    // Extract model from metadata - check multiple possible keys
    const modelKeys = ['Model', 'Model:', 'model', 'Target Model', 'target_model', 'target model'];
    let modelStr = '';
    if (metadata && typeof metadata === 'object') {
        for (const key of modelKeys) {
            if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '') {
                modelStr = String(metadata[key]).trim();
                break;
            }
        }
    }
    if (modelStr) {
        // Clean the model string (remove dashes at start, trim)
        const cleanedModel = modelStr.replace(/^[-:\s]+/, '').trim();
        state.metadataModel = cleanedModel;
        
        // Show locked indicator
        showModelLockedIndicator(cleanedModel);
        
        // Refresh model options to disable non-matching models
        setTimeout(() => {
            updateModelOptions(true); // Skip default - preserve existing selection
            validateModelMatch();
        }, 300);
    } else {
        // No model in metadata - clear state
        state.metadataModel = null;
        hideModelLockedIndicator();
    }
    
    // Clear existing content
    elements.metadataGrid.innerHTML = '';
    
    // Helper function to find value by multiple possible keys
    const getValue = (possibleKeys) => {
        if (!metadata || typeof metadata !== 'object') return null;
        for (const key of possibleKeys) {
            if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '') {
                return String(metadata[key]).trim();
            }
        }
        return null;
    };
    
    // Define metadata fields to display with multiple key variations
    const fields = [
        { 
            keys: ['Task ID', 'Task ID:', 'task id', 'TaskID'], 
            icon: '', 
            label: 'Task ID',
            badge: true 
        },
        { 
            keys: ['Domain', 'Domain:', 'domain'], 
            icon: '', 
            label: 'Domain' 
        },
        { 
            keys: ['Use Case', 'Use Case:', 'use case', 'UseCase'], 
            icon: '', 
            label: 'Use Case' 
        },
        { 
            keys: ['L1 Taxonomy', 'L1 Taxonomy:', 'l1 taxonomy', 'L1Taxonomy'], 
            icon: '', 
            label: 'L1 Taxonomy' 
        },
        { 
            keys: ['User Prompt Length', 'User Prompt length', 'User Prompt Length:', 'user prompt length'], 
            icon: '', 
            label: 'User Prompt Length' 
        },
        { 
            keys: ['Model', 'Model:', 'model'], 
            icon: '', 
            label: 'Model' 
        }
    ];
    
    let hasAnyData = false;
    let itemsAdded = 0;
    
    fields.forEach(field => {
        const value = getValue(field.keys);
        
        // Always show the field, even if value is null (will show N/A)
        const displayValue = value || 'N/A';
        
        // Always show Task ID (even when N/A) — used for admin mode trigger (5-click)
        if (value) hasAnyData = true;
        
        const item = document.createElement('div');
        item.className = 'metadata-item';
        
        const label = document.createElement('div');
        label.className = 'metadata-label';
        // Create icon span and text separately for better styling
        const iconSpan = document.createElement('span');
        iconSpan.textContent = field.icon;
        iconSpan.style.fontSize = '1rem';
        const textSpan = document.createElement('span');
        textSpan.textContent = field.label;
        label.appendChild(iconSpan);
        label.appendChild(textSpan);
        
        const valueDiv = document.createElement('div');
        valueDiv.className = 'metadata-value';
        
        if (field.label === 'Task ID') {
            // Task ID: no copy. 5-click triggers admin mode password prompt.
            const badge = document.createElement('span');
            badge.className = 'metadata-badge';
            badge.textContent = displayValue;
            badge.style.cursor = 'default';
            badge.title = '';
            badge.dataset.adminClickCount = '0';
            badge.addEventListener('click', (async () => {
                if (state.adminMode) return;
                await fetchConfigFromAPI();
                if (!getConfigValue('admin_mode_enabled', true)) {
                    showToast('Admin mode is disabled in config', 'info');
                    badge.dataset.adminClickCount = '0';
                    return;
                }
                let count = parseInt(badge.dataset.adminClickCount || '0', 10);
                count++;
                badge.dataset.adminClickCount = String(count);
                if (count >= 5) {
                    badge.dataset.adminClickCount = '0';
                    const expectedPassword = getConfigValue('admin_mode_password', ADMIN_MODE_PASSWORD);
                    const password = await showPasswordPrompt({
                        title: 'Admin Mode',
                        message: 'Enter password to enable admin mode (all locks disabled for testing).'
                    });
                    if (password === expectedPassword) {
                        activateAdminMode();
                    } else if (password !== null) {
                        showToast('Wrong password', 'error');
                    }
                } else {
                    clearTimeout(badge._adminClickReset);
                    badge._adminClickReset = setTimeout(() => { badge.dataset.adminClickCount = '0'; }, 2000);
                }
            }));
            valueDiv.appendChild(badge);
        } else if (field.badge && value) {
            const badge = document.createElement('span');
            badge.className = 'metadata-badge';
            badge.textContent = displayValue;
            badge.style.cursor = 'pointer';
            badge.title = 'Click to copy';
            badge.addEventListener('click', () => {
                navigator.clipboard.writeText(displayValue);
                showToast('Copied to clipboard!', 'success');
            });
            valueDiv.appendChild(badge);
        } else {
            valueDiv.textContent = displayValue;
        }
        
        item.appendChild(label);
        item.appendChild(valueDiv);
        elements.metadataGrid.appendChild(item);
        itemsAdded++;
    });
    
    // Always populate the navbar chip with the same fields
    _populateTaskInfoChip(fields, getValue);

    // Show metadata sidebar if we have any data OR if we added any items
    // This ensures sidebar shows even if some fields are missing
    const shouldShow = hasAnyData || itemsAdded > 0 || elements.metadataGrid.children.length > 0;
    
    if (shouldShow) {
        if (elements.metadataSidebar) {
            elements.metadataSidebar.style.display = 'block';
            elements.metadataSidebar.classList.remove('collapsed');
            document.body.classList.add('sidebar-visible');
        } else {
            console.error('Metadata sidebar element not found!');
        }
    } else {
        if (elements.metadataSidebar) {
            elements.metadataSidebar.style.display = 'none';
            elements.metadataSidebar.classList.remove('collapsed');
            document.body.classList.remove('sidebar-visible');
            console.warn('No metadata items to display, hiding sidebar');
        }
    }
}

// ============== Task Info Navbar Chip ==============

function _populateTaskInfoChip(fields, getValue) {
    const chip = document.getElementById('taskInfoChip');
    const chipLabel = document.getElementById('taskInfoChipLabel');
    const chipBtn = document.getElementById('taskInfoChipBtn');
    const dropdown = document.getElementById('taskInfoDropdown');
    const grid = document.getElementById('taskInfoDropdownGrid');
    if (!chip || !grid) return;

    grid.innerHTML = '';

    // Field icon map
    const icons = { 'Task ID': '', 'Domain': '', 'Use Case': '', 'L1 Taxonomy': '', 'User Prompt Length': '', 'Model': '' };

    fields.forEach(field => {
        const value = getValue(field.keys);
        const displayValue = value || 'N/A';

        const row = document.createElement('div');
        row.className = 'task-info-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'task-info-row-label';
        labelEl.textContent = (icons[field.label] || '') + ' ' + field.label;

        const valueEl = document.createElement('span');
        valueEl.className = 'task-info-row-value';

        // Task ID gets a copyable badge
        if (field.label === 'Task ID') {
            const badge = document.createElement('span');
            badge.className = 'task-info-badge';
            badge.textContent = displayValue;
            badge.title = 'Click to copy';
            // Reuse 5-click admin mode from the badge if it's the Task ID
            badge.dataset.adminClickCount = '0';
            badge.addEventListener('click', async () => {
                if (value && value !== 'N/A') {
                    navigator.clipboard.writeText(value);
                    showToast('Copied Task ID!', 'success');
                }
            });
            valueEl.appendChild(badge);
        } else {
            valueEl.textContent = displayValue;
        }

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        grid.appendChild(row);
    });

    // Set chip label to Task ID if available, else "Task Info"
    const taskId = getValue(['Task ID', 'Task ID:', 'task id', 'TaskID']);
    if (chipLabel) chipLabel.textContent = taskId ? taskId : 'Task Info';

    // Show the chip
    chip.classList.remove('hidden');

    // Wire toggle (once)
    if (!chipBtn._taskInfoWired) {
        chipBtn._taskInfoWired = true;
        chipBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = dropdown.classList.contains('open');
            dropdown.classList.toggle('open', !isOpen);
            chip.classList.toggle('open', !isOpen);
        });
        document.addEventListener('click', (e) => {
            if (!chip.contains(e.target)) {
                dropdown.classList.remove('open');
                chip.classList.remove('open');
            }
        });
    }
}
export function toggleMetadataSidebar() {
    if (!elements.metadataSidebar || !elements.metadataToggleBtn) return;
    
    const isCollapsed = elements.metadataSidebar.classList.contains('collapsed');
    
    if (isCollapsed) {
        // Expand
        elements.metadataSidebar.classList.remove('collapsed');
        elements.metadataToggleBtn.querySelector('.metadata-toggle-icon').textContent = '▼';
        document.body.classList.add('sidebar-visible');
    } else {
        // Collapse
        elements.metadataSidebar.classList.add('collapsed');
        elements.metadataToggleBtn.querySelector('.metadata-toggle-icon').textContent = '▶';
        document.body.classList.remove('sidebar-visible');
    }
}
