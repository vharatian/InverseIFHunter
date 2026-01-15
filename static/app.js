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

// ============== State ==============

const state = {
    sessionId: null,
    notebook: null,
    referenceValidated: false,  // Must pass reference judge before hunt
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
    modelSelect: document.getElementById('modelSelect'),
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
    elements.uploadSection.classList.add('hidden');
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
    let domain = data.notebook.metadata?.Domain || data.notebook.metadata?.domain || '';
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
    
    for (const review of reviews) {
        const gradingBasis = review.grading_basis || {};
        for (const [criterionId, vote] of Object.entries(gradingBasis)) {
            if (!criteriaVotes[criterionId]) {
                criteriaVotes[criterionId] = { pass: 0, fail: 0 };
            }
            if (vote.toUpperCase() === 'PASS') {
                criteriaVotes[criterionId].pass++;
            } else if (vote.toUpperCase() === 'FAIL') {
                criteriaVotes[criterionId].fail++;
            }
        }
    }
    
    // Check if ANY criterion has both a pass AND a fail
    const hasDiverseCriterion = Object.entries(criteriaVotes).some(
        ([id, votes]) => votes.pass > 0 && votes.fail > 0
    );
    
    if (!hasDiverseCriterion && Object.keys(criteriaVotes).length > 0) {
        // Build a summary of votes for the error message
        const votesSummary = Object.entries(criteriaVotes)
            .map(([id, v]) => `${id}: ${v.pass} pass, ${v.fail} fail`)
            .join('\n  ');
        
        showToast('Criterion diversity required: At least one criterion must have both PASS and FAIL.', 'error');
        alert(
            `Cannot save: Missing criterion diversity!\n\n` +
            `Requirement: At least one criterion (C1, C2, etc.) must receive both a PASS and a FAIL across the 4 responses.\n\n` +
            `Current votes:\n  ${votesSummary}\n\n` +
            `Please review your grading to ensure diverse criteria judgments.`
        );
        return;
    }
    
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
        
        // Then save to drive
        const response = await fetch(`/api/save-to-drive/${state.sessionId}`, {
            method: 'POST'
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
    
    // Parse and store criteria from response_reference
    state.criteria = parseCriteria(notebook.response_reference || '');
    console.log('Parsed criteria:', state.criteria);
}

// Parse criteria from response_reference text (looks for JSON with criteria fields)
function parseCriteria(responseReference) {
    if (!responseReference || !responseReference.trim()) {
        console.warn('Empty response_reference, using default criteria');
        return getDefaultCriteria();
    }
    
    try {
        // Try to parse the entire response as JSON first
        const trimmed = responseReference.trim();
        
        // Method 1: Full JSON object with C1, C2, etc. keys
        if (trimmed.startsWith('{')) {
            const data = JSON.parse(trimmed);
            const criteria = [];
            
            // Look for C1, C2, etc. keys
            for (const key of Object.keys(data)) {
                if (/^C\d+$/i.test(key)) {
                    const value = data[key];
                    if (typeof value === 'string') {
                        criteria.push({ id: key.toUpperCase(), criteria: value });
                    } else if (typeof value === 'object' && value !== null) {
                        // Has description or criteria field
                        const desc = value.description || value.criteria || value.text || JSON.stringify(value);
                        criteria.push({ id: key.toUpperCase(), criteria: desc });
                    }
                }
            }
            
            if (criteria.length > 0) {
                console.log('Parsed criteria from JSON object:', criteria);
                return criteria;
            }
        }
        
        // Method 2: JSON array with id/criteria fields
        const jsonArrayMatch = responseReference.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (jsonArrayMatch) {
            const criteriaArray = JSON.parse(jsonArrayMatch[0]);
            if (Array.isArray(criteriaArray)) {
                const filtered = criteriaArray.filter(c => c.id && c.criteria);
                if (filtered.length > 0) {
                    console.log('Parsed criteria from JSON array:', filtered);
                    return filtered;
                }
            }
        }
        
        // Method 3: Look for embedded JSON object  
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
                // Continue to next method
            }
        }
        
    } catch (e) {
        console.warn('Could not parse criteria from response_reference:', e);
    }
    
    // Fallback: create default criteria
    console.log('Using default criteria fallback');
    return getDefaultCriteria();
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
        reasoning_budget_percent: 0.9,
        max_retries: 3, // Hardcoded to 3 retries
        judge_model: 'gpt-5', // Always GPT-5
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
    
    // Reset progress
    elements.progressFill.style.width = '0%';
    elements.progressText.textContent = `0 / ${parallel_workers} hunts complete`;
    elements.progressPercent.textContent = '0%';
    
    // Initialize breaks indicator
    elements.breaksIndicator.innerHTML = '';
    for (let i = 0; i < target_breaks; i++) {
        const dot = document.createElement('span');
        dot.className = 'break-dot';
        dot.dataset.index = i;
        elements.breaksIndicator.appendChild(dot);
    }
    
    // Initialize table rows
    const models = state.config.models;
    elements.resultsTableBody.innerHTML = '';
    for (let i = 1; i <= parallel_workers; i++) {
        const model = models[i - 1] || models[0];
        const shortModel = model.split('/').pop().split('-')[0];
        
        const row = document.createElement('tr');
        row.id = `hunt-row-${i}`;
        row.innerHTML = `
            <td>${i}</td>
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
    const row = document.getElementById(`hunt-row-${huntId}`);
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
    
    // Debug log
    console.log('Hunt Result:', { hunt_id, status, score, is_breaking, error });
    
    // Store result with response data
    state.results.push(data);
    
    // Add to blind judging queue if completed successfully (for criteria review later)
    if (status === 'completed' && !error) {
        state.blindJudging.queue.push(data);
    }
    
    // Update table row - SHOW score immediately, hide criteria for blind judging
    const row = document.getElementById(`hunt-row-${hunt_id}`);
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
    
    // Update status
    elements.huntStatus.querySelector('.status-dot').className = 'status-dot completed';
    elements.statusText.textContent = 'Completed';
    
    // Show results section immediately (no modal)
    elements.resultsSection.classList.remove('hidden');
    elements.summarySection.classList.remove('hidden');
    
    // Populate breaking results (with criteria MASKED)
    displayBreakingResults();
    
    // Populate summary
    document.getElementById('summaryTotal').textContent = completed_hunts;
    document.getElementById('summaryBreaks').textContent = breaks_found;
    
    const successRate = completed_hunts > 0 ? Math.round((breaks_found / completed_hunts) * 100) : 0;
    document.getElementById('summarySuccess').textContent = `${successRate}% (${breaks_found}/${completed_hunts} breaks)`;
    document.getElementById('summaryMet').textContent = breaks_found >= 3 ? '✅ Yes' : '❌ No';
    
    showToast(
        breaks_found >= 3
            ? `🎉 Found ${breaks_found} model breaking responses!` 
            : `Hunt complete. Found ${breaks_found} breaks.`,
        breaks_found >= 3 ? 'success' : 'info'
    );
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
    const isFailed = score === 0;
    const scoreEmoji = isFailed ? '🔴' : '🟢';
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
            <div style="margin-bottom: 1rem;">
                <label style="font-weight: 600; display: block; margin-bottom: 0.5rem;">Model Response (${shortModel}_${slotNum}):</label>
                <div class="code-block" style="max-height: 400px; overflow-y: auto; white-space: pre-wrap;">${escapeHtml(responseText)}</div>
            </div>
            
            <!-- Model Reasoning Trace - VISIBLE for human review -->
            <div style="margin-top: 1rem;">
                <label style="font-weight: 600; display: block; margin-bottom: 0.5rem;">🧠 Model Reasoning Trace:</label>
                ${reasoningTrace ? `
                    <div class="code-block" style="max-height: 300px; overflow-y: auto; font-size: 0.85rem; background: var(--bg-tertiary);">
                        ${escapeHtml(reasoningTrace)}
                    </div>
                ` : `
                    <div style="padding: 0.75rem; background: var(--bg-tertiary); border-radius: 6px; border: 1px dashed var(--border); color: var(--text-muted); font-style: italic; font-size: 0.85rem;">
                        ⚠️ No reasoning trace available. The model either doesn't support chain-of-thought reasoning, or the reasoning was empty for this response.
                    </div>
                `}
            </div>
            
            <!-- Human Review Section with Criteria -->
            <div class="human-review-section" style="margin-top: 1.5rem; padding: 1rem; background: var(--bg-tertiary); border-radius: 8px; border: 1px solid var(--border);">
                <label style="font-weight: 600; display: block; margin-bottom: 0.75rem;">📝 Human Review (human_judge_${slotNum}):</label>
                
                <!-- Grading Basis - Per Criterion -->
                <div class="criteria-grading" data-hunt-id="${result.hunt_id}" style="margin-bottom: 1rem;">
                    <label style="font-weight: 500; font-size: 0.9rem; display: block; margin-bottom: 0.5rem;">Grading Basis:</label>
                    ${(state.criteria || []).map(c => `
                        <div class="criterion-row" data-criterion-id="${c.id}" style="display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.5rem; padding: 0.5rem; margin-bottom: 0.5rem; background: var(--bg-primary); border-radius: 6px; border: 1px solid var(--border);">
                            <span style="font-weight: 600; min-width: 35px;">${c.id}:</span>
                            <span style="flex: 1; font-size: 0.85rem; color: var(--text-secondary); word-break: break-word; min-width: 200px;">${escapeHtml(c.criteria)}</span>
                            <div class="criterion-buttons" style="display: flex; gap: 0.25rem; flex-shrink: 0;">
                                <button class="btn btn-small criterion-pass" data-hunt-id="${result.hunt_id}" data-criterion="${c.id}" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; background: transparent; border: 1px solid var(--success); color: var(--success);">PASS</button>
                                <button class="btn btn-small criterion-fail" data-hunt-id="${result.hunt_id}" data-criterion="${c.id}" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; background: transparent; border: 1px solid var(--danger); color: var(--danger);">FAIL</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
                
                <!-- Explanation -->
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 500; font-size: 0.9rem; display: block; margin-bottom: 0.25rem;">Explanation:</label>
                    <textarea class="human-review-notes" data-hunt-id="${result.hunt_id}" placeholder="Explain your grading decisions (which criteria failed and why)..." style="width: 100%; min-height: 80px; padding: 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font-size: 0.9rem; resize: vertical;"></textarea>
                </div>
                
                <!-- Submit Button -->
                <button class="btn btn-primary submit-human-review-btn" data-hunt-id="${result.hunt_id}" style="margin-top: 0.75rem; width: 100%;">✅ Submit Human Review</button>
                <div class="human-review-status" data-hunt-id="${result.hunt_id}" style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-muted);"></div>
            </div>
            
            <!-- LLM Judge Section - Hidden until human submits -->
            <div class="llm-judge-section" data-hunt-id="${result.hunt_id}" style="margin-top: 1rem; display: none;" data-llm-judge='${llmJudgeData.replace(/'/g, "&#39;")}'>
                <div style="padding: 1rem; background: var(--bg-tertiary); border-radius: 8px; border: 1px solid var(--accent-primary);">
                    <label style="font-weight: 600; display: block; margin-bottom: 0.5rem;">🤖 LLM Judge (llm_judge_${slotNum}):</label>
                    <div class="llm-judge-score" style="margin-bottom: 0.75rem;">
                        <span class="score-badge ${scoreClass}">${scoreEmoji} Score: ${score}</span>
                    </div>
                    
                    <!-- Criteria Breakdown -->
                    <div class="llm-criteria-breakdown" style="margin-bottom: 0.75rem;">
                        <label style="font-weight: 500; font-size: 0.9rem; display: block; margin-bottom: 0.5rem;">📋 Grading Basis:</label>
                        ${formatLLMCriteria(result.judge_criteria, result.judge_explanation)}
                    </div>
                    
                    <!-- Full Explanation -->
                    <div class="llm-judge-explanation" style="font-size: 0.9rem; color: var(--text-secondary); max-height: 300px; overflow-y: auto; white-space: pre-wrap; background: var(--bg-primary); padding: 0.75rem; border-radius: 6px;">
                        <label style="font-weight: 500; display: block; margin-bottom: 0.25rem;">📝 Full Explanation:</label>
                        ${escapeHtml(result.judge_explanation || 'No explanation available')}
                    </div>
                </div>
            </div>
            
            <!-- Reveal Button - Shows after human review -->
            <div class="reveal-section" data-hunt-id="${result.hunt_id}" style="margin-top: 1rem; text-align: center;">
                <button class="btn btn-secondary reveal-llm-btn" data-hunt-id="${result.hunt_id}" disabled style="opacity: 0.5;">
                    🔒 Submit your review first to reveal LLM Judge
                </button>
            </div>
        </div>
    `;
    
    // Toggle expand
    card.querySelector('.expandable-header').addEventListener('click', () => {
        card.classList.toggle('open');
    });
    
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
    
    // Reveal button handler
    card.querySelector('.reveal-llm-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        revealLLMJudge(result.hunt_id, card);
    });
    
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
            grading[criterionId] = grade;
            if (grade === 'fail') anyFailed = true;
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
    
    // Enable reveal button
    let revealBtn = card.querySelector('.reveal-llm-btn');
    if (revealBtn) {
        revealBtn.disabled = false;
        revealBtn.style.opacity = '1';
        revealBtn.textContent = '👁️ Reveal LLM Judge';
    }
    
    showToast(`Slot ${slotNum} submitted as ${overallJudgment.toUpperCase()}`, 'success');
    
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
    state.blindJudging = {
        queue: [],
        currentResult: null,
        humanJudgments: {}
    };
    
    // Hide progress, results, and summary sections
    elements.progressSection?.classList.add('hidden');
    elements.resultsSection?.classList.add('hidden');
    elements.summarySection?.classList.add('hidden');
    
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
    if (!criteria || Object.keys(criteria).length === 0) {
        return '<div style="padding: 0.5rem; color: var(--text-muted); font-style: italic;">No criteria breakdown available</div>';
    }
    
    const entries = Object.entries(criteria);
    
    // Build HTML for each criterion
    const criteriaHtml = entries.map(([key, value]) => {
        const isPassing = String(value).toUpperCase() === 'PASS';
        const statusEmoji = isPassing ? '✅' : '❌';
        const statusText = isPassing ? 'PASS' : 'FAIL';
        const statusColor = isPassing ? 'var(--success)' : 'var(--danger)';
        
        // Find matching criteria description from state.criteria
        const criteriaDesc = (state.criteria || []).find(c => c.id === key);
        const criteriaText = criteriaDesc ? criteriaDesc.criteria : '';
        
        return `
            <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; margin: 0.25rem 0; background: var(--bg-tertiary); border-radius: 6px; border-left: 3px solid ${statusColor};">
                <span style="font-weight: 600; min-width: 35px;">${key}:</span>
                <span style="color: ${statusColor}; font-weight: 600;">${statusEmoji} ${statusText}</span>
                ${criteriaText ? `<span style="flex: 1; font-size: 0.85rem; color: var(--text-secondary);">${escapeHtml(criteriaText)}</span>` : ''}
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
}

