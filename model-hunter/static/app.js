/**
 * Model Hunter - Frontend Application
 * 
 * Handles:
 * - Theme toggling
 * - Notebook upload/fetch
 * - Hunt configuration
 * - SSE progress streaming
 * - Results display
 */

// ============== Production Mode ==============
// Set to false to enable console logging for debugging
const DEBUG_MODE = false;

// Disable console logging in production
if (!DEBUG_MODE) {
    const noop = () => {};
    console.log = noop;
    console.debug = noop;
    console.info = noop;
    // Keep console.warn and console.error for actual issues
}

// ============== Provider Models ==============

const PROVIDER_MODELS = {
    'openrouter': [
        { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron-3-Nano (Fast)' },
        { id: 'qwen/qwen3-235b-a22b-thinking-2507', name: 'Qwen3-235B (Thinking)' }
    ],
    'fireworks': [
        // Only Qwen3 for Fireworks (Nemotron not available on serverless)
        { id: 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507', name: 'Qwen3-235B (Thinking)' }
    ]
};
// ============== State ==============

const state = {
    sessionId: null,
    notebook: null,
    referenceValidated: false,  // Must pass reference judge before hunt
    criteria: null,              // Current criteria from response_reference
    initialCriteria: null,       // Original criteria when notebook was first loaded (NEVER overwrite)
    config: {
        parallel_workers: 4,
        target_breaks: 4,
        models: ['qwen/qwen3-235b-a22b-thinking-2507'],  // Default to Qwen instead of Nemotron
        reasoning_budget_percent: 0.9,
        max_retries: 3,
        judge_model: 'gpt-5',
        custom_judge_system_prompt: null
    },
    results: [],
    isHunting: false,
    humanReviews: {},  // Explicit init
    
    // Response selection state (NEW)
    allResponses: [],       // All hunt responses (accumulated across runs)
    selectedRowNumbers: [], // Row numbers (0-based indices) of 4 selected hunts for review
    llmRevealed: false,     // Whether LLM judgments have been revealed
    accumulatedHuntOffset: 0,  // Track total hunts for progress table numbering
    currentRunStartOffset: 0,  // Offset at start of current run (for row lookup during run)
    originalNotebookJson: null,  // Original notebook JSON for WYSIWYG snapshot
    
    // Blind judging state
    blindJudging: {
        queue: [],           // Queue of results waiting for human judgment
        currentResult: null, // Current result being judged
        humanJudgments: {}   // Map of hunt_id -> human score
    },
    diversityCheckPassed: false,  // Flag to track if diversity check passed at confirmation
    selectionConfirmed: false,     // Flag to track if selection is confirmed and locked
    
    // Metadata and editing state
    metadata: null,  // Parsed metadata from notebook
    metadataModel: null,  // Model from metadata (e.g., 'qwen', 'nemotron')
    promptLengthRange: null,  // {min: number, max: number} from metadata
    unsavedChanges: {
        prompt: false,
        response: false,
        modelRef: false,
        judge: false
    },
    modelMismatchWarning: false  // Track if model mismatch warning is shown
};


// ============== DOM Elements ==============

const elements = {
    themeToggle: document.getElementById('themeToggle'),
    
    // Upload
    fileDropzone: document.getElementById('fileDropzone'),
    fileInput: document.getElementById('fileInput'),
    colabUrlInput: document.getElementById('colabUrlInput'),
    fetchUrlBtn: document.getElementById('fetchUrlBtn'),
    uploadSection: document.getElementById('uploadSection'),
    
    // Tabs (for preview)
    uploadTab: document.getElementById('uploadTab'),
    
    // Config
    huntSection: document.getElementById('configSection'),
    configSection: document.getElementById('configSection'), // Keep both for safety
    parallelWorkers: document.getElementById('parallelWorkers'),
    providerSelect: document.getElementById('providerSelect'),  // NEW
    modelSelect: document.getElementById('modelSelect'),
    // independentJudge removed (now mandatory)
    startHuntBtn: document.getElementById('startHuntBtn'),
    
    // Preview
    previewTabs: document.getElementById('previewTabs'),
    promptPreview: document.getElementById('promptPreview'),
    referencePreview: document.getElementById('referencePreview'),
    modelrefPreview: document.getElementById('modelrefPreview'),
    judgePreview: document.getElementById('judgePreview'),
    judgeReferenceBtn: document.getElementById('judgeReferenceBtn'),
    saveResponseBtn: document.getElementById('saveReponseBtn'),  // Save Response button
    judgeBeforeHuntBtn: document.getElementById('judgeBeforeHuntBtn'),  // Judge button next to Start Hunt
    referenceJudgeResult: document.getElementById('referenceJudgeResult'),
    metadataToggleBtn: document.getElementById('metadataToggleBtn'),
    
    // New editable elements
    metadataSidebar: document.getElementById('metadataSidebar'),
    metadataCard: document.getElementById('metadataCard'), // Keep for backward compatibility
    metadataGrid: document.getElementById('metadataGrid'),
    promptLengthWarning: document.getElementById('promptLengthWarning'),
    promptLengthInfo: document.getElementById('promptLengthInfo'),
    savePromptBtn: document.getElementById('savePromptBtn'),
    saveModelRefBtn: document.getElementById('saveModelRefBtn'),
    saveJudgeBtn: document.getElementById('saveJudgeBtn'),
    saveAllBtn: document.getElementById('saveAllBtn'),
    jsonPreviewContent: document.getElementById('jsonPreviewContent'),
    jsonPreviewStatus: document.getElementById('jsonPreviewStatus'),
    
    // Progress
    progressSection: document.getElementById('progressSection'),
    progressFill: document.getElementById('progressFill'),
    progressText: document.getElementById('progressText'),
    progressPercent: document.getElementById('progressPercent'),
    breaksIndicator: document.getElementById('breaksIndicator'),
    resultsTableBody: document.getElementById('resultsTableBody'),
    huntStatus: document.getElementById('huntStatus'),
    statusText: document.getElementById('statusText'),
    
    // Results
    resultsSection: document.getElementById('resultsSection'),
    breakingResults: document.getElementById('breakingResults'),
    noBreaksMessage: document.getElementById('noBreaksMessage'),
    saveDriveBtn: document.getElementById('saveDriveBtn'),
    saveDriveContainer: document.getElementById('saveDriveContainer'),
    
    // Summary
    summarySection: document.getElementById('summarySection'),
    
    // Selection Section (NEW)
    selectionSection: document.getElementById('selectionSection'),
    selectionGrid: document.getElementById('selectionGrid'),
    selectionCount: document.getElementById('selectionCount'),
    confirmSelectionBtn: document.getElementById('confirmSelectionBtn'),
    
    // Reveal Button - now at bottom
    revealLLMBtn: document.getElementById('revealLLMBtnBottom'),  // Bottom button
    reviewProgressText: document.getElementById('reviewProgressText'),
    reviewInstructions: document.getElementById('reviewInstructions'),
    reviewProgressContainer: document.getElementById('reviewProgressContainer'),
    bottomInstructions: document.getElementById('bottomInstructions'),
    
    // Blind Judging Modal
    blindJudgeModal: document.getElementById('blindJudgeModal'),
    judgeHuntId: document.getElementById('judgeHuntId'),
    judgeResponseText: document.getElementById('judgeResponseText'),
    humanJudgePass: document.getElementById('humanJudgePass'),
    humanJudgeFail: document.getElementById('humanJudgeFail'),
    humanJudgeSkip: document.getElementById('humanJudgeSkip'),
    llmJudgeReveal: document.getElementById('llmJudgeReveal'),
    humanJudgeResult: document.getElementById('humanJudgeResult'),
    llmJudgeResult: document.getElementById('llmJudgeResult'),
    judgeMatch: document.getElementById('judgeMatch'),
    nextHuntBtn: document.getElementById('nextHuntBtn'),
    
    toastContainer: document.getElementById('toastContainer')
};


// ============== Theme ==============

function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeIcon(next);
}

function updateThemeIcon(theme) {
    elements.themeToggle.textContent = theme === 'dark' ? '🌙' : '☀️';
}


// ============== Tabs ==============

function initTabs() {
    // No upload/url tabs anymore - only file upload
    // This function is kept for compatibility but does nothing now
}


// ============== File Upload ==============

function initFileUpload() {
    const dropzone = elements.fileDropzone;
    const input = elements.fileInput;
    
    // Only setup file upload if elements exist (may have been removed)
    if (dropzone && input) {
        dropzone.addEventListener('click', () => input.click());
        
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });
        
        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });
        
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            
            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.ipynb')) {
                uploadFile(file);
            } else {
                showToast('Please upload a .ipynb file', 'error');
            }
        });
        
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                uploadFile(file);
            }
        });
    }
    
    // URL Fetch button - ensure it's properly set up
    const setupFetchButton = () => {
        // Get button element (try elements first, then DOM)
        let fetchBtn = elements.fetchUrlBtn || document.getElementById('fetchUrlBtn');
        
        if (fetchBtn) {
            // Update elements reference
            elements.fetchUrlBtn = fetchBtn;
            
            // Remove any existing listeners
            fetchBtn.onclick = null;
            
            // Create a new handler function
            const handleFetchClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Fetch button clicked');
                fetchFromUrl();
            };
            
            // Add click event listener with capture phase to ensure it fires
            fetchBtn.addEventListener('click', handleFetchClick, true);
            
            // Also add onclick as fallback
            fetchBtn.onclick = handleFetchClick;
            
            // Ensure button is enabled and has correct type
            fetchBtn.disabled = false;
            fetchBtn.type = 'button'; // Ensure it doesn't submit forms
            
            // Make sure button is not hidden or has pointer-events disabled
            fetchBtn.style.pointerEvents = 'auto';
            fetchBtn.style.cursor = 'pointer';
            
            console.log('✅ Fetch button setup complete', fetchBtn);
        } else {
            console.error('fetchUrlBtn element not found during initialization');
            // Retry after a short delay in case DOM isn't ready
            setTimeout(() => {
                const retryBtn = document.getElementById('fetchUrlBtn');
                if (retryBtn) {
                    console.log('Found fetch button on retry, setting up...');
                    setupFetchButton();
                } else {
                    console.error('❌ Fetch button still not found after retry');
                }
            }, 100);
        }
    };
    
    setupFetchButton();
    
    // Enter key in URL input
    if (elements.colabUrlInput) {
        elements.colabUrlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                fetchFromUrl();
            }
        });
    }
}

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        showToast('Uploading notebook...', 'info');
        
        const response = await fetch('/api/upload-notebook', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Upload failed');
        }
        
        const data = await response.json();
        handleNotebookLoaded(data, false);
        
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function fetchFromUrl() {
    console.log('fetchFromUrl called');
    
    // Re-get elements in case they changed
    if (!elements.colabUrlInput) {
        elements.colabUrlInput = document.getElementById('colabUrlInput');
    }
    if (!elements.fetchUrlBtn) {
        elements.fetchUrlBtn = document.getElementById('fetchUrlBtn');
    }
    
    if (!elements.colabUrlInput) {
        console.error('colabUrlInput element not found');
        showToast('URL input field not found', 'error');
        return;
    }
    
    if (!elements.fetchUrlBtn) {
        console.error('fetchUrlBtn element not found');
        showToast('Fetch button not found', 'error');
        return;
    }
    
    const url = elements.colabUrlInput.value?.trim();
    if (!url) {
        showToast('Please enter a Colab URL', 'error');
        return;
    }
    
    try {
        console.log('Fetching from URL:', url);
        showToast('Fetching notebook from URL...', 'info');
        elements.fetchUrlBtn.disabled = true;
        elements.fetchUrlBtn.textContent = '⏳ Fetching...';
        
        const response = await fetch('/api/fetch-notebook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        
        console.log('Response status:', response.status);
        
        if (!response.ok) {
            let errorMessage = 'Fetch failed';
            try {
            const error = await response.json();
                errorMessage = error.detail || error.message || 'Fetch failed';
            } catch (e) {
                errorMessage = `HTTP ${response.status}: ${response.statusText}`;
            }
            throw new Error(errorMessage);
        }
        
        const data = await response.json();
        console.log('Notebook loaded successfully:', data.session_id);
        handleNotebookLoaded(data, true);
        
    } catch (error) {
        console.error('Error fetching notebook:', error);
        showToast(`Error: ${error.message}`, 'error');
    } finally {
        if (elements.fetchUrlBtn) {
            elements.fetchUrlBtn.disabled = false;
            elements.fetchUrlBtn.textContent = '📥 Fetch';
        }
    }
}

function handleNotebookLoaded(data, isUrl = false) {
    // Clear any previous results when loading a new notebook
    clearPreviousResults();
    
    state.sessionId = data.session_id;
    state.notebook = data.notebook;
    // Store original notebook JSON for WYSIWYG snapshot
    state.originalNotebookJson = data.original_notebook_json || null;
    // Store URL if this was fetched from URL
    if (isUrl && data.notebook) {
        state.notebook.url = elements.colabUrlInput?.value || null;
    }
    
    // Save sessionId to localStorage for restoration on refresh
    if (data.session_id) {
        localStorage.setItem('modelHunter_sessionId', data.session_id);
        console.log('💾 Saved sessionId to localStorage:', data.session_id);
    }
    
    // Toggle UI sections
    // Keep URL section visible (don't hide uploadSection)
    elements.huntSection.classList.remove('hidden');
    
    // Handle Save to Drive visibility (Container)
    if (elements.saveDriveContainer) {
        if (isUrl) {
            elements.saveDriveContainer.classList.remove('hidden');
        } else {
            elements.saveDriveContainer.classList.add('hidden');
        }
    }
    
    showToast('Notebook loaded! Configure hunt settings.', 'success');
    
    // Show config section
    elements.configSection.classList.remove('hidden');
    
    // Preselect model based on notebook metadata or model_slots
    let modelPrefix = null;
    let modelSource = null; // Track where we got the model from
    
    // First, try to get model from metadata (most explicit) - PRIORITY 1
    console.log('🔍 Checking metadata for model:', data.notebook.metadata);
    if (data.notebook.metadata) {
        const metadata = data.notebook.metadata;
        console.log('   Metadata keys:', Object.keys(metadata));
        console.log('   Full metadata:', JSON.stringify(metadata, null, 2));
        
        // Try multiple variations: Model, model, MODEL, and case-insensitive search
        let rawModel = metadata.Model || metadata.model || metadata['Model'] || metadata['model'];
        
        // Also try case-insensitive search
        if (!rawModel) {
            const modelKey = Object.keys(metadata).find(k => k.toLowerCase() === 'model');
            if (modelKey) {
                rawModel = metadata[modelKey];
                console.log(`   Found model key (case-insensitive): "${modelKey}" = "${rawModel}"`);
            }
        }
        
        if (rawModel) {
            // Clean the value: remove leading dashes, spaces, colons, trim
            // Handles cases like "Model: - qwen" -> "qwen", " - qwen" -> "qwen"
            modelPrefix = rawModel.toString().trim().replace(/^[-:\s]+/, '').trim();
            if (modelPrefix) {
                console.log(`✅ Detected model from metadata: "${rawModel}" -> "${modelPrefix}"`);
                modelSource = 'metadata';
            } else {
                console.warn(`⚠️ Model value in metadata was empty after cleaning: "${rawModel}"`);
            }
        } else {
            console.log('   No Model field found in metadata');
        }
    } else {
        console.log('   No metadata object found');
    }
    
    // Fallback: extract from model_slots ONLY if metadata didn't provide a model - PRIORITY 2
    if (!modelPrefix && data.notebook.model_prefix) {
        modelPrefix = data.notebook.model_prefix;
        modelSource = 'model_slots';
        console.log(`⚠️ Using model prefix from model_slots (metadata had no valid Model field): ${modelPrefix}`);
    }
    
    // Warn if there's a conflict between metadata and model_slots
    if (modelSource === 'metadata' && data.notebook.model_prefix && 
        modelPrefix.toLowerCase() !== data.notebook.model_prefix.toLowerCase()) {
        console.warn(`⚠️ CONFLICT: Metadata says "${modelPrefix}" but model_slots say "${data.notebook.model_prefix}". Using metadata (PRIORITY).`);
    }
    
    // If still no model, check if default should be used
    if (!modelPrefix) {
        console.log('⚠️ No model detected from metadata or model_slots. Will use default (Qwen).');
        modelPrefix = 'qwen'; // Set default
        modelSource = 'default';
    }
    
    console.log(`📌 Final model selection: "${modelPrefix}" (source: ${modelSource})`);
    
    // Map model prefix to model ID
    if (modelPrefix) {
        const modelPrefixLower = modelPrefix.toLowerCase().trim();
        let modelId = null;
        let provider = 'openrouter'; // Default provider
        
        console.log(`🔍 Mapping model prefix: "${modelPrefix}" (lowercase: "${modelPrefixLower}")`);
        
        if (modelPrefixLower === 'nemotron' || modelPrefixLower.includes('nemotron')) {
            modelId = 'nvidia/nemotron-3-nano-30b-a3b';
            provider = 'openrouter';
            console.log(`  → Mapped to Nemotron`);
        } else if (modelPrefixLower === 'qwen' || modelPrefixLower.includes('qwen')) {
            // Prefer openrouter if available, fallback to fireworks
            if (PROVIDER_MODELS['openrouter']?.some(m => m.id.includes('qwen'))) {
                modelId = 'qwen/qwen3-235b-a22b-thinking-2507';
                provider = 'openrouter';
                console.log(`  → Mapped to Qwen (OpenRouter)`);
            } else if (PROVIDER_MODELS['fireworks']?.some(m => m.id.includes('qwen'))) {
                modelId = 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507';
                provider = 'fireworks';
                console.log(`  → Mapped to Qwen (Fireworks)`);
            }
        } else {
            console.warn(`⚠️ Unknown model prefix: "${modelPrefix}". Will use default (Qwen).`);
            // Default to Qwen if unknown
            modelId = 'qwen/qwen3-235b-a22b-thinking-2507';
            provider = 'openrouter';
        }
        
        // Set the provider and model if found
        if (modelId && elements.providerSelect && elements.modelSelect) {
            console.log(`🎯 Setting model: ${modelId} for provider: ${provider} (source: ${modelSource})`);
            // Set provider first
            elements.providerSelect.value = provider;
            // Update model dropdown options for the provider (skip default selection)
            updateModelOptions(true); // Skip default - we'll set it manually
            // Small delay to ensure dropdown is updated, then set model
            setTimeout(() => {
                const option = elements.modelSelect.querySelector(`option[value="${modelId}"]`);
                if (option) {
                    // Force selection
                    option.selected = true;
                    elements.modelSelect.value = modelId;
                    // Update state config
                    state.config.models = [modelId];
                    console.log(`✅ Preselected model: ${modelId} (provider: ${provider}) based on: ${modelPrefix} (${modelSource})`);
                    console.log(`   Dropdown value after setting: ${elements.modelSelect.value}`);
                    console.log(`   Selected option: ${option.textContent}`);
                    showToast(`Model preselected: ${modelPrefix}`, 'info');
                    
                    // Validate model match after preselection
                    setTimeout(() => validateModelMatch(), 100);
                } else {
                    console.error(`❌ Model ${modelId} not found in dropdown. Available options:`, 
                        Array.from(elements.modelSelect.options).map(o => ({value: o.value, text: o.textContent})));
                    showToast(`Model ${modelPrefix} not available in dropdown`, 'warning');
                }
            }, 200); // Increased delay to ensure dropdown is populated
        } else {
            console.warn('⚠️ Provider or model select elements not found');
        }
    } else {
        // No model detected - use default (Qwen)
        console.log('ℹ️ No model detected, using default: Qwen');
        if (elements.providerSelect && elements.modelSelect) {
            elements.providerSelect.value = 'openrouter';
            updateModelOptions();
            setTimeout(() => {
                const defaultModel = 'qwen/qwen3-235b-a22b-thinking-2507';
                if (elements.modelSelect.querySelector(`option[value="${defaultModel}"]`)) {
                    elements.modelSelect.value = defaultModel;
                    state.config.models = [defaultModel];
                }
            }, 100);
        }
    }
    
    // Reset Start Hunt button state (must validate new notebook first)
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Judge the reference response first (click "Judge Reference Response")';
    }
    
    // Populate preview tabs
    populatePreviewTabs(data.notebook);
    
    // Check for validation warnings
    if (data.notebook.validation_warnings && data.notebook.validation_warnings.length > 0) {
        const warnings = data.notebook.validation_warnings;
        console.warn('Notebook validation warnings:', warnings);
        
        // Show warning toast for each issue
        warnings.forEach(warning => {
            showToast(`⚠️ ${warning}`, 'error');
        });
        
        // Also display in the reference preview tab
        if (elements.referencePreview) {
            elements.referencePreview.innerHTML = `
                <div style="color: var(--danger); margin-bottom: 1rem; padding: 0.75rem; background: var(--danger-bg); border-radius: 8px;">
                    <strong>⚠️ JSON Validation Issues:</strong>
                    <ul style="margin: 0.5rem 0 0 1.5rem;">
                        ${warnings.map(w => `<li>${w}</li>`).join('')}
                    </ul>
                </div>
                <pre style="white-space: pre-wrap; word-break: break-word;">${data.notebook.response_reference || 'No reference found'}</pre>
            `;
        }
        
        showToast('Notebook loaded with validation warnings', 'warning');
    } else {
        showToast('Notebook loaded successfully!', 'success');
    }
}

