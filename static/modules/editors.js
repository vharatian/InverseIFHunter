/**
 * editors.js — Prompt Validation, Model Matching, Model Options
 * 
 * Handles prompt length validation and model mismatch warnings.
 * Old split-view markdown editing, structured input, and resizable panels
 * have been removed — the Testbed is now the primary editor.
 */

import { elements } from './dom.js';
import { state } from './state.js';
import { renderInsightTip } from './utils.js';
import { showToast } from './celebrations.js';
import { getProviderModels, getJudgeModels, getConfigValue, adminBypass } from './config.js';
import { validateModelReferenceAndCriteria } from './notebook.js';

// ============== Prompt Length Validation ==============

export function validatePromptLength() {
    const text = state.notebook?.prompt || '';
    if (state.adminMode && adminBypass('prompt_length_range')) return true;

    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;

    if ((state.currentTurn || 1) > 1 || state.isMultiTurn) return true;

    if (state.promptLengthRange) {
        const { min, max } = state.promptLengthRange;
        return wordCount >= min && wordCount <= max;
    }
    return true;
}

// ============== Model Locked Indicator ==============

export function showModelLockedIndicator(modelName) {
    renderInsightTip('configTipContainer', 'config', { model: modelName });
}

export function hideModelLockedIndicator() {
    const indicator = document.getElementById('modelLockedIndicator');
    if (indicator) {
        indicator.style.display = 'none';
        indicator.classList.add('hidden');
    }
}

// ============== Model Matching Validation ==============

export function validateModelMatch() {
    state.modelMismatchWarning = false;
    const existingWarning = document.getElementById('modelMismatchWarning');
    if (existingWarning) existingWarning.remove();
    return true;
}

export function clearModelMismatchWarning() {
    state.modelMismatchWarning = false;
    
    const existingWarning = document.getElementById('modelMismatchWarning');
    if (existingWarning) existingWarning.remove();
    
    if (elements.startHuntBtn) {
        elements.startHuntBtn.style.opacity = '';
        elements.startHuntBtn.style.cursor = '';
    }
}

export function showModelMismatchWarning(selectedModel, metadataModel) {
    if (state.adminMode && adminBypass('model_mismatch_warning')) return;
    
    state.modelMismatchWarning = true;
    
    const existingWarning = document.getElementById('modelMismatchWarning');
    if (existingWarning) existingWarning.remove();
    
    const warning = document.createElement('div');
    warning.id = 'modelMismatchWarning';
    warning.className = 'model-mismatch-warning';
    warning.innerHTML = `
        <div style="background: var(--danger-bg, #fee2e2); border: 2px solid var(--danger, #ef4444); border-radius: 8px; padding: 12px; margin-top: 8px;">
            <strong style="color: var(--danger, #ef4444);">⛔ MODEL MISMATCH - HUNT BLOCKED</strong><br><br>
            <strong>Required (from metadata):</strong> ${metadataModel}<br>
            <strong>Currently selected:</strong> ${selectedModel}<br><br>
            <em>Select the correct model to enable hunting.</em>
        </div>
    `;
    
    const modelGroup = elements.modelSelect?.closest('.form-group');
    if (modelGroup) modelGroup.appendChild(warning);
    
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = false;
        elements.startHuntBtn.title = '';
        elements.startHuntBtn.style.opacity = '';
        elements.startHuntBtn.style.cursor = '';
    }
    
    if (!(state.adminMode && adminBypass('model_mismatch_warning'))) {
        showToast('⛔ Model mismatch! Select the correct model to hunt.', 'error');
    }
}


// ============== Model Options Helper ==============

export function updateModelOptions(skipDefaultSelection = false) {
    if (!elements.providerSelect || !elements.modelSelect) return;

    const provider = elements.providerSelect.value;
    const providerModels = getProviderModels();
    const models = (providerModels[provider] || providerModels['openrouter'] || []);
    
    elements.modelSelect.innerHTML = '';
    
    let defaultModelId = 'qwen/qwen3-235b-a22b-thinking-2507';
    if (provider === 'fireworks') {
        defaultModelId = 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507';
    }
    
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        
        if (!skipDefaultSelection) {
            if (state._preselectedModelId && model.id === state._preselectedModelId) {
                option.selected = true;
            } else if (!state._preselectedModelId) {
                if (model.id === defaultModelId || model.id.includes('qwen')) {
                    option.selected = true;
                }
            }
        }
        elements.modelSelect.appendChild(option);
    });
    
    if (!skipDefaultSelection && models.length > 0) {
        const currentOption = elements.modelSelect.querySelector(`option[value="${elements.modelSelect.value}"]`);
        if (!currentOption || currentOption.disabled) {
            const firstEnabled = Array.from(elements.modelSelect.options).find(opt => !opt.disabled);
            if (firstEnabled) elements.modelSelect.value = firstEnabled.value;
        }
    }
    
    if (!skipDefaultSelection && elements.modelSelect.value) {
        state.config.models = [elements.modelSelect.value];
    }

    populateJudgeModelDropdown();
    _rebuildModelPills();
}

function _rebuildModelPills() {
    const grid = document.getElementById('modelPillGrid');
    const sel  = elements.modelSelect;
    if (!grid || !sel) return;
    grid.innerHTML = '';
    Array.from(sel.options).forEach(opt => {
        const pill = document.createElement('button');
        pill.type        = 'button';
        pill.className   = 'hc-pill';
        pill.dataset.value = opt.value;
        pill.textContent = opt.text;
        if (opt.value === sel.value) pill.classList.add('active');
        grid.appendChild(pill);
    });
    if (sel.disabled) grid.classList.add('hc-locked');
    else grid.classList.remove('hc-locked');
}

function populateJudgeModelDropdown() {
    const sel = document.getElementById('judgeModel');
    if (!sel) return;
    const provider = elements.providerSelect?.value || 'openrouter';
    const list = getJudgeModels(provider);
    const currentValue = sel.value;
    sel.innerHTML = '';
    list.forEach(({ id, name }) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = name;
        if (id === currentValue) opt.selected = true;
        sel.appendChild(opt);
    });
    if (!sel.value && list.length > 0) sel.value = list[0].id;
    sel.disabled = false;
    _rebuildJudgePills();
}

function _rebuildJudgePills() {
    const grid = document.getElementById('judgePillGrid');
    const sel  = document.getElementById('judgeModel');
    if (!grid || !sel) return;
    grid.innerHTML = '';
    Array.from(sel.options).forEach(opt => {
        const pill = document.createElement('button');
        pill.type          = 'button';
        pill.className     = 'hc-pill';
        pill.dataset.value = opt.value;
        pill.textContent   = opt.text;
        if (opt.value === sel.value) pill.classList.add('active');
        grid.appendChild(pill);
    });
}
