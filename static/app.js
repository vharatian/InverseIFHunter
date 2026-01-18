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


const PROVIDER_MODELS = {
    'openrouter': [
        { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron-3-Nano (Fast)' },
        { id: 'qwen/qwen3-235b-a22b-thinking-2507', name: 'Qwen3-235B (Thinking)' }
    ],
    'fireworks': [
        // Only Qwen3 for Fireworks (Nemotron not available on serverless)
        { id: 'accounts/fireworks/models/qwen3-235b-a22b-thinking', name: 'Qwen3-235B (Thinking)' }
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
        models: ['nvidia/nemotron-3-nano-30b-a3b-bf16'],
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
    selectedHuntIds: [],    // IDs of 4 selected responses for review
    llmRevealed: false,     // Whether LLM judgments have been revealed
    accumulatedHuntOffset: 0,  // Track total hunts for progress table numbering
    currentRunStartOffset: 0,  // Offset at start of current run (for row lookup during run)
    
    // Blind judging state
    blindJudging: {
        queue: [],           // Queue of results waiting for human judgment
        currentResult: null, // Current result being judged
        humanJudgments: {}   // Map of hunt_id -> human score
    }
};


// ============== DOM Elements ==============

const elements = {
    themeToggle: document.getElementById('themeToggle'),
    
    // Upload
    fileDropzone: document.getElementById('fileDropzone'),
    fileInput: document.getElementById('fileInput'),
    colabUrlInput: document.getElementById('colabUrlInput'),
    fetchUrlBtn: document.getElementById('fetchUrlBtn'),
    notebookInfo: document.getElementById('notebookInfo'),
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
    saveResponseBtn: document.getElementById('saveReponseBtn'),  // Save & Re-judge button
    referenceJudgeResult: document.getElementById('referenceJudgeResult'),
    
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
    
    // URL Fetch button
    if (elements.fetchUrlBtn) {
        elements.fetchUrlBtn.addEventListener('click', fetchFromUrl);
    }
    
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
    const url = elements.colabUrlInput?.value?.trim();
    if (!url) {
        showToast('Please enter a Colab URL', 'error');
        return;
    }
    
    try {
        showToast('Fetching notebook from URL...', 'info');
        elements.fetchUrlBtn.disabled = true;
        elements.fetchUrlBtn.textContent = '⏳ Fetching...';
        
        const response = await fetch('/api/fetch-notebook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Fetch failed');
        }
        
        const data = await response.json();
        handleNotebookLoaded(data, true);
        
    } catch (error) {
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

    
    // Show notebook info
    elements.notebookInfo.classList.remove('hidden');
    const filenameEl = document.getElementById('infoFilename');
    const filename = data.notebook.filename || '-';
    filenameEl.textContent = filename;
    filenameEl.title = filename; // Show full name on hover
    
    // Extract domain from metadata or filename
    let domain = '';
    if (data.notebook.metadata) {
        // Try multiple variations of the domain key (case-insensitive)
        const metadata = data.notebook.metadata;
        // First try exact matches
        domain = metadata.Domain || metadata.domain || metadata['Domain'] || metadata['domain'];
        
        // If not found, search case-insensitively
        if (!domain) {
            const domainKey = Object.keys(metadata).find(key => key.toLowerCase() === 'domain');
            if (domainKey) {
                domain = metadata[domainKey];
            }
        }
    }
    
    if (!domain && filename !== '-') {
        // Try to extract domain from filename pattern like "single_turn_,,,Domain,UseCase_..."
        const parts = filename.split(',');
        if (parts.length >= 2) {
            domain = parts[parts.length - 2] || parts[1] || '';
        }
    }
    document.getElementById('infoDomain').textContent = domain || 'Unknown';
    document.getElementById('infoPromptLength').textContent = `${data.notebook.prompt_length} chars`;
    document.getElementById('infoAttempts').textContent = data.notebook.attempts_made || 0;
    
    // Show config section
    elements.configSection.classList.remove('hidden');
    
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
    
    // ===== VALIDATION 0: Check LLM revealed =====
    if (!state.llmRevealed) {
        showToast('Complete all reviews and reveal LLM judgments before saving.', 'error');
        return;
    }
    
    // ===== VALIDATION 1: Check pending reviews =====
    const reviewCount = Object.keys(state.humanReviews || {}).length;
    if (reviewCount < 4) {
        showToast(`Only ${reviewCount}/4 human reviews completed. Complete all reviews first.`, 'error');
        return;
    }
    
    // ===== VALIDATION 1b: Check each review has criteria grading and explanation =====
    const reviews = Object.values(state.humanReviews || {});
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
    
    // ===== VALIDATION 2: Check for valid combination (4 failing OR 3 failing + 1 passing) =====
    const failCount = reviews.filter(r => r.judgment === 'bad' || r.judgment === 'fail').length;
    const passCount = reviews.filter(r => r.judgment === 'good' || r.judgment === 'pass').length;
    
    const validCombination = (failCount === 4) || (failCount === 3 && passCount === 1);
    if (!validCombination) {
        showToast(`Invalid combination: ${failCount} fail + ${passCount} pass. Need 4 failing OR 3 failing + 1 passing.`, 'error');
        alert(
            `Cannot save: Invalid response combination!\n\n` +
            `Current: ${failCount} failing + ${passCount} passing\n\n` +
            `Required: Either 4 failing responses OR 3 failing + 1 passing.\n\n` +
            `Please adjust your human reviews to meet this requirement.`
        );
        return;
    }
    
    // ===== VALIDATION 3: Check for criterion diversity (at least one C has both PASS and FAIL) =====
    const criteriaVotes = {};  // Track votes per criterion: { C1: { pass: 0, fail: 0 }, ... }
    
    console.log('🔍 DIVERSITY CHECK - All reviews:', reviews);
    
    for (const review of reviews) {
        const gradingBasis = review.grading_basis || {};
        console.log('  Review grading_basis:', gradingBasis);
        
        for (const [criterionId, vote] of Object.entries(gradingBasis)) {
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
    
    console.log('  Criteria votes summary:', criteriaVotes);
    
    // Check if ANY criterion has both a pass AND a fail
    const hasDiverseCriterion = Object.entries(criteriaVotes).some(
        ([id, votes]) => votes.pass > 0 && votes.fail > 0
    );
    
    console.log('  Has diverse criterion?', hasDiverseCriterion);
    console.log('  Total criteria checked:', Object.keys(criteriaVotes).length);
    
    // CRITICAL: Must have at least one criterion with both PASS and FAIL
    if (!hasDiverseCriterion && Object.keys(criteriaVotes).length > 0) {
        // Build a summary of votes for the error message
        const votesSummary = Object.entries(criteriaVotes)
            .map(([id, v]) => `${id}: ${v.pass} pass, ${v.fail} fail`)
            .join('\n  ');
        
        console.error('❌ DIVERSITY CHECK FAILED:', votesSummary);
        
        showToast('Criterion diversity required: At least one criterion must have both PASS and FAIL. You can still edit the slots to fix this.', 'error');
        alert(
            `Cannot save: Missing criterion diversity!\n\n` +
            `Requirement: At least one criterion (C1, C2, etc.) must receive both a PASS and a FAIL across the 4 responses.\n\n` +
            `Current votes:\n  ${votesSummary}\n\n` +
            `⚠️ IMPORTANT: You can still edit the human judge slots above to fix this.\n` +
            `Change some criteria from FAIL to PASS (or vice versa) to create diversity, then try saving again.`
        );
        // CRITICAL: Return here to prevent save
        return;
    }
    
    console.log('✅ Diversity check passed');
    
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
        // First save reviews
        await fetch(`/api/save-reviews/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviews: state.humanReviews || {} })
        });
        
        // Then save to drive - ONLY the selected responses
        const response = await fetch(`/api/save-to-drive/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                selected_hunt_ids: state.selectedHuntIds || [] 
            })
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Save failed');
        }
        
        showToast('Successfully saved back to Google Drive!', 'success');
        
    } catch (error) {
        console.error('Drive Save Error:', error);
        showToast(`Save failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

function populatePreviewTabs(notebook) {
    elements.promptPreview.textContent = notebook.prompt || 'No prompt found';
    elements.referencePreview.textContent = notebook.response || 'No expected response found';
    elements.judgePreview.textContent = notebook.judge_system_prompt || 'No judge prompt found';
    
    // Populate Model Reference tab with response_reference (grading criteria)
    if (elements.modelrefPreview) {
        elements.modelrefPreview.textContent = notebook.response_reference || 'No model reference criteria found';
    }
    
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
    try {
        const parsedCriteria = parseCriteria(notebook.response_reference || '');
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
        return;
    }
    
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
    // But hunt is still disabled until judge passes
    if (elements.modelrefPreview) {
        elements.modelrefPreview.textContent = responseReference || 'No model reference criteria found';
    }
    if (elements.startHuntBtn) {
        // Don't enable yet - still need to judge first
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Model Reference is valid. Click "Judge Reference Response" to validate.';
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
    
    try {
        // Extract only the JSON array between [ and ]
        const arrayMatch = responseReference.match(/\[[\s\S]*?\]/);
        
        if (!arrayMatch) {
            const error = 'No JSON array found between [ and ] brackets in response_reference';
            console.error(error);
            throw new Error(error);
        }
        
        const jsonArrayStr = arrayMatch[0];
        const criteriaArray = JSON.parse(jsonArrayStr);
        
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
    const model = elements.modelSelect?.value || 'nvidia/nemotron-3-nano-30b-a3b:free';
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
    
    state.isHunting = true;
    state.config = getConfig();
    state.results = [];
    
    // Add loading state to button
    elements.startHuntBtn.classList.add('loading');
    elements.startHuntBtn.disabled = true;
    
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
    
    // Start SSE stream
    const eventSource = new EventSource(`/api/hunt-stream/${state.sessionId}`);
    
    eventSource.onmessage = (event) => {
        console.log('SSE message:', event.data);
    };
    
    eventSource.addEventListener('start', (event) => {
        const data = JSON.parse(event.data);
        console.log('Hunt started:', data);
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

function handleHuntComplete(data) {
    state.isHunting = false;
    
    // Remove loading state from button
    elements.startHuntBtn.classList.remove('loading');
    elements.startHuntBtn.disabled = false;
    
    // Show upload and config sections again
    document.querySelector('.section')?.classList.remove('hidden');
    elements.configSection?.classList.remove('hidden');
    
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
        
        // Store all responses (accumulate across runs)
        const newResponses = data.results || [];
        state.allResponses = [...state.allResponses, ...newResponses];
        
        // Count total breaks across all accumulated responses
        const totalBreaks = state.allResponses.filter(r => r.judge_score === 0).length;
        const totalPasses = state.allResponses.filter(r => r.judge_score >= 1).length;
        
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
        
        const criteriaMet = criteriaMetBreaks && criteriaMetDiversity;
        
        if (!criteriaMet) {
            // Don't show selection - criteria not met
            elements.selectionSection.classList.add('hidden');
            let errorMsg = '';
            if (!criteriaMetBreaks) {
                errorMsg = `⚠️ Need at least 3 breaks (score 0). Currently have ${totalBreaks}. Run more hunts!`;
            } else if (!criteriaMetDiversity) {
                const criteriaList = Object.keys(criteriaGrades).join(', ') || 'none found';
                errorMsg = `⚠️ Need at least 1 criterion with both PASS and FAIL across hunts.\nCriteria found: ${criteriaList}\nRun hunts until at least one criterion has both grades.`;
            }
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
    
    // NO auto-selection - human picks all 4 manually
    state.selectedHuntIds = [];
    
    // Filter to only show broken hunts (judge_score === 0)
    const brokenHunts = state.allResponses.filter(r => r.judge_score === 0);
    
    if (brokenHunts.length === 0) {
        grid.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">No broken hunts found. Run more hunts to find model breaks.</div>';
        return;
    }
    
    // Create cards for only broken responses
    brokenHunts.forEach((result, index) => {
        const isSelected = state.selectedHuntIds.includes(result.hunt_id);
        const isFailed = result.judge_score === 0;
        const shortModel = (result.model || 'unknown').split('/').pop().substring(0, 20);
        
        const card = document.createElement('div');
        card.className = `selection-card ${isSelected ? 'selected' : ''}`;
        card.dataset.huntId = result.hunt_id;
        card.style.cssText = `
            padding: 1rem;
            border: 2px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border)'};
            border-radius: 8px;
            cursor: pointer;
            background: ${isSelected ? 'rgba(var(--accent-primary-rgb), 0.1)' : 'var(--bg-primary)'};
            transition: all 0.2s;
        `;
        
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <span style="font-weight: 600;">Response ${result.hunt_id}</span>
                <span class="score-badge" style="padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; background: ${isFailed ? 'var(--success)' : 'var(--danger)'}; color: white;">
                    ${isFailed ? '✅ BREAK' : '❌ PASS'}
                </span>
            </div>
            <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
                Model: ${shortModel}
            </div>
            <div style="font-size: 0.8rem; color: var(--text-muted); max-height: 60px; overflow: hidden; text-overflow: ellipsis;">
                ${escapeHtml((result.response || '').substring(0, 150))}...
            </div>
            <div style="text-align: center; margin-top: 0.5rem;">
                <input type="checkbox" class="selection-checkbox" ${isSelected ? 'checked' : ''} style="transform: scale(1.3);">
            </div>
        `;
        
        // Click handler
        card.addEventListener('click', (e) => {
            if (e.target.type !== 'checkbox') {
                const checkbox = card.querySelector('.selection-checkbox');
                checkbox.checked = !checkbox.checked;
            }
            toggleResponseSelection(result.hunt_id, card);
        });
        
        grid.appendChild(card);
    });
    
    updateSelectionCount();
}