async function saveToDrive() {
    if (!state.sessionId) return;
    
    // ===== SARCASTIC CONFIRMATION DIALOG =====
    const confirmed = confirm(
        `🚨 FINAL WARNING: ONE-TIME ACTION 🚨\n\n` +
        `Are you ABSOLUTELY, POSITIVELY, 100% CERTAIN you want to save?\n\n` +
        `Because once you click "OK", there's no going back.\n` +
        `No undo button. No "oops, let me fix that".\n` +
        `This is it. The point of no return.\n\n` +
        `Did you:\n` +
        `✅ Review all selected responses carefully?\n` +
        `✅ Grade all criteria correctly?\n` +
        `✅ Write explanations that make sense?\n` +
        `✅ Double-check everything?\n\n` +
        `If you're not 100% sure, click "Cancel" and go back.\n` +
        `If you're ready to commit to this forever, click "OK".\n\n` +
        `Last chance to back out...`
    );
    
    if (!confirmed) {
        showToast('Smart move. Double-check everything before saving!', 'info');
        return;
    }
    
    // ===== VALIDATION 0: Check LLM revealed =====
    if (!state.llmRevealed) {
        showToast('Complete all reviews and reveal LLM judgments before saving.', 'error');
        return;
    }
    
    // FIX 3: Require exactly 4 reviews before allowing save
    const selectedRowNumbers = state.selectedRowNumbers || [];
    if (selectedRowNumbers.length === 0) {
        showToast(`Please select hunts for review.`, 'error');
        return;
    }
    
    if (selectedRowNumbers.length !== 4) {
        showToast(`Must have exactly 4 hunts selected. Currently: ${selectedRowNumbers.length}`, 'error');
        return;
    }
    
    // Get selected results and their hunt_ids
    const selectedResults = selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r);
    const selectedHuntIds = selectedResults.map(r => r.hunt_id);
    
    // Check that reviews exist for all selected row numbers (using row number keys)
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const missingReviews = reviewKeys.filter(key => !state.humanReviews || !state.humanReviews[key]);
    if (missingReviews.length > 0) {
        showToast(`Missing reviews for ${missingReviews.length} selected hunt(s). Please complete all reviews first.`, 'error');
        console.error('Missing reviews for row numbers:', missingReviews);
        console.error('Available review keys:', Object.keys(state.humanReviews || {}));
        return;
    }
    
    // Get reviews only for selected row numbers
    const reviews = reviewKeys.map(key => state.humanReviews[key]).filter(r => r);
    
    if (reviews.length !== selectedRowNumbers.length) {
        showToast(`Only ${reviews.length}/${selectedRowNumbers.length} review(s) found for selected hunts. Please complete all reviews.`, 'error');
        return;
    }
    
    // ===== VALIDATION 1b: Check each review has criteria grading and explanation =====
    const incompleteReviews = [];
    
    for (let i = 0; i < reviews.length; i++) {
        const review = reviews[i];
        const reviewNum = i + 1;
        const issues = [];
        
        // Check for criteria grading
        const gradingBasis = review.grading_basis || {};
        const gradedCriteria = Object.keys(gradingBasis).filter(k => 
            gradingBasis[k] && (gradingBasis[k].toUpperCase() === 'PASS' || gradingBasis[k].toUpperCase() === 'FAIL')
        );
        
        if (gradedCriteria.length === 0) {
            issues.push('missing criteria grading');
        }
        
        // Check for explanation
        const explanation = (review.explanation || '').trim();
        if (!explanation || explanation.length < 10) {
            issues.push('missing or too short explanation');
        }
        
        if (issues.length > 0) {
            incompleteReviews.push(`Slot ${reviewNum}: ${issues.join(', ')}`);
        }
    }
    
    if (incompleteReviews.length > 0) {
        showToast(`${incompleteReviews.length} review(s) incomplete. Add criteria grading and explanation.`, 'error');
        alert(
            `Cannot save: Incomplete reviews!\n\n` +
            `Each review must have:\n` +
            `• Criteria grading (PASS/FAIL for each criterion)\n` +
            `• A detailed explanation (at least 10 characters)\n\n` +
            `Incomplete reviews:\n${incompleteReviews.join('\n')}\n\n` +
            `Please complete all reviews before saving.`
        );
        return;
    }
    
    // ===== VALIDATION 2: Removed - no longer require specific combination =====
    // Allow any combination of hunts to be saved
    const failCount = reviews.filter(r => r.judgment === 'bad' || r.judgment === 'fail').length;
    const passCount = reviews.filter(r => r.judgment === 'good' || r.judgment === 'pass').length;
    
    // Log combination for informational purposes only
    console.log(`Saving ${reviews.length} review(s): ${failCount} failing, ${passCount} passing`);
    
    // ===== VALIDATION: Check if diversity check was already passed at confirmation =====
    if (!state.diversityCheckPassed) {
        console.warn('⚠️ Diversity check not passed at confirmation. This should not happen if user confirmed selection properly.');
        showToast('Diversity check was not completed. Please confirm your selection again.', 'error');
        return;
    }
    
    console.log('✅ Diversity check already passed at confirmation - proceeding with save');
    
    // ===== All validations passed - proceed with save =====
    const btn = document.getElementById('saveDriveBtn');
    if (!btn) {
        console.error("Save button not found");
        return;
    }
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Saving...';
    
    try {
        // Convert row-based review keys back to hunt_id-based keys for backend compatibility
        const selectedRowNumbers = state.selectedRowNumbers || [];
        const selectedResults = selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r);
        const reviewsForBackend = {};
        const missingReviews = [];
        
        console.log('DEBUG: Preparing reviews for backend:');
        console.log('  selectedRowNumbers:', selectedRowNumbers);
        console.log('  selectedResults hunt_ids:', selectedResults.map(r => r.hunt_id));
        console.log('  state.humanReviews keys:', Object.keys(state.humanReviews || {}));
        
        selectedRowNumbers.forEach((rn, index) => {
            const reviewKey = `row_${rn}`;
            const review = state.humanReviews[reviewKey];
            const currentSlotNum = index + 1;
            
            console.log(`DEBUG: Processing slot ${currentSlotNum}:`);
            console.log(`  row_number: ${rn}, reviewKey: ${reviewKey}`);
            console.log(`  review exists: ${!!review}`);
            console.log(`  selectedResults[${index}] exists: ${!!selectedResults[index]}`);
            console.log(`  selectedResults[${index}].hunt_id: ${selectedResults[index]?.hunt_id}`);
            
            if (review && selectedResults[index]) {
                // CRITICAL FIX: Use slotNum as part of the key to handle duplicate hunt_ids
                // Format: "hunt_id:slotNum" to ensure uniqueness
                const uniqueKey = `${selectedResults[index].hunt_id}:${currentSlotNum}`;
                reviewsForBackend[uniqueKey] = {
                    hunt_id: selectedResults[index].hunt_id,  // Keep hunt_id for reference
                    judgment: review.judgment,
                    grading_basis: review.grading_basis,
                    explanation: review.explanation,
                    slotNum: currentSlotNum,  // Use current position, not the old slotNum from review
                    timestamp: review.timestamp
                };
                console.log(`  ✓ Mapped review for hunt_id ${selectedResults[index].hunt_id} -> slot ${currentSlotNum} (key: ${uniqueKey}, old slotNum was ${review.slotNum})`);
            } else if (selectedResults[index]) {
                // Review missing for this hunt
                console.log(`  ✗ MISSING REVIEW for slot ${currentSlotNum}, hunt_id ${selectedResults[index].hunt_id}`);
                missingReviews.push({
                    hunt_id: selectedResults[index].hunt_id,
                    row_number: rn,
                    slot_num: currentSlotNum
                });
            }
        });
        
        console.log('DEBUG: Final reviewsForBackend:', Object.keys(reviewsForBackend).map(hid => ({
            hunt_id: hid,
            slotNum: reviewsForBackend[hid].slotNum,
            judgment: reviewsForBackend[hid].judgment
        })));
        
        // VALIDATION: Check if reviews are missing before saving
        if (missingReviews.length > 0) {
            const missingHuntIds = missingReviews.map(m => m.hunt_id).join(', ');
            const missingRowNumbers = missingReviews.map(m => m.row_number).join(', ');
            
            const warningMessage = 
                `⚠️ WARNING: Reviews are missing for ${missingReviews.length} hunt(s):\n\n` +
                `Hunt IDs: ${missingHuntIds}\n` +
                `Row Numbers: ${missingRowNumbers}\n\n` +
                `These will be saved with empty review data.\n\n` +
                `Did you submit your reviews? Click "Cancel" to review them first, or "OK" to continue saving.`;
            
            const proceed = confirm(warningMessage);
            if (!proceed) {
                showToast('Save cancelled. Please complete your reviews first.', 'info');
                btn.disabled = false;
                btn.textContent = originalText;
                return;
            }
        }
        
        // ===== WYSIWYG SNAPSHOT APPROACH =====
        // Validate selectedResults has all required fields and maintains order
        if (selectedResults.length === 0) {
            throw new Error(`No selected results to save. Please select at least 1 hunt.`);
        }
        
        // Validate each result has required fields
        selectedResults.forEach((result, index) => {
            if (!result || typeof result !== 'object') {
                throw new Error(`Invalid result at index ${index}: must be an object`);
            }
            if (!result.hunt_id) {
                throw new Error(`Result at index ${index} missing 'hunt_id' field`);
            }
            if (result.response === undefined && result.response !== null) {
                throw new Error(`Result at index ${index} missing 'response' field`);
            }
        });
        
        console.log('📸 Creating snapshot:', {
            selectedResults: selectedResults.length,
            resultsOrder: selectedResults.map(r => r.hunt_id),
            reviews: Object.keys(reviewsForBackend).length,
            totalHunts: state.allResponses.length
        });
        
        // Validate we have original notebook
        // Get URL from notebook (stored when fetched)
        const notebookUrl = state.notebook?.url || document.getElementById('colabUrlInput')?.value;
        if (!notebookUrl) {
            throw new Error('No Colab URL found. Please fetch notebook from URL.');
        }
        
        // If original_notebook_json is missing, try to fetch it from the backend session storage
        let originalNotebookJson = state.originalNotebookJson;
        if (!originalNotebookJson && state.sessionId) {
            console.warn('⚠️ originalNotebookJson missing, attempting to fetch from session storage...');
            try {
                const response = await fetch(`/api/get-original-notebook/${state.sessionId}`);
                if (response.ok) {
                    const data = await response.json();
                    originalNotebookJson = data.original_notebook_json;
                    // Cache it in state for future use
                    state.originalNotebookJson = originalNotebookJson;
                    console.log('✅ Retrieved original notebook from session storage');
                } else {
                    console.error('Failed to fetch original notebook:', await response.text());
                }
            } catch (e) {
                console.error('Failed to fetch original content from session:', e);
            }
        }
        
        if (!originalNotebookJson) {
            throw new Error('Original notebook content not available. Please reload the notebook from URL or file.');
        }
        
        // Create snapshot
        // Note: selected_results order determines slots 1-4 (index 0 = slot 1, index 1 = slot 2, etc.)
        const snapshot = {
            original_notebook_json: originalNotebookJson,
            url: notebookUrl,
            selected_results: selectedResults,  // Order preserved - determines slot assignment
            human_reviews: reviewsForBackend,
            total_hunts_ran: state.allResponses.length,
            include_reasoning: true,
            metadata: {
                parsed_notebook: {
                    filename: state.notebook?.filename || 'notebook.ipynb',
                    metadata: state.notebook?.metadata || {},
                    prompt: state.notebook?.prompt || '',
                    response: state.notebook?.response || '',
                    response_reference: state.notebook?.response_reference || '',
                    judge_system_prompt: state.notebook?.judge_system_prompt || '',
                    judge_prompt_template: state.notebook?.judge_prompt_template || '',
                    model_slots: state.notebook?.model_slots || []
                }
            }
        };
        
        // Send snapshot to new endpoint
        const response = await fetch('/api/save-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snapshot)
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || err.error || 'Save failed');
        }
        
        const result = await response.json();
        console.log('✅ Snapshot saved successfully:', result);
        
        const successMessage = missingReviews.length > 0
            ? `✅ Saved to Google Drive! (Note: ${missingReviews.length} hunt(s) saved without reviews)`
            : '✅ Successfully saved to Colab notebook!';
        
        showToast(successMessage, missingReviews.length > 0 ? 'warning' : 'success');
        
    } catch (error) {
        console.error('Drive Save Error:', error);
        showToast(`Save failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

function populatePreviewTabs(notebook) {
    // Populate rich text editors (contentEditable divs)
    if (elements.promptPreview) {
        // For contentEditable, use textContent to set plain text (formatting will be added by user)
        elements.promptPreview.textContent = notebook.prompt || '';
        // Reset unsaved changes
        state.unsavedChanges.prompt = false;
        // Update word count display after loading
        setTimeout(() => validatePromptLength(), 100);
    }
    
    if (elements.referencePreview) {
        elements.referencePreview.textContent = notebook.response || '';
        state.unsavedChanges.response = false;
    }
    
    if (elements.judgePreview) {
        elements.judgePreview.textContent = notebook.judge_system_prompt || '';
        state.unsavedChanges.judge = false;
    }
    
    // Populate Model Reference with structured input
    if (elements.modelrefPreview) {
        // Convert JSON to structured text format if it's JSON
        const responseRef = notebook.response_reference || '';
        if (responseRef.trim().startsWith('[') || responseRef.trim().startsWith('{')) {
            // It's JSON, convert to structured format
            try {
                const json = JSON.parse(responseRef);
                if (Array.isArray(json)) {
                    const structured = json.map(item => {
                        const id = item.id || 'C1';
                        const criteriaKey = Object.keys(item).find(k => k.startsWith('criteria'));
                        const description = criteriaKey ? item[criteriaKey] : '';
                        return `${id}: ${description}`;
                    }).join('\n');
                    elements.modelrefPreview.value = structured;
                } else {
                    elements.modelrefPreview.value = responseRef;
                }
            } catch (e) {
                // If parsing fails, use as-is
                elements.modelrefPreview.value = responseRef;
            }
        } else {
            // Already in structured format or plain text
            elements.modelrefPreview.value = responseRef;
        }
    }
    
    // Display metadata FIRST - before any validation that might cause early return
    // This ensures metadata is always shown even if other parts of the notebook are invalid
    console.log('📊 Notebook metadata received:', notebook.metadata);
    console.log('📊 Metadata type:', typeof notebook.metadata);
    console.log('📊 Metadata keys:', notebook.metadata ? Object.keys(notebook.metadata) : 'null');
    console.log('📊 Full notebook object keys:', Object.keys(notebook));
    
    // Try multiple ways to get metadata
    let metadataToDisplay = null;
    if (notebook.metadata && typeof notebook.metadata === 'object' && Object.keys(notebook.metadata).length > 0) {
        metadataToDisplay = notebook.metadata;
    } else if (notebook.metadata) {
        // Metadata exists but might be empty
        metadataToDisplay = notebook.metadata;
    } else {
        console.warn('⚠️ No metadata found in notebook object');
        metadataToDisplay = {};
    }
    
    console.log('📊 Calling displayMetadata with:', metadataToDisplay);
    displayMetadata(metadataToDisplay);
    
    // Validate Model Reference is valid JSON format
    const modelRefValidation = validateModelReferenceJSON(notebook.response_reference || '');
    state.modelRefValid = modelRefValidation.valid;
    
    if (!modelRefValidation.valid) {
        showToast('⚠️ Model Reference is not valid JSON format!', 'error');
        if (elements.modelrefPreview) {
            elements.modelrefPreview.innerHTML = `
                <div style="color: var(--danger); margin-bottom: 1rem; padding: 0.75rem; background: var(--danger-bg); border-radius: 8px;">
                    <strong>❌ Invalid JSON Format</strong><br>
                    ${escapeHtml(modelRefValidation.error)}
                </div>
                <pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(notebook.response_reference || 'No content')}</pre>
            `;
        }
        // Disable Start Hunt if Model Reference is invalid
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = 'Model Reference must be valid JSON before hunting';
        }
    }
    
    // Parse and store criteria from response_reference
    let parsedCriteria;
    try {
        parsedCriteria = parseCriteria(notebook.response_reference || '');
        state.criteria = parsedCriteria;
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showToast(`❌ Failed to parse criteria: ${error.message}. Please fix the response_reference format.`, 'error');
        state.criteria = null;
        // Disable hunt button
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = `Criteria Parse Error: ${error.message}`;
        }
        // Don't return early - continue to initialize other features
        // Metadata is already displayed above
    }
    
    // Only continue with criteria-related code if parsing succeeded
    if (parsedCriteria && Array.isArray(parsedCriteria)) {
        // Store initial criteria to detect missing ones later
        // CRITICAL: Only set initialCriteria ONCE when notebook is first loaded
        // This must happen BEFORE any modifications to response_reference
        if (!state.initialCriteria || !Array.isArray(state.initialCriteria) || state.initialCriteria.length === 0) {
            state.initialCriteria = JSON.parse(JSON.stringify(parsedCriteria)); // Deep copy
            console.log('✅ INITIAL CRITERIA SET (first time):', state.initialCriteria.map(c => c.id));
            console.log('   Full initial criteria:', state.initialCriteria);
        } else {
            console.log('✅ INITIAL CRITERIA PRESERVED (not overwritten):', state.initialCriteria.map(c => c.id));
            console.log('   Current criteria:', parsedCriteria.map(c => c.id));
            console.log('   Missing from current:', state.initialCriteria
                .filter(c => !parsedCriteria.find(pc => pc.id === c.id))
                .map(c => c.id));
        }
        console.log('Parsed current criteria:', state.criteria);
        
        // Validate Model Reference: Check JSON format AND criteria completeness
        validateModelReferenceAndCriteria(notebook.response_reference || '');
    }
    
    // Initialize rich text editors
    initRichTextEditors();
    
    // Initialize structured input for Model Reference
    initStructuredInput();
    
    // Initialize prompt length validation
    initPromptLengthValidation();
    
    // Setup save button handlers
    setupSaveHandlers();
}

// ============== Metadata Display ==============

function displayMetadata(metadata) {
    console.log('📊 displayMetadata called with:', metadata);
    console.log('📊 metadataSidebar element:', elements.metadataSidebar);
    console.log('📊 metadataGrid element:', elements.metadataGrid);
    
    if (!elements.metadataSidebar || !elements.metadataGrid) {
        console.error('❌ Metadata sidebar elements not found!', {
            sidebar: !!elements.metadataSidebar,
            grid: !!elements.metadataGrid
        });
        return;
    }
    
    console.log('📊 Displaying metadata:', metadata);
    console.log('📊 Metadata keys:', metadata ? Object.keys(metadata) : 'null');
    console.log('📊 Full metadata object:', JSON.stringify(metadata, null, 2));
    
    state.metadata = metadata || {};
    
    // Don't return early if metadata is empty - still try to display what we can
    if (!metadata || (typeof metadata === 'object' && Object.keys(metadata).length === 0)) {
        console.warn('⚠️ No metadata to display or empty object, but will still try to show sidebar if elements exist');
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
            console.log('✅ Prompt length range set:', state.promptLengthRange);
            // Update word count display after range is set
            setTimeout(() => validatePromptLength(), 100);
        }
    }
    
    // Extract model from metadata
    const modelStr = (metadata && metadata['Model']) || (metadata && metadata['model']) || '';
    if (modelStr) {
        // Clean the model string (remove dashes, spaces, convert to lowercase)
        const cleanedModel = modelStr.toString().trim().replace(/^[-:\s]+/, '').toLowerCase();
        state.metadataModel = cleanedModel;
        console.log('✅ Metadata model extracted:', state.metadataModel);
        
        // Validate model match on initial load (after model is preselected)
        setTimeout(() => validateModelMatch(), 500);
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
            icon: '🆔', 
            label: 'Task ID',
            badge: true 
        },
        { 
            keys: ['Domain', 'Domain:', 'domain'], 
            icon: '🌐', 
            label: 'Domain' 
        },
        { 
            keys: ['Use Case', 'Use Case:', 'use case', 'UseCase'], 
            icon: '💼', 
            label: 'Use Case' 
        },
        { 
            keys: ['L1 Taxonomy', 'L1 Taxonomy:', 'l1 taxonomy', 'L1Taxonomy'], 
            icon: '📚', 
            label: 'L1 Taxonomy' 
        },
        { 
            keys: ['User Prompt Length', 'User Prompt length', 'User Prompt Length:', 'user prompt length'], 
            icon: '📏', 
            label: 'User Prompt Length' 
        },
        { 
            keys: ['Model', 'Model:', 'model'], 
            icon: '🤖', 
            label: 'Model' 
        }
    ];
    
    let hasAnyData = false;
    let itemsAdded = 0;
    
    fields.forEach(field => {
        const value = getValue(field.keys);
        
        // Always show the field, even if value is null (will show N/A)
        const displayValue = value || 'N/A';
        
        // Skip Task ID only if it's truly missing (not just N/A)
        if (field.label === 'Task ID' && !value) {
            console.log('⚠️ Task ID not found, skipping Task ID field');
            return; // Skip Task ID if not found
        }
        
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
        
        if (field.badge && value) {
            const badge = document.createElement('span');
            badge.className = 'metadata-badge';
            badge.textContent = displayValue;
            badge.style.cursor = 'pointer';
            badge.title = 'Click to copy';
            badge.addEventListener('click', () => {
                navigator.clipboard.writeText(displayValue);
                showToast('✅ Task ID copied to clipboard!', 'success');
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
    
    console.log('📊 Metadata display summary:', {
        hasAnyData,
        itemsAdded,
        childrenCount: elements.metadataGrid.children.length,
        metadataKeys: Object.keys(metadata)
    });
    
    // Show metadata sidebar if we have any data OR if we added any items
    // This ensures sidebar shows even if some fields are missing
    const shouldShow = hasAnyData || itemsAdded > 0 || elements.metadataGrid.children.length > 0;
    
    console.log('📊 Metadata sidebar visibility check:', {
        hasAnyData,
        itemsAdded,
        childrenCount: elements.metadataGrid.children.length,
        shouldShow,
        sidebarElement: !!elements.metadataSidebar,
        gridElement: !!elements.metadataGrid
    });
    
    if (shouldShow) {
        if (elements.metadataSidebar) {
            elements.metadataSidebar.style.display = 'block';
            elements.metadataSidebar.classList.remove('collapsed');
            document.body.classList.add('sidebar-visible');
            console.log('✅ Metadata sidebar displayed with', elements.metadataGrid.children.length, 'items');
        } else {
            console.error('❌ Metadata sidebar element not found!');
        }
    } else {
        if (elements.metadataSidebar) {
            elements.metadataSidebar.style.display = 'none';
            elements.metadataSidebar.classList.remove('collapsed');
            document.body.classList.remove('sidebar-visible');
            console.warn('⚠️ No metadata items to display, hiding sidebar');
        }
    }
}

// ============== Rich Text Editor ==============

function initRichTextEditors() {
    // Initialize toolbar buttons for all rich text editors
    document.querySelectorAll('.rich-text-toolbar').forEach(toolbar => {
        toolbar.querySelectorAll('.rich-text-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const command = btn.dataset.command;
                const editor = toolbar.nextElementSibling;
                
                if (editor && editor.contentEditable === 'true') {
                    editor.focus();
                    document.execCommand(command, false, null);
                    updateToolbarState(toolbar, editor);
                }
            });
        });
    });
    
    // Add keyboard shortcuts
    document.querySelectorAll('.rich-text-content').forEach(editor => {
        editor.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'b') {
                    e.preventDefault();
                    document.execCommand('bold', false, null);
                    updateToolbarState(editor.previousElementSibling, editor);
                } else if (e.key === 'i') {
                    e.preventDefault();
                    document.execCommand('italic', false, null);
                    updateToolbarState(editor.previousElementSibling, editor);
                }
            }
        });
        
        // Track changes
        editor.addEventListener('input', () => {
            const editorId = editor.id;
            if (editorId === 'promptPreview') {
                state.unsavedChanges.prompt = true;
                // Update word count live as user types
                validatePromptLength();
            } else if (editorId === 'referencePreview') {
                state.unsavedChanges.response = true;
            } else if (editorId === 'judgePreview') {
                state.unsavedChanges.judge = true;
            }
        });
        
        // Also validate on paste for prompt editor
        if (editor.id === 'promptPreview') {
            editor.addEventListener('paste', () => {
                // Use setTimeout to allow paste to complete first
                setTimeout(() => {
                    validatePromptLength();
                }, 10);
            });
        }
        
        // Handle placeholder
        editor.addEventListener('focus', () => {
            if (editor.textContent.trim() === '') {
                editor.textContent = '';
            }
        });
        
        editor.addEventListener('blur', () => {
            if (editor.textContent.trim() === '') {
                const placeholder = editor.dataset.placeholder || '';
                if (placeholder) {
                    editor.textContent = '';
                }
            }
        });
    });
}

function updateToolbarState(toolbar, editor) {
    if (!toolbar || !editor) return;
    
    toolbar.querySelectorAll('.rich-text-btn').forEach(btn => {
        const command = btn.dataset.command;
        if (command === 'bold' || command === 'italic') {
            btn.classList.toggle('active', document.queryCommandState(command));
        }
    });
}

// ============== Structured Text to JSON Converter ==============

function initStructuredInput() {
    if (!elements.modelrefPreview) return;
    
    elements.modelrefPreview.addEventListener('input', () => {
        state.unsavedChanges.modelRef = true;
        convertStructuredToJSON();
    });
    
    // Initial conversion if content exists
    if (elements.modelrefPreview.value) {
        convertStructuredToJSON();
    }
}

function convertStructuredToJSON() {
    if (!elements.modelrefPreview || !elements.jsonPreviewContent) return;
    
    const inputText = elements.modelrefPreview.value.trim();
    
    if (!inputText) {
        elements.jsonPreviewContent.textContent = 'Enter criteria above to see JSON preview...';
        elements.jsonPreviewContent.className = 'json-preview-content';
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
        
        // Display and store the JSON
        elements.jsonPreviewContent.textContent = jsonString;
        elements.jsonPreviewContent.className = 'json-preview-content valid';
        
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
        elements.jsonPreviewContent.textContent = `Error: ${error.message}`;
        elements.jsonPreviewContent.className = 'json-preview-content error';
        
        if (elements.jsonPreviewStatus) {
            elements.jsonPreviewStatus.textContent = '❌ Invalid format';
            elements.jsonPreviewStatus.style.color = 'var(--danger)';
        }
        
        state.convertedModelRefJSON = null;
        
        // Mark JSON as invalid and disable hunt button
        state.modelRefValid = false;
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = `Model Reference JSON Error: ${error.message}`;
        }
    }
}

// ============== Prompt Length Validation ==============

function initPromptLengthValidation() {
    if (!elements.promptPreview) return;
    
    // Validate on input
    elements.promptPreview.addEventListener('input', validatePromptLength);
}

function validatePromptLength() {
    if (!elements.promptPreview) {
        return true; // No validation if element not found
    }
    
    const text = elements.promptPreview.textContent || '';
    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
    
    // Update live word count display
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

// ============== Model Matching Validation ==============

function validateModelMatch() {
    if (!state.metadataModel || !elements.modelSelect) {
        return true; // No validation if metadata model not set
    }
    
    const selectedModel = elements.modelSelect.value || '';
    if (!selectedModel) {
        return true; // No model selected yet
    }
    
    const selectedModelLower = selectedModel.toLowerCase();
    
    // Extract model name from selected model ID
    let selectedModelName = '';
    if (selectedModelLower.includes('nemotron')) {
        selectedModelName = 'nemotron';
    } else if (selectedModelLower.includes('qwen')) {
        selectedModelName = 'qwen';
    } else {
        // Unknown model - allow it (might be a new model)
        return true;
    }
    
    // Check if selected model matches metadata model
    const metadataModelLower = state.metadataModel.toLowerCase();
    const matches = (
        (metadataModelLower.includes('qwen') && selectedModelName === 'qwen') ||
        (metadataModelLower.includes('nemotron') && selectedModelName === 'nemotron')
    );
    
    // Remove any existing warning
    const existingWarning = document.getElementById('modelMismatchWarning');
    if (existingWarning) {
        existingWarning.remove();
    }
    
    if (!matches && selectedModelName) {
        // Model mismatch - show warning and disable save/start buttons
        state.modelMismatchWarning = true;
        
        // Create warning element
        const warning = document.createElement('div');
        warning.id = 'modelMismatchWarning';
        warning.className = 'model-mismatch-warning';
        warning.innerHTML = `
            ⚠️ <strong>Model Mismatch!</strong><br>
            Metadata shows: <strong>${state.metadataModel}</strong> | Selected: <strong>${selectedModelName}</strong><br>
            Please double-check the model in metadata before proceeding.
        `;
        
        // Insert warning before model select
        const modelGroup = elements.modelSelect.closest('.form-group');
        if (modelGroup) {
            modelGroup.appendChild(warning);
        }
        
        // Disable start hunt button
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = 'Model mismatch detected. Please select the correct model from metadata.';
        }
        
        // Disable save buttons
        disableSaveButtons(true);
        
        showToast('⚠️ Model mismatch detected! Please select the correct model from metadata.', 'error');
        return false;
    } else {
        // Model matches or no model selected yet
        state.modelMismatchWarning = false;
        
        // Enable start hunt button
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }
        
        // Enable save buttons
        disableSaveButtons(false);
        
        return true;
    }
}

function disableSaveButtons(disable) {
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

// ============== Save Handlers ==============

function setupSaveHandlers() {
    // Individual save buttons
    if (elements.savePromptBtn) {
        elements.savePromptBtn.addEventListener('click', () => saveCell('prompt'));
    }
    
    if (elements.saveResponseBtn) {
        // Keep existing handler, but update to use new format
        // The existing saveAndRejudge function will be updated
    }
    
    if (elements.saveModelRefBtn) {
        elements.saveModelRefBtn.addEventListener('click', () => saveCell('response_reference'));
    }
    
    if (elements.saveJudgeBtn) {
        elements.saveJudgeBtn.addEventListener('click', () => saveCell('judge_system_prompt'));
    }
    
    // Save All button
    if (elements.saveAllBtn) {
        elements.saveAllBtn.addEventListener('click', saveAllCells);
    }
}

async function saveCell(cellType) {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    // Validate prompt length if saving prompt
    if (cellType === 'prompt' && !validatePromptLength()) {
        showToast('⚠️ Cannot save: Prompt length is outside the required range', 'error');
        return;
    }
    
    let content = '';
    let cellHeading = '';
    
    switch (cellType) {
        case 'prompt':
            // Get text content from contentEditable div (strips HTML formatting for now)
            content = elements.promptPreview?.textContent || elements.promptPreview?.innerText || '';
            cellHeading = 'prompt';
            break;
        case 'response':
            content = elements.referencePreview?.textContent || elements.referencePreview?.innerText || '';
            cellHeading = 'response';
            break;
        case 'response_reference':
            // Use converted JSON if available, otherwise try to convert now
            if (!state.convertedModelRefJSON) {
                convertStructuredToJSON();
            }
            content = state.convertedModelRefJSON || '';
            if (!content) {
                showToast('⚠️ Please ensure Model Reference is in valid format', 'error');
                return;
            }
            cellHeading = 'response_reference';
            break;
        case 'judge_system_prompt':
            content = elements.judgePreview?.textContent || elements.judgePreview?.innerText || '';
            cellHeading = 'judge_system_prompt';
            break;
        default:
            showToast('Unknown cell type', 'error');
            return;
    }
    
    if (!content.trim()) {
        showToast(`${cellType} cannot be empty`, 'error');
        return;
    }
    
    try {
        let btn = null;
        if (cellType === 'prompt') {
            btn = elements.savePromptBtn;
        } else if (cellType === 'response') {
            btn = elements.saveResponseBtn;
        } else if (cellType === 'response_reference') {
            btn = elements.saveModelRefBtn;
        } else if (cellType === 'judge_system_prompt') {
            btn = elements.saveJudgeBtn;
        }
        
        const originalText = btn ? btn.textContent : '';
        
        if (btn) {
            btn.disabled = true;
            btn.textContent = '💾 Saving...';
        }
        
        const response = await fetch(`/api/update-notebook-cell/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cell_type: cellHeading,
                content: content
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to save');
        }
        
        const data = await response.json();
        showToast(`✅ ${cellType} saved to Colab!`, 'success');
        
        // Mark as saved
        state.unsavedChanges[cellType === 'response_reference' ? 'modelRef' : cellType] = false;
        
        // If saving response, also re-judge
        if (cellType === 'response') {
            await judgeReferenceResponse();
        }
        
    } catch (error) {
        showToast(`❌ Error saving ${cellType}: ${error.message}`, 'error');
    } finally {
        let btn = null;
        let originalText = '';
        if (cellType === 'prompt') {
            btn = elements.savePromptBtn;
            originalText = '💾 Save Prompt';
        } else if (cellType === 'response') {
            btn = elements.saveResponseBtn;
            originalText = '💾 Save Response';
        } else if (cellType === 'response_reference') {
            btn = elements.saveModelRefBtn;
            originalText = '💾 Save Model Reference';
        } else if (cellType === 'judge_system_prompt') {
            btn = elements.saveJudgeBtn;
            originalText = '💾 Save Judge Prompt';
        }
        
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

async function saveAllCells() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    // Validate prompt length
    if (!validatePromptLength()) {
        showToast('⚠️ Cannot save: Prompt length is outside the required range', 'error');
        return;
    }
    
    // Check if Model Reference is valid
    if (!state.convertedModelRefJSON) {
        convertStructuredToJSON();
        if (!state.convertedModelRefJSON) {
            showToast('⚠️ Please ensure Model Reference is in valid format', 'error');
            return;
        }
    }
    
    const cellsToSave = [];
    
    // Collect all edited content
    const promptContent = elements.promptPreview?.textContent || elements.promptPreview?.innerText || '';
    if (promptContent.trim()) {
        cellsToSave.push({
            cell_type: 'prompt',
            content: promptContent
        });
    }
    
    const responseContent = elements.referencePreview?.textContent || elements.referencePreview?.innerText || '';
    if (responseContent.trim()) {
        cellsToSave.push({
            cell_type: 'response',
            content: responseContent
        });
    }
    
    // Ensure Model Reference is converted
    if (!state.convertedModelRefJSON) {
        convertStructuredToJSON();
    }
    if (state.convertedModelRefJSON) {
        cellsToSave.push({
            cell_type: 'response_reference',
            content: state.convertedModelRefJSON
        });
    }
    
    const judgeContent = elements.judgePreview?.textContent || elements.judgePreview?.innerText || '';
    if (judgeContent.trim()) {
        cellsToSave.push({
            cell_type: 'judge_system_prompt',
            content: judgeContent
        });
    }
    
    if (cellsToSave.length === 0) {
        showToast('No changes to save', 'info');
        return;
    }
    
    try {
        if (elements.saveAllBtn) {
            elements.saveAllBtn.disabled = true;
            elements.saveAllBtn.textContent = '💾 Saving All...';
        }
        
        const response = await fetch(`/api/update-notebook-cells/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cells: cellsToSave })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to save');
        }
        
        const data = await response.json();
        showToast(`✅ All changes saved to Colab! (${cellsToSave.length} cells)`, 'success');
        
        // Mark all as saved
        Object.keys(state.unsavedChanges).forEach(key => {
            state.unsavedChanges[key] = false;
        });
        
        // Re-judge if response was saved
        if (cellsToSave.some(c => c.cell_type === 'response')) {
            await judgeReferenceResponse();
        }
        
    } catch (error) {
        showToast(`❌ Error saving: ${error.message}`, 'error');
    } finally {
        if (elements.saveAllBtn) {
            elements.saveAllBtn.disabled = false;
            elements.saveAllBtn.textContent = '💾 Save All Changes to Colab';
        }
    }
}

// Validate Model Reference: JSON format AND criteria completeness
function validateModelReferenceAndCriteria(responseReference) {
    // Step 1: Check JSON format
    const jsonValidation = validateModelReferenceJSON(responseReference);
    state.modelRefValid = jsonValidation.valid;
    
    if (!jsonValidation.valid) {
        // JSON is invalid - show error and disable hunt
        if (elements.modelrefPreview) {
            elements.modelrefPreview.innerHTML = `
                <div style="color: var(--danger); margin-bottom: 1rem; padding: 0.75rem; background: var(--danger-bg); border-radius: 8px;">
                    <strong>❌ Invalid JSON Format</strong><br>
                    ${escapeHtml(jsonValidation.error)}
                </div>
                <pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(responseReference || 'No content')}</pre>
            `;
        }
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = `Model Reference JSON Error: ${jsonValidation.error}`;
        }
        return;
    }
    
    // Step 2: JSON is valid, now check criteria completeness
    let currentCriteria;
    try {
        currentCriteria = parseCriteria(responseReference);
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showToast(`❌ Failed to parse criteria: ${error.message}`, 'error');
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = `Criteria Parse Error: ${error.message}`;
        }
        return;
    }
    const currentCriteriaIds = new Set(currentCriteria.map(c => c.id));
    const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
    const missingCriteriaIds = [...initialCriteriaIds].filter(id => !currentCriteriaIds.has(id));
    
    if (missingCriteriaIds.length > 0) {
        // Criteria are missing - show warning and disable hunt
        const missingList = missingCriteriaIds.map(id => {
            const criterion = (state.initialCriteria || []).find(c => c.id === id);
            return `• ${id}: ${criterion ? criterion.criteria.substring(0, 60) + '...' : 'Description not available'}`;
        }).join('<br>');
        
        if (elements.modelrefPreview) {
            elements.modelrefPreview.innerHTML = `
                <div style="color: var(--warning); margin-bottom: 1rem; padding: 0.75rem; background: var(--warning-bg); border-radius: 8px;">
                    <strong>⚠️ Missing Criteria</strong><br>
                    The following criteria from the original notebook are missing from Model Reference:<br>
                    ${missingList}
                </div>
                <pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(responseReference || 'No content')}</pre>
            `;
        }
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = `Missing criteria: ${missingCriteriaIds.join(', ')}. Please add them back to Model Reference.`;
        }
        showToast(`⚠️ Missing criteria: ${missingCriteriaIds.join(', ')}`, 'warning');
        return;
    }
    
    // Step 3: JSON is valid AND all criteria are present
    // Check if reference was already validated (judged and passed)
    // If already validated, enable the button; otherwise keep it disabled until judging
    if (elements.modelrefPreview) {
        elements.modelrefPreview.textContent = responseReference || 'No model reference criteria found';
    }
    if (elements.startHuntBtn) {
        // Only enable if reference was already validated (judged and all criteria passed)
        if (state.referenceValidated && state.modelRefValid) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        } else {
            // Don't enable yet - still need to judge first
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = 'Model Reference is valid. Click "Judge Reference Response" to validate.';
        }
    }
    console.log('✅ Model Reference validation passed: JSON valid and all criteria present');
}

// Validate that Model Reference is valid JSON format with criteria
// Only validates the JSON array between [ and ], ignoring any text outside
function validateModelReferenceJSON(responseReference) {
    if (!responseReference || !responseReference.trim()) {
        return { valid: false, error: 'Model Reference is empty' };
    }
    
    try {
        // Extract only the JSON array between [ and ]
        const arrayMatch = responseReference.match(/\[[\s\S]*?\]/);
        
        if (!arrayMatch) {
            return { valid: false, error: 'Model Reference must contain a JSON array between [ and ] brackets' };
        }
        
        const jsonArrayStr = arrayMatch[0];
        const arr = JSON.parse(jsonArrayStr);
        
        if (!Array.isArray(arr)) {
            return { valid: false, error: 'Content between [ and ] must be a JSON array' };
        }
        
        if (arr.length === 0) {
            return { valid: false, error: 'JSON array cannot be empty' };
        }
        
        // Validate each item has id and criteria fields
        for (let idx = 0; idx < arr.length; idx++) {
            const item = arr[idx];
            if (typeof item !== 'object' || item === null) {
                return { valid: false, error: `Criterion at index ${idx} must be a JSON object` };
            }
            if (!item.id) {
                return { valid: false, error: `Criterion at index ${idx} is missing 'id' field` };
            }
            // Check for criteria1, criteria2, etc. fields
            const hasCriteria = Object.keys(item).some(key => key.startsWith('criteria') && key !== 'id');
            if (!hasCriteria) {
                return { valid: false, error: `Criterion at index ${idx} (id: ${item.id}) is missing a 'criteria' field` };
            }
        }
        
        return { valid: true };
        
    } catch (e) {
        return { valid: false, error: `JSON parse error: ${e.message}` };
    }
}

// Parse criteria from response_reference text
// Only parses the JSON array between [ and ], ignoring any text outside
// STRICT MODE: No fallback - throws error if parsing fails
function parseCriteria(responseReference) {
    if (!responseReference || !responseReference.trim()) {
        const error = 'Empty response_reference - cannot parse criteria';
        console.error(error);
        throw new Error(error);
    }
    
    // Clean the input - remove any leading/trailing whitespace
    const cleaned = responseReference.trim();
    
    try {
        // First, try to parse the entire string as JSON (most common case)
        let criteriaArray = null;
        let jsonArrayStr = null;
        
        try {
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) {
                criteriaArray = parsed;
                jsonArrayStr = cleaned;
                console.log('✅ Parsed as direct JSON array');
            } else {
                // It's JSON but not an array
                throw new Error('Parsed JSON is not an array');
            }
        } catch (jsonParseError) {
            // Not pure JSON, try to extract JSON array from text
            console.log('Not pure JSON, attempting extraction. Error:', jsonParseError.message);
            
            // Try to find JSON array with balanced brackets (most robust method)
            let bracketCount = 0;
            let startIndex = -1;
            let arrayMatch = null;
            
            for (let i = 0; i < cleaned.length; i++) {
                if (cleaned[i] === '[') {
                    if (bracketCount === 0) startIndex = i;
                    bracketCount++;
                } else if (cleaned[i] === ']') {
                    bracketCount--;
                    if (bracketCount === 0 && startIndex >= 0) {
                        arrayMatch = cleaned.substring(startIndex, i + 1);
                        break;
                    }
                }
            }
            
            // If balanced bracket matching failed, try regex as fallback
            if (!arrayMatch) {
                // Try greedy match (captures full array including nested arrays)
                const greedyMatch = cleaned.match(/\[[\s\S]*\]/);
                if (greedyMatch) {
                    arrayMatch = greedyMatch[0];
                } else {
                    // Try non-greedy
                    const nonGreedyMatch = cleaned.match(/\[[\s\S]*?\]/);
                    if (nonGreedyMatch) {
                        arrayMatch = nonGreedyMatch[0];
                    }
                }
            }
            
            if (arrayMatch) {
                try {
                    jsonArrayStr = arrayMatch;
                    criteriaArray = JSON.parse(jsonArrayStr);
                    console.log('✅ Extracted and parsed JSON array from text');
                } catch (parseError) {
                    console.error('Failed to parse extracted array:', parseError);
                    console.error('Extracted string:', arrayMatch.substring(0, 200));
                    throw new Error(`JSON parse error in response_reference: ${parseError.message}`);
                }
            } else {
                // No array found at all
                const error = 'No JSON array found between [ and ] brackets in response_reference';
                console.error(error);
                console.error('Response reference content (first 500 chars):', cleaned.substring(0, 500));
                throw new Error(error);
            }
        }
        
        if (!Array.isArray(criteriaArray) || criteriaArray.length === 0) {
            const error = 'JSON array is empty or invalid - must contain at least one criterion';
            console.error(error);
            throw new Error(error);
        }
        
        // Parse each criterion item
            const criteria = [];
        for (let idx = 0; idx < criteriaArray.length; idx++) {
            const item = criteriaArray[idx];
            
            if (typeof item !== 'object' || item === null) {
                continue;
            }
            
            const c_id = item.id || `C${idx + 1}`;
            
            // Look for criteria1, criteria2, etc. fields
            let criteriaText = null;
            for (const key of Object.keys(item)) {
                if (key.startsWith('criteria') && key !== 'id') {
                    criteriaText = item[key];
                    break;
                }
            }
            
            // Fallback to description or other fields
            if (!criteriaText) {
                criteriaText = item.description || item.criteria || item.text || JSON.stringify(item);
            }
            
            if (criteriaText) {
                criteria.push({ id: c_id, criteria: criteriaText });
            }
        }
        
        if (criteria.length > 0) {
            console.log('Parsed criteria from JSON array:', criteria);
            return criteria;
        }
        
        // Try alternative format: JSON object with C1, C2 keys
        const jsonObjMatch = responseReference.match(/\{[\s\S]*?"C\d+"[\s\S]*?\}/);
        if (jsonObjMatch) {
            try {
                const data = JSON.parse(jsonObjMatch[0]);
                const criteria = [];
                for (const key of Object.keys(data)) {
                    if (/^C\d+$/i.test(key)) {
                        const value = data[key];
                        const desc = typeof value === 'string' ? value : 
                                     (value?.description || value?.criteria || JSON.stringify(value));
                        criteria.push({ id: key.toUpperCase(), criteria: desc });
                    }
                }
                if (criteria.length > 0) {
                    console.log('Parsed criteria from embedded JSON:', criteria);
                    return criteria;
                }
            } catch (e) {
                // Continue to throw error
            }
        }
        
        const error = 'Could not extract valid criteria from response_reference JSON array';
        console.error(error);
        throw new Error(error);
        
    } catch (e) {
        if (e instanceof SyntaxError || e.message.includes('JSON')) {
            const error = `JSON parse error in response_reference: ${e.message}`;
            console.error(error);
            throw new Error(error);
        }
        // Re-throw if it's already our custom error
        throw e;
    }
}

function getDefaultCriteria() {
    return [
        { id: 'C1', criteria: 'Response meets formatting requirements' },
        { id: 'C2', criteria: 'Response follows exact instructions' },
        { id: 'C3', criteria: 'Response avoids violations' },
        { id: 'C4', criteria: 'Response maintains context' }
    ];
}

function initPreviewTabs() {
    if (!elements.previewTabs) return;
    
    const tabs = elements.previewTabs.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            const previewType = tab.dataset.preview;
            document.querySelectorAll('.preview-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById(`preview${previewType.charAt(0).toUpperCase() + previewType.slice(1)}`).classList.remove('hidden');
        });
    });
}


// ============== Hunt Configuration ==============

function getConfig() {
    const model = elements.modelSelect?.value || 'qwen/qwen3-235b-a22b-thinking-2507';
    const huntCount = parseInt(elements.parallelWorkers.value) || 4;
    
    // Create array with same model for all hunts
    const models = Array(huntCount).fill(model);
    
    return {
        parallel_workers: huntCount,
        target_breaks: huntCount, // All hunts should run (no early stop based on target)
        models: models,
        provider: elements.providerSelect ? elements.providerSelect.value : 'openrouter', // NEW
        reasoning_budget_percent: 0.9,
        max_retries: 3, // Hardcoded to 3 retries
        judge_model: 'gpt-5', // Always GPT-5
        independent_judging: true, // Mandatory per user request
        custom_judge_system_prompt: null
    };
}


// ============== Hunt Execution ==============

async function startHunt() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    if (state.isHunting) {
        showToast('Hunt already in progress', 'warning');
        return;
    }
    
    // MANDATORY: Check if reference was judged and all criteria passed (100%)
    if (!state.referenceValidated) {
        showToast('❌ You must judge the reference response first! Click "Judge Only" or "Save & Re-judge" before starting hunt.', 'error');
        return;
    }
    
    // MANDATORY: Check if reference was judged and all criteria passed (100%)
    if (!state.referenceValidated) {
        showToast('❌ You must judge the reference response first! All criteria must pass (100%) before starting hunt. Click "Judge Only" or "Save & Re-judge".', 'error');
        // Ensure button is disabled
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
        }
        return;
    }
    
    // Validate model match before starting
    if (!validateModelMatch()) {
        showToast('⚠️ Model mismatch detected! Please select the correct model from metadata.', 'error');
        return;
    }
    
    state.isHunting = true;
    state.config = getConfig();
    state.results = [];
    
    // Add loading state to button
    elements.startHuntBtn.classList.add('loading');
    elements.startHuntBtn.disabled = true;
    
    // FIX 4: Lock model and provider selection once hunt starts
    if (elements.modelSelect) {
        elements.modelSelect.disabled = true;
        elements.modelSelect.title = 'Model selection locked during hunt. Refresh page to change.';
    }
    if (elements.providerSelect) {
        elements.providerSelect.disabled = true;
        elements.providerSelect.title = 'Provider selection locked during hunt. Refresh page to change.';
    }
    
    // Hide upload and config sections during hunt
    document.querySelector('.section')?.classList.add('hidden'); // Hide upload section
    elements.configSection?.classList.add('hidden'); // Hide config section
    
    // Update config on server
    await fetch(`/api/update-config/${state.sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.config)
    });
    
    // Show progress section and reset it
    elements.progressSection.classList.remove('hidden');
    elements.resultsSection.classList.add('hidden');
    elements.summarySection.classList.add('hidden');
    
    // Initialize progress UI (resets progress to 0%)
    initProgressUI();
    
    // Scroll to progress section
    elements.progressSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    // Start SSE stream with reconnection support
    let eventSource = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 3;
    const reconnectDelay = 2000; // 2 seconds
    
    function connectSSE() {
        eventSource = new EventSource(`/api/hunt-stream/${state.sessionId}`);
        
        eventSource.onmessage = (event) => {
            console.log('SSE message:', event.data);
        };
        
        eventSource.addEventListener('start', (event) => {
            const data = JSON.parse(event.data);
            console.log('Hunt started:', data);
            reconnectAttempts = 0; // Reset on successful connection
        });
        
        eventSource.addEventListener('hunt_start', (event) => {
            const data = JSON.parse(event.data);
            updateTableRow(data.hunt_id, { status: 'running', model: data.model });
        });
        
        eventSource.addEventListener('hunt_result', (event) => {
            const data = JSON.parse(event.data);
            handleHuntResult(data);
        });
        
        eventSource.addEventListener('early_stop', (event) => {
            const data = JSON.parse(event.data);
            showToast(data.reason, 'info');
        });
        
        eventSource.addEventListener('complete', (event) => {
            const data = JSON.parse(event.data);
            handleHuntComplete(data);
            eventSource.close();
        });
        
        eventSource.addEventListener('error', (event) => {
            console.error('SSE error:', event);
            eventSource.close();
            
            // Try to reconnect if hunt is still in progress
            if (state.isHunting && reconnectAttempts < maxReconnectAttempts) {
                reconnectAttempts++;
                console.log(`SSE reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts}...`);
                showToast(`Connection lost. Reconnecting... (${reconnectAttempts}/${maxReconnectAttempts})`, 'warning');
                
                setTimeout(() => {
                    if (state.isHunting) {
                        connectSSE();
                    }
                }, reconnectDelay * reconnectAttempts);
                return;
            }
            
            // Max reconnect attempts reached or hunt finished
            state.isHunting = false;
            
            // Remove loading state from button
            elements.startHuntBtn.classList.remove('loading');
            elements.startHuntBtn.disabled = false;
            
            // Update status to show error
            if (elements.huntStatus) {
                elements.huntStatus.querySelector('.status-dot').className = 'status-dot failed';
                elements.statusText.textContent = 'Error - Connection lost';
            }
            
            showToast('Hunt connection error. Please try again.', 'error');
        });
        
        eventSource.addEventListener('ping', () => {
            // Keepalive, ignore
        });
    }
    
    // Start the connection
    connectSSE();
}

