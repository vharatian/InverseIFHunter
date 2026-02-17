/**
 * editors.js — Markdown Editors, Structured Input, Prompt Validation, Model Matching
 * 
 * Handles split-view markdown editing, structured text to JSON conversion,
 * prompt length validation, and model mismatch warnings.
 * 
 */

import { elements } from './dom.js';
import { state } from './state.js';
import { renderInsightTip } from './utils.js';
import { showToast } from './celebrations.js';
import { PROVIDER_MODELS } from './config.js';
import { validateModelReferenceAndCriteria } from './notebook.js';

// ============== Markdown Split Editor ==============

// Markdown editor elements mapping
const markdownEditors = {
    prompt: { textarea: 'promptMarkdown', preview: 'promptPreview' },
    response: { textarea: 'responseMarkdown', preview: 'referencePreview' },
    judge: { textarea: 'judgeMarkdown', preview: 'judgePreview' }
};

export function initMarkdownEditors() {
    // Initialize each Markdown toolbar
    document.querySelectorAll('.markdown-toolbar').forEach(toolbar => {
        const targetId = toolbar.dataset.target;
        const textarea = document.getElementById(targetId);
        
        if (!textarea) return;
        
        // Add click handlers to toolbar buttons
        toolbar.querySelectorAll('.md-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const mdType = btn.dataset.md;
                insertMarkdown(textarea, mdType);
                updateMarkdownPreview(textarea);
            });
        });
        
        // Add preview toggle handler
        const previewToggle = toolbar.querySelector('.preview-toggle');
        if (previewToggle) {
            const previewPaneId = previewToggle.dataset.preview;
            const previewPane = document.getElementById(previewPaneId);
            const splitView = previewPane?.closest('.markdown-split-view');
            const resizeHandle = previewPane?.previousElementSibling;

            const applyToggleState = (checked) => {
                if (!previewPane) return;
                if (checked) {
                    previewPane.classList.remove('collapsed');
                    splitView?.classList.remove('preview-collapsed');
                    if (resizeHandle?.classList.contains('resize-handle')) resizeHandle.classList.remove('hidden');
                } else {
                    previewPane.classList.add('collapsed');
                    splitView?.classList.add('preview-collapsed');
                    if (resizeHandle?.classList.contains('resize-handle')) resizeHandle.classList.add('hidden');
                }
            };

            previewToggle.addEventListener('change', (e) => applyToggleState(e.target.checked));
            // Apply initial state on load (in case toggle starts unchecked)
            applyToggleState(previewToggle.checked);
        }
    });
    
    // Initialize live preview for each editor
    Object.values(markdownEditors).forEach(({ textarea: textareaId, preview: previewId }) => {
        const textarea = document.getElementById(textareaId);
        const preview = document.getElementById(previewId);
        
        if (!textarea || !preview) return;
        
        // Live preview on input
        textarea.addEventListener('input', () => {
            updateMarkdownPreview(textarea);
            
            // Track unsaved changes
            if (textareaId === 'promptMarkdown') {
                state.unsavedChanges.prompt = true;
                validatePromptLength();
            } else if (textareaId === 'responseMarkdown') {
                state.unsavedChanges.response = true;
            } else if (textareaId === 'judgeMarkdown') {
                state.unsavedChanges.judge = true;
            }
        });
        
        // Also update on paste
        textarea.addEventListener('paste', () => {
            setTimeout(() => {
                updateMarkdownPreview(textarea);
                if (textareaId === 'promptMarkdown') {
                    validatePromptLength();
                }
            }, 10);
        });
        
        // Keyboard shortcuts
        textarea.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'b') {
                    e.preventDefault();
                    insertMarkdown(textarea, 'bold');
                    updateMarkdownPreview(textarea);
                } else if (e.key === 'i') {
                    e.preventDefault();
                    insertMarkdown(textarea, 'italic');
                    updateMarkdownPreview(textarea);
                } else if (e.key === 'k') {
                    e.preventDefault();
                    insertMarkdown(textarea, 'link');
                    updateMarkdownPreview(textarea);
                }
            }
            
            // Tab key for indentation
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
                textarea.selectionStart = textarea.selectionEnd = start + 2;
                updateMarkdownPreview(textarea);
            }
        });
    });
}