function toggleResponseSelection(huntId, card) {
    const checkbox = card.querySelector('.selection-checkbox');
    
    if (checkbox.checked) {
        // Add to selection (max 4)
        if (state.selectedHuntIds.length >= 4) {
            checkbox.checked = false;
            showToast('Maximum 4 responses allowed. Unselect one first.', 'warning');
            return;
        }
        state.selectedHuntIds.push(huntId);
        card.classList.add('selected');
        card.style.borderColor = 'var(--accent-primary)';
        card.style.background = 'rgba(var(--accent-primary-rgb), 0.1)';
    } else {
        // Remove from selection
        state.selectedHuntIds = state.selectedHuntIds.filter(id => id !== huntId);
        card.classList.remove('selected');
        card.style.borderColor = 'var(--border)';
        card.style.background = 'var(--bg-primary)';
    }
    
    updateSelectionCount();
}

function updateSelectionCount() {
    const count = state.selectedHuntIds.length;
    elements.selectionCount.textContent = `Selected: ${count} / 4`;
    elements.selectionCount.style.color = count === 4 ? 'var(--success)' : 'var(--text-primary)';
    elements.confirmSelectionBtn.disabled = count !== 4;
}

function confirmSelection() {
    if (state.selectedHuntIds.length !== 4) {
        showToast('Please select exactly 4 responses', 'error');
        return;
    }
    
    // Hide selection, show results with blind review
    elements.selectionSection.classList.add('hidden');
    elements.resultsSection.classList.remove('hidden');
    
    // Display the selected responses for review (blind mode)
    displaySelectedForReview();
    
    showToast('Selection confirmed! Complete your human reviews.', 'success');
}