function initProgressUI() {
    const { parallel_workers, target_breaks } = state.config;
    
    // Save offset at start of THIS run for row lookup during hunt
    state.currentRunStartOffset = state.accumulatedHuntOffset;
    
    // Reset progress for THIS run only
    elements.progressFill.style.width = '0%';
    elements.progressText.textContent = `0 / ${parallel_workers} hunts complete`;
    elements.progressPercent.textContent = '0%';
    
    // Initialize breaks indicator for this run
    elements.breaksIndicator.innerHTML = '';
    for (let i = 0; i < target_breaks; i++) {
        const dot = document.createElement('span');
        dot.className = 'break-dot';
        dot.dataset.index = i;
        elements.breaksIndicator.appendChild(dot);
    }
    
    // APPEND table rows (don't clear!) - use offset for proper numbering
    const models = state.config.models;
    const offset = state.accumulatedHuntOffset;
    
    for (let i = 1; i <= parallel_workers; i++) {
        const globalRowNum = offset + i;
        const model = models[i - 1] || models[0];
        const shortModel = model.split('/').pop().split('-')[0];
        
        const row = document.createElement('tr');
        row.id = `hunt-row-${globalRowNum}`;
        row.innerHTML = `
            <td>${globalRowNum}</td>
            <td class="model-cell" title="${model}">${shortModel}</td>
            <td class="status-cell"><span class="score-badge pending">⏳ Pending</span></td>
            <td class="score-cell">-</td>
            <td class="issues-cell">-</td>
            <td class="response-cell" style="max-width: 400px;">
                <span class="response-placeholder" style="color: var(--text-muted);">-</span>
            </td>
        `;
        elements.resultsTableBody.appendChild(row);
    }
    
    // Update status
    elements.huntStatus.querySelector('.status-dot').className = 'status-dot running';
    elements.statusText.textContent = 'Running...';
}