export function insertMarkdown(textarea, type) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.substring(start, end);
    let insertion = '';
    let cursorOffset = 0;
    
    switch (type) {
        case 'heading':
            insertion = `## ${selectedText || 'Heading'}`;
            cursorOffset = selectedText ? insertion.length : 3;
            break;
        case 'bold':
            insertion = `**${selectedText || 'bold text'}**`;
            cursorOffset = selectedText ? insertion.length : 2;
            break;
        case 'italic':
            insertion = `*${selectedText || 'italic text'}*`;
            cursorOffset = selectedText ? insertion.length : 1;
            break;
        case 'code':
            insertion = `\`${selectedText || 'code'}\``;
            cursorOffset = selectedText ? insertion.length : 1;
            break;
        case 'codeblock':
            insertion = `\`\`\`\n${selectedText || 'code here'}\n\`\`\``;
            cursorOffset = selectedText ? insertion.length : 4;
            break;
        case 'link':
            insertion = `[${selectedText || 'link text'}](url)`;
            cursorOffset = selectedText ? insertion.length - 4 : 1;
            break;
        case 'image':
            insertion = `![${selectedText || 'alt text'}](image-url)`;
            cursorOffset = selectedText ? insertion.length - 11 : 2;
            break;
        case 'quote':
            insertion = `> ${selectedText || 'quote'}`;
            cursorOffset = selectedText ? insertion.length : 2;
            break;
        case 'ul':
            if (selectedText) {
                insertion = selectedText.split('\n').map(line => `- ${line}`).join('\n');
            } else {
                insertion = '- list item';
            }
            cursorOffset = selectedText ? insertion.length : 2;
            break;
        case 'ol':
            if (selectedText) {
                insertion = selectedText.split('\n').map((line, i) => `${i + 1}. ${line}`).join('\n');
            } else {
                insertion = '1. list item';
            }
            cursorOffset = selectedText ? insertion.length : 3;
            break;
        case 'hr':
            insertion = '\n---\n';
            cursorOffset = insertion.length;
            break;
        case 'math':
            insertion = `$${selectedText || 'formula'}$`;
            cursorOffset = selectedText ? insertion.length : 1;
            break;
        default:
            return;
    }
    
    textarea.value = textarea.value.substring(0, start) + insertion + textarea.value.substring(end);
    textarea.focus();
    
    // Set cursor position
    if (selectedText) {
        textarea.selectionStart = start;
        textarea.selectionEnd = start + insertion.length;
    } else {
        textarea.selectionStart = textarea.selectionEnd = start + cursorOffset;
    }
}

export function updateMarkdownPreview(textarea) {
    // Find corresponding preview element
    let previewId = null;
    for (const [key, { textarea: tid, preview: pid }] of Object.entries(markdownEditors)) {
        if (tid === textarea.id) {
            previewId = pid;
            break;
        }
    }
    
    const preview = document.getElementById(previewId);
    if (!preview) return;
    
    const markdown = textarea.value;
    
    // Use marked.js to render Markdown
    if (typeof marked !== 'undefined') {
        try {
            // Configure marked for safe rendering
            marked.setOptions({
                breaks: true,  // Convert \n to <br>
                gfm: true,     // GitHub Flavored Markdown
                sanitize: false
            });
            preview.innerHTML = marked.parse(markdown);
        } catch (e) {
            preview.innerHTML = `<p style="color: var(--danger);">Preview error: ${e.message}</p>`;
        }
    } else {
        // Fallback: basic text display
        preview.textContent = markdown;
    }
}

// Legacy function name for backward compatibility
export function initRichTextEditors() {
    initMarkdownEditors();
}

export function updateToolbarState(toolbar, editor) {
    // No-op for Markdown editors (kept for backward compatibility)
}