async function judgeReferenceResponse() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
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
            const error = await response.json();
            throw new Error(error.detail || 'Judge failed');
        }
        
        const data = await response.json();
        
        // Check if ALL criteria pass (not just overall score)
        const criteria = data.criteria || {};
        const criteriaEntries = Object.entries(criteria);
        const allCriteriaPass = criteriaEntries.length > 0 && 
            criteriaEntries.every(([key, value]) => String(value).toUpperCase() === 'PASS');
        
        // Only enable hunt if ALL criteria pass
        const isPassing = allCriteriaPass;
        const scoreClass = isPassing ? 'score-1' : 'score-0';
        const scoreEmoji = isPassing ? '✅' : '❌';
        
        // Update reference validated state
        state.referenceValidated = isPassing;
        
        // Enable/disable Start Hunt based on result - ONLY if ALL criteria pass
        if (elements.startHuntBtn) {
            if (isPassing) {
                elements.startHuntBtn.disabled = false;
                elements.startHuntBtn.title = '';
            } else {
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = 'All criteria must pass before starting hunt';
            }
        }
        
        // Build criteria breakdown HTML
        const criteriaHtml = formatJudgeCriteriaDisplay(criteria);
        
        resultDiv.innerHTML = `
            <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid ${isPassing ? 'var(--success)' : 'var(--danger)'};">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                    <span class="score-badge ${scoreClass}">${scoreEmoji} Score: ${data.score}</span>
                    <span style="font-weight: 600;">${isPassing ? 'ALL CRITERIA PASS - Hunt Enabled!' : 'CRITERIA FAILED - Fix before hunting'}</span>
                </div>
                
                <!-- Criteria Breakdown -->
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📋 Criteria Breakdown:</label>
                    ${criteriaHtml}
                </div>
                
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📝 Judge Explanation:</label>
                    <p style="margin-top: 0.25rem; font-size: 0.9rem; color: var(--text-secondary); white-space: pre-wrap;">${escapeHtml(data.explanation || 'No explanation provided')}</p>
                </div>
            </div>
        `;
        resultDiv.classList.remove('hidden');
        
        const passCount = criteriaEntries.filter(([k, v]) => String(v).toUpperCase() === 'PASS').length;
        const totalCount = criteriaEntries.length;
        showToast(`Reference: ${passCount}/${totalCount} criteria pass (${isPassing ? 'HUNT ENABLED' : 'Fix required'})`, isPassing ? 'success' : 'warning');
        
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
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
            const error = await judgeResponse.json();
            throw new Error(error.detail || 'Judge failed');
        }
        
        const data = await judgeResponse.json();
        
        // Check if ALL criteria pass (not just overall score)
        const criteria = data.criteria || {};
        const criteriaEntries = Object.entries(criteria);
        const allCriteriaPass = criteriaEntries.length > 0 && 
            criteriaEntries.every(([key, value]) => String(value).toUpperCase() === 'PASS');
        
        // Only enable hunt if ALL criteria pass
        const isPassing = allCriteriaPass;
        const scoreClass = isPassing ? 'score-1' : 'score-0';
        const scoreEmoji = isPassing ? '✅' : '❌';
        
        // Update reference validated state
        state.referenceValidated = isPassing;
        
        // Enable/disable Start Hunt based on result - ONLY if ALL criteria pass
        if (elements.startHuntBtn) {
            if (isPassing) {
                elements.startHuntBtn.disabled = false;
                elements.startHuntBtn.title = '';
            } else {
                elements.startHuntBtn.disabled = true;
                elements.startHuntBtn.title = 'All criteria must pass before starting hunt';
            }
        }
        
        // Build criteria breakdown HTML
        const criteriaHtml = formatJudgeCriteriaDisplay(criteria);
        
        resultDiv.innerHTML = `
            <div style="padding: 1rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid ${isPassing ? 'var(--success)' : 'var(--danger)'};">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                    <span class="score-badge ${scoreClass}">${scoreEmoji} Score: ${data.score}</span>
                    <span style="font-weight: 600;">${isPassing ? '✅ Saved & ALL CRITERIA PASS - Hunt Enabled!' : '❌ Saved but CRITERIA FAILED - Edit & try again'}</span>
                </div>
                
                <!-- Criteria Breakdown -->
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📋 Criteria Breakdown:</label>
                    ${criteriaHtml}
                </div>
                
                <div style="margin-top: 0.75rem;">
                    <label style="font-weight: 600; font-size: 0.9rem;">📝 Judge Explanation:</label>
                    <p style="margin-top: 0.25rem; font-size: 0.9rem; color: var(--text-secondary); white-space: pre-wrap;">${escapeHtml(data.explanation || 'No explanation provided')}</p>
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
    
    // Disable Start Hunt until reference is validated
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Validate the reference response first (click "Judge Reference Response")';
    }
    
    console.log('🔥 Model Hunter initialized');
}

// Start app
document.addEventListener('DOMContentLoaded', init);