function updateTableRow(huntId, data) {
    // Use global row number (offset + huntId)
    const globalRowNum = state.currentRunStartOffset + huntId;
    const row = document.getElementById(`hunt-row-${globalRowNum}`);
    if (!row) return;
    
    if (data.model) {
        const shortModel = data.model.split('/').pop().split('-')[0];
        row.querySelector('.model-cell').textContent = shortModel;
    }
    
    if (data.status === 'running') {
        row.querySelector('.status-cell').innerHTML = `
            <span class="score-badge pending">
                <span class="spinner"></span> Running
            </span>
        `;
    }
}

function handleHuntResult(data) {
    const { hunt_id, status, score, is_breaking, error, completed, total, breaks, response } = data;
    
    // Calculate global row number: offset at run start + hunt_id
    const globalRowNum = state.currentRunStartOffset + hunt_id;
    
    // Debug log
    console.log('Hunt Result:', { 
        hunt_id, 
        status, 
        score, 
        is_breaking, 
        globalRowNum,
        currentRunStartOffset: state.currentRunStartOffset 
    });
    
    // Store result with response data
    state.results.push(data);
    
    // Store in allResponses for selection phase (with row number for reference)
    if (response && status === 'completed' && !error) {
        const responseData = {
            ...data,
            rowNumber: globalRowNum - 1  // 0-based index for allResponses
        };
        // Only add if not already present (avoid duplicates on re-judging)
        const existingIndex = state.allResponses.findIndex(r => r.hunt_id === data.hunt_id);
        if (existingIndex >= 0) {
            state.allResponses[existingIndex] = responseData;
        } else {
            state.allResponses.push(responseData);
        }
    }
    
    // Add to blind judging queue if completed successfully (for criteria review later)
    if (status === 'completed' && !error) {
        state.blindJudging.queue.push(data);
    }
    
    // Update table row using global row number
    const row = document.getElementById(`hunt-row-${globalRowNum}`);
    if (row) {
        // Status
        if (status === 'failed') {
            row.querySelector('.status-cell').innerHTML = `
                <span class="score-badge" style="background: var(--danger-bg); color: var(--danger);">❌ Failed</span>
            `;
            row.querySelector('.score-cell').innerHTML = '-';
        } else {
            row.querySelector('.status-cell').innerHTML = `
                <span class="score-badge" style="background: var(--success-bg); color: var(--success);">✅ Done</span>
            `;
            
            // Score - SHOW IMMEDIATELY (score 0 = GREEN/wanted, score 1 = RED/not wanted)
            if (score !== null && score !== undefined) {
                row.querySelector('.score-cell').innerHTML = `
                    <span class="score-badge score-${score}">
                        ${score === 0 ? '✅ 0' : '❌ 1'}
                    </span>
                `;
            } else {
                // Score is null - display warning
                row.querySelector('.score-cell').innerHTML = `
                    <span class="score-badge" style="background: var(--warning-bg); color: var(--warning);">⚠️ ?</span>
                `;
            }
        }
        
        // Issues - SHOW IMMEDIATELY
        if (error) {
            row.querySelector('.issues-cell').textContent = error.substring(0, 50) + '...';
        } else if (is_breaking) {
            row.querySelector('.issues-cell').textContent = '🎯 Model breaking!';
        } else {
            row.querySelector('.issues-cell').textContent = '-';
        }
        
        // Response - SHOW IMMEDIATELY (expandable)
        const responseCell = row.querySelector('.response-cell');
        if (responseCell && response) {
            const responseText = response.trim();
            const responseId = `response-${globalRowNum}`;
            
            // Check if already initialized
            const isInitialized = responseCell.dataset.initialized === 'true';
            const isExpanded = responseCell.dataset.expanded === 'true';
            
            if (!isInitialized) {
                // Initialize expandable response
                responseCell.innerHTML = `
                    <div class="response-container" style="position: relative;">
                        <div class="response-preview" id="${responseId}" style="
                            max-height: 60px;
                            overflow: hidden;
                            white-space: pre-wrap;
                            word-break: break-word;
                            font-size: 0.85rem;
                            line-height: 1.4;
                            color: var(--text-primary);
                            cursor: pointer;
                            padding: 0.5rem;
                            background: var(--bg-tertiary);
                            border-radius: 4px;
                            transition: max-height 0.3s ease;
                        " onclick="toggleResponse(${globalRowNum})">
                            <span class="response-text">${escapeHtml(responseText)}</span>
                        </div>
                        <button class="response-toggle-btn" onclick="toggleResponse(${globalRowNum})" style="
                            position: absolute;
                            top: 0.25rem;
                            right: 0.25rem;
                            background: var(--bg-primary);
                            border: 1px solid var(--border);
                            border-radius: 4px;
                            padding: 0.25rem 0.5rem;
                            font-size: 0.75rem;
                            cursor: pointer;
                            color: var(--text-primary);
                            z-index: 10;
                        ">▼ Expand</button>
                    </div>
                `;
                responseCell.dataset.initialized = 'true';
                responseCell.dataset.expanded = 'false';
            } else {
                // Update existing response text
                const preview = responseCell.querySelector('.response-preview');
                const toggleBtn = responseCell.querySelector('.response-toggle-btn');
                if (preview) {
                    const textSpan = preview.querySelector('.response-text');
                    if (textSpan) {
                        textSpan.textContent = responseText;
                    }
                }
            }
        } else if (responseCell && error) {
            responseCell.innerHTML = `
                <span style="color: var(--danger); font-size: 0.85rem;">Error: ${escapeHtml(error.substring(0, 100))}</span>
            `;
        }
    }
    
    // Update progress
    const percent = Math.round((completed / total) * 100);
    elements.progressFill.style.width = `${percent}%`;
    elements.progressText.textContent = `${completed} / ${total} hunts complete`;
    elements.progressPercent.textContent = `${percent}%`;
    
    // Update breaks indicator
    const dots = elements.breaksIndicator.querySelectorAll('.break-dot');
    for (let i = 0; i < breaks && i < dots.length; i++) {
        dots[i].classList.add('found');
    }
}

// Toggle response expansion in progress table
function toggleResponse(rowNum) {
    const row = document.getElementById(`hunt-row-${rowNum}`);
    if (!row) return;
    
    const responseCell = row.querySelector('.response-cell');
    if (!responseCell) return;
    
    const isExpanded = responseCell.dataset.expanded === 'true';
    const preview = responseCell.querySelector('.response-preview');
    const toggleBtn = responseCell.querySelector('.response-toggle-btn');
    
    if (preview && toggleBtn) {
        if (isExpanded) {
            preview.style.maxHeight = '60px';
            toggleBtn.textContent = '▼ Expand';
            responseCell.dataset.expanded = 'false';
        } else {
            preview.style.maxHeight = 'none';
            toggleBtn.textContent = '▲ Collapse';
            responseCell.dataset.expanded = 'true';
        }
    }
}

// Make toggleResponse available globally
window.toggleResponse = toggleResponse;

// Toggle response expansion in selection table
function toggleSelectionResponse(rowNumber) {
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

// Make toggleSelectionResponse available globally
window.toggleSelectionResponse = toggleSelectionResponse;

function handleHuntComplete(data) {
    state.isHunting = false;
    
    // Remove loading state from button
    elements.startHuntBtn.classList.remove('loading');
    
    // FIX 1: Don't enable Start Hunt button if reviews section is visible
    const isInReviewMode = !elements.resultsSection.classList.contains('hidden') && state.selectionConfirmed;
    if (isInReviewMode) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Cannot start new hunt while reviews are in progress. Complete reviews or refresh page.';
    } else {
        elements.startHuntBtn.disabled = false;
        elements.startHuntBtn.title = '';
    }
    
    // Show upload and config sections again
    document.querySelector('.section')?.classList.remove('hidden');
    elements.configSection?.classList.remove('hidden');
    
    // FIX 4: Keep model/provider locked even after hunt completes (only unlock on refresh)
    // Don't re-enable model/provider selects here - they stay locked until page refresh
    
    const { completed_hunts, breaks_found } = data;
    
    // Update accumulated hunt offset for next run
    state.accumulatedHuntOffset += completed_hunts;
    
    // Update status
    elements.huntStatus.querySelector('.status-dot').className = 'status-dot completed';
    elements.statusText.textContent = 'Completed';
    
    // Reset reveal state for new hunt
    state.llmRevealed = false;
    state.humanReviews = {};
    
    // Fetch ALL responses and show selection UI
    fetchAllResponsesAndShowSelection(completed_hunts, breaks_found);
}

async function fetchAllResponsesAndShowSelection(completedHunts, breaksFound) {
    try {
        // Fetch all results from the session
        const response = await fetch(`/api/results/${state.sessionId}`);
        const data = await response.json();
        
        // Store all responses (accumulate across runs, avoiding duplicates)
        const newResponses = data.results || [];
        
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
        
        // Count total breaks across all accumulated responses (check both judge_score and score fields)
        const totalBreaks = state.allResponses.filter(r => {
            const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
            const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
            return (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
        }).length;
        const totalPasses = state.allResponses.filter(r => {
            const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
            const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
            return (judgeScore !== null && judgeScore > 0) || (score !== null && score > 0);
        }).length;
        
        // Populate summary
        elements.summarySection.classList.remove('hidden');
        document.getElementById('summaryTotal').textContent = state.allResponses.length;
        document.getElementById('summaryBreaks').textContent = totalBreaks;
        
        const successRate = state.allResponses.length > 0 ? Math.round((totalBreaks / state.allResponses.length) * 100) : 0;
        document.getElementById('summarySuccess').textContent = `${successRate}% (${totalBreaks}/${state.allResponses.length} breaks)`;
        document.getElementById('summaryMet').textContent = totalBreaks >= 3 ? '✅ Yes' : '❌ No';
        
        // VALIDATION 1: Need at least 3 breaks
        const criteriaMetBreaks = totalBreaks >= 3;
        
        // VALIDATION 2: Criteria-level diversity - at least 1 criterion has both PASS and FAIL
        // Build map of criteria grades across all hunts
        const criteriaGrades = {}; // { C1: ['PASS','FAIL','PASS'], C2: ['FAIL','FAIL'], ... }
        state.allResponses.forEach(r => {
            const gradingBasis = r.judge_criteria || r.grading_basis || {};
            Object.entries(gradingBasis).forEach(([key, val]) => {
                if (!criteriaGrades[key]) criteriaGrades[key] = [];
                const grade = String(val || '').toUpperCase();
                if (grade === 'PASS' || grade === 'FAIL') {
                    criteriaGrades[key].push(grade);
                }
            });
        });
        
        // Check if at least one criterion has BOTH pass and fail
        const diverseCriteria = Object.entries(criteriaGrades).filter(([key, grades]) => {
            const hasPass = grades.includes('PASS');
            const hasFail = grades.includes('FAIL');
            return hasPass && hasFail;
        });
        const criteriaMetDiversity = diverseCriteria.length >= 1;
        
        console.log('Criteria diversity check:', { criteriaGrades, diverseCriteria, criteriaMetDiversity });
        
        // Only check breaks requirement, not diversity (diversity is checked for LLM judge only, not for selection)
        const criteriaMet = criteriaMetBreaks;
        
        if (!criteriaMet) {
            // Don't show selection - criteria not met
            elements.selectionSection.classList.add('hidden');
            let errorMsg = `⚠️ Need at least 3 breaks (score 0). Currently have ${totalBreaks}. Run more hunts!`;
            showToast(errorMsg, 'warning');
            alert(`Cannot proceed to human review:\n\n${errorMsg}\n\nPlease run more hunts until criteria is met.`);
            return;
        }
        
        // Show selection section - criteria met!
        elements.selectionSection.classList.remove('hidden');
        
        // Display selection cards (NO auto-selection)
        displaySelectionCards();
        
        showToast(`✅ Criteria met! ${totalBreaks} breaks, ${totalPasses} passes. Select exactly 4 for review.`, 'success');
    } catch (error) {
        console.error('Error fetching results:', error);
        showToast('Error fetching results', 'error');
    }
}

function displaySelectionCards() {
    const grid = elements.selectionGrid;
    grid.innerHTML = '';
    
    // Don't reset selection - keep existing selection if any
    // state.selectedRowNumbers is preserved
    
    if (state.allResponses.length === 0) {
        grid.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No hunts found. Run hunts first.</div>';
        return;
    }
    
    // Create a table showing all hunts with their row numbers
    const table = document.createElement('table');
    table.style.cssText = 'width: 100%; border-collapse: collapse;';
    table.innerHTML = `
        <thead>
            <tr style="background: var(--bg-secondary); border-bottom: 2px solid var(--border);">
                <th style="padding: 0.75rem; text-align: left; font-weight: 600;">Select</th>
                <th style="padding: 0.75rem; text-align: left; font-weight: 600;">Slot</th>
                <th style="padding: 0.75rem; text-align: left; font-weight: 600;">Hunt #</th>
                <th style="padding: 0.75rem; text-align: left; font-weight: 600;">Status</th>
                <th style="padding: 0.75rem; text-align: left; font-weight: 600;">Model</th>
                <th style="padding: 0.75rem; text-align: center; font-weight: 600; width: 100px;">Details</th>
            </tr>
        </thead>
        <tbody id="huntSelectionTableBody">
        </tbody>
    `;
    
    const tbody = table.querySelector('#huntSelectionTableBody');
    
    // Show all hunts in order (breaking first, then passing)
    const sortedHunts = [...state.allResponses].sort((a, b) => {
        // Sort: breaking first (score 0), then passing (score > 0)
        const aJudgeScore = a.judge_score !== undefined && a.judge_score !== null ? Number(a.judge_score) : (a.score !== undefined && a.score !== null ? Number(a.score) : 999);
        const bJudgeScore = b.judge_score !== undefined && b.judge_score !== null ? Number(b.judge_score) : (b.score !== undefined && b.score !== null ? Number(b.score) : 999);
        const aIsBreaking = aJudgeScore === 0;
        const bIsBreaking = bJudgeScore === 0;
        if (aIsBreaking && !bIsBreaking) return -1;
        if (!aIsBreaking && bIsBreaking) return 1;
        return 0;
    });
    
    sortedHunts.forEach((result, index) => {
        const rowNumber = state.allResponses.indexOf(result); // Get original index in allResponses
        const isSelected = state.selectedRowNumbers.includes(rowNumber);
        
        // Get slot number if selected (1-based index in selectedRowNumbers array)
        const slotIndex = isSelected ? state.selectedRowNumbers.indexOf(rowNumber) : -1;
        const slotNumber = slotIndex >= 0 ? slotIndex + 1 : null;
        const slotDisplay = slotNumber ? `Slot ${slotNumber}` : '-';
        const slotStyle = slotNumber ? 
            'background: var(--accent-primary); color: white; padding: 0.25rem 0.5rem; border-radius: 4px; font-weight: 600; font-size: 0.85rem;' :
            'color: var(--text-muted);';
        
        // Determine if breaking or passing
        const judgeScore = result.judge_score !== undefined && result.judge_score !== null ? Number(result.judge_score) : null;
        const score = result.score !== undefined && result.score !== null ? Number(result.score) : null;
        const isBreaking = (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
        
        const shortModel = (result.model || 'unknown').split('/').pop().substring(0, 20);
        
        const row = document.createElement('tr');
        row.className = `hunt-selection-row ${isSelected ? 'selected' : ''}`;
        row.dataset.rowNumber = rowNumber;
        row.style.cssText = `
            border-bottom: 1px solid var(--border);
            cursor: pointer;
            background: ${isSelected ? 'rgba(var(--accent-primary-rgb), 0.1)' : 'transparent'};
            transition: background 0.2s;
        `;
        row.onmouseenter = () => {
            if (!isSelected) row.style.background = 'var(--bg-secondary)';
        };
        row.onmouseleave = () => {
            if (!isSelected) row.style.background = 'transparent';
        };
        
        // FIX 2: Disable checkbox if selection is confirmed
        const checkboxDisabled = state.selectionConfirmed ? 'disabled' : '';
        const checkboxStyle = state.selectionConfirmed 
            ? 'transform: scale(1.3); cursor: not-allowed; opacity: 0.6;' 
            : 'transform: scale(1.3); cursor: pointer;';
        
        row.innerHTML = `
            <td style="padding: 0.75rem; text-align: center;">
                <input type="checkbox" class="hunt-selection-checkbox" ${isSelected ? 'checked' : ''} 
                       ${checkboxDisabled}
                       data-row-number="${rowNumber}" 
                       style="${checkboxStyle}">
            </td>
            <td style="padding: 0.75rem; text-align: center;">
                <span style="${slotStyle}">${slotDisplay}</span>
            </td>
            <td style="padding: 0.75rem; font-weight: 600;">Hunt #${rowNumber + 1}</td>
            <td style="padding: 0.75rem;">
                <span class="score-badge" style="padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.85rem; background: ${isBreaking ? 'var(--success)' : 'var(--danger)'}; color: white;">
                    ${isBreaking ? '✅ BREAK' : '❌ PASS'}
                </span>
            </td>
            <td style="padding: 0.75rem; font-size: 0.9rem; color: var(--text-secondary);">${shortModel}</td>
            <td style="padding: 0.75rem; text-align: center;">
                <button class="details-toggle-btn" data-row-number="${rowNumber}" 
                        style="background: var(--bg-tertiary); border: 1px solid var(--border); 
                               border-radius: 4px; padding: 0.4rem 0.75rem; cursor: pointer; 
                               font-size: 0.85rem; color: var(--text-primary); 
                               transition: all 0.2s; display: inline-flex; align-items: center; 
                               gap: 0.25rem; white-space: nowrap;">
                    <span class="details-icon">▼</span>
                    <span class="details-text">Details</span>
                </button>
            </td>
        `;
        
        // Click handler for row (but exclude details button)
        row.addEventListener('click', (e) => {
            // Don't trigger selection if clicking the details button
            if (e.target.closest('.details-toggle-btn')) {
                return;
            }
            if (e.target.type !== 'checkbox') {
                const checkbox = row.querySelector('.hunt-selection-checkbox');
                checkbox.checked = !checkbox.checked;
            }
            toggleHuntSelection(rowNumber, row);
        });
        
        // Details button click handler
        const detailsBtn = row.querySelector('.details-toggle-btn');
        detailsBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent row selection
            toggleDetailsRow(rowNumber, row, result);
        });
        
        // Add hover effects to details button
        detailsBtn.addEventListener('mouseenter', () => {
            if (detailsBtn.style.background !== 'var(--accent-primary)') {
                detailsBtn.style.background = 'var(--bg-hover)';
                detailsBtn.style.borderColor = 'var(--border-hover)';
            }
        });
        detailsBtn.addEventListener('mouseleave', () => {
            if (detailsBtn.style.background !== 'var(--accent-primary)') {
                detailsBtn.style.background = 'var(--bg-tertiary)';
                detailsBtn.style.borderColor = 'var(--border)';
            }
        });
        
        tbody.appendChild(row);
    });
    
    grid.appendChild(table);
    updateSelectionCount();
}