// Initialize resizable split view panels
export function initResizablePanels() {
    document.querySelectorAll('.resize-handle').forEach(handle => {
        let isResizing = false;
        let startY = 0;
        let startEditorHeight = 0;
        let startPreviewHeight = 0;
        
        const splitView = handle.closest('.markdown-split-view');
        const editorPane = splitView?.querySelector('.markdown-editor-pane');
        const previewPane = splitView?.querySelector('.markdown-preview-pane');
        
        if (!splitView || !editorPane || !previewPane) return;
        
        const onMouseDown = (e) => {
            isResizing = true;
            startY = e.clientY || e.touches?.[0]?.clientY;
            startEditorHeight = editorPane.offsetHeight;
            startPreviewHeight = previewPane.offsetHeight;
            
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
            
            // Add active state
            handle.style.background = 'var(--accent-primary)';
        };
        
        const onMouseMove = (e) => {
            if (!isResizing) return;
            
            const clientY = e.clientY || e.touches?.[0]?.clientY;
            const delta = clientY - startY;
            
            const newEditorHeight = Math.max(100, startEditorHeight + delta);
            
            // Only resize editor - let preview auto-expand to fit content
            editorPane.style.height = `${newEditorHeight}px`;
            editorPane.style.flex = 'none';
            
            // IMPORTANT: Don't set fixed height on preview - let it auto-expand
            previewPane.style.height = 'auto';
            previewPane.style.flex = '1 1 auto';
            previewPane.style.overflow = 'visible';
        };
        
        const onMouseUp = () => {
            if (!isResizing) return;
            isResizing = false;
            
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            
            // Remove active state
            handle.style.background = '';
        };
        
        // Mouse events
        handle.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        
        // Touch events for mobile
        handle.addEventListener('touchstart', onMouseDown, { passive: true });
        document.addEventListener('touchmove', onMouseMove, { passive: true });
        document.addEventListener('touchend', onMouseUp);
    });
}

// ============== Structured Text to JSON Converter ==============

export function initStructuredInput() {
    if (!elements.modelrefPreview) return;
    
    elements.modelrefPreview.addEventListener('input', () => {
        state.unsavedChanges.modelRef = true;
        convertStructuredToJSON();
    });
    
    // Initial conversion if content exists
    if (elements.modelrefPreview.value) {
        convertStructuredToJSON();
    }
    
    // Criteria buttons (+ C1, + C2, ... + C10): always add on a new line
    document.querySelectorAll('.criteria-add-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const criterion = btn.dataset.criterion; // e.g. "C1", "C2"
            if (!criterion) return;
            const textarea = elements.modelrefPreview;
            if (!textarea) return;
            const current = textarea.value;
            // Always add on a new line: append newline + "Cn: " (never at cursor/end-of-line/middle)
            const prefix = current.length === 0 ? '' : (current.endsWith('\n') ? '' : '\n');
            const toInsert = current.length === 0 ? `${criterion}: ` : `${prefix}\n${criterion}: `;
            textarea.value = current + toInsert;
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            state.unsavedChanges.modelRef = true;
            convertStructuredToJSON();
        });
    });
}