function displaySelectedForReview() {
    elements.breakingResults.innerHTML = '';
    elements.noBreaksMessage.classList.add('hidden');
    
    // DEBUG: Log what we're filtering
    console.log('displaySelectedForReview called');
    console.log('selectedHuntIds:', state.selectedHuntIds);
    console.log('allResponses hunt_ids:', state.allResponses.map(r => r.hunt_id));
    
    // Get the selected responses from allResponses - LIMIT TO EXACTLY 4
    const selectedResponses = state.allResponses.filter(r => 
        state.selectedHuntIds.includes(r.hunt_id)
    ).slice(0, 4);  // Force max 4 just in case
    
    console.log('selectedResponses count:', selectedResponses.length);
    console.log('selectedResponses hunt_ids:', selectedResponses.map(r => r.hunt_id));
    
    if (selectedResponses.length === 0) {
        elements.noBreaksMessage.classList.remove('hidden');
        console.warn('No matching responses found!');
        return;
    }
    
    // Create result cards for each selected response (blind mode - LLM hidden)
    selectedResponses.forEach((result, index) => {
        const card = createResultCard(result, index);
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
    elements.saveDriveBtn.disabled = true;
    elements.saveDriveBtn.style.opacity = '0.5';
}

function updateReviewProgress() {
    const reviewCount = Object.keys(state.humanReviews).length;
    const selectedCount = state.selectedHuntIds.length;
    
    if (elements.reviewProgressText) {
        elements.reviewProgressText.textContent = `${reviewCount} / ${selectedCount} completed`;
        elements.reviewProgressText.style.color = reviewCount === selectedCount ? 'var(--success)' : 'var(--text-primary)';
    }
    
    // Enable reveal button only when all 4 reviews are complete
    if (elements.revealLLMBtn) {
        const allComplete = reviewCount >= 4;
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
    if (Object.keys(state.humanReviews).length < 4) {
        showToast('Please complete all 4 human reviews first', 'error');
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

function createResultCard(result, slotIndex) {
    const card = document.createElement('div');
    card.className = 'expandable-card';
    card.dataset.huntId = result.hunt_id;
    card.dataset.slotIndex = slotIndex || 0;
    
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
    console.log(`Slot ${slotNum} dedup check:`, {
        responseLen: responseClean.length,
        traceLen: traceClean.length,
        first50Match: responseClean.substring(0, 50) === traceClean.substring(0, 50),
        hasTrace: !!reasoningTrace
    });
    
    // Check for duplicates in UI only - export still gets full trace
    if (reasoningTrace && traceClean.length > 0) {
        const isDuplicate = (
            traceClean === responseClean ||
            responseClean.includes(traceClean) ||
            traceClean.includes(responseClean)
        );
        if (isDuplicate) {
            console.log(`Slot ${slotNum}: Hiding duplicate trace in UI (export has full trace)`);
            reasoningTrace = ''; // Hide from UI only
        }
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
            <!-- Tabbed Interface -->
            <div class="slot-tabs-container" data-hunt-id="${result.hunt_id}">
                <!-- Tab Navigation -->
                <div class="slot-tabs-nav" role="tablist">
                    <button class="slot-tab active" data-tab="response" role="tab" aria-selected="true">
                        📄 Response
                    </button>
                    <button class="slot-tab" data-tab="reasoning" role="tab" aria-selected="false">
                        🧠 Reasoning
                    </button>
                    <button class="slot-tab" data-tab="grade" role="tab" aria-selected="false">
                        ✅ Grade
                    </button>
                    <button class="slot-tab" data-tab="review" role="tab" aria-selected="false">
                        📝 Review
                    </button>
            </div>
            
                <!-- Tab Content -->
                <div class="slot-tabs-content">
                    <!-- Response Tab -->
                    <div class="slot-tab-panel active" data-tab="response" role="tabpanel">
                        <div class="tab-content-inner">
                            <label style="font-weight: 600; display: block; margin-bottom: 0.75rem; color: var(--text-primary);">
                                Model Response (${shortModel}_${slotNum}):
                            </label>
                            <div class="code-block" style="white-space: pre-wrap; line-height: 1.6; font-size: 0.9rem;">${escapeHtml(responseText)}</div>
                        </div>
                    </div>
                    
                    <!-- Reasoning Tab -->
                    <div class="slot-tab-panel" data-tab="reasoning" role="tabpanel">
                        <div class="tab-content-inner">
                            <label style="font-weight: 600; display: block; margin-bottom: 0.75rem; color: var(--text-primary);">
                                🧠 Model Reasoning Trace:
                            </label>
                ${reasoningTrace ? `
                                <div class="code-block" style="font-size: 0.85rem; background: var(--bg-tertiary); white-space: pre-wrap; line-height: 1.6;">
                        ${escapeHtml(reasoningTrace)}
                    </div>
                ` : `
                                <div style="padding: 1.5rem; background: var(--bg-tertiary); border-radius: 8px; border: 1px dashed var(--border); color: var(--text-muted); font-style: italic; text-align: center;">
                                    ⚠️ No reasoning trace available.<br>
                                    <span style="font-size: 0.85rem;">The model either doesn't support chain-of-thought reasoning, or the reasoning was empty for this response.</span>
                    </div>
                `}
                        </div>
            </div>
            
                    <!-- Grade Tab (Criteria) -->
                    <div class="slot-tab-panel" data-tab="grade" role="tabpanel">
                        <div class="tab-content-inner">
                            <label style="font-weight: 600; display: block; margin-bottom: 1rem; color: var(--text-primary);">
                                📋 Grading Basis - Per Criterion:
                            </label>
                            <div class="criteria-grading" data-hunt-id="${result.hunt_id}">
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
                </div>
                
                    <!-- Review Tab (Explanation + Submit) -->
                    <div class="slot-tab-panel" data-tab="review" role="tabpanel">
                        <div class="tab-content-inner">
                            <label style="font-weight: 600; display: block; margin-bottom: 0.75rem; color: var(--text-primary);">
                                📝 Human Review (human_judge_${slotNum}):
                            </label>
                            
                            <div style="margin-bottom: 1rem;">
                                <label style="font-weight: 500; font-size: 0.9rem; display: block; margin-bottom: 0.5rem; color: var(--text-secondary);">
                                    Explanation:
                                </label>
                                <textarea class="human-review-notes" data-hunt-id="${result.hunt_id}" placeholder="Explain your grading decisions (which criteria failed and why)..." style="width: 100%; min-height: 120px; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-primary); color: var(--text-primary); font-size: 0.9rem; resize: vertical; font-family: inherit; line-height: 1.5;"></textarea>
                </div>
                
                            <button class="btn btn-primary submit-human-review-btn" data-hunt-id="${result.hunt_id}" style="width: 100%; padding: 0.875rem; font-weight: 600; font-size: 0.95rem; border-radius: 8px;">
                                ✅ Submit Human Review
                            </button>
                            <div class="human-review-status" data-hunt-id="${result.hunt_id}" style="margin-top: 0.75rem; font-size: 0.85rem; color: var(--text-muted); text-align: center;"></div>
                        </div>
                    </div>
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
    
    // Tab switching functionality
    const tabContainer = card.querySelector('.slot-tabs-container');
    if (tabContainer) {
        const tabs = tabContainer.querySelectorAll('.slot-tab');
        const tabPanels = tabContainer.querySelectorAll('.slot-tab-panel');
        
        tabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent card toggle
                
                const targetTab = tab.dataset.tab;
                
                // Remove active from all tabs and panels
                tabs.forEach(t => {
                    t.classList.remove('active');
                    t.setAttribute('aria-selected', 'false');
                });
                tabPanels.forEach(p => {
                    p.classList.remove('active');
                });
                
                // Add active to clicked tab and corresponding panel
                tab.classList.add('active');
                tab.setAttribute('aria-selected', 'true');
                const targetPanel = tabContainer.querySelector(`.slot-tab-panel[data-tab="${targetTab}"]`);
                if (targetPanel) {
                    targetPanel.classList.add('active');
                }
            });
        });
    }
    
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
        });
    });
    
    // Submit human review button
    card.querySelector('.submit-human-review-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        submitHumanReview(result.hunt_id, card, slotNum);
    });
    
    // Re-enable submit button when user types in textarea or changes criteria
    const notesTextarea = card.querySelector('.human-review-notes');
    const submitBtn = card.querySelector('.submit-human-review-btn');
    
    // Listen for textarea input to re-enable submit
    notesTextarea.addEventListener('input', () => {
        if (submitBtn.disabled && submitBtn.textContent.includes('Submitted')) {
            submitBtn.disabled = false;
            submitBtn.textContent = '✅ Submit Human Review';
            submitBtn.style.background = '';
        }
    });
    
    // Also re-enable on any criteria button click if already submitted
    const criteriaRows = card.querySelectorAll('.criteria-rating-row');
    criteriaRows.forEach(row => {
        row.querySelectorAll('.criteria-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (submitBtn.disabled && submitBtn.textContent.includes('Submitted')) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '✅ Submit Human Review';
                    submitBtn.style.background = '';
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
function submitHumanReview(huntId, card, slotNum) {
    const notes = card.querySelector(`.human-review-notes[data-hunt-id="${huntId}"]`).value;
    const statusEl = card.querySelector(`.human-review-status[data-hunt-id="${huntId}"]`);
    const criteriaGrading = card.querySelector(`.criteria-grading[data-hunt-id="${huntId}"]`);
    
    // Collect grades for each criterion
    const criterionRows = criteriaGrading.querySelectorAll('.criterion-row');
    const grading = {};
    let allGraded = true;
    let anyFailed = false;
    
    criterionRows.forEach(row => {
        const criterionId = row.dataset.criterionId;
        const grade = row.dataset.grade;
        if (!grade) {
            allGraded = false;
        } else {
            // Store as uppercase for consistency
            grading[criterionId] = grade.toUpperCase(); // 'pass' -> 'PASS', 'fail' -> 'FAIL'
            if (grade.toLowerCase() === 'fail') anyFailed = true;
        }
    });
    
    // Validate all criteria are graded
    if (!allGraded) {
        showToast('Please grade all criteria before submitting', 'error');
        return;
    }
    
    // Determine overall judgment based on criteria
    const overallJudgment = anyFailed ? 'fail' : 'pass';
    
    // Store human review in state with slot info and criteria
    if (!state.humanReviews) state.humanReviews = {};
    state.humanReviews[huntId] = {
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
    
    // Show detailed status
    const gradingDisplay = Object.entries(grading).map(([k, v]) => 
        `${k}: ${v === 'pass' ? '✅' : '❌'}`
    ).join(' | ');
    statusEl.innerHTML = `<strong>${overallJudgment.toUpperCase()}</strong> - ${gradingDisplay}`;
    statusEl.style.color = overallJudgment === 'pass' ? 'var(--success)' : 'var(--danger)';
    
    showToast(`Slot ${slotNum} submitted as ${overallJudgment.toUpperCase()}`, 'success');
    
    // Update the progress display (NEW)
    updateReviewProgress();
    
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
    const reviewCount = Object.keys(state.humanReviews || {}).length;
    const totalSlots = 4;
    
    if (reviewCount >= totalSlots) {
        showToast('All 4 reviews complete! Ready to export.', 'success');
        // Enable save button prominently
        if (elements.saveDriveBtn) {
            elements.saveDriveBtn.classList.add('pulse');
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
    
    // Check if all 4 reviews are complete (warn if not)
    const reviewCount = Object.keys(state.humanReviews || {}).length;
    if (reviewCount < 4) {
        const proceed = confirm(`Only ${reviewCount}/4 human reviews completed. Export anyway?`);
        if (!proceed) return;
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
    state.isHunting = false;
    state.humanReviews = {};  // Reset human reviews
    state.allResponses = [];  // Reset accumulated responses
    state.selectedHuntIds = [];  // Reset selection
    state.llmRevealed = false;  // Reset reveal state
    state.accumulatedHuntOffset = 0;  // Reset hunt offset
    state.currentRunStartOffset = 0;  // Reset run offset
    state.blindJudging = {
        queue: [],
        currentResult: null,
        humanJudgments: {}
    };
    
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
    const explanationLines = (fullExplanation || '').split('\n');
    const criteriaExplanations = {};
    
    // Try multiple patterns to extract explanations for each criterion
    for (const [key] of Object.entries(criteria)) {
        const patterns = [
            // Pattern: "C1: explanation..." or "C1 - explanation..."
            new RegExp(`${key}[:\\-]\\s*(.+?)(?=C\\d|$)`, 'gi'),
            // Pattern: "**C1**: explanation..."
            new RegExp(`\\*\\*${key}\\*\\*[:\\-]?\\s*(.+?)(?=\\*\\*C\\d|$)`, 'gi'),
            // Pattern: Line starting with C1
            new RegExp(`^\\s*${key}[.:\\-]?\\s*(.+)`, 'gim')
        ];
        
        for (const pattern of patterns) {
            for (const line of explanationLines) {
                const match = pattern.exec(line);
                if (match && match[1]) {
                    criteriaExplanations[key] = match[1].trim().replace(/^\*\*\w+\*\*:?\s*/, '');
                    break;
                }
            }
            if (criteriaExplanations[key]) break;
        }
        
        // Fallback: look for the criterion in any line
        if (!criteriaExplanations[key]) {
            for (const line of explanationLines) {
                if (line.toUpperCase().includes(key.toUpperCase()) && line.length > key.length + 10) {
                    // Remove the criterion prefix
                    criteriaExplanations[key] = line.replace(new RegExp(`^.*${key}[:\\-]?\\s*`, 'i'), '').trim();
                    break;
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


// ============== Event Listeners ==============

function initEventListeners() {
    elements.themeToggle.addEventListener('click', toggleTheme);
    elements.startHuntBtn.addEventListener('click', startHunt);
    if (elements.saveDriveBtn) elements.saveDriveBtn.addEventListener('click', saveToDrive);
    
    // Clear results and reset when model changes
    if (elements.modelSelect) {
        elements.modelSelect.addEventListener('change', () => {
            // Full clear when model changes
            clearPreviousResults();
            showToast('Model changed. Previous results cleared.', 'info');
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
    
    // Judge reference response button
    elements.judgeReferenceBtn?.addEventListener('click', judgeReferenceResponse);
    
    // Save response to Colab & Re-judge button
    elements.saveResponseBtn?.addEventListener('click', saveAndRejudge);
    
    // NEW: Selection and Reveal buttons
    elements.confirmSelectionBtn?.addEventListener('click', confirmSelection);
    elements.revealLLMBtn?.addEventListener('click', revealLLMJudgments);
}

async function judgeReferenceResponse() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }
    
    // Check for missing criteria before judging
    // Compare initial criteria with current criteria from preview
    const currentRefText = elements.modelrefPreview?.textContent || '';
    let currentCriteria;
    try {
        currentCriteria = parseCriteria(currentRefText);
    } catch (error) {
        console.error('Failed to parse criteria:', error);
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
                    <strong>Action Required:</strong> Please add these criteria back to the response_reference section in your Colab notebook, then click "Save to Colab & Re-judge" or "Judge Only" again.
                </p>
            </div>
        `;
        resultDiv.classList.remove('hidden');
        return;
    }
    
    const btn = elements.judgeReferenceBtn;
    const resultDiv = elements.referenceJudgeResult;
    
    try {
        btn.disabled = true;
        btn.textContent = '⏳ Judging...';
        resultDiv.classList.add('hidden');
        
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
        
        // Check for missing criteria: Compare initial criteria with current criteria
        // If a criterion was in initial but not in current, it's MISSING
        const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
        const missingCriteriaIds = [...initialCriteriaIds].filter(id => !currentCriteriaIds.has(id));
        
        console.log('🔍 POST-JUDGE MISSING CHECK:');
        console.log('   Initial criteria IDs:', Array.from(initialCriteriaIds));
        console.log('   Current criteria IDs (from response_reference):', Array.from(currentCriteriaIds));
        console.log('   Judged criteria IDs (from judge result):', Array.from(judgedCriteriaIds));
        console.log('   Missing criteria IDs (in initial but not in current):', missingCriteriaIds);
        console.log('   state.initialCriteria exists?', !!state.initialCriteria);
        console.log('   state.initialCriteria length:', state.initialCriteria?.length || 0);
        console.log('   state.initialCriteria:', state.initialCriteria);
        
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
            console.log('✅ No missing criteria detected - all initial criteria are present in current response_reference');
            
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
        resultDiv.classList.remove('hidden');
        
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
        
        // Also show toast
        showToast(`Error: ${error.message}`, 'error');
        
        // Disable hunt button on error
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
            elements.startHuntBtn.title = 'Fix judge error before starting hunt';
        }
        state.referenceValidated = false;
    } finally {
        btn.disabled = false;
        btn.textContent = '⚖️ Judge Only';
    }
}

// Save edited response to Colab and re-judge
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
        
        // Check for missing criteria: Compare initial criteria with current criteria
        // If a criterion was in initial but not in current, it's MISSING
        const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
        const missingCriteriaIds = [...initialCriteriaIds].filter(id => !currentCriteriaIds.has(id));
        
        console.log('DEBUG: Missing criteria check (saveAndRejudge) - Initial:', Array.from(initialCriteriaIds), 'Current:', Array.from(currentCriteriaIds), 'Missing:', missingCriteriaIds);
        
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
        resultDiv.classList.remove('hidden');
        
        const passCount = criteriaEntries.filter(([k, v]) => String(v).toUpperCase() === 'PASS').length;
        const totalCount = criteriaEntries.length;
        showToast(`Saved: ${passCount}/${totalCount} criteria pass (${isPassing ? 'HUNT ENABLED' : 'Fix required'})`, isPassing ? 'success' : 'warning');
        
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '💾 Save to Colab & Re-judge';
    }
}


// ============== Initialize ==============

function init() {
    initTheme();
    initTabs();
    initFileUpload();
    initPreviewTabs();
    initEventListeners();
    
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

    // Initial population
    updateModelOptions();

    // Event listener
    elements.providerSelect.addEventListener('change', updateModelOptions);
}

function updateModelOptions() {
    const provider = elements.providerSelect.value;
    const models = PROVIDER_MODELS[provider] || [];
    
    // Clear current options
    elements.modelSelect.innerHTML = '';
    
    // Add new options
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        elements.modelSelect.appendChild(option);
    });
    
    console.log(`Updated models for provider: ${provider}`);
}

// Start app
document.addEventListener('DOMContentLoaded', init);