// Refresh selection table to update slot indicators without resetting selection
function refreshSelectionTable() {
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
        const slotDisplay = slotNumber ? `Slot ${slotNumber}` : '-';
        const slotStyle = slotNumber ? 
            'background: var(--accent-primary); color: white; padding: 0.25rem 0.5rem; border-radius: 4px; font-weight: 600; font-size: 0.85rem;' :
            'color: var(--text-muted);';
        
        // Update slot cell (second column)
        const slotCell = row.querySelector('td:nth-child(2)');
        if (slotCell) {
            slotCell.innerHTML = `<span style="${slotStyle}">${slotDisplay}</span>`;
        }
        
        // Update row selection styling
        if (isSelected) {
            row.classList.add('selected');
            row.style.background = 'rgba(var(--accent-primary-rgb), 0.1)';
            row.style.borderLeft = '4px solid var(--accent-primary)';
        } else {
            row.classList.remove('selected');
            row.style.background = 'transparent';
            row.style.borderLeft = 'none';
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

function toggleHuntSelection(rowNumber, row) {
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
    
    // Get the result directly by row number (no lookup needed!)
    const result = state.allResponses[rowNumber];
    if (!result) {
        console.error(`❌ CRITICAL: No result found at row number ${rowNumber}`);
        return;
    }
    
    // Determine if breaking or passing
    const judgeScore = result.judge_score !== undefined && result.judge_score !== null ? Number(result.judge_score) : null;
    const score = result.score !== undefined && result.score !== null ? Number(result.score) : null;
    const isBreaking = (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
    
    if (checkbox.checked) {
        // Add to selection (max 4)
        if (state.selectedRowNumbers.length >= 4) {
            checkbox.checked = false;
            showToast('Maximum 4 hunts allowed. Unselect one first.', 'warning');
            return;
        }
        
        // Add to selection temporarily to validate
        const tempSelection = [...state.selectedRowNumbers];
        if (!tempSelection.includes(rowNumber)) {
            tempSelection.push(rowNumber);
        }
        
        // Validate selection combination: Must be exactly 4 hunts with either:
        // - 4 breaking, OR
        // - 3 breaking + 1 passing
        if (tempSelection.length === 4) {
            const tempResults = tempSelection.map(rn => state.allResponses[rn]).filter(r => r);
            const breakingCount = tempResults.filter(r => {
                const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
                const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
                return (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
            }).length;
            const passingCount = tempResults.filter(r => {
                const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
                const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
                return (judgeScore !== null && judgeScore > 0) || (score !== null && score > 0);
            }).length;
            
            // Check if combination is valid
            const isValid = (breakingCount === 4) || (breakingCount === 3 && passingCount === 1);
            
            if (!isValid) {
                checkbox.checked = false;
                showToast(`❌ Invalid combination! Must select either 4 breaking OR 3 breaking + 1 passing. Current: ${breakingCount} breaking, ${passingCount} passing.`, 'error');
                return;
            }
        }
        
        // Add to selection - combination is valid
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

function toggleDetailsRow(rowNumber, row, result) {
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

function updateSelectionCount() {
    const count = state.selectedRowNumbers.length;
    
    // Get results directly by row numbers - NO LOOKUP NEEDED!
    const selectedResults = state.selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r !== undefined);
    
    // Count breaking vs passing
    const breakingCount = selectedResults.filter(r => {
        const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
        const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
        return (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
    }).length;
    const passingCount = selectedResults.filter(r => {
        const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
        const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
        return (judgeScore !== null && judgeScore > 0) || (score !== null && score > 0);
    }).length;
    
    // Validate combination when exactly 4 are selected
    let isValid = true;
    let validationMessage = '';
    if (count === 4) {
        isValid = (breakingCount === 4) || (breakingCount === 3 && passingCount === 1);
        if (!isValid) {
            validationMessage = `⚠️ Invalid combination! Must be either 4 breaking OR 3 breaking + 1 passing. Current: ${breakingCount} breaking, ${passingCount} passing.`;
        } else {
            validationMessage = `✅ Valid combination: ${breakingCount} breaking, ${passingCount} passing`;
        }
    } else if (count > 0 && count < 4) {
        validationMessage = `Select ${4 - count} more hunt(s). Must be exactly 4 total.`;
    }
    
    if (selectedResults.length !== count) {
        console.error(`❌ CRITICAL: Expected ${count} results but found ${selectedResults.length}`);
        console.error('   Selected row numbers:', state.selectedRowNumbers);
        console.error('   allResponses length:', state.allResponses.length);
    }
    
    // Update UI with validation message
    if (elements.selectionCount) {
        let statusText = '';
        let statusColor = 'var(--text-muted)';
        
        if (count === 0) {
            statusText = 'No hunts selected';
            statusColor = 'var(--text-muted)';
        } else if (count < 4) {
            statusText = `Selected: ${count}/4 hunts (${breakingCount} breaking, ${passingCount} passing) - Select ${4 - count} more`;
            statusColor = 'var(--text-primary)';
        } else if (count === 4) {
            if (isValid) {
                statusText = `✅ Valid: ${breakingCount} breaking, ${passingCount} passing`;
                statusColor = 'var(--success)';
            } else {
                statusText = `❌ Invalid: ${breakingCount} breaking, ${passingCount} passing - Must be 4 breaking OR 3 breaking + 1 passing`;
                statusColor = 'var(--danger)';
            }
        } else {
            statusText = `Too many selected: ${count}/4`;
            statusColor = 'var(--danger)';
        }
        
        elements.selectionCount.textContent = statusText;
        elements.selectionCount.style.color = statusColor;
    }
    
    console.log('🔍 updateSelectionCount:', {
        selectedRowNumbers: state.selectedRowNumbers,
        selectedResultsCount: selectedResults.length,
        breakingCount,
        passingCount,
        isValid,
        validationMessage,
        count
    });
    
    // Build status text - no validation restrictions, allow any combination
    // Enable confirm button only if exactly 4 hunts are selected AND combination is valid
    const shouldEnable = (count === 4) && isValid;
    if (elements.confirmSelectionBtn) {
        elements.confirmSelectionBtn.disabled = !shouldEnable;
        if (!shouldEnable && count === 4) {
            elements.confirmSelectionBtn.title = 'Invalid combination! Must be 4 breaking OR 3 breaking + 1 passing.';
        } else if (!shouldEnable && count < 4) {
            elements.confirmSelectionBtn.title = `Select ${4 - count} more hunt(s). Must be exactly 4 total.`;
        } else {
            elements.confirmSelectionBtn.title = '';
        }
    }
    
    console.log('🔍 Button state:', {
        count,
        breakingCount,
        passingCount,
        shouldEnable,
        buttonDisabled: elements.confirmSelectionBtn.disabled
    });
}

function confirmSelection() {
    if (state.selectedRowNumbers.length === 0) {
        showToast('Please select at least 1 hunt to review', 'error');
        return;
    }
    
    // Get selected results directly by row numbers
    const selectedResults = state.selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r);
    
    if (selectedResults.length === 0) {
        showToast(`Error: Could not find selected hunts.`, 'error');
        return;
    }
    
    // MANDATORY: Must select exactly 4 hunts
    if (selectedResults.length !== 4) {
        showToast(`❌ Must select exactly 4 hunts. Currently selected: ${selectedResults.length}`, 'error');
        return;
    }
    
    // Count breaking vs passing
    const breakingCount = selectedResults.filter(r => {
        const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
        const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
        return (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
    }).length;
    const passingCount = selectedResults.filter(r => {
        const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
        const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
        return (judgeScore !== null && judgeScore > 0) || (score !== null && score > 0);
    }).length;
    
    // MANDATORY: Validate combination - must be either 4 breaking OR 3 breaking + 1 passing
    const isValid = (breakingCount === 4) || (breakingCount === 3 && passingCount === 1);
    
    if (!isValid) {
        showToast(`❌ Invalid combination! Must select either 4 breaking OR 3 breaking + 1 passing. Current: ${breakingCount} breaking, ${passingCount} passing.`, 'error');
        return;
    }
    
    // ===== DIVERSITY CHECK: Check for criterion diversity in LLM JUDGE ONLY =====
    const criteriaVotes = {};  // Track votes per criterion from LLM judges: { C1: { pass: 0, fail: 0 }, ... }
    
    console.log('🔍 DIVERSITY CHECK - LLM Judge criteria from selected results:', selectedResults);
    
    // Check LLM judge criteria (not human judge)
    for (const result of selectedResults) {
        const judgeCriteria = result.judge_criteria || {};
        console.log('  LLM Judge criteria:', judgeCriteria);
        
        for (const [criterionId, vote] of Object.entries(judgeCriteria)) {
            if (!criteriaVotes[criterionId]) {
                criteriaVotes[criterionId] = { pass: 0, fail: 0 };
            }
            const voteUpper = String(vote || '').toUpperCase();
            if (voteUpper === 'PASS') {
                criteriaVotes[criterionId].pass++;
            } else if (voteUpper === 'FAIL') {
                criteriaVotes[criterionId].fail++;
            }
        }
    }
    
    console.log('  LLM Criteria votes summary:', criteriaVotes);
    
    // Check if ANY criterion has both a pass AND a fail in LLM judge results
    const hasDiverseCriterion = Object.entries(criteriaVotes).some(
        ([id, votes]) => votes.pass > 0 && votes.fail > 0
    );
    
    console.log('  Has diverse criterion in LLM judges?', hasDiverseCriterion);
    console.log('  Total criteria checked:', Object.keys(criteriaVotes).length);
    
    // CRITICAL: Must have at least one criterion with both PASS and FAIL in LLM judge results
    if (!hasDiverseCriterion && Object.keys(criteriaVotes).length > 0) {
        // Build a summary of votes for the error message
        const votesSummary = Object.entries(criteriaVotes)
            .map(([id, v]) => `${id}: ${v.pass} pass, ${v.fail} fail`)
            .join('\n  ');
        
        console.error('❌ LLM JUDGE DIVERSITY CHECK FAILED:', votesSummary);
        
        showToast('LLM Judge criterion diversity required: At least one criterion must have both PASS and FAIL in LLM judge results. Run more hunts to get diverse LLM judgments.', 'error');
        alert(
            `Cannot confirm selection: Missing LLM Judge criterion diversity!\n\n` +
            `Requirement: At least one criterion (C1, C2, etc.) must receive both a PASS and a FAIL from LLM judges across the selected responses.\n\n` +
            `Current LLM judge votes:\n  ${votesSummary}\n\n` +
            `⚠️ NOTE: This checks LLM judge diversity, not human judge diversity.\n` +
            `Run more hunts until LLM judges give diverse results, then try selecting again.`
        );
        // CRITICAL: Return here to prevent confirmation
        return;
    }
    
    console.log('✅ LLM Judge diversity check passed');
    
    // ===== CONFIRMATION DIALOG =====
    const confirmed = confirm(
        `🎯 Moving to Human Review Stage 🎯\n\n` +
        `You've selected ${selectedResults.length} hunt(s) (${breakingCount} breaking, ${passingCount} passing).\n\n` +
        `These hunts will be moved to the human review stage.\n` +
        `You can still change your selection later if needed.\n\n` +
        `Click "Cancel" to go back and adjust your selection.\n` +
        `Click "OK" to proceed to human review.`
    );
    
    if (!confirmed) {
        showToast('You can adjust your selection and try again.', 'info');
        return;
    }
    
    // Mark diversity check as passed
    state.diversityCheckPassed = true;
    // FIX 2: Lock selection after confirmation
    state.selectionConfirmed = true;
    
    // Keep selection section visible, but selection is now locked
    elements.resultsSection.classList.remove('hidden');
    
    // Display the selected responses for review (blind mode)
    displaySelectedForReview();
    
    // FIX 1: Disable Start Hunt button when in reviews section
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Cannot start new hunt while reviews are in progress. Complete reviews or refresh page.';
    }
    
    // FIX 2: Disable all checkboxes in selection table
    disableSelectionCheckboxes();
    
    showToast(`Selection confirmed and locked! ${selectedResults.length} hunt(s) moved to human review. Complete all 4 reviews to proceed.`, 'success');
}

function displaySelectedForReview() {
    elements.breakingResults.innerHTML = '';
    elements.noBreaksMessage.classList.add('hidden');
    
    // Get selected results directly by row numbers - NO LOOKUP!
    const selectedResponses = state.selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r !== undefined);
    
    console.log('displaySelectedForReview called');
    console.log('selectedRowNumbers:', state.selectedRowNumbers);
    console.log('selectedResponses count:', selectedResponses.length);
    
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
    
    // Show save container but keep button disabled until reveal
    elements.saveDriveContainer.classList.remove('hidden');
    // FIX 3: Ensure buttons are disabled until all 4 reviews complete
    elements.saveDriveBtn.disabled = true;
    elements.saveDriveBtn.style.opacity = '0.5';
    if (elements.revealLLMBtn) {
        elements.revealLLMBtn.disabled = true;
        elements.revealLLMBtn.style.opacity = '0.5';
    }
}

// FIX 2: Helper function to disable all selection checkboxes
function disableSelectionCheckboxes() {
    const checkboxes = document.querySelectorAll('.hunt-selection-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.disabled = true;
        checkbox.style.cursor = 'not-allowed';
        checkbox.style.opacity = '0.6';
    });
}

// FIX 2: Helper function to enable all selection checkboxes (for future use)
function enableSelectionCheckboxes() {
    const checkboxes = document.querySelectorAll('.hunt-selection-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.disabled = false;
        checkbox.style.cursor = 'pointer';
        checkbox.style.opacity = '1';
    });
}

function updateReviewProgress() {
    // Count reviews for SELECTED row numbers only
    const selectedRowNumbers = state.selectedRowNumbers || [];
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const reviewCount = reviewKeys.filter(key => state.humanReviews && state.humanReviews[key]).length;
    const selectedCount = selectedRowNumbers.length;
    
    if (elements.reviewProgressText) {
        elements.reviewProgressText.textContent = `${reviewCount} / ${selectedCount} completed`;
        elements.reviewProgressText.style.color = reviewCount === selectedCount ? 'var(--success)' : 'var(--text-primary)';
    }
    
    // Enable reveal button only when all selected reviews are complete
    if (elements.revealLLMBtn) {
        const allComplete = reviewCount >= selectedCount && selectedCount > 0;
        elements.revealLLMBtn.disabled = !allComplete || state.llmRevealed;
        
        if (state.llmRevealed) {
            elements.revealLLMBtn.textContent = '✅ LLM Judgments Revealed';
            elements.revealLLMBtn.disabled = true;
        } else if (allComplete) {
            elements.revealLLMBtn.textContent = '👁️ Reveal LLM Judgments';
        }
    }
    
    // Update top instructions
    if (elements.reviewInstructions) {
        if (state.llmRevealed) {
            elements.reviewInstructions.textContent = '✅ Reviews locked. Scroll down to save.';
            elements.reviewInstructions.style.color = 'var(--success)';
        } else if (reviewCount >= 4) {
            elements.reviewInstructions.textContent = '✅ All reviews complete! Scroll down to reveal LLM judgments.';
            elements.reviewInstructions.style.color = 'var(--success)';
        } else {
            elements.reviewInstructions.textContent = `Complete all 4 human reviews, then scroll down to reveal LLM judgments and save.`;
        }
    }
    
    // Update bottom instructions
    if (elements.bottomInstructions) {
        if (state.llmRevealed) {
            elements.bottomInstructions.textContent = '✅ LLM Judgments revealed. Reviews locked. Click Save to Colab Notebook.';
            elements.bottomInstructions.style.color = 'var(--success)';
        } else if (reviewCount >= 4) {
            elements.bottomInstructions.textContent = '✅ All reviews complete! Click "Reveal LLM Judgments" → Save will be enabled.';
            elements.bottomInstructions.style.color = 'var(--success)';
        } else {
            elements.bottomInstructions.textContent = `Complete all 4 human reviews → Click "Reveal LLM Judgments" → Save will be enabled`;
            elements.bottomInstructions.style.color = 'var(--text-muted)';
        }
    }
}

function revealLLMJudgments() {
    // FIX 3: Ensure exactly 4 reviews are complete before allowing reveal
    const selectedRowNumbers = state.selectedRowNumbers || [];
    if (selectedRowNumbers.length === 0) {
        showToast('Please select hunts first', 'error');
        return;
    }
    
    if (selectedRowNumbers.length !== 4) {
        showToast(`Must have exactly 4 hunts selected. Currently: ${selectedRowNumbers.length}`, 'error');
        return;
    }
    
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const completedReviews = reviewKeys.filter(key => state.humanReviews && state.humanReviews[key]);
    
    if (completedReviews.length !== 4) {
        showToast(`Only ${completedReviews.length}/4 review(s) complete. Please complete all 4 reviews before revealing LLM judgments.`, 'error');
        return;
    }
    
    state.llmRevealed = true;
    
    // Show all LLM judge sections
    document.querySelectorAll('.llm-judge-section').forEach(section => {
        section.style.display = 'block';
    });
    
    // Lock all human review inputs
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
    
    // Enable save button
    elements.saveDriveBtn.disabled = false;
    elements.saveDriveBtn.style.opacity = '1';
    
    // Update progress display
    updateReviewProgress();
    
    showToast('LLM Judgments revealed! Reviews are now locked. You can save to Drive.', 'success');
}

async function displayBreakingResults() {
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

function createResultCard(result, slotIndex, rowNumber) {
    const card = document.createElement('div');
    card.className = 'expandable-card';
    card.dataset.huntId = result.hunt_id;
    card.dataset.slotIndex = slotIndex || 0;
    card.dataset.rowNumber = rowNumber !== undefined ? rowNumber : null; // Store row number for unique identification
    
    const shortModel = result.model.split('/').pop();
    const score = result.judge_score ?? 0;
    const isFailed = score === 0;  // isFailed means model BROKE (which is success in our case!)
    const scoreEmoji = isFailed ? '🟢' : '🔴';  // Green = BREAK (good), Red = PASS (bad)
    const scoreClass = isFailed ? 'score-0' : 'score-1';
    const responseText = result.response || 'No response available';
    const slotNum = slotIndex !== undefined ? slotIndex + 1 : result.hunt_id;
    
    // Frontend deduplication: hide trace if similar to response
    let reasoningTrace = result.reasoning_trace || '';
    const responseClean = responseText.trim().toLowerCase();
    const traceClean = reasoningTrace.trim().toLowerCase();
    
    // Debug logging
    console.log(`Slot ${slotNum} reasoning trace check:`, {
        hasTrace: !!reasoningTrace,
        traceLength: reasoningTrace.length,
        responseLength: responseText.length,
        tracePreview: reasoningTrace.substring(0, 100),
        responsePreview: responseText.substring(0, 100),
        traceInResult: 'reasoning_trace' in result,
        resultKeys: Object.keys(result)
    });
    
    // Check for duplicates in UI only - export still gets full trace
    // Only hide if trace is EXACTLY the same as response (not if one contains the other)
    // This is less aggressive - thinking models often have reasoning that overlaps with response
    if (reasoningTrace && traceClean.length > 0) {
        const isExactDuplicate = traceClean === responseClean;
        if (isExactDuplicate) {
            console.log(`Slot ${slotNum}: Hiding exact duplicate trace in UI (export has full trace)`);
            reasoningTrace = ''; // Hide from UI only
        } else {
            console.log(`Slot ${slotNum}: Showing reasoning trace (${reasoningTrace.length} chars)`);
        }
    } else if (!reasoningTrace) {
        console.log(`Slot ${slotNum}: No reasoning trace found in result`);
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
                    ${shortModel}
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
                        📄 Model Response (${shortModel}_${slotNum}):
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
                </div>
                
                            <button class="btn btn-primary submit-human-review-btn" data-hunt-id="${result.hunt_id}" style="width: 100%; padding: 0.875rem; font-weight: 600; font-size: 0.95rem; border-radius: 8px;">
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
                    <div class="llm-judge-explanation" style="font-size: 0.9rem; color: var(--text-secondary); white-space: pre-wrap; background: var(--bg-primary); padding: 1rem; border-radius: 8px; line-height: 1.6;">
                        <label style="font-weight: 500; display: block; margin-bottom: 0.5rem; color: var(--text-primary);">📝 Full Explanation:</label>
                        ${escapeHtml(result.judge_explanation || 'No explanation available')}
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
    
    // Get submit button reference for enabling when criteria are clicked
    const submitBtn = card.querySelector('.submit-human-review-btn');
    
    // Criterion pass/fail button handlers
    card.querySelectorAll('.criterion-pass').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const criterion = btn.dataset.criterion;
            const row = btn.closest('.criterion-row');
            row.querySelector('.criterion-pass').classList.add('active');
            row.querySelector('.criterion-pass').style.background = 'var(--success)';
            row.querySelector('.criterion-pass').style.color = 'white';
            row.querySelector('.criterion-fail').classList.remove('active');
            row.querySelector('.criterion-fail').style.background = 'transparent';
            row.querySelector('.criterion-fail').style.color = 'var(--danger)';
            row.dataset.grade = 'pass';
            
            // Enable submit button when criteria is selected
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
            }
        });
    });
    
    card.querySelectorAll('.criterion-fail').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const criterion = btn.dataset.criterion;
            const row = btn.closest('.criterion-row');
            row.querySelector('.criterion-fail').classList.add('active');
            row.querySelector('.criterion-fail').style.background = 'var(--danger)';
            row.querySelector('.criterion-fail').style.color = 'white';
            row.querySelector('.criterion-pass').classList.remove('active');
            row.querySelector('.criterion-pass').style.background = 'transparent';
            row.querySelector('.criterion-pass').style.color = 'var(--success)';
            row.dataset.grade = 'fail';
            
            // Enable submit button when criteria is selected
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
            }
        });
    });
    
    // Submit human review button
    card.querySelector('.submit-human-review-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const rowNum = card.dataset.rowNumber !== null && card.dataset.rowNumber !== undefined 
            ? Number(card.dataset.rowNumber) 
            : null;
        submitHumanReview(result.hunt_id, card, slotNum, rowNum);
    });
    
    // Re-enable submit button when user types in textarea or changes criteria
    const notesTextarea = card.querySelector('.human-review-notes');
    
    // Listen for textarea input to re-enable submit (if it was previously submitted)
    notesTextarea.addEventListener('input', () => {
        if (submitBtn && submitBtn.disabled && submitBtn.textContent.includes('Submitted')) {
            submitBtn.disabled = false;
            submitBtn.textContent = '✅ Submit Human Review';
            submitBtn.style.background = '';
        } else if (submitBtn) {
            // Also enable if not disabled but just to be sure
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
        }
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

function handleHumanReview(huntId, judgment, card, slotNum) {
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
async function submitHumanReview(huntId, card, slotNum, rowNumber) {
    const notesEl = card.querySelector(`.human-review-notes[data-hunt-id="${huntId}"]`);
    const notes = notesEl ? (notesEl.value || notesEl.textContent || '') : '';
    const statusEl = card.querySelector(`.human-review-status[data-hunt-id="${huntId}"]`);
    const criteriaGrading = card.querySelector(`.criteria-grading[data-hunt-id="${huntId}"]`);
    
    // Use row number as key if available, otherwise fall back to hunt_id
    // Row number ensures uniqueness across different runs
    const reviewKey = rowNumber !== null && rowNumber !== undefined ? `row_${rowNumber}` : `hunt_${huntId}`;
    
    // Collect grades for each criterion
    const criterionRows = criteriaGrading.querySelectorAll('.criterion-row');
    const grading = {};
    let allGraded = true;
    
    criterionRows.forEach(row => {
        const criterionId = row.dataset.criterionId;
        const grade = row.dataset.grade;
        if (!grade) {
            allGraded = false;
        } else {
            // Store as uppercase for consistency
            grading[criterionId] = grade.toUpperCase(); // 'pass' -> 'PASS', 'fail' -> 'FAIL'
        }
    });
    
    // Validate all criteria are graded
    if (!allGraded) {
        showToast('Please grade all criteria before submitting', 'error');
        return;
    }
    
    // Calculate pass/fail based on 50% rule: if MORE than 50% criteria are PASS, overall is PASS
    // If 50% or less pass, it's FAIL (breaking) - matches LLM judge logic
    const totalCriteria = Object.keys(grading).length;
    const passCount = Object.values(grading).filter(v => v.toUpperCase() === 'PASS').length;
    const passRate = totalCriteria > 0 ? passCount / totalCriteria : 0;
    const overallJudgment = passRate > 0.5 ? 'pass' : 'fail';
    
    // ===== SARCASTIC CONFIRMATION DIALOG =====
    const gradingSummary = Object.entries(grading).map(([k, v]) => `${k}: ${v}`).join(', ');
    const confirmed = confirm(
        `📝 SUBMITTING REVIEW FOR SLOT ${slotNum} 📝\n\n` +
        `Your grading: ${gradingSummary}\n` +
        `Pass rate: ${passCount}/${totalCriteria} (${Math.round(passRate * 100)}%)\n` +
        `Overall: ${overallJudgment.toUpperCase()}\n\n` +
        `Are you sure about these grades?\n` +
        `Double-checked your explanation?\n\n` +
        `(Note: You can edit this later, but it's better to get it right the first time!)\n\n` +
        `Click "Cancel" to review again.\n` +
        `Click "OK" to submit.`
    );
    
    if (!confirmed) {
        showToast('Take your time! Make sure everything is correct.', 'info');
        return;
    }
    
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
            body: JSON.stringify({ reviews: reviewForBackend })
        });
        
        if (!saveResponse.ok) {
            console.warn(`Failed to auto-save review for hunt ${huntId}:`, await saveResponse.text());
            // Don't show error to user - it's auto-save, will be saved again on final save
        } else {
            console.log(`✅ Auto-saved review for hunt ${huntId} to backend`);
        }
    } catch (error) {
        console.warn(`Error auto-saving review for hunt ${huntId}:`, error);
        // Don't show error to user - it's auto-save, will be saved again on final save
    }
    
    // Check if all 4 reviews are done
    checkAllReviewsComplete();
}