export function convertStructuredToJSON() {
    if (!elements.modelrefPreview) return;
    
    const inputText = elements.modelrefPreview.value.trim();
    
    if (!inputText) {
        if (elements.jsonPreviewContent) {
            elements.jsonPreviewContent.textContent = 'Enter criteria above to see JSON preview...';
            elements.jsonPreviewContent.className = 'json-preview-content';
        }
        if (elements.jsonPreviewStatus) {
            elements.jsonPreviewStatus.textContent = '';
        }
        state.convertedModelRefJSON = null;
        return;
    }
    
    try {
        // First, try to parse as JSON directly (user might paste JSON)
        let criteria = null;
        let jsonString = null;
        
        try {
            const parsed = JSON.parse(inputText);
            
            // Check if it's already a valid criteria array
            if (Array.isArray(parsed) && parsed.length > 0) {
                // Validate structure: should have id and criteria fields
                const isValid = parsed.every(item => 
                    item && 
                    typeof item === 'object' && 
                    item.id && 
                    Object.keys(item).some(key => key.startsWith('criteria'))
                );
                
                if (isValid) {
                    // It's already valid JSON criteria format - use it directly
                    criteria = parsed;
                    jsonString = JSON.stringify(criteria, null, 2);
                    console.log('✅ Detected valid JSON format, using directly');
                } else {
                    // Invalid structure, fall through to structured text parsing
                    throw new Error('Invalid JSON structure');
                }
            } else {
                // Not an array, fall through to structured text parsing
                throw new Error('Not a valid criteria array');
            }
        } catch (jsonError) {
            // Not valid JSON or not in expected format, try structured text format
            console.log('Not valid JSON, trying structured text format');
            
            // Parse structured text format: C1: description, C2: description, etc.
            const lines = inputText.split('\n').filter(line => line.trim());
            criteria = [];
            
            lines.forEach((line, index) => {
                line = line.trim();
                if (!line) return;
                
                // Match pattern: C1: description or C1 description
                const match = line.match(/^C(\d+)[:\s]+(.+)$/i);
                if (match) {
                    const id = `C${match[1]}`;
                    const description = match[2].trim();
                    criteria.push({
                        id: id,
                        [`criteria${match[1]}`]: description
                    });
                } else {
                    // If no match, try to infer from line number
                    const inferredId = `C${index + 1}`;
                    criteria.push({
                        id: inferredId,
                        [`criteria${index + 1}`]: line
                    });
                }
            });
            
            if (criteria.length === 0) {
                throw new Error('No valid criteria found. Use format: C1: description, or paste valid JSON array');
            }
            
            // Convert to JSON string
            jsonString = JSON.stringify(criteria, null, 2);
        }
        
        // Store the JSON (display removed from UI)
        if (elements.jsonPreviewContent) {
            elements.jsonPreviewContent.textContent = jsonString;
            elements.jsonPreviewContent.className = 'json-preview-content valid';
        }
        if (elements.jsonPreviewStatus) {
            elements.jsonPreviewStatus.textContent = `✅ Valid (${criteria.length} criteria)`;
            elements.jsonPreviewStatus.style.color = 'var(--success)';
        }
        
        // Store converted JSON in state for saving
        state.convertedModelRefJSON = jsonString;
        
        // Validate the JSON and update button state
        // Use the converted JSON for validation
        validateModelReferenceAndCriteria(jsonString);
        
    } catch (error) {
        if (elements.jsonPreviewContent) {
            elements.jsonPreviewContent.textContent = `Error: ${error.message}`;
            elements.jsonPreviewContent.className = 'json-preview-content error';
        }
        if (elements.jsonPreviewStatus) {
            elements.jsonPreviewStatus.textContent = '❌ Invalid format';
            elements.jsonPreviewStatus.style.color = 'var(--danger)';
        }
        
        state.convertedModelRefJSON = null;
        
        // Mark JSON as invalid and disable hunt button — bypass in admin mode
        state.modelRefValid = false;
        if (elements.startHuntBtn && !state.adminMode) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = `Model Reference JSON Error: ${error.message}`;
        } else if (state.adminMode && elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = 'Admin mode';
        }
    }
}

// ============== Prompt Length Validation ==============

export function initPromptLengthValidation() {
    if (!elements.promptPreview) return;
    
    // Validate on input
    elements.promptPreview.addEventListener('input', validatePromptLength);
}