function revealLLMJudge(huntId, card) {
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

function checkAllReviewsComplete() {
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
    
    console.log('🔍 checkAllReviewsComplete:', {
        selectedRowNumbers,
        reviewKeys,
        completedReviews,
        reviewCount,
        totalSlots,
        allReviews: Object.keys(state.humanReviews || {})
    });
    
    // FIX 3: Only enable buttons when exactly 4 reviews are complete
    if (reviewCount >= totalSlots && totalSlots === 4) {
        showToast(`All ${totalSlots} review(s) complete! Ready to export.`, 'success');
        // Enable reveal button
        if (elements.revealLLMBtn) {
            elements.revealLLMBtn.disabled = false;
            elements.revealLLMBtn.style.opacity = '1';
        }
        // Enable save button prominently
        if (elements.saveDriveBtn) {
            elements.saveDriveBtn.disabled = false;
            elements.saveDriveBtn.style.opacity = '1';
            elements.saveDriveBtn.classList.add('pulse');
        }
        // Update progress display
        updateReviewProgress();
    } else if (totalSlots === 4 && reviewCount < 4) {
        // FIX 3: Ensure buttons remain disabled if not all 4 reviews complete
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


// ============== Export ==============

async function exportNotebook() {
    if (!state.sessionId) {
        showToast('No session to export. Please upload a notebook first.', 'error');
        return;
    }
    
    // Check if there are results to export
    if (!state.results || state.results.length === 0) {
        showToast('No hunt results to export. Run a hunt first.', 'warning');
        return;
    }
    
    // FIX 3: Require all 4 reviews before allowing export
    const selectedRowNumbers = state.selectedRowNumbers || [];
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const reviews = reviewKeys.map(key => state.humanReviews[key]).filter(r => r);
    const reviewCount = reviews.length;
    
    if (selectedRowNumbers.length !== 4) {
        showToast(`Must have exactly 4 hunts selected. Currently: ${selectedRowNumbers.length}`, 'error');
        return;
    }
    
    if (reviewCount < 4) {
        showToast(`Cannot export: Only ${reviewCount}/4 reviews completed. Please complete all 4 reviews before exporting.`, 'error');
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
        showToast(`Export error: ${error.message}`, 'error');
    }
}


// ============== Utilities ==============

function clearPreviousResults() {
    // Reset state
    state.results = [];
    state.diversityCheckPassed = false;  // Reset diversity check flag
    state.isHunting = false;
    state.humanReviews = {};  // Reset human reviews
    state.allResponses = [];  // Reset accumulated responses
    state.selectedRowNumbers = [];  // Reset selection
    state.selectionConfirmed = false;  // FIX 2: Reset selection lock
    state.llmRevealed = false;  // Reset reveal state
    state.accumulatedHuntOffset = 0;  // Reset hunt offset
    state.currentRunStartOffset = 0;  // Reset run offset
    state.originalNotebookJson = null;  // Reset original notebook
    state.blindJudging = {
        queue: [],
        currentResult: null,
        humanJudgments: {}
    };
    
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
    
    console.log('Previous results cleared');
}

/**
 * Format LLM Judge criteria breakdown for display
 * Shows each criterion (C1, C2, etc.) with pass/fail status and explanation
 */
function formatLLMCriteria(criteria, fullExplanation) {
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
 * Format judge criteria for the reference judge display (simpler format)
 * Shows each criterion with pass/fail status
 */
function formatJudgeCriteriaDisplay(criteria) {
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

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `alert alert-${type === 'info' ? 'warning' : type} fade-in`;
    toast.style.marginBottom = '0.5rem';
    toast.innerHTML = `
        <span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
        <span>${message}</span>
    `;
    
    elements.toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}


// ============== Blind Judging ==============

function showNextBlindJudge() {
    if (state.blindJudging.queue.length === 0) {
        // All judging complete - show final results
        hideBlindJudgeModal();
        showFinalResults();
        return;
    }
    
    // Get next result from queue
    const result = state.blindJudging.queue.shift();
    state.blindJudging.currentResult = result;
    
    // Reset modal state
    elements.llmJudgeReveal.classList.add('hidden');
    elements.humanJudgePass.disabled = false;
    elements.humanJudgeFail.disabled = false;
    elements.humanJudgeSkip.disabled = false;
    
    // Populate modal
    elements.judgeHuntId.textContent = result.hunt_id;
    elements.judgeResponseText.textContent = result.response || 'No response content available';
    
    // Show modal
    elements.blindJudgeModal.classList.remove('hidden');
}

function handleHumanJudgment(humanScore) {
    const result = state.blindJudging.currentResult;
    if (!result) return;
    
    // Store human judgment
    state.blindJudging.humanJudgments[result.hunt_id] = humanScore;
    
    // Disable buttons
    elements.humanJudgePass.disabled = true;
    elements.humanJudgeFail.disabled = true;
    elements.humanJudgeSkip.disabled = true;
    
    // Reveal LLM judgment
    const llmScore = result.score;
    const isMatch = humanScore === llmScore;
    
    elements.humanJudgeResult.textContent = humanScore === 0 ? '❌ FAIL (0)' : '✅ PASS (1)';
    elements.humanJudgeResult.style.color = humanScore === 0 ? 'var(--success)' : 'var(--danger)';
    
    elements.llmJudgeResult.textContent = llmScore === 0 ? '❌ FAIL (0)' : llmScore === 1 ? '✅ PASS (1)' : '? Unknown';
    elements.llmJudgeResult.style.color = llmScore === 0 ? 'var(--success)' : 'var(--danger)';
    
    elements.judgeMatch.textContent = isMatch ? '✅ Match!' : '❌ Disagree';
    elements.judgeMatch.className = `comparison-value ${isMatch ? 'match' : 'no-match'}`;
    
    // Update table row with actual score now
    updateRowWithScore(result.hunt_id, result);
    
    // Show reveal section
    elements.llmJudgeReveal.classList.remove('hidden');
}

function updateRowWithScore(huntId, result) {
    const row = document.getElementById(`hunt-row-${huntId}`);
    if (!row) return;
    
    const score = result.score;
    
    // Update status
    row.querySelector('.status-cell').innerHTML = `
        <span class="score-badge" style="background: var(--success-bg); color: var(--success);">✅ Reviewed</span>
    `;
    
    // Update score
    if (score !== null && score !== undefined) {
        row.querySelector('.score-cell').innerHTML = `
            <span class="score-badge score-${score}">
                ${score === 0 ? '✅ 0' : '❌ 1'}
            </span>
        `;
    }
    
    // Update issues
    if (result.is_breaking) {
        row.querySelector('.issues-cell').textContent = '🎯 Model breaking!';
    } else {
        row.querySelector('.issues-cell').textContent = '-';
    }
    
    // Update breaks indicator
    if (result.is_breaking) {
        const dots = elements.breaksIndicator.querySelectorAll('.break-dot:not(.found)');
        if (dots.length > 0) {
            dots[0].classList.add('found');
        }
    }
}

function hideBlindJudgeModal() {
    elements.blindJudgeModal.classList.add('hidden');
    state.blindJudging.currentResult = null;
}

function showFinalResults() {
    // Show upload and config sections again
    document.querySelector('.section')?.classList.remove('hidden');
    elements.configSection?.classList.remove('hidden');
    
    // Update status
    elements.statusText.textContent = 'Review Complete';
    
    // Show results section
    elements.resultsSection.classList.remove('hidden');
    elements.summarySection.classList.remove('hidden');
    
    // Calculate actual breaks from results
    const breaksFound = state.results.filter(r => r.is_breaking).length;
    const totalHunts = state.results.length;
    
    // Populate summary
    document.getElementById('summaryTotal').textContent = totalHunts;
    document.getElementById('summaryBreaks').textContent = breaksFound;
    
    const successRate = totalHunts > 0 ? Math.round((breaksFound / totalHunts) * 100) : 0;
    document.getElementById('summarySuccess').textContent = `${successRate}% (${breaksFound}/${totalHunts} breaks)`;
    document.getElementById('summaryMet').textContent = breaksFound >= 3 ? '✅ Yes' : '❌ No';
    
    // Populate breaking results
    displayBreakingResults();
    
    showToast(
        breaksFound >= 3
            ? `Found ${breaksFound} model breaking responses.` 
            : `Review complete. Found ${breaksFound} breaks.`,
        breaksFound >= 3 ? 'success' : 'info'
    );
}


// ============== Hunt Number Controls ==============

function initHuntNumberControls() {
    const numberInput = document.getElementById('parallelWorkers');
    const slider = document.getElementById('parallelWorkersSlider');
    const decreaseBtn = document.querySelector('.hunt-btn-decrease');
    const increaseBtn = document.querySelector('.hunt-btn-increase');
    const presetBtns = document.querySelectorAll('.preset-btn');
    
    if (!numberInput || !slider) return;
    
    // Function to update all controls to a value
    function updateValue(newValue) {
        const value = Math.max(1, Math.min(6, parseInt(newValue) || 4));
        
        numberInput.value = value;
        slider.value = value;
        
        // Update preset button states
        presetBtns.forEach(btn => {
            if (parseInt(btn.dataset.value) === value) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        
        // Update button states
        if (decreaseBtn) {
            decreaseBtn.disabled = value <= 1;
        }
        if (increaseBtn) {
            increaseBtn.disabled = value >= 6;
        }
    }
    
    // Sync number input -> slider
    numberInput.addEventListener('input', (e) => {
        updateValue(e.target.value);
    });
    
    // Sync slider -> number input
    slider.addEventListener('input', (e) => {
        updateValue(e.target.value);
    });
    
    // Decrease button
    if (decreaseBtn) {
        decreaseBtn.addEventListener('click', () => {
            const current = parseInt(numberInput.value) || 4;
            if (current > 1) {
                updateValue(current - 1);
            }
        });
    }
    
    // Increase button
    if (increaseBtn) {
        increaseBtn.addEventListener('click', () => {
            const current = parseInt(numberInput.value) || 4;
            if (current < 6) {
                updateValue(current + 1);
            }
        });
    }
    
    // Preset buttons
    presetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            updateValue(btn.dataset.value);
        });
    });
    
    // Initialize state
    updateValue(numberInput.value);
}

// ============== Event Listeners ==============

function initEventListeners() {
    elements.themeToggle.addEventListener('click', toggleTheme);
    elements.startHuntBtn.addEventListener('click', startHunt);
    if (elements.saveDriveBtn) elements.saveDriveBtn.addEventListener('click', saveToDrive);
    
    // Metadata sidebar toggle
    if (elements.metadataToggleBtn) {
        elements.metadataToggleBtn.addEventListener('click', toggleMetadataSidebar);
    }
    
    // Clear results and reset when model changes
    // FIX 4: Only allow model change if not locked (not during/after hunt)
    if (elements.modelSelect) {
        elements.modelSelect.addEventListener('change', () => {
            // Check if model selection is locked
            if (elements.modelSelect.disabled) {
                showToast('Model selection is locked. Please refresh the page to change model.', 'warning');
                // Revert to previous value
                const previousModel = state.config.models?.[0] || 'qwen/qwen3-235b-a22b-thinking-2507';
                elements.modelSelect.value = previousModel;
                return;
            }
            // Full clear when model changes
            clearPreviousResults();
            showToast('Model changed. Previous results cleared.', 'info');
            // Validate model match with metadata
            validateModelMatch();
        });
    }
    
    // FIX 4: Prevent provider change if locked
    if (elements.providerSelect) {
        elements.providerSelect.addEventListener('change', () => {
            if (elements.providerSelect.disabled) {
                showToast('Provider selection is locked. Please refresh the page to change provider.', 'warning');
                // Revert to previous value
                const previousProvider = state.config.provider || 'openrouter';
                elements.providerSelect.value = previousProvider;
                return;
            }
            // Update model options when provider changes
            updateModelOptions();
        });
    }
    
    // Blind judging buttons
    elements.humanJudgePass?.addEventListener('click', () => handleHumanJudgment(1));
    elements.humanJudgeFail?.addEventListener('click', () => handleHumanJudgment(0));
    elements.humanJudgeSkip?.addEventListener('click', () => {
        // Skip without recording judgment, but still reveal LLM score
        handleHumanJudgment(null);
    });
    elements.nextHuntBtn?.addEventListener('click', showNextBlindJudge);
    
    // Judge reference response button (for other tabs)
    elements.judgeReferenceBtn?.addEventListener('click', judgeReferenceResponse);
    
    // Judge button next to Start Hunt button
    elements.judgeBeforeHuntBtn?.addEventListener('click', judgeReferenceResponse);
    
    // Save response button (Response tab)
    elements.saveResponseBtn?.addEventListener('click', saveResponseOnly);
    
    // NEW: Selection and Reveal buttons
    elements.confirmSelectionBtn?.addEventListener('click', confirmSelection);
    elements.revealLLMBtn?.addEventListener('click', revealLLMJudgments);
}

// ============== Metadata Sidebar Toggle ==============

function toggleMetadataSidebar() {
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

async function judgeReferenceResponse() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    // Check for missing criteria before judging
    // Compare initial criteria with current criteria from preview
    // Get the JSON version from the converted JSON, not the structured text input
    let currentRefText = '';
    if (state.convertedModelRefJSON) {
        // Use the converted JSON if available
        currentRefText = state.convertedModelRefJSON;
    } else if (elements.jsonPreviewContent && elements.jsonPreviewContent.textContent && 
               !elements.jsonPreviewContent.textContent.includes('Enter criteria') &&
               !elements.jsonPreviewContent.textContent.includes('Error:')) {
        // Use the JSON preview if available
        currentRefText = elements.jsonPreviewContent.textContent.trim();
    } else if (elements.modelrefPreview) {
        // Fallback: get value from input and try to convert
        const inputValue = elements.modelrefPreview.value.trim();
        if (inputValue) {
            // Try to parse as JSON first
            try {
                const parsed = JSON.parse(inputValue);
                if (Array.isArray(parsed)) {
                    currentRefText = inputValue;
                } else {
                    // Not JSON, trigger conversion
                    convertStructuredToJSON();
                    currentRefText = state.convertedModelRefJSON || inputValue;
                }
            } catch (e) {
                // Not JSON, trigger conversion
                convertStructuredToJSON();
                currentRefText = state.convertedModelRefJSON || inputValue;
            }
        }
    }
    
    let currentCriteria;
    try {
        currentCriteria = parseCriteria(currentRefText);
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        console.error('Input text was:', currentRefText.substring(0, 200));
        showToast(`❌ Failed to parse criteria: ${error.message}`, 'error');
        return;
    }
    const currentCriteriaIds = new Set(currentCriteria.map(c => c.id));
    const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
    const missingBeforeJudge = [...initialCriteriaIds].filter(id => !currentCriteriaIds.has(id));
    
    console.log('🔍 PRE-JUDGE CHECK:');
    console.log('   Initial criteria IDs:', Array.from(initialCriteriaIds));
    console.log('   Current criteria IDs:', Array.from(currentCriteriaIds));
    console.log('   Missing criteria IDs:', missingBeforeJudge);
    console.log('   state.initialCriteria exists?', !!state.initialCriteria);
    console.log('   state.initialCriteria length:', state.initialCriteria?.length || 0);
    
    // Check minimum 3 criteria requirement
    if (currentCriteria.length < 3) {
        const resultDiv = elements.referenceJudgeResult;
        resultDiv.innerHTML = `
            <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 2px solid var(--warning);">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                    <span style="font-size: 1.5rem;">⚠️</span>
                    <span style="font-weight: 600; color: var(--warning);">Minimum 3 Criteria Required</span>
                </div>
                <p style="margin-bottom: 0.5rem; color: var(--text-secondary);">
                    You currently have <strong>${currentCriteria.length} criteria</strong> in your response_reference.
                </p>
                <p style="color: var(--text-secondary); font-size: 0.9rem;">
                    <strong>Requirement:</strong> You must have at least <strong>3 criteria</strong> before judging.<br>
                    Please add more criteria to your response_reference section in your Colab notebook.
                </p>
            </div>
        `;
        resultDiv.classList.remove('hidden');
        // Keep response editor in view
        const responseEditor = document.getElementById('responseEditor');
        if (responseEditor) {
            responseEditor.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
        }
        showToast(`❌ Minimum 3 criteria required. Currently have ${currentCriteria.length}.`, 'error');
        return;
    }
    
    if (missingBeforeJudge.length > 0) {
        const missingIds = missingBeforeJudge.join(', ');
        showToast(`❌ Cannot judge: Missing criteria ${missingIds}. Please add them back to response_reference and try again.`, 'error');
        // Show a warning in the result div
        const resultDiv = elements.referenceJudgeResult;
        resultDiv.innerHTML = `
            <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 2px solid var(--warning);">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                    <span style="font-size: 1.5rem;">⚠️</span>
                    <span style="font-weight: 600; color: var(--warning);">Missing Criteria Detected</span>
                </div>
                <p style="margin-bottom: 0.5rem; color: var(--text-secondary);">
                    The following criteria were in the original notebook but are missing from the current response_reference:
                </p>
                <ul style="margin-left: 1.5rem; margin-bottom: 0.75rem; color: var(--warning);">
                    ${missingBeforeJudge.map(id => {
                        const criterion = (state.initialCriteria || []).find(c => c.id === id);
                        return `<li><strong>${id}</strong>: ${criterion ? escapeHtml(criterion.criteria) : 'Criterion description not found'}</li>`;
                    }).join('')}
                </ul>
                <p style="color: var(--text-secondary); font-size: 0.9rem;">
                    <strong>Action Required:</strong> Please add these criteria back to the response_reference section in your Colab notebook, then click "Judge Reference" again.
                </p>
            </div>
        `;
        resultDiv.classList.remove('hidden');
        // Keep response editor in view
        const responseEditor = document.getElementById('responseEditor');
        if (responseEditor) {
            responseEditor.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
        }
        return;
    }
    
    // Use the button that was clicked (could be judgeReferenceBtn or judgeBeforeHuntBtn)
    const btn = event?.target?.id === 'judgeBeforeHuntBtn' ? elements.judgeBeforeHuntBtn : elements.judgeReferenceBtn;
    const resultDiv = elements.referenceJudgeResult;
    
    try {
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ Judging...';
        }
        // Don't hide the result div - just clear it, so response editor stays visible
        if (resultDiv) {
            resultDiv.innerHTML = '';
            resultDiv.classList.add('hidden');
        }
        
        const response = await fetch(`/api/judge-reference/${state.sessionId}`, {
            method: 'POST'
        });
        
        if (!response.ok) {
            if (response.status === 404) {
                // Session not found - likely expired or invalid
                showToast('⚠️ Session expired. Please reload the notebook.', 'error');
                throw new Error('Session not found. Please reload the notebook from Colab.');
            }
            const error = await response.json();
            throw new Error(error.detail || 'Judge failed');
        }
        
        const data = await response.json();
        
        // Update state.criteria from judge result to keep in sync
        let criteria = data.criteria || {};
        let criteriaEntries = Object.entries(criteria); // Use let, not const
        
        // Debug: Log what criteria were judged
        console.log('Judge result criteria:', Object.keys(criteria));
        console.log('Initial criteria IDs:', (state.initialCriteria || []).map(c => c.id));
        console.log('Current state.criteria IDs (before update):', (state.criteria || []).map(c => c.id));
        
        // IMPORTANT: Re-parse criteria from fresh response_reference if provided
        // This ensures state.criteria matches what was actually in the notebook when judging
        let currentCriteria = [];
        if (data.response_reference) {
            console.log('Re-parsing criteria from fresh response_reference');
            try {
            currentCriteria = parseCriteria(data.response_reference);
            state.criteria = currentCriteria;
            console.log('Updated state.criteria IDs (from response_reference):', state.criteria.map(c => c.id));
            } catch (error) {
                console.error('Failed to parse criteria:', error);
                showToast(`❌ Failed to parse criteria: ${error.message}`, 'error');
                return;
            }
        } else {
            // Fallback: Update state.criteria based on what was actually judged
            const judgedCriteriaIds = new Set(Object.keys(criteria));
            state.criteria = (state.criteria || []).filter(c => judgedCriteriaIds.has(c.id));
            currentCriteria = state.criteria;
        }
        
        // CRITICAL: Filter out criteria from judge result that are NOT in response_reference
        // These should be marked as MISSING, not FAIL
        const currentCriteriaIds = new Set(currentCriteria.map(c => c.id));
        const judgedCriteriaIds = new Set(Object.keys(criteria));
        const criteriaNotInResponseRef = [...judgedCriteriaIds].filter(id => !currentCriteriaIds.has(id));
        
        if (criteriaNotInResponseRef.length > 0) {
            console.warn('⚠️ Judge returned criteria not in response_reference:', criteriaNotInResponseRef);
            console.warn('   These will be marked as MISSING instead of their judge status (FAIL/PASS)');
            // Mark these as MISSING and add them to state.criteria
            for (const id of criteriaNotInResponseRef) {
                criteria[id] = 'MISSING';
                // Add to state.criteria if not already there
                if (!state.criteria.find(c => c.id === id)) {
                    state.criteria.push({ 
                        id: id, 
                        criteria: `Criterion ${id} (not in response_reference - please add it back)` 
                    });
                    console.log(`✅ Added missing criterion ${id} to state.criteria (from judge result)`);
                }
            }
            // Recalculate entries after adding MISSING
            criteriaEntries = Object.entries(criteria);
        }
        
        // Check for missing criteria: Compare initial criteria with what was actually judged
        // With independent judging, ALL criteria in response_reference should be evaluated
        // If a criterion was in initial but not in judge result, it's MISSING
        const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
        // Use judgedCriteriaIds (what judge actually returned) instead of currentCriteriaIds
        // This ensures we detect if judge didn't evaluate a criterion that should be there
        const missingCriteriaIds = [...initialCriteriaIds].filter(id => !judgedCriteriaIds.has(id));
        
        console.log('🔍 POST-JUDGE MISSING CHECK:');
        console.log('   Initial criteria IDs:', Array.from(initialCriteriaIds));
        console.log('   Current criteria IDs (from response_reference):', Array.from(currentCriteriaIds));
        console.log('   Judged criteria IDs (from judge result):', Array.from(judgedCriteriaIds));
        console.log('   Missing criteria IDs (in initial but not in judge result):', missingCriteriaIds);
        console.log('   state.initialCriteria exists?', !!state.initialCriteria);
        console.log('   state.initialCriteria length:', state.initialCriteria?.length || 0);
        console.log('   state.initialCriteria:', state.initialCriteria);
        
        // Also check if criteria are in response_reference but not judged (shouldn't happen with independent judging)
        const inResponseRefButNotJudged = [...currentCriteriaIds].filter(id => !judgedCriteriaIds.has(id));
        if (inResponseRefButNotJudged.length > 0) {
            console.warn('⚠️ WARNING: Criteria in response_reference but not in judge result:', inResponseRefButNotJudged);
            console.warn('   This should not happen with independent judging - all criteria in response_reference should be evaluated');
        }
        
        if (missingCriteriaIds.length > 0) {
            console.warn('⚠️ MISSING CRITERIA DETECTED:', missingCriteriaIds);
            // Add missing criteria to judge result as MISSING
            for (const missingId of missingCriteriaIds) {
                // Don't overwrite if already in criteria (shouldn't happen, but just in case)
                if (!(missingId in criteria)) {
                    criteria[missingId] = 'MISSING';
                }
                // Also add to state.criteria so it shows in UI
                const missingCriterion = (state.initialCriteria || []).find(c => c.id === missingId);
                if (missingCriterion) {
                    if (!state.criteria.find(c => c.id === missingId)) {
                        state.criteria.push(missingCriterion);
                        console.log(`✅ Added missing criterion ${missingId} to state.criteria`);
                    } else {
                        console.log(`ℹ️ Missing criterion ${missingId} already in state.criteria`);
                    }
                } else {
                    console.error(`❌ ERROR: Missing criterion ${missingId} not found in state.initialCriteria!`);
                    console.error('   This means the notebook was loaded AFTER this criterion was removed from response_reference.');
                    console.error('   state.initialCriteria:', state.initialCriteria);
                    console.error('   To fix: Reload the notebook from the ORIGINAL Colab URL (before C4 was removed)');
                    // Still add it to state.criteria as MISSING even without description
                    // This ensures it shows in the UI
                    if (!state.criteria.find(c => c.id === missingId)) {
                        state.criteria.push({ id: missingId, criteria: `Criterion ${missingId} (description not available - was removed before notebook was loaded)` });
                        console.log(`⚠️ Added missing criterion ${missingId} to state.criteria without description`);
                    }
                }
            }
            // Recalculate entries after adding MISSING
            criteriaEntries = Object.entries(criteria);
        } else {
            console.log('✅ No missing criteria detected - all initial criteria were evaluated by judge');
            
            // Optional: Check for sequential gaps as a WARNING only (not marking as missing)
            // This helps identify potential issues but doesn't assume criteria should exist
            const allCriteriaIds = new Set([...initialCriteriaIds, ...currentCriteriaIds, ...judgedCriteriaIds]);
            const criteriaNumbers = Array.from(allCriteriaIds)
                .map(id => {
                    const match = id.match(/^C(\d+)$/i);
                    return match ? parseInt(match[1]) : null;
                })
                .filter(num => num !== null)
                .sort((a, b) => a - b);
            
            if (criteriaNumbers.length > 0) {
                const minNum = Math.min(...criteriaNumbers);
                const maxNum = Math.max(...criteriaNumbers);
                
                // Check for sequential gaps (e.g., C1, C2, C17 - missing C3-C16)
                const sequentialGaps = [];
                for (let i = minNum; i <= maxNum; i++) {
                    const cId = `C${i}`;
                    if (!allCriteriaIds.has(cId)) {
                        sequentialGaps.push(cId);
                    }
                }
                
                if (sequentialGaps.length > 0) {
                    console.warn('⚠️ SEQUENTIAL GAP DETECTED (WARNING ONLY - not marking as missing):', sequentialGaps);
                    console.warn('   This suggests non-sequential criteria IDs. This is OK if those criteria never existed.');
                    console.warn('   Only criteria in initialCriteria will be marked as MISSING.');
                }
            }
            
            // Double-check: if judge result has fewer criteria than initial, something might be wrong
            if (initialCriteriaIds.size > judgedCriteriaIds.size) {
                const notJudged = [...initialCriteriaIds].filter(id => !judgedCriteriaIds.has(id));
                console.warn('⚠️ WARNING: Some initial criteria were not judged:', notJudged);
                console.warn('   This might indicate criteria were removed from response_reference after initial load');
            }
        }
        
        console.log('Final state.criteria IDs:', state.criteria.map(c => c.id));
        console.log('Final judge result criteria (including missing):', Object.keys(criteria));
        console.log('Final criteria object:', criteria);
        
        // Check if ALL criteria pass (not just overall score)
        // Missing criteria (MISSING status) don't count as failures, but block hunting
        const evaluatedCriteria = criteriaEntries.filter(([key, value]) => 
            String(value).toUpperCase() !== 'MISSING'
        );
        const missingCriteria = criteriaEntries.filter(([key, value]) => 
            String(value).toUpperCase() === 'MISSING'
        );
        const allCriteriaPass = evaluatedCriteria.length > 0 && 
            evaluatedCriteria.every(([key, value]) => String(value).toUpperCase() === 'PASS');
        
        // Block hunting if there are missing criteria
        const hasMissingCriteria = missingCriteria.length > 0;
        const isPassing = allCriteriaPass && !hasMissingCriteria;
        const scoreClass = isPassing ? 'score-1' : 'score-0';
        const scoreEmoji = isPassing ? '✅' : '❌';
        
        // Update reference validated state
        state.referenceValidated = isPassing;
        
        // Enable/disable Start Hunt based on result
        // Requirements: JSON valid + All criteria present + All criteria pass + No missing criteria
        if (elements.startHuntBtn) {
            // First check: JSON must be valid
            if (!state.modelRefValid) {
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = 'Model Reference must be valid JSON before hunting';
            }
            // Second check: All criteria must be present (no missing)
            else if (hasMissingCriteria) {
                const missingIds = missingCriteria.map(([id]) => id).join(', ');
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = `Missing criteria: ${missingIds}. Please add them back to response_reference and re-judge.`;
            }
            // Third check: All criteria must pass
            else if (isPassing && !hasMissingCriteria) {
                elements.startHuntBtn.disabled = false;
                elements.startHuntBtn.title = '';
            } else {
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = 'All criteria must pass before starting hunt';
            }
        }
        
        // Build criteria breakdown HTML
        const criteriaHtml = formatJudgeCriteriaDisplay(criteria);
        
        // Build status message
        let statusMessage = '';
        if (hasMissingCriteria) {
            const missingIds = missingCriteria.map(([id]) => id).join(', ');
            statusMessage = `⚠️ MISSING CRITERIA: ${missingIds} - Please add them back to response_reference and re-judge`;
        } else if (isPassing) {
            statusMessage = 'ALL CRITERIA PASS - Hunt Enabled!';
        } else {
            statusMessage = 'CRITERIA FAILED - Fix before hunting';
        }
        
        resultDiv.innerHTML = `
            <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid ${hasMissingCriteria ? 'var(--warning)' : (isPassing ? 'var(--success)' : 'var(--danger)')};">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                    <span class="score-badge ${scoreClass}">${scoreEmoji} Score: ${data.score}</span>
                    <span style="font-weight: 600;">${statusMessage}</span>
                </div>
                
                <!-- Criteria Breakdown -->
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📋 Criteria Breakdown:</label>
                    ${criteriaHtml}
                </div>
                
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📝 Judge Explanation:</label>
                    <p style="margin-top: 0.25rem; font-size: 0.9rem; color: var(--text-secondary); white-space: pre-wrap;">${escapeHtml(data.explanation || 'No explanation provided')}</p>
                    ${missingCriteria && missingCriteria.length > 0 ? `
                    <div style="margin-top: 0.5rem; padding: 0.5rem; background: var(--warning-bg); border-left: 3px solid var(--warning); border-radius: 4px; font-size: 0.85rem;">
                        <strong>⚠️ Note:</strong> The judge's explanation above refers only to the criteria present in <code>response_reference</code> (${evaluatedCriteria.length} criteria evaluated). 
                        ${missingCriteria.length} criterion/criteria (${missingCriteria.map(([id]) => id).join(', ')}) ${missingCriteria.length === 1 ? 'is' : 'are'} missing from <code>response_reference</code> and ${missingCriteria.length === 1 ? 'was' : 'were'} not evaluated.
                    </div>
                    ` : ''}
                </div>
                
                ${(data.score === null || !criteria || Object.keys(criteria).length === 0) ? `
                <div style="margin-top: 0.75rem; padding: 0.5rem; background: var(--danger-bg); border-radius: 4px;">
                    <label style="font-weight: 600; font-size: 0.9rem; color: var(--danger);">⚠️ Debug - Raw Output:</label>
                    <pre style="margin-top: 0.25rem; font-size: 0.8rem; color: var(--text-secondary); white-space: pre-wrap; max-height: 200px; overflow: auto;">${escapeHtml(data.raw_output || 'No raw output')}</pre>
                </div>
                ` : ''}
            </div>
        `;
        // Show result div below response editor (not covering it)
        resultDiv.classList.remove('hidden');
        // Scroll response editor into view first, then show result
        const responseEditor = document.getElementById('responseEditor');
        if (responseEditor) {
            // Keep response editor in view - don't scroll away
            responseEditor.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
        }
        
        const passCount = criteriaEntries.filter(([k, v]) => String(v).toUpperCase() === 'PASS').length;
        const totalCount = criteriaEntries.length;
        showToast(`Reference: ${passCount}/${totalCount} criteria pass (${isPassing ? 'HUNT ENABLED' : 'Fix required'})`, isPassing ? 'success' : 'warning');
        
    } catch (error) {
        // Display error prominently in result div
        resultDiv.innerHTML = `
            <div style="padding: 1rem; background: var(--danger-bg); border-radius: 8px; border: 2px solid var(--danger);">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                    <span style="font-size: 1.2rem;">❌</span>
                    <span style="font-weight: 600; color: var(--danger); font-size: 1rem;">Judge Error</span>
                </div>
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem; color: var(--danger);">Error Message:</label>
                    <p style="margin-top: 0.25rem; font-size: 0.9rem; color: var(--text-primary); white-space: pre-wrap; word-break: break-word;">${escapeHtml(error.message || 'Unknown error occurred')}</p>
                </div>
            </div>
        `;
        resultDiv.classList.remove('hidden');
        // Keep response editor in view
        const responseEditor = document.getElementById('responseEditor');
        if (responseEditor) {
            responseEditor.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
        }
        
        // Also show toast
        showToast(`Error: ${error.message}`, 'error');
        
        // Disable hunt button on error
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = 'Fix judge error before starting hunt';
        }
        state.referenceValidated = false;
    } finally {
        if (btn) {
            btn.disabled = false;
            // Update button text based on which button it is
            if (btn.id === 'judgeBeforeHuntBtn') {
                btn.textContent = '⚖️ Judge Reference';
            } else if (btn.id === 'judgeReferenceBtn') {
                btn.textContent = '⚖️ Judge Only';
            }
        }
    }
}

// Save Response Only (without judging)
async function saveResponseOnly() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    const btn = elements.saveResponseBtn;
    if (!btn) {
        showToast('Save button not found', 'error');
        return;
    }
    
    // Get response from rich text editor (contenteditable div)
    const responseEditor = elements.referencePreview;
    const newResponse = responseEditor?.textContent || responseEditor?.innerText || '';
    
    if (!newResponse.trim()) {
        showToast('Response cannot be empty', 'error');
        return;
    }
    
    try {
        btn.disabled = true;
        btn.textContent = '💾 Saving...';
        
        // Save to Colab
        const saveResponse = await fetch(`/api/update-response/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: newResponse })
        });
        
        if (!saveResponse.ok) {
            const error = await saveResponse.json();
            throw new Error(error.detail || 'Failed to save to Colab');
        }
        
        showToast('✅ Saved to Colab!', 'success');
        
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '💾 Save Response';
    }
}

// Combined Save & Judge function for Response tab (legacy - not used anymore)
async function saveAndJudgeResponse() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    // Check minimum 3 criteria requirement
    const currentRefText = elements.modelrefPreview?.textContent || '';
    let currentCriteria;
    try {
        currentCriteria = parseCriteria(currentRefText);
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showToast(`❌ Failed to parse criteria: ${error.message}`, 'error');
        return;
    }
    if (currentCriteria.length < 3) {
        showToast(`❌ Minimum 3 criteria required. Currently have ${currentCriteria.length}. Please add more criteria before saving.`, 'error');
        return;
    }
    
    const btn = elements.saveAndJudgeResponseBtn;
    if (!btn) {
        showToast('Save & Judge button not found', 'error');
        return;
    }
    const resultDiv = elements.referenceJudgeResult;
    // Get response from rich text editor (contenteditable div)
    const responseEditor = elements.referencePreview;
    const newResponse = responseEditor?.textContent || responseEditor?.innerText || '';
    
    if (!newResponse.trim()) {
        showToast('Response cannot be empty', 'error');
        return;
    }
    
    try {
        btn.disabled = true;
        btn.textContent = '💾 Saving...';
        // Don't hide result div - keep response editor visible
        if (resultDiv) {
            resultDiv.innerHTML = '';
            resultDiv.classList.add('hidden');
        }
        
        // Step 1: Save to Colab
        const saveResponse = await fetch(`/api/update-response/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: newResponse })
        });
        
        if (!saveResponse.ok) {
            const error = await saveResponse.json();
            throw new Error(error.detail || 'Failed to save to Colab');
        }
        
        showToast('✅ Saved to Colab!', 'success');
        btn.textContent = '⚖️ Judging...';
        
        // Step 2: Judge
        const judgeResponse = await fetch(`/api/judge-reference/${state.sessionId}`, {
            method: 'POST'
        });
        
        if (!judgeResponse.ok) {
            if (judgeResponse.status === 404) {
                showToast('⚠️ Session expired. Please reload the notebook.', 'error');
                throw new Error('Session not found. Please reload the notebook from Colab.');
            }
            const error = await judgeResponse.json();
            throw new Error(error.detail || 'Judge failed');
        }
        
        const data = await judgeResponse.json();
        
        // Update state.criteria from judge result
        let criteria = data.criteria || {};
        let criteriaEntries = Object.entries(criteria);
        
        // Check for missing criteria
        const evaluatedCriteria = criteriaEntries.map(([id]) => id);
        const missingCriteria = (state.initialCriteria || [])
            .filter(c => !evaluatedCriteria.includes(c.id))
            .map(c => [c.id, c.criteria]);
        const hasMissingCriteria = missingCriteria.length > 0;
        
        // Determine if all criteria pass
        const allCriteriaPass = criteriaEntries.length > 0 && 
            criteriaEntries.every(([k, v]) => String(v).toUpperCase() === 'PASS');
        const isPassing = allCriteriaPass && !hasMissingCriteria;
        
        const scoreClass = isPassing ? 'score-1' : 'score-0';
        const scoreEmoji = isPassing ? '✅' : '❌';
        
        // Update reference validated state
        state.referenceValidated = isPassing;
        
        // Enable/disable Start Hunt based on result
        if (elements.startHuntBtn) {
            if (!state.modelRefValid) {
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = 'Model Reference must be valid JSON before hunting';
            } else if (hasMissingCriteria) {
                const missingIds = missingCriteria.map(([id]) => id).join(', ');
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = `Missing criteria: ${missingIds}. Please add them back to response_reference and re-judge.`;
            } else if (isPassing && !hasMissingCriteria) {
                elements.startHuntBtn.disabled = false;
                elements.startHuntBtn.title = '';
            } else {
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = 'All criteria must pass before starting hunt';
            }
        }
        
        // Build criteria breakdown HTML
        const criteriaHtml = formatJudgeCriteriaDisplay(criteria);
        
        // Build status message
        let statusMessage = '';
        if (hasMissingCriteria) {
            const missingIds = missingCriteria.map(([id]) => id).join(', ');
            statusMessage = `⚠️ Saved but MISSING CRITERIA: ${missingIds} - Please add them back to response_reference and re-judge`;
        } else if (isPassing) {
            statusMessage = '✅ Saved & ALL CRITERIA PASS - Hunt Enabled!';
        } else {
            statusMessage = '❌ Saved but CRITERIA FAILED - Edit & try again';
        }
        
        resultDiv.innerHTML = `
            <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid ${hasMissingCriteria ? 'var(--warning)' : (isPassing ? 'var(--success)' : 'var(--danger)')};">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                    <span class="score-badge ${scoreClass}">${scoreEmoji} Score: ${data.score}</span>
                    <span style="font-weight: 600;">${statusMessage}</span>
                </div>
                
                <!-- Criteria Breakdown -->
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📋 Criteria Breakdown:</label>
                    ${criteriaHtml}
                </div>
                
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📝 Judge Explanation:</label>
                    <p style="margin-top: 0.25rem; font-size: 0.9rem; color: var(--text-secondary); white-space: pre-wrap;">${escapeHtml(data.explanation || 'No explanation provided')}</p>
                    ${missingCriteria && missingCriteria.length > 0 ? `
                    <div style="margin-top: 0.5rem; padding: 0.5rem; background: var(--warning-bg); border-left: 3px solid var(--warning); border-radius: 4px; font-size: 0.85rem;">
                        <strong>⚠️ Note:</strong> The judge's explanation above refers only to the criteria present in <code>response_reference</code> (${evaluatedCriteria.length} criteria evaluated). 
                        ${missingCriteria.length} criterion/criteria (${missingCriteria.map(([id]) => id).join(', ')}) ${missingCriteria.length === 1 ? 'is' : 'are'} missing from <code>response_reference</code> and ${missingCriteria.length === 1 ? 'was' : 'were'} not evaluated.
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
        // Show result div below response editor (expands downward)
        resultDiv.classList.remove('hidden');
        // Keep response editor in view - don't scroll away
        const responseEditor = document.getElementById('responseEditor');
        if (responseEditor) {
            // Just ensure editor is visible, don't scroll to result
            responseEditor.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
        }
        
        const passCount = criteriaEntries.filter(([k, v]) => String(v).toUpperCase() === 'PASS').length;
        const totalCount = criteriaEntries.length;
        showToast(`Saved & Judged: ${passCount}/${totalCount} criteria pass (${isPassing ? 'HUNT ENABLED' : 'Fix required'})`, isPassing ? 'success' : 'warning');
        
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        // Display error in result div
        if (resultDiv) {
            resultDiv.innerHTML = `
                <div style="padding: 1rem; background: var(--danger-bg); border-radius: 8px; border: 2px solid var(--danger);">
                    <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                        <span style="font-size: 1.2rem;">❌</span>
                        <span style="font-weight: 600; color: var(--danger); font-size: 1rem;">Error</span>
                    </div>
                    <div style="margin-top: 0.75rem;">
                        <label style="font-weight: 600; font-size: 0.9rem; color: var(--danger);">Error Message:</label>
                        <p style="margin-top: 0.25rem; font-size: 0.9rem; color: var(--text-primary); white-space: pre-wrap; word-break: break-word;">${escapeHtml(error.message || 'Unknown error occurred')}</p>
                    </div>
                </div>
            `;
            resultDiv.classList.remove('hidden');
            // Keep response editor in view
            const responseEditor = document.getElementById('responseEditor');
            if (responseEditor) {
                responseEditor.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
            }
        }
        
        // Disable hunt button on error
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = 'Fix error before starting hunt';
        }
        state.referenceValidated = false;
    } finally {
        btn.disabled = false;
        btn.textContent = '💾⚖️ Save & Judge Response';
    }
}