export function validatePromptLength() {
    const promptTextarea = document.getElementById('promptMarkdown');
    if (!promptTextarea) {
        return true; // No validation if element not found
    }
    if (state.adminMode) return true; // Bypass in admin mode
    
    const text = promptTextarea.value || '';
    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
    
    // Turn 2+: no word limit/range — show count only, no validation
    const turnAboveOne = (state.currentTurn || 1) > 1 || state.isMultiTurn;
    if (turnAboveOne) {
        const wordCountTextEl = document.getElementById('promptWordCountText');
        const wordCountRangeEl = document.getElementById('promptWordCountRange');
        const wordCountEl = document.getElementById('promptWordCount');
        if (wordCountTextEl) wordCountTextEl.textContent = `${wordCount} word${wordCount !== 1 ? 's' : ''}`;
        if (wordCountRangeEl) wordCountRangeEl.textContent = '';
        if (wordCountEl) {
            wordCountEl.style.background = 'var(--bg-tertiary)';
            wordCountEl.style.color = 'var(--text-primary)';
            wordCountEl.style.border = '1px solid var(--border)';
        }
        if (elements.promptLengthWarning) elements.promptLengthWarning.classList.add('hidden');
        return true;
    }
    
    // Turn 1: apply range from metadata
    const wordCountEl = document.getElementById('promptWordCount');
    const wordCountTextEl = document.getElementById('promptWordCountText');
    const wordCountRangeEl = document.getElementById('promptWordCountRange');
    
    if (wordCountTextEl) {
        wordCountTextEl.textContent = `${wordCount} word${wordCount !== 1 ? 's' : ''}`;
    }
    
    // Show range if available
    if (wordCountRangeEl && state.promptLengthRange) {
        const { min, max } = state.promptLengthRange;
        wordCountRangeEl.textContent = `(range: ${min}-${max})`;
    } else if (wordCountRangeEl) {
        wordCountRangeEl.textContent = '';
    }
    
    // Color code based on range
    if (wordCountEl && state.promptLengthRange) {
        const { min, max } = state.promptLengthRange;
        
        if (wordCount >= min && wordCount <= max) {
            // In range - green
            wordCountEl.style.background = 'var(--success-bg)';
            wordCountEl.style.color = 'var(--success)';
            wordCountEl.style.border = '1px solid var(--success)';
        } else {
            // Out of range - red
            wordCountEl.style.background = 'var(--danger-bg)';
            wordCountEl.style.color = 'var(--danger)';
            wordCountEl.style.border = '1px solid var(--danger)';
        }
    } else if (wordCountEl) {
        // No range set - neutral
        wordCountEl.style.background = 'var(--bg-tertiary)';
        wordCountEl.style.color = 'var(--text-primary)';
        wordCountEl.style.border = '1px solid var(--border)';
    }
    
    // Show warning if outside range
    if (elements.promptLengthWarning && state.promptLengthRange) {
        const { min, max } = state.promptLengthRange;
        
        if (wordCount < min || wordCount > max) {
            elements.promptLengthWarning.classList.remove('hidden');
            elements.promptLengthWarning.className = 'prompt-length-warning error';
            elements.promptLengthWarning.innerHTML = `
                ⚠️ <strong>Prompt length out of range!</strong><br>
                Current: ${wordCount} words | Required: ${min} - ${max} words
            `;
            return false;
        } else {
            elements.promptLengthWarning.classList.add('hidden');
            return true;
        }
    }
    
    return true;
}

// ============== Model Locked Indicator ==============

export function showModelLockedIndicator(modelName) {
    // Model lock disabled — just update config tip, don't show lock indicator
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
    // Model lock disabled — all models are allowed regardless of metadata
    state.modelMismatchWarning = false;
    const existingWarning = document.getElementById('modelMismatchWarning');
    if (existingWarning) existingWarning.remove();
    return true;
}

export function clearModelMismatchWarning() {
    state.modelMismatchWarning = false;
    
    // Remove warning element
    const existingWarning = document.getElementById('modelMismatchWarning');
    if (existingWarning) {
        existingWarning.remove();
    }
    
    // Restore start hunt button styling (but don't enable - other validations may apply)
    if (elements.startHuntBtn) {
        elements.startHuntBtn.style.opacity = '';
        elements.startHuntBtn.style.cursor = '';
        // Note: Don't enable the button here - other validations may still require it disabled
    }
    
    // Re-enable save buttons
    disableSaveButtons(false);
}