// Save edited response to Colab and re-judge (legacy function)
async function saveAndRejudge() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    // Check minimum 3 criteria requirement
    const currentRefText = elements.modelrefPreview?.textContent || '';
    let currentCriteria;
    try {
        currentCriteria = parseCriteria(currentRefText);
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showToast(`❌ Failed to parse criteria: ${error.message}`, 'error');
        return;
    }
    if (currentCriteria.length < 3) {
        showToast(`❌ Minimum 3 criteria required. Currently have ${currentCriteria.length}. Please add more criteria before saving.`, 'error');
        return;
    }
    
    const btn = elements.saveResponseBtn;
    const resultDiv = elements.referenceJudgeResult;
    const newResponse = elements.referencePreview.value;
    
    if (!newResponse.trim()) {
        showToast('Response cannot be empty', 'error');
        return;
    }
    
    try {
        btn.disabled = true;
        btn.textContent = '💾 Saving...';
        resultDiv.classList.add('hidden');
        
        // Step 1: Save to Colab
        const saveResponse = await fetch(`/api/update-response/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response: newResponse })
        });
        
        if (!saveResponse.ok) {
            const error = await saveResponse.json();
            throw new Error(error.detail || 'Failed to save to Colab');
        }
        
        showToast('✅ Saved to Colab!', 'success');
        btn.textContent = '⚖️ Re-judging...';
        
        // Step 2: Re-judge
        const judgeResponse = await fetch(`/api/judge-reference/${state.sessionId}`, {
            method: 'POST'
        });
        
        if (!judgeResponse.ok) {
            if (judgeResponse.status === 404) {
                // Session not found - likely expired or invalid
                showToast('⚠️ Session expired. Please reload the notebook.', 'error');
                throw new Error('Session not found. Please reload the notebook from Colab.');
            }
            const error = await judgeResponse.json();
            throw new Error(error.detail || 'Judge failed');
        }
        
        const data = await judgeResponse.json();
        
        // Update state.criteria from judge result to keep in sync
        let criteria = data.criteria || {};
        let criteriaEntries = Object.entries(criteria);
        
        // Debug: Log what criteria were judged
        console.log('Judge result criteria (saveAndRejudge):', Object.keys(criteria));
        console.log('Initial criteria IDs:', (state.initialCriteria || []).map(c => c.id));
        console.log('Current state.criteria IDs (before update):', (state.criteria || []).map(c => c.id));
        
        // IMPORTANT: Re-parse criteria from fresh response_reference if provided
        // This ensures state.criteria matches what was actually in the notebook when judging
        let currentCriteria = [];
        if (data.response_reference) {
            console.log('Re-parsing criteria from fresh response_reference (saveAndRejudge)');
            try {
            currentCriteria = parseCriteria(data.response_reference);
            state.criteria = currentCriteria;
            console.log('Updated state.criteria IDs (from response_reference):', state.criteria.map(c => c.id));
            } catch (error) {
                console.error('Failed to parse criteria:', error);
                showToast(`❌ Failed to parse criteria: ${error.message}`, 'error');
                return;
            }
        } else {
            // Fallback: Update state.criteria based on what was actually judged
            const judgedCriteriaIds = new Set(Object.keys(criteria));
            state.criteria = (state.criteria || []).filter(c => judgedCriteriaIds.has(c.id));
            currentCriteria = state.criteria;
        }
        
        // CRITICAL: Filter out criteria from judge result that are NOT in response_reference
        // These should be marked as MISSING, not FAIL
        const currentCriteriaIds = new Set(currentCriteria.map(c => c.id));
        const judgedCriteriaIds = new Set(Object.keys(criteria));
        const criteriaNotInResponseRef = [...judgedCriteriaIds].filter(id => !currentCriteriaIds.has(id));
        
        if (criteriaNotInResponseRef.length > 0) {
            console.warn('⚠️ Judge returned criteria not in response_reference (saveAndRejudge):', criteriaNotInResponseRef);
            console.warn('   These will be marked as MISSING instead of their judge status (FAIL/PASS)');
            // Mark these as MISSING and add them to state.criteria
            for (const id of criteriaNotInResponseRef) {
                criteria[id] = 'MISSING';
                // Add to state.criteria if not already there
                if (!state.criteria.find(c => c.id === id)) {
                    state.criteria.push({ 
                        id: id, 
                        criteria: `Criterion ${id} (not in response_reference - please add it back)` 
                    });
                    console.log(`✅ Added missing criterion ${id} to state.criteria (from judge result, saveAndRejudge)`);
                }
            }
            // Recalculate entries after adding MISSING
            criteriaEntries = Object.entries(criteria);
        }
        
        // Check for missing criteria: Compare initial criteria with what was actually judged
        // With independent judging, ALL criteria in response_reference should be evaluated
        const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
        const judgedCriteriaIdsSet = new Set(Object.keys(criteria));
        const missingCriteriaIds = [...initialCriteriaIds].filter(id => !judgedCriteriaIdsSet.has(id));
        
        console.log('DEBUG: Missing criteria check (saveAndRejudge) - Initial:', Array.from(initialCriteriaIds), 'Current:', Array.from(currentCriteriaIds), 'Judged:', Array.from(judgedCriteriaIdsSet), 'Missing:', missingCriteriaIds);
        
        if (missingCriteriaIds.length > 0) {
            console.warn('Missing criteria detected (saveAndRejudge):', missingCriteriaIds);
            // Add missing criteria to judge result as MISSING
            for (const missingId of missingCriteriaIds) {
                criteria[missingId] = 'MISSING';
                // Also add to state.criteria so it shows in UI
                const missingCriterion = (state.initialCriteria || []).find(c => c.id === missingId);
                if (missingCriterion && !state.criteria.find(c => c.id === missingId)) {
                    state.criteria.push(missingCriterion);
                }
            }
            // Recalculate entries after adding MISSING
            criteriaEntries = Object.entries(criteria);
        } else {
            console.log('✅ No missing criteria detected (saveAndRejudge) - all initial criteria are present in current response_reference');
            
            // Optional: Check for sequential gaps as a WARNING only (not marking as missing)
            // This helps identify potential issues but doesn't assume criteria should exist
            const allCriteriaIds = new Set([...initialCriteriaIds, ...currentCriteriaIds, ...judgedCriteriaIds]);
            const criteriaNumbers = Array.from(allCriteriaIds)
                .map(id => {
                    const match = id.match(/^C(\d+)$/i);
                    return match ? parseInt(match[1]) : null;
                })
                .filter(num => num !== null)
                .sort((a, b) => a - b);
            
            if (criteriaNumbers.length > 0) {
                const minNum = Math.min(...criteriaNumbers);
                const maxNum = Math.max(...criteriaNumbers);
                
                // Check for sequential gaps (e.g., C1, C2, C17 - missing C3-C16)
                const sequentialGaps = [];
                for (let i = minNum; i <= maxNum; i++) {
                    const cId = `C${i}`;
                    if (!allCriteriaIds.has(cId)) {
                        sequentialGaps.push(cId);
                    }
                }
                
                if (sequentialGaps.length > 0) {
                    console.warn('⚠️ SEQUENTIAL GAP DETECTED (WARNING ONLY - not marking as missing, saveAndRejudge):', sequentialGaps);
                    console.warn('   This suggests non-sequential criteria IDs. This is OK if those criteria never existed.');
                    console.warn('   Only criteria in initialCriteria will be marked as MISSING.');
                }
            }
        }
        
        console.log('Final state.criteria IDs (saveAndRejudge):', state.criteria.map(c => c.id));
        console.log('Final judge result criteria (including missing):', Object.keys(criteria));
        
        // Check if ALL criteria pass (not just overall score)
        // Missing criteria (MISSING status) don't count as failures, but block hunting
        const evaluatedCriteria = criteriaEntries.filter(([key, value]) => 
            String(value).toUpperCase() !== 'MISSING'
        );
        const missingCriteria = criteriaEntries.filter(([key, value]) => 
            String(value).toUpperCase() === 'MISSING'
        );
        const allCriteriaPass = evaluatedCriteria.length > 0 && 
            evaluatedCriteria.every(([key, value]) => String(value).toUpperCase() === 'PASS');
        
        // Block hunting if there are missing criteria
        const hasMissingCriteria = missingCriteria.length > 0;
        const isPassing = allCriteriaPass && !hasMissingCriteria;
        const scoreClass = isPassing ? 'score-1' : 'score-0';
        const scoreEmoji = isPassing ? '✅' : '❌';
        
        // Update reference validated state
        state.referenceValidated = isPassing;
        
        // Enable/disable Start Hunt based on result
        // Requirements: JSON valid + All criteria present + All criteria pass + No missing criteria
        if (elements.startHuntBtn) {
            // First check: JSON must be valid
            if (!state.modelRefValid) {
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = 'Model Reference must be valid JSON before hunting';
            }
            // Second check: All criteria must be present (no missing)
            else if (hasMissingCriteria) {
                const missingIds = missingCriteria.map(([id]) => id).join(', ');
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = `Missing criteria: ${missingIds}. Please add them back to response_reference and re-judge.`;
            }
            // Third check: All criteria must pass
            else if (isPassing && !hasMissingCriteria) {
                elements.startHuntBtn.disabled = false;
                elements.startHuntBtn.title = '';
            } else {
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = 'All criteria must pass before starting hunt';
            }
        }
        
        // Build criteria breakdown HTML
        const criteriaHtml = formatJudgeCriteriaDisplay(criteria);
        
        // Build status message
        let statusMessage = '';
        if (hasMissingCriteria) {
            const missingIds = missingCriteria.map(([id]) => id).join(', ');
            statusMessage = `⚠️ Saved but MISSING CRITERIA: ${missingIds} - Please add them back to response_reference and re-judge`;
        } else if (isPassing) {
            statusMessage = '✅ Saved & ALL CRITERIA PASS - Hunt Enabled!';
        } else {
            statusMessage = '❌ Saved but CRITERIA FAILED - Edit & try again';
        }
        
        resultDiv.innerHTML = `
            <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid ${hasMissingCriteria ? 'var(--warning)' : (isPassing ? 'var(--success)' : 'var(--danger)')};">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                    <span class="score-badge ${scoreClass}">${scoreEmoji} Score: ${data.score}</span>
                    <span style="font-weight: 600;">${statusMessage}</span>
                </div>
                
                <!-- Criteria Breakdown -->
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📋 Criteria Breakdown:</label>
                    ${criteriaHtml}
                </div>
                
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📝 Judge Explanation:</label>
                    <p style="margin-top: 0.25rem; font-size: 0.9rem; color: var(--text-secondary); white-space: pre-wrap;">${escapeHtml(data.explanation || 'No explanation provided')}</p>
                    ${missingCriteria && missingCriteria.length > 0 ? `
                    <div style="margin-top: 0.5rem; padding: 0.5rem; background: var(--warning-bg); border-left: 3px solid var(--warning); border-radius: 4px; font-size: 0.85rem;">
                        <strong>⚠️ Note:</strong> The judge's explanation above refers only to the criteria present in <code>response_reference</code> (${evaluatedCriteria.length} criteria evaluated). 
                        ${missingCriteria.length} criterion/criteria (${missingCriteria.map(([id]) => id).join(', ')}) ${missingCriteria.length === 1 ? 'is' : 'are'} missing from <code>response_reference</code> and ${missingCriteria.length === 1 ? 'was' : 'were'} not evaluated.
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
        // Show result div below response editor (expands downward)
        resultDiv.classList.remove('hidden');
        // Keep response editor in view - don't scroll away from it
        const responseEditor = document.getElementById('responseEditor');
        if (responseEditor) {
            // Just ensure editor is visible, don't scroll to result
            responseEditor.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
        }
        
        const passCount = criteriaEntries.filter(([k, v]) => String(v).toUpperCase() === 'PASS').length;
        const totalCount = criteriaEntries.length;
        showToast(`Saved: ${passCount}/${totalCount} criteria pass (${isPassing ? 'HUNT ENABLED' : 'Fix required'})`, isPassing ? 'success' : 'warning');
        
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '💾 Save Response';
    }
}


// ============== Initialize ==============

function init() {
    initTheme();
    initTabs();
    initFileUpload();
    initPreviewTabs();
    initEventListeners();
    initHuntNumberControls();
    
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Validate the reference response first (click "Judge Reference Response")';
    }

    // Initialize provider logic
    initializeProviderLogic();
    
    console.log('🔥 Model Hunter initialized');
}

// Initialize Provider/Model selection logic
function initializeProviderLogic() {
    if (!elements.providerSelect || !elements.modelSelect) return;

    // Set default provider to openrouter (has Qwen)
    if (elements.providerSelect) {
        elements.providerSelect.value = 'openrouter';
    }

    // Initial population (will select Qwen by default, but this can be overridden by notebook metadata)
    updateModelOptions();

    // Event listener
    elements.providerSelect.addEventListener('change', updateModelOptions);
}

function updateModelOptions(skipDefaultSelection = false) {
    const provider = elements.providerSelect.value;
    const models = PROVIDER_MODELS[provider] || [];
    
    // Clear current options
    elements.modelSelect.innerHTML = '';
    
    // Determine default model based on provider (only if skipDefaultSelection is false)
    let defaultModelId = 'qwen/qwen3-235b-a22b-thinking-2507'; // Default to Qwen
    if (provider === 'fireworks') {
        defaultModelId = 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507';
    }
    
    // Add new options
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        // Only set default selection if skipDefaultSelection is false
        if (!skipDefaultSelection) {
            if (model.id === defaultModelId || (models.length > 0 && model.id.includes('qwen'))) {
                option.selected = true;
            }
        }
        elements.modelSelect.appendChild(option);
    });
    
    // If no Qwen model was found and we're not skipping default, select first model
    if (!skipDefaultSelection && elements.modelSelect.value !== defaultModelId && models.length > 0) {
        // Check if default model exists in the list
        const defaultExists = models.some(m => m.id === defaultModelId);
        if (!defaultExists && models.length > 0) {
            elements.modelSelect.value = models[0].id;
        }
    }
    
    // Update state config with selected model (only if we set a default)
    if (!skipDefaultSelection && elements.modelSelect.value) {
        state.config.models = [elements.modelSelect.value];
    }
    
    console.log(`Updated models for provider: ${provider}, selected: ${elements.modelSelect.value} (skipDefault: ${skipDefaultSelection})`);
}

// Restore session on page load
async function restoreSession() {
    const savedSessionId = localStorage.getItem('modelHunter_sessionId');
    if (!savedSessionId) {
        console.log('No saved session found');
        return;
    }
    
    console.log('🔄 Attempting to restore session:', savedSessionId);
    
    try {
        // Try to get session from backend
        const response = await fetch(`/api/session/${savedSessionId}`);
        if (response.ok) {
            const sessionData = await response.json();
            console.log('✅ Session restored:', sessionData);
            
            // Try to get full notebook data
            // We need to reconstruct the notebook from session storage
            // For now, show a message that they need to reload the notebook
            showToast('🔄 Session found! Please reload the notebook to continue.', 'info');
            
            // Store sessionId in state
            state.sessionId = savedSessionId;
            
            // Optionally, try to fetch notebook data if available
            // This would require an endpoint to get notebook from session
        } else if (response.status === 404) {
            // Session expired or not found
            console.log('⚠️ Session expired or not found');
            localStorage.removeItem('modelHunter_sessionId');
            showToast('⚠️ Previous session expired. Please load a new notebook.', 'warning');
        } else {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        console.error('Error restoring session:', error);
        localStorage.removeItem('modelHunter_sessionId');
    }
}

// Start app
document.addEventListener('DOMContentLoaded', async () => {
    await init();
    // Restore session after initialization
    await restoreSession();
    
    // Ensure fetch button is set up (backup in case init didn't catch it)
    const fetchBtn = document.getElementById('fetchUrlBtn');
    if (fetchBtn && !fetchBtn.onclick) {
        console.log('Setting up fetch button as backup...');
        fetchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Fetch button clicked (backup handler)');
            fetchFromUrl();
        });
        fetchBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            fetchFromUrl();
        };
        fetchBtn.type = 'button';
        fetchBtn.disabled = false;
    }
});