export function showModelMismatchWarning(selectedModel, metadataModel) {
    if (state.adminMode) return; // No locks in admin mode
    
    state.modelMismatchWarning = true;
    
    // Remove any existing warning first
    const existingWarning = document.getElementById('modelMismatchWarning');
    if (existingWarning) {
        existingWarning.remove();
    }
    
    // Create warning element
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
    
    // Insert warning after model select
    const modelGroup = elements.modelSelect?.closest('.form-group');
    if (modelGroup) {
        modelGroup.appendChild(warning);
    }
    
    // FORCE disable start hunt button — bypass in admin mode
    if (elements.startHuntBtn) {
        if (state.adminMode) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = 'Admin mode';
        } else {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = 'MODEL MISMATCH: Select the correct model from metadata to hunt.';
            elements.startHuntBtn.style.opacity = '0.5';
            elements.startHuntBtn.style.cursor = 'not-allowed';
        }
    }
    
    // Disable save buttons too — bypass in admin mode
    if (!state.adminMode) {
        disableSaveButtons(true);
        showToast('⛔ Model mismatch! Select the correct model to hunt.', 'error');
    }
}

export function disableSaveButtons(disable) {
    const saveButtons = [
        elements.saveAllBtn,
        elements.savePromptBtn,
        elements.saveResponseBtn,
        elements.saveModelRefBtn,
        elements.saveJudgeBtn,
        elements.judgeBeforeHuntBtn // Also disable judge button on model mismatch
    ];
    
    saveButtons.forEach(btn => {
        if (btn) {
            if (disable) {
                btn.disabled = true;
                btn.title = 'Model mismatch detected. Please select the correct model from metadata.';
                btn.style.opacity = '0.6';
                btn.style.cursor = 'not-allowed';
            } else {
                btn.disabled = false;
                btn.title = '';
                btn.style.opacity = '1';
                btn.style.cursor = 'pointer';
            }
        }
    });
}


// ============== Model Options Helper ==============

export function updateModelOptions(skipDefaultSelection = false) {
    if (!elements.providerSelect || !elements.modelSelect) return;

    const provider = elements.providerSelect.value;
    const models = PROVIDER_MODELS[provider] || [];
    
    // Clear current options
    elements.modelSelect.innerHTML = '';
    
    // Determine default model based on provider (only if skipDefaultSelection is false)
    let defaultModelId = 'qwen/qwen3-235b-a22b-thinking-2507'; // Default to Qwen
    if (provider === 'fireworks') {
        defaultModelId = 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507';
    }
    
    // Add new options (all models enabled)
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        
        if (!skipDefaultSelection) {
            // If a notebook preselected a model, honor that
            if (state._preselectedModelId && model.id === state._preselectedModelId) {
                option.selected = true;
            } else if (!state._preselectedModelId) {
                // No preselection — default to Qwen
                if (model.id === defaultModelId || model.id.includes('qwen')) {
                    option.selected = true;
                }
            }
        }
        elements.modelSelect.appendChild(option);
    });
    
    // If no Qwen model was found and we're not skipping default, select first ENABLED model
    if (!skipDefaultSelection && models.length > 0) {
        // Check if current selection is disabled
        const currentOption = elements.modelSelect.querySelector(`option[value="${elements.modelSelect.value}"]`);
        if (!currentOption || currentOption.disabled) {
            // Select first enabled option
            const firstEnabled = Array.from(elements.modelSelect.options).find(opt => !opt.disabled);
            if (firstEnabled) {
                elements.modelSelect.value = firstEnabled.value;
            }
        }
    }
    
    // Update state config with selected model (only if we set a default)
    if (!skipDefaultSelection && elements.modelSelect.value) {
        state.config.models = [elements.modelSelect.value];
    }
    
    console.log(`Updated models for provider: ${provider}, selected: ${elements.modelSelect.value} (skipDefault: ${skipDefaultSelection})`);
}
