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

// ============== Version Check & Update Prompt ==============
let currentVersion = null;
let pendingUpdateVersion = null; // Tracks if there's a new version available
const VERSION_CHECK_INTERVAL = 30000; // Check every 30 seconds

async function checkVersion() {
    try {
        const response = await fetch('/api/version');
        const data = await response.json();
        
        if (currentVersion === null) {
            // First check - just store the version
            currentVersion = data.version;
            console.log('📦 App version:', currentVersion);
        } else if (data.version !== currentVersion) {
            // Version changed - store it for later prompt
            pendingUpdateVersion = data.version;
            console.warn('🔄 New version detected:', data.version, '(will prompt before next task)');
        }
    } catch (e) {
        // Silently fail - server might be updating
    }
}

function hasPendingUpdate() {
    return pendingUpdateVersion !== null;
}

function showUpdatePrompt() {
    return new Promise((resolve) => {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'update-prompt-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;
        
        // Create dialog
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: var(--bg-secondary, #1e1e2e);
            border-radius: 12px;
            padding: 24px 32px;
            max-width: 450px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.4);
            border: 1px solid var(--border, #333);
        `;
        
        dialog.innerHTML = `
            <div style="font-size: 48px; margin-bottom: 16px;">🔄</div>
            <h3 style="margin: 0 0 12px 0; color: var(--text-primary, #fff); font-size: 18px;">New Version Available</h3>
            <p style="margin: 0 0 24px 0; color: var(--text-secondary, #aaa); font-size: 14px; line-height: 1.5;">
                A new version has been deployed. It's recommended to refresh before starting a new task for the latest changes.
            </p>
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="update-refresh-btn" style="
                    background: linear-gradient(90deg, #2563eb, #7c3aed);
                    color: white;
                    border: none;
                    padding: 10px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-weight: 600;
                    font-size: 14px;
                ">Refresh Now</button>
                <button id="update-continue-btn" style="
                    background: transparent;
                    color: var(--text-secondary, #aaa);
                    border: 1px solid var(--border, #444);
                    padding: 10px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                ">Continue Anyway</button>
            </div>
        `;
        
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        
        // Handle buttons
        dialog.querySelector('#update-refresh-btn').onclick = () => {
            window.location.reload();
        };
        
        dialog.querySelector('#update-continue-btn').onclick = () => {
            overlay.remove();
            resolve(true); // Continue with action
        };
    });
}

// Start version checking after page load
document.addEventListener('DOMContentLoaded', () => {
    checkVersion();
    setInterval(checkVersion, VERSION_CHECK_INTERVAL);
});

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
    // NOTE: Row numbering now uses totalHuntsCount (from localStorage) as single source of truth
    currentRunStartOffset: 0,  // Offset at start of current run (set from totalHuntsCount - requestedHunts)
    originalNotebookJson: null,  // Original notebook JSON for WYSIWYG snapshot
    
    // Hunt response data for slide-out panel
    huntResponseData: {},  // Keyed by row number, stores {model, status, score, response}
    
    // 16 Hunt Limit tracking
    totalHuntsCount: 0,     // Total hunts for current notebook (persisted in localStorage)
    notebookId: null,       // Unique identifier for current notebook (file_id from Google Drive)
    huntLimitReached: false, // Flag to prevent further hunts
    
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
    modelMismatchWarning: false,  // Track if model mismatch warning is shown
    
    // Multi-turn state
    currentTurn: 1,
    conversationHistory: [],  // [{role: "user", content: ...}, {role: "assistant", content: ...}]
    turns: [],                // [{turnNumber, prompt, criteria, selectedResponse, ...}]
    isMultiTurn: false,       // Activates when trainer advances to turn 2
    multiTurnTotalHunts: 0,   // Total hunts across all turns
    huntsThisTurn: 0,         // Hunts in the CURRENT turn (resets on new turn)
    previousTurnHuntIds: new Set()  // hunt_ids from completed turns (excluded from current turn fetch)
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
    // Markdown textareas (new split view editors)
    promptMarkdown: document.getElementById('promptMarkdown'),
    responseMarkdown: document.getElementById('responseMarkdown'),
    judgeMarkdown: document.getElementById('judgeMarkdown'),
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
    
    // Multi-Turn Section
    multiTurnSection: document.getElementById('multiTurnSection'),
    
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
    
    toastContainer: document.getElementById('toastContainer'),
    
    // Response Slide-out Panel
    responseSlideout: document.getElementById('responseSlideout'),
    responseSlideoutBackdrop: document.getElementById('responseSlideoutBackdrop'),
    slideoutTitle: document.getElementById('slideoutTitle'),
    slideoutModel: document.getElementById('slideoutModel'),
    slideoutStatus: document.getElementById('slideoutStatus'),
    slideoutScore: document.getElementById('slideoutScore'),
    slideoutResponseText: document.getElementById('slideoutResponseText'),
    slideoutCloseBtn: document.getElementById('slideoutCloseBtn')
};


// ============== Hunt Limit Constants ==============
const MAX_HUNTS_PER_NOTEBOOK = 16;  // Now applies PER TURN (not global)
const HUNT_COUNT_STORAGE_PREFIX = 'modelHunter_huntCount_';

// ============== Turn Color System ==============
const TURN_COLORS = [
    '#2383e2',  // Turn 1: Blue (Notion)
    '#9065e0',  // Turn 2: Purple
    '#e8a441',  // Turn 3: Amber
    '#eb5757',  // Turn 4: Red
    '#4dab9a',  // Turn 5: Teal
    '#3b82f6',  // Turn 6: Blue alt
];

function getTurnColor(turnNumber) {
    return TURN_COLORS[(turnNumber - 1) % TURN_COLORS.length];
}

/**
 * Compute cumulative hunt statistics across ALL completed turns + current turn.
 * Returns { totalHunts, totalBreaks } 
 */
function getCumulativeStats() {
    // Previous turns
    let prevHunts = 0;
    let prevBreaks = 0;
    if (state.turns && state.turns.length > 0) {
        state.turns.forEach(t => {
            const results = t.results || [];
            prevHunts += results.length;
            prevBreaks += results.filter(r => r.is_breaking).length;
        });
    }
    
    // Current turn (from allResponses with score-based break detection)
    const currentHunts = state.allResponses.length;
    const currentBreaks = state.allResponses.filter(r => {
        const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
        const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
        return (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0) || r.is_breaking === true;
    }).length;
    
    return {
        totalHunts: prevHunts + currentHunts,
        totalBreaks: prevBreaks + currentBreaks
    };
}

function getTurnColorClass(turnNumber) {
    const idx = ((turnNumber - 1) % TURN_COLORS.length) + 1;
    return `turn-color-${idx}`;
}

// ================================================================
// INSIGHT TIPS — Data-driven contextual tips from ML analysis
// Source: 46,686 hunts across 741 trainers
// ================================================================

const INSIGHT_TIPS = {
    // Config / pre-hunt tips
    config: [
        { text: 'Tasks with <strong>8+ criteria</strong> achieve a ~48% break rate — nearly double the average.', icon: '💡' },
        { text: 'The average break rate across all hunts is <strong>26.3%</strong>. Don\'t worry if the first few pass — persistence pays off.', icon: '📊' },
        { text: '<strong>Creative domains</strong> like Sports & Recreation yield ~34% break rates — try diverse topics.', icon: '🎯' },
        { text: 'Format-constraint criteria (exact word positions, bold/italic) are especially effective at breaking models.', icon: '✨' },
        { text: 'Policy & Legal Analysis tasks have the <strong>highest break rate at ~60%</strong> — complex reasoning trips models up.', icon: '⚖️' },
    ],
    // Model-specific tips
    nemotron: [
        { text: 'Nemotron has a <strong>24% break rate</strong>. It struggles most with format constraints and multi-step criteria.', icon: '🤖' },
        { text: 'Nemotron is weaker on <strong>criteria C5–C6</strong> (regex/format checks) — craft criteria around structured output.', icon: '🔍' },
    ],
    qwen: [
        { text: 'Qwen3 has a <strong>30% break rate</strong> — higher than Nemotron. It struggles with complex multi-step reasoning.', icon: '🤖' },
        { text: 'Qwen3 is weaker on <strong>criteria C7–C8</strong> (character-level checks) — exploit exact-format requirements.', icon: '🔍' },
    ],
    // During hunting
    hunting: [
        { text: 'Hang tight — the judge evaluates each criterion independently. Partial breaks are common.', icon: '⏳' },
        { text: 'Each hunt tests the model\'s consistency. Even small prompt variations can reveal new weaknesses.', icon: '🔬' },
        { text: 'Across <strong>46K+ hunts</strong>, models fail ~1 in 4 attempts. Every hunt counts.', icon: '📈' },
    ],
    // Post-hunt / results
    results: [
        { text: 'You need at least <strong>3 breaks</strong> to proceed. If you\'re close, try adjusting criteria wording.', icon: '🎯' },
        { text: 'Successful trainers review failing criteria to understand <strong>which specific rules</strong> trip models up.', icon: '🔎' },
        { text: 'The top trainers average <strong>3.6 criteria per task</strong> — quality and specificity beat quantity.', icon: '🏆' },
    ],
    // Selection tips
    selection: [
        { text: 'Pick responses where the model <strong>confidently gave wrong output</strong> — these are the most valuable breaks.', icon: '✅' },
        { text: 'A mix of <strong>3 breaking + 1 passing</strong> gives reviewers contrast to evaluate the boundary.', icon: '⚖️' },
    ],
    // Multi-turn decision
    multiTurn: [
        { text: 'Most trainers continue until they find a clear breaking pattern across 2–3 turns.', icon: '🔄' },
        { text: 'Refining your prompt across turns often uncovers <strong>deeper model weaknesses</strong> than repeating the same one.', icon: '💡' },
        { text: 'Adding more criteria in subsequent turns can <strong>dramatically increase</strong> break rates.', icon: '📊' },
    ],
    // Summary / final
    summary: [
        { text: 'Great work! Every hunt contributes to improving model safety across the community.', icon: '🎉', type: 'success' },
        { text: 'The most successful trainers <strong>explore multiple domains</strong> and refine their criteria iteratively.', icon: '🧭' },
        { text: 'Your results help identify blind spots in model behavior — this data directly improves training.', icon: '🛡️' },
    ],
};

/**
 * Pick a random tip from a category. 
 * If `model` is provided, tries model-specific tips first.
 */
function getRandomTip(category, model) {
    // Try model-specific tips for config/hunting categories
    if (model && (category === 'config' || category === 'hunting')) {
        const modelKey = model.toLowerCase().includes('nemotron') ? 'nemotron' : 
                         model.toLowerCase().includes('qwen') ? 'qwen' : null;
        if (modelKey && INSIGHT_TIPS[modelKey] && Math.random() < 0.4) {
            const tips = INSIGHT_TIPS[modelKey];
            return tips[Math.floor(Math.random() * tips.length)];
        }
    }
    const tips = INSIGHT_TIPS[category] || INSIGHT_TIPS.config;
    return tips[Math.floor(Math.random() * tips.length)];
}

/**
 * Render a tip into a container element. Creates or updates an .insight-tip div.
 * @param {string} containerId - ID of the container element
 * @param {string} category - Tip category key from INSIGHT_TIPS
 * @param {object} [options] - { model, type, append }
 */
function renderInsightTip(containerId, category, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    const tip = getRandomTip(category, options.model);
    if (!tip) return;
    
    // Find or create the tip element
    let tipEl = container.querySelector('.insight-tip');
    if (!tipEl) {
        tipEl = document.createElement('div');
        tipEl.className = 'insight-tip tip-fade-in';
        if (options.append === false) {
            container.prepend(tipEl);
        } else {
            container.appendChild(tipEl);
        }
    }
    
    // Apply type class
    tipEl.className = 'insight-tip tip-fade-in';
    if (tip.type) tipEl.classList.add(`tip-${tip.type}`);
    if (options.type) tipEl.classList.add(`tip-${options.type}`);
    
    tipEl.innerHTML = `<span class="tip-icon">${tip.icon || '💡'}</span> ${tip.text}`;
}

/**
 * Rotate the tip in a container every N seconds.
 */
function startTipRotation(containerId, category, intervalMs = 15000, options = {}) {
    // Render immediately
    renderInsightTip(containerId, category, options);
    
    // Rotate periodically
    const intervalId = setInterval(() => {
        const container = document.getElementById(containerId);
        if (!container || container.closest('.hidden')) {
            clearInterval(intervalId);
            return;
        }
        renderInsightTip(containerId, category, options);
    }, intervalMs);
    
    return intervalId;
}

// ============== Original Notebook JSON Update Helper ==============
/**
 * Update originalNotebookJson with a saved cell.
 * This ensures that when we later save the snapshot, all previously saved cells are included.
 * 
 * @param {string} cellHeading - The heading/marker for the cell (e.g., 'prompt', 'response', 'response_reference')
 * @param {string} content - The new content for the cell
 */
function updateOriginalNotebookWithCell(cellHeading, content) {
    if (!state.originalNotebookJson) {
        console.warn('Cannot update originalNotebookJson: not set');
        return;
    }
    
    try {
        const notebook = JSON.parse(state.originalNotebookJson);
        const cells = notebook.cells || [];
        
        // Format the cell heading to match notebook format (e.g., **[prompt]**)
        const headingPattern = new RegExp(`\\*\\*\\[${cellHeading}\\]\\*\\*`, 'i');
        
        // Find existing cell with this heading
        let cellIndex = cells.findIndex(cell => {
            const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
            return headingPattern.test(source);
        });
        
        // Format the new cell content
        const formattedContent = `**[${cellHeading}]**\n\n${content}`;
        
        if (cellIndex >= 0) {
            // Update existing cell
            cells[cellIndex].source = [formattedContent];
            console.log(`✅ Updated existing cell [${cellHeading}] in originalNotebookJson`);
        } else {
            // Find insertion point - after metadata, before any model slots
            // Look for judge_system_prompt or judge_prompt_template as anchor
            let insertIndex = cells.length;
            
            // Try to insert before model slots or at the end of setup cells
            for (let i = 0; i < cells.length; i++) {
                const source = Array.isArray(cells[i].source) ? cells[i].source.join('') : (cells[i].source || '');
                // Insert before any model slot cells
                if (/\*\*\[(qwen|nemotron|model)_\d\]\*\*/i.test(source)) {
                    insertIndex = i;
                    break;
                }
                // Insert before number_of_attempts_made
                if (/\*\*\[number_of_attempts_made\]\*\*/i.test(source)) {
                    insertIndex = i;
                    break;
                }
            }
            
            // Create new cell
            const newCell = {
                cell_type: 'markdown',
                id: `auto_${cellHeading}_${Date.now()}`,
                metadata: {},
                source: [formattedContent]
            };
            
            cells.splice(insertIndex, 0, newCell);
            console.log(`✅ Added new cell [${cellHeading}] to originalNotebookJson at index ${insertIndex}`);
        }
        
        notebook.cells = cells;
        state.originalNotebookJson = JSON.stringify(notebook, null, 2);
        console.log(`📝 originalNotebookJson updated, now has ${cells.length} cells`);
        
    } catch (e) {
        console.error('Failed to update originalNotebookJson:', e);
    }
}

// ============== Hunt Limit Functions ==============

function getHuntCountKey(notebookId) {
    // Create a unique key for localStorage based on notebook ID
    return `${HUNT_COUNT_STORAGE_PREFIX}${notebookId || 'unknown'}`;
}

function loadHuntCount(notebookId) {
    if (!notebookId) return 0;
    const key = getHuntCountKey(notebookId);
    const stored = localStorage.getItem(key);
    return stored ? parseInt(stored, 10) : 0;
}

function saveHuntCount(notebookId, count) {
    if (!notebookId) return;
    const key = getHuntCountKey(notebookId);
    localStorage.setItem(key, count.toString());
}

function clearHuntCount(notebookId) {
    if (!notebookId) return;
    const key = getHuntCountKey(notebookId);
    localStorage.removeItem(key);
}

function incrementHuntCount(notebookId, addCount) {
    const current = loadHuntCount(notebookId);
    const newCount = current + addCount;
    saveHuntCount(notebookId, newCount);
    state.totalHuntsCount = newCount;
    state.huntsThisTurn += addCount;  // Track per-turn hunts
    updateHuntLimitUI();
    return newCount;
}

function canStartMoreHunts(requestedHunts = 1) {
    // Per-turn limit: check huntsThisTurn against MAX_HUNTS_PER_NOTEBOOK
    const projected = state.huntsThisTurn + requestedHunts;
    return projected <= MAX_HUNTS_PER_NOTEBOOK;
}

function getRemainingHunts() {
    return Math.max(0, MAX_HUNTS_PER_NOTEBOOK - state.huntsThisTurn);
}

function updateHuntLimitUI() {
    // Per-turn limit: use huntsThisTurn for limit checks
    const remaining = getRemainingHunts();
    const thisTurn = state.huntsThisTurn;
    const totalGlobal = state.totalHuntsCount;
    
    // Update slider and input max values based on remaining hunts this turn
    const slider = document.getElementById('parallelWorkersSlider');
    const numberInput = document.getElementById('parallelWorkers');
    const maxAllowed = Math.min(6, remaining);
    
    if (slider) {
        slider.max = maxAllowed > 0 ? maxAllowed : 1;
        if (parseInt(slider.value) > maxAllowed) {
            slider.value = maxAllowed > 0 ? maxAllowed : 1;
        }
    }
    if (numberInput) {
        numberInput.max = maxAllowed > 0 ? maxAllowed : 1;
        if (parseInt(numberInput.value) > maxAllowed) {
            numberInput.value = maxAllowed > 0 ? maxAllowed : 1;
        }
    }
    
    // Update preset buttons - disable those above remaining limit
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
        const btnValue = parseInt(btn.dataset.value);
        if (btnValue > remaining) {
            btn.disabled = true;
            btn.style.opacity = '0.4';
            btn.title = `Only ${remaining} hunts remaining this turn`;
        } else {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.title = '';
        }
    });
    
    // Find or create the hunt limit indicator
    let indicator = document.getElementById('huntLimitIndicator');
    
    if (thisTurn > 0 || totalGlobal > 0) {
        if (!indicator) {
            const huntSection = document.querySelector('.hunt-action-section');
            if (huntSection) {
                indicator = document.createElement('div');
                indicator.id = 'huntLimitIndicator';
                indicator.style.cssText = 'margin-top: 0.75rem; font-size: 0.85rem; text-align: center;';
                huntSection.appendChild(indicator);
            }
        }
        
        if (indicator) {
            const turnLabel = state.currentTurn > 1 ? ` (Turn ${state.currentTurn})` : '';
            if (remaining === 0) {
                indicator.innerHTML = `
                    <span style="color: var(--danger); font-weight: 600;">
                        ⛔ Turn limit reached (${thisTurn}/${MAX_HUNTS_PER_NOTEBOOK} this turn)
                    </span>
                    <br>
                    <span style="color: var(--text-muted); font-size: 0.8rem;">
                        Continue to the next turn or end the session.
                    </span>
                `;
                state.huntLimitReached = true;
            } else if (remaining <= 4) {
                indicator.innerHTML = `
                    <span style="color: var(--warning);">
                        ⚠️ ${remaining} hunts remaining this turn${turnLabel} (${thisTurn}/${MAX_HUNTS_PER_NOTEBOOK})
                    </span>
                    ${totalGlobal > thisTurn ? `<br><span style="color: var(--text-muted); font-size: 0.75rem;">${totalGlobal} total across all turns</span>` : ''}
                `;
            } else {
                indicator.innerHTML = `
                    <span style="color: var(--text-muted);">
                        📊 ${thisTurn}/${MAX_HUNTS_PER_NOTEBOOK} hunts this turn${turnLabel}
                    </span>
                    ${totalGlobal > thisTurn ? `<br><span style="color: var(--text-muted); font-size: 0.75rem;">${totalGlobal} total across all turns</span>` : ''}
                `;
            }
        }
    } else if (indicator) {
        indicator.innerHTML = '';
    }
    
    // Disable Start Hunt button if per-turn limit reached
    if (elements.startHuntBtn && state.huntLimitReached) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'Turn hunt limit reached. Continue to next turn or end session.';
    }
}

function showHuntLimitReachedError() {
    const turnLabel = state.currentTurn > 1 ? ` for Turn ${state.currentTurn}` : '';
    showToast(
        `⛔ Maximum ${MAX_HUNTS_PER_NOTEBOOK} hunts reached${turnLabel}. ` +
        `Continue to the next turn or end the session.`,
        'error'
    );
}


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
    
    // Warm up API connections in background for faster hunt execution
    warmupConnections();
    
    state.sessionId = data.session_id;
    state.notebook = data.notebook;
    // Store original notebook JSON for WYSIWYG snapshot
    state.originalNotebookJson = data.original_notebook_json || null;
    // Store URL if this was fetched from URL
    if (isUrl && data.notebook) {
        state.notebook.url = elements.colabUrlInput?.value || null;
    }
    
    // Set notebook ID for hunt limit tracking (use file_id if available, or generate from URL/session)
    const notebookUrl = elements.colabUrlInput?.value || '';
    const fileIdMatch = notebookUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    state.notebookId = fileIdMatch ? fileIdMatch[1] : data.session_id;
    
    // Load existing hunt count for this notebook
    state.totalHuntsCount = loadHuntCount(state.notebookId);
    state.huntsThisTurn = 0;  // Reset per-turn counter on fresh load
    state.huntLimitReached = state.huntsThisTurn >= MAX_HUNTS_PER_NOTEBOOK;
    console.log(`📊 Hunt count for notebook ${state.notebookId}: total=${state.totalHuntsCount}, thisTurn=${state.huntsThisTurn}/${MAX_HUNTS_PER_NOTEBOOK}`);
    
    // Update hunt limit UI
    updateHuntLimitUI();
    
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
    
    // Auto-collapse the upload section (notebook is loaded, no need to show it)
    const uploadBody = document.getElementById('uploadBody');
    const uploadChevron = document.getElementById('uploadChevron');
    const uploadHeaderText = document.getElementById('uploadHeaderText');
    if (uploadBody && uploadChevron) {
        uploadBody.classList.add('collapsed');
        uploadChevron.classList.add('collapsed');
    }
    if (uploadHeaderText) {
        uploadHeaderText.textContent = 'Notebook Loaded ✓';
    }
    
    // Show config section
    elements.configSection.classList.remove('hidden');
    
    // Show a contextual config tip
    renderInsightTip('configTipContainer', 'config');
    
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
        
        // Count only valid responses (exclude empty response errors)
        const validResponseCount = state.allResponses.filter(r => 
            r.response && r.response.trim() && !r.error
        ).length;
        
        console.log('📸 Creating snapshot:', {
            selectedResults: selectedResults.length,
            resultsOrder: selectedResults.map(r => r.hunt_id),
            reviews: Object.keys(reviewsForBackend).length,
            totalHunts: validResponseCount
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
        const totalHunts = state.isMultiTurn 
            ? state.multiTurnTotalHunts + validResponseCount 
            : validResponseCount;
        
        const snapshot = {
            original_notebook_json: originalNotebookJson,
            url: notebookUrl,
            selected_results: selectedResults,  // Order preserved - determines slot assignment
            human_reviews: reviewsForBackend,
            total_hunts_ran: totalHunts,
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
                },
                // Multi-turn data (included when applicable)
                is_multi_turn: state.isMultiTurn,
                turns: state.isMultiTurn ? [...state.turns, {
                    turn_number: state.currentTurn,
                    prompt: state.notebook?.prompt || '',
                    response_reference: state.notebook?.response_reference || '',
                    status: 'breaking',
                    results: selectedResults
                }] : [],
                conversation_history: state.isMultiTurn ? state.conversationHistory : []
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
    // Populate Markdown editors (textareas) and update previews
    const promptTextarea = document.getElementById('promptMarkdown');
    if (promptTextarea) {
        promptTextarea.value = notebook.prompt || '';
        // Update preview
        updateMarkdownPreview(promptTextarea);
        // Reset unsaved changes
        state.unsavedChanges.prompt = false;
        // Update word count display after loading
        setTimeout(() => validatePromptLength(), 100);
    }
    
    const responseTextarea = document.getElementById('responseMarkdown');
    if (responseTextarea) {
        responseTextarea.value = notebook.response || '';
        // Update preview
        updateMarkdownPreview(responseTextarea);
        state.unsavedChanges.response = false;
    }
    
    const judgeTextarea = document.getElementById('judgeMarkdown');
    if (judgeTextarea) {
        judgeTextarea.value = notebook.judge_system_prompt || '';
        // Update preview
        updateMarkdownPreview(judgeTextarea);
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
    
    // Initialize resizable panels
    initResizablePanels();
    
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

// ============== Markdown Split Editor ==============

// Markdown editor elements mapping
const markdownEditors = {
    prompt: { textarea: 'promptMarkdown', preview: 'promptPreview' },
    response: { textarea: 'responseMarkdown', preview: 'referencePreview' },
    judge: { textarea: 'judgeMarkdown', preview: 'judgePreview' }
};

function initMarkdownEditors() {
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
            previewToggle.addEventListener('change', (e) => {
                const previewPaneId = previewToggle.dataset.preview;
                const previewPane = document.getElementById(previewPaneId);
                if (previewPane) {
                    if (e.target.checked) {
                        previewPane.classList.remove('collapsed');
                    } else {
                        previewPane.classList.add('collapsed');
                    }
                }
            });
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

function insertMarkdown(textarea, type) {
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

function updateMarkdownPreview(textarea) {
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
function initRichTextEditors() {
    initMarkdownEditors();
}

function updateToolbarState(toolbar, editor) {
    // No-op for Markdown editors (kept for backward compatibility)
}

// Initialize resizable split view panels
function initResizablePanels() {
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
    const promptTextarea = document.getElementById('promptMarkdown');
    if (!promptTextarea) {
        return true; // No validation if element not found
    }
    
    const text = promptTextarea.value || '';
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

// ============== Model Locked Indicator ==============

function showModelLockedIndicator(modelName) {
    const indicator = document.getElementById('modelLockedIndicator');
    const nameSpan = document.getElementById('modelLockedName');
    if (indicator && nameSpan) {
        nameSpan.textContent = modelName;
        // Update config tip with model-specific insight
        renderInsightTip('configTipContainer', 'config', { model: modelName });
        indicator.style.display = 'block';
        indicator.classList.remove('hidden');
        console.log(`🔒 Model locked to: ${modelName} (from notebook metadata)`);
    }
}

function hideModelLockedIndicator() {
    const indicator = document.getElementById('modelLockedIndicator');
    if (indicator) {
        indicator.style.display = 'none';
        indicator.classList.add('hidden');
    }
}

// ============== Model Matching Validation ==============

function validateModelMatch() {
    // If no metadata model set, allow (can't validate)
    if (!state.metadataModel) {
        state.modelMismatchWarning = false;
        return true;
    }
    
    if (!elements.modelSelect) {
        return true;
    }
    
    const selectedModel = elements.modelSelect.value || '';
    if (!selectedModel) {
        // No model selected - BLOCK hunt
        showModelMismatchWarning('(none selected)', state.metadataModel);
        return false;
    }
    
    // Extract key model identifiers from both
    const getModelKey = (modelStr) => {
        const lower = (modelStr || '').toLowerCase();
        // Check for known model families
        if (lower.includes('nemotron')) return 'nemotron';
        if (lower.includes('qwen')) return 'qwen';
        if (lower.includes('llama')) return 'llama';
        if (lower.includes('deepseek')) return 'deepseek';
        if (lower.includes('mistral')) return 'mistral';
        if (lower.includes('gpt')) return 'gpt';
        if (lower.includes('claude')) return 'claude';
        if (lower.includes('gemini')) return 'gemini';
        // Return normalized string for comparison
        return lower.replace(/[^a-z0-9]/g, '');
    };
    
    const selectedKey = getModelKey(selectedModel);
    const metadataKey = getModelKey(state.metadataModel);
    
    // Remove any existing warning
    const existingWarning = document.getElementById('modelMismatchWarning');
    if (existingWarning) {
        existingWarning.remove();
    }
    
    // Check if models match
    const matches = selectedKey === metadataKey;
    
    if (!matches) {
        // Model mismatch - show warning and BLOCK
        showModelMismatchWarning(selectedModel, state.metadataModel);
        return false;
    } else {
        // Model matches - clear warning state and restore UI
        clearModelMismatchWarning();
        return true;
    }
}

function clearModelMismatchWarning() {
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

function showModelMismatchWarning(selectedModel, metadataModel) {
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
    
    // FORCE disable start hunt button
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = true;
        elements.startHuntBtn.title = 'MODEL MISMATCH: Select the correct model from metadata to hunt.';
        elements.startHuntBtn.style.opacity = '0.5';
        elements.startHuntBtn.style.cursor = 'not-allowed';
    }
    
    // Disable save buttons too
    disableSaveButtons(true);
    
    showToast('⛔ Model mismatch! Select the correct model to hunt.', 'error');
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
            // Get raw Markdown from textarea (preserves formatting directly)
            const promptTextarea = document.getElementById('promptMarkdown');
            content = promptTextarea ? promptTextarea.value : '';
            cellHeading = 'prompt';
            break;
        case 'response':
            // Get raw Markdown from textarea
            const responseTextarea = document.getElementById('responseMarkdown');
            content = responseTextarea ? responseTextarea.value : '';
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
            // Get raw Markdown from textarea
            const judgeTextarea = document.getElementById('judgeMarkdown');
            content = judgeTextarea ? judgeTextarea.value : '';
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
        
        // CRITICAL: Update originalNotebookJson so snapshot saves include this cell
        updateOriginalNotebookWithCell(cellHeading, content);
        
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
    
    // Collect all edited content from Markdown textareas
    const promptTextarea = document.getElementById('promptMarkdown');
    const promptContent = promptTextarea ? promptTextarea.value : '';
    if (promptContent.trim()) {
        cellsToSave.push({
            cell_type: 'prompt',
            content: promptContent
        });
    }
    
    const responseTextarea = document.getElementById('responseMarkdown');
    const responseContent = responseTextarea ? responseTextarea.value : '';
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
    
    const judgeTextarea = document.getElementById('judgeMarkdown');
    const judgeContent = judgeTextarea ? judgeTextarea.value : '';
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
        
        // CRITICAL: Update originalNotebookJson for each saved cell so snapshot saves include them
        cellsToSave.forEach(cell => {
            updateOriginalNotebookWithCell(cell.cell_type, cell.content);
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
// Supports multiple formats:
// 1. JSON array: [{"id": "C1", "criteria1": "..."}, ...]
// 2. Plain text: "C1: ...\nC2: ...\nC3: ..."
function parseCriteria(responseReference) {
    console.log('=== parseCriteria DEBUG ===');
    console.log('Input type:', typeof responseReference);
    console.log('Input length:', responseReference ? responseReference.length : 0);
    console.log('Input preview (first 500 chars):', responseReference ? responseReference.substring(0, 500) : 'NULL/UNDEFINED');
    
    if (!responseReference || !responseReference.trim()) {
        const error = 'Empty response_reference - cannot parse criteria';
        console.error(error);
        throw new Error(error);
    }
    
    // Clean the input - remove any leading/trailing whitespace
    const cleaned = responseReference.trim();
    console.log('Cleaned length:', cleaned.length);
    console.log('Contains [:', cleaned.includes('['));
    console.log('Contains ]:', cleaned.includes(']'));
    
    try {
        // First, try to parse the entire string as JSON (most common case)
        let criteriaArray = null;
        let jsonArrayStr = null;
        let isPlainTextFormat = false;
        
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
                    // Fall through to try plain text format
                }
            }
            
            // If still no criteriaArray, try plain text format: "C1: ...\nC2: ..."
            if (!criteriaArray) {
                console.log('Trying plain text format (C1: ..., C2: ..., etc.)');
                const plainTextPattern = /^(C\d+)\s*[:：]\s*(.+)$/gim;
                const matches = [...cleaned.matchAll(plainTextPattern)];
                
                if (matches.length > 0) {
                    criteriaArray = matches.map((match, idx) => ({
                        id: match[1].toUpperCase(),
                        [`criteria${idx + 1}`]: match[2].trim()
                    }));
                    isPlainTextFormat = true;
                    console.log(`✅ Parsed ${matches.length} criteria from plain text format`);
                } else {
                    // No format matched
                    const error = 'No JSON array or plain text criteria (C1:, C2:, etc.) found in response_reference';
                    console.error(error);
                    console.error('Response reference content (first 500 chars):', cleaned.substring(0, 500));
                    throw new Error(error);
                }
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
    
    // Check for pending update before starting new hunt
    if (hasPendingUpdate()) {
        await showUpdatePrompt();
        // If user chose "Continue Anyway", we proceed
        // If user chose "Refresh Now", page reloads (won't reach here)
    }
    
    // MANDATORY: Check if reference was judged and all criteria passed (100%)
    if (!state.referenceValidated) {
        showToast('❌ You must judge the reference response first! All criteria must pass (100%) before starting hunt. Click "Judge Only" or "Save & Re-judge".', 'error');
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
        }
        return;
    }
    
    // FINAL CHECK: Validate model match before starting
    if (state.metadataModel) {
        const selectedModel = elements.modelSelect?.value || '';
        const getKey = (s) => {
            const l = (s || '').toLowerCase();
            if (l.includes('nemotron')) return 'nemotron';
            if (l.includes('qwen')) return 'qwen';
            if (l.includes('llama')) return 'llama';
            if (l.includes('deepseek')) return 'deepseek';
            if (l.includes('mistral')) return 'mistral';
            return l.replace(/[^a-z0-9]/g, '');
        };
        
        if (getKey(selectedModel) !== getKey(state.metadataModel)) {
            showToast(`⛔ BLOCKED: Model mismatch! Required: ${state.metadataModel}, Selected: ${selectedModel}`, 'error');
            if (elements.startHuntBtn) {
                elements.startHuntBtn.disabled = true;
            }
            return;
        }
    }
    
    // CHECK HUNT LIMIT: Block if maximum hunts reached for this notebook
    const requestedHunts = parseInt(elements.parallelWorkers?.value) || 4;
    if (state.huntLimitReached) {
        showHuntLimitReachedError();
        return;
    }
    
    if (!canStartMoreHunts(requestedHunts)) {
        const remaining = getRemainingHunts();
        const turnCtx = (state.isMultiTurn || state.currentTurn > 1) ? ` this turn` : '';
        if (remaining === 0) {
            showHuntLimitReachedError();
            state.huntLimitReached = true;
            updateHuntLimitUI();
            return;
        } else {
            showToast(
                `⚠️ Only ${remaining} hunts remaining${turnCtx}. Reduce hunt count to ${remaining} or less.`,
                'warning'
            );
            return;
        }
    }
    
    // CRITICAL: Calculate hunt offset BEFORE incrementing count
    // This is the starting hunt_id for this run (previous total hunts)
    const huntOffset = state.totalHuntsCount;
    
    // CRITICAL FIX: Capture config BEFORE incrementing count
    // incrementHuntCount calls updateHuntLimitUI which modifies the UI input values!
    // If we call getConfig() after, it reads the modified (lower) values.
    state.config = getConfig();
    console.log(`📊 Config captured with ${state.config.parallel_workers} workers BEFORE increment`);
    
    // Increment hunt count immediately (before the hunt starts)
    // This will update UI but we already captured the config
    incrementHuntCount(state.notebookId, requestedHunts);
    console.log(`📊 Hunt count incremented: ${state.totalHuntsCount}/${MAX_HUNTS_PER_NOTEBOOK}, offset for this run: ${huntOffset}`);
    
    state.isHunting = true;
    state.results = [];
    
    // Store the offset for this run (used in initProgressUI)
    state.currentRunStartOffset = huntOffset;
    
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
    
    // Start rotating hunting tips (model-aware)
    const selectedModel = elements.modelSelect?.value || '';
    startTipRotation('huntingTipContainer', 'hunting', 12000, { model: selectedModel });
    
    // Update config on server WITH hunt offset for unique hunt_id generation
    const configWithOffset = {
        ...state.config,
        hunt_offset: huntOffset  // Tell backend where to start hunt_ids
    };
    await fetch(`/api/update-config/${state.sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configWithOffset)
    });
    
    // Show progress section (centered) and reset it
    elements.progressSection.classList.remove('hidden');
    elements.progressSection.classList.add('hunt-active');
    elements.resultsSection.classList.add('hidden');
    elements.summarySection.classList.add('hidden');
    
    // Initialize progress UI (resets progress to 0%)
    initProgressUI();
    
    // Update turn-aware UI (journey bar shows "Hunting" for current turn)
    updateTurnAwareUI();
    
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
        
        eventSource.addEventListener('hunt_progress', (event) => {
            const data = JSON.parse(event.data);
            handleHuntProgress(data);
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
            
            // Try to recover completed results
            fetch(`/api/results/${state.sessionId}`)
                .then(resp => resp.ok ? resp.json() : Promise.reject('not ok'))
                .then(recoveryData => {
                    const recoveredCount = (recoveryData.results || []).length;
                    if (recoveredCount > 0) {
                        showToast(`Connection lost. Recovered ${recoveredCount} completed results. You can review them or run more hunts.`, 'warning');
                        fetchAllResponses().then(() => showMultiTurnDecision());
                    } else {
                        showToast('Hunt connection error. Please try again.', 'error');
                    }
                })
                .catch(() => {
                    showToast('Hunt connection error. Please try again.', 'error');
                });
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
    
    // Use the offset that was set BEFORE incrementing (in startHunt)
    const offset = state.currentRunStartOffset;
    
    console.log(`📊 initProgressUI: totalHuntsCount=${state.totalHuntsCount}, parallel_workers=${parallel_workers}, offset=${offset}`);
    
    // Reset progress for THIS run only
    elements.progressFill.style.width = '0%';
    const turnLabel = (state.isMultiTurn || state.currentTurn > 1) ? ` (Turn ${state.currentTurn})` : '';
    elements.progressText.textContent = `0 / ${parallel_workers} hunts complete${turnLabel}`;
    elements.progressPercent.textContent = '0%';
    
    // Update turn-aware progress bar color
    if (state.isMultiTurn || state.currentTurn > 1) {
        const color = getTurnColor(state.currentTurn);
        if (elements.progressFill) elements.progressFill.style.background = color;
    }
    
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
    
    // Update status (with turn context)
    elements.huntStatus.querySelector('.status-dot').className = 'status-dot running';
    const runTurnLabel = (state.isMultiTurn || state.currentTurn > 1) ? ` — Turn ${state.currentTurn}` : '';
    elements.statusText.textContent = `Running...${runTurnLabel}`;
}

function updateTableRow(huntId, data) {
    // hunt_id from backend is already globally unique (no offset needed)
    const row = document.getElementById(`hunt-row-${huntId}`);
    if (!row) {
        console.warn(`Row hunt-row-${huntId} not found`);
        return;
    }
    
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

function handleHuntProgress(data) {
    const { hunt_id, step, message } = data;
    
    // Find the row by hunt_id (already globally unique)
    const row = document.getElementById(`hunt-row-${hunt_id}`);
    if (!row) return;
    
    // Map step to display text and style
    const stepDisplay = {
        'calling_model': { icon: '🔄', text: 'Calling API...', color: 'var(--warning)' },
        'received_response': { icon: '📥', text: 'Got Response', color: 'var(--info)' },
        'judging': { icon: '⚖️', text: 'Judging...', color: 'var(--accent-primary)' }
    };
    
    const display = stepDisplay[step] || { icon: '⏳', text: step, color: 'var(--text-muted)' };
    
    // Update status cell with detailed progress
    row.querySelector('.status-cell').innerHTML = `
        <span class="score-badge pending" style="font-size: 0.75rem;">
            <span class="spinner"></span> ${display.icon} ${display.text}
        </span>
    `;
    
    console.log(`Hunt ${hunt_id} progress: ${step} - ${message}`);
}

function handleHuntResult(data) {
    const { hunt_id, status, score, is_breaking, error, completed, total, breaks, response, model } = data;
    
    // hunt_id from backend is already globally unique (no offset calculation needed)
    const globalRowNum = hunt_id;
    
    // Debug log
    console.log('Hunt Result:', { 
        hunt_id, 
        status, 
        score, 
        is_breaking, 
        globalRowNum
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
        
        // Response - SHOW "View" BUTTON that opens slide-out panel
        const responseCell = row.querySelector('.response-cell');
        if (responseCell && response) {
            const responseText = response.trim();
            const shortModel = model ? model.split('/').pop().substring(0, 20) : 'Unknown';
            
            // Store response data for slide-out panel
            state.huntResponseData[globalRowNum] = {
                huntNum: globalRowNum,
                model: model || 'Unknown',
                status: status || 'pending',
                score: score,
                is_breaking: is_breaking,
                response: responseText,
                error: error
            };
            
            // Render simple "View" button
            const previewText = responseText.length > 50 ? responseText.substring(0, 50) + '...' : responseText;
            responseCell.innerHTML = `
                <button class="response-view-btn" onclick="window.openResponseSlideout(${globalRowNum})">
                    View
                </button>
                <span style="color: var(--text-muted); font-size: 0.75rem; margin-left: 0.5rem;">
                    ${escapeHtml(previewText)}
                </span>
            `;
        } else if (responseCell && error) {
            responseCell.innerHTML = `
                <span style="color: var(--danger); font-size: 0.85rem;">Error: ${escapeHtml(error.substring(0, 100))}</span>
            `;
        }
    }
    
    // Update progress (with turn context)
    const percent = Math.round((completed / total) * 100);
    elements.progressFill.style.width = `${percent}%`;
    const turnCtx = (state.isMultiTurn || state.currentTurn > 1) ? ` (Turn ${state.currentTurn})` : '';
    elements.progressText.textContent = `${completed} / ${total} hunts complete${turnCtx}`;
    elements.progressPercent.textContent = `${percent}%`;
    
    // Update breaks indicator
    const dots = elements.breaksIndicator.querySelectorAll('.break-dot');
    for (let i = 0; i < breaks && i < dots.length; i++) {
        dots[i].classList.add('found');
    }
}

// ============== Response Slide-out Panel ==============

function openResponseSlideout(rowNum) {
    console.log('openResponseSlideout called with rowNum:', rowNum);
    
    const data = state.huntResponseData[rowNum];
    if (!data) {
        console.warn(`No response data found for row ${rowNum}`);
        showToast('Response data not available yet', 'warning');
        return;
    }
    
    console.log('Response data found:', data);
    
    // Get elements directly from DOM (backup in case elements object not updated)
    const slideout = document.getElementById('responseSlideout');
    const backdrop = document.getElementById('responseSlideoutBackdrop');
    const titleEl = document.getElementById('slideoutTitle');
    const modelEl = document.getElementById('slideoutModel');
    const statusEl = document.getElementById('slideoutStatus');
    const scoreEl = document.getElementById('slideoutScore');
    const responseTextEl = document.getElementById('slideoutResponseText');
    
    if (!slideout) {
        console.error('Slideout panel element not found!');
        showToast('Error: Panel not found', 'error');
        return;
    }
    
    // Update slide-out content
    if (titleEl) {
        titleEl.textContent = `Hunt #${data.huntNum} Response`;
    }
    
    if (modelEl) {
        const shortModel = data.model.split('/').pop();
        modelEl.textContent = shortModel;
    }
    
    if (statusEl) {
        statusEl.textContent = data.status;
        statusEl.className = 'response-slideout-meta-value';
        if (data.status === 'completed') {
            // is_breaking = true means model broke = GOOD for hunt = 'pass' styling
            statusEl.classList.add(data.is_breaking ? 'pass' : 'fail');
        }
    }
    
    if (scoreEl) {
        if (data.score !== null && data.score !== undefined) {
            scoreEl.textContent = data.score === 0 ? 'BREAKING' : 'PASSING';
            scoreEl.className = 'response-slideout-meta-value';
            // Score 0 = breaking = GOOD for hunt = 'pass' styling
            // Score 1-4 = passing = BAD for hunt = 'fail' styling
            scoreEl.classList.add(data.score === 0 ? 'pass' : 'fail');
        } else {
            scoreEl.textContent = '-';
            scoreEl.className = 'response-slideout-meta-value';
        }
    }
    
    if (responseTextEl) {
        responseTextEl.textContent = data.response || 'No response';
    }
    
    // Open the slide-out (reset right position for opening)
    slideout.style.right = '0';
    slideout.classList.add('open');
    if (backdrop) {
        backdrop.classList.add('visible');
    }
    
    // Prevent body scroll when panel is open
    document.body.style.overflow = 'hidden';
    
    console.log('Slideout panel opened');
}

function closeResponseSlideout() {
    const slideout = document.getElementById('responseSlideout');
    const backdrop = document.getElementById('responseSlideoutBackdrop');
    
    if (slideout) {
        // Set right position to fully hide based on current width
        const currentWidth = slideout.offsetWidth;
        slideout.style.right = `-${currentWidth + 10}px`;
        slideout.classList.remove('open');
    }
    if (backdrop) {
        backdrop.classList.remove('visible');
    }
    
    // Restore body scroll
    document.body.style.overflow = '';
}

// Open slide-out for selection table details
function openSelectionDetailSlideout(rowNumber, result) {
    console.log('Opening selection detail slideout for row:', rowNumber);
    
    const slideout = document.getElementById('responseSlideout');
    const backdrop = document.getElementById('responseSlideoutBackdrop');
    const titleEl = document.getElementById('slideoutTitle');
    const modelEl = document.getElementById('slideoutModel');
    const statusEl = document.getElementById('slideoutStatus');
    const scoreEl = document.getElementById('slideoutScore');
    const responseTextEl = document.getElementById('slideoutResponseText');
    
    if (!slideout) {
        console.error('Slideout panel element not found!');
        return;
    }
    
    // Determine if breaking
    const judgeScore = result.judge_score !== undefined && result.judge_score !== null ? Number(result.judge_score) : null;
    const score = result.score !== undefined && result.score !== null ? Number(result.score) : null;
    const isBreaking = (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
    
    // Update slide-out content
    if (titleEl) {
        titleEl.textContent = `Hunt #${rowNumber + 1} Response`;
    }
    
    if (modelEl) {
        const shortModel = (result.model || 'Unknown').split('/').pop();
        modelEl.textContent = shortModel;
    }
    
    if (statusEl) {
        statusEl.textContent = isBreaking ? 'BREAK' : 'PASS';
        statusEl.className = 'response-slideout-meta-value';
        statusEl.classList.add(isBreaking ? 'pass' : 'fail');
    }
    
    if (scoreEl) {
        const displayScore = judgeScore !== null ? judgeScore : (score !== null ? score : '-');
        scoreEl.textContent = displayScore;
        scoreEl.className = 'response-slideout-meta-value';
        if (displayScore !== '-') {
            scoreEl.classList.add(displayScore === 0 ? 'pass' : 'fail');
        }
    }
    
    if (responseTextEl) {
        responseTextEl.textContent = result.response || 'No response available';
    }
    
    // Open the slide-out (reset right position for opening)
    slideout.style.right = '0';
    slideout.classList.add('open');
    if (backdrop) {
        backdrop.classList.add('visible');
    }
    
    document.body.style.overflow = 'hidden';
}

// ============== Grading Slide-out Panel ==============

function openGradingSlideout(result, slotIndex, rowNumber) {
    const slideout = document.getElementById('gradingSlideout');
    const backdrop = document.getElementById('gradingSlideoutBackdrop');
    const slotBadge = document.getElementById('gradingSlotBadge');
    const slotModel = document.getElementById('gradingSlotModel');
    const body = document.getElementById('gradingSlideoutBody');
    
    if (!slideout || !body) {
        console.error('Grading slideout elements not found!');
        return;
    }
    
    // Check if we're in read-only mode (after LLM reveal)
    const isReadOnly = state.llmRevealed;
    
    const shortModel = result.model.split('/').pop();
    const slotNum = slotIndex !== undefined ? slotIndex + 1 : result.hunt_id;
    const responseText = result.response || 'No response available';
    const reasoningTrace = result.reasoning_trace || '';
    const huntId = result.hunt_id;
    
    // Get existing review data if any
    const existingReview = state.humanReviews?.[huntId] || {};
    const existingNotes = existingReview.notes || '';
    const existingGrades = existingReview.grades || {};
    
    // Update header
    slotBadge.textContent = `Slot ${slotNum}`;
    slotModel.textContent = shortModel;
    
    // Build body content
    const disabledAttr = isReadOnly ? 'disabled' : '';
    const disabledStyle = isReadOnly ? 'opacity: 0.6; cursor: not-allowed; pointer-events: none;' : '';
    const textareaStyle = isReadOnly ? 'background: var(--bg-tertiary); opacity: 0.7;' : '';
    
    body.innerHTML = `
        ${isReadOnly ? `
        <!-- Locked Banner -->
        <div style="padding: 0.75rem 1rem; background: linear-gradient(135deg, rgba(251, 191, 36, 0.15), rgba(251, 191, 36, 0.05)); border: 1px solid var(--warning); border-radius: 8px; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-size: 1.2rem;">🔒</span>
            <span style="color: var(--warning); font-weight: 600;">Reviews are locked - View only mode</span>
        </div>
        ` : ''}
        
        <!-- Response Section -->
        <div class="grading-section">
            <div class="grading-section-title">📄 Model Response</div>
            <div class="grading-response-box">${escapeHtml(responseText)}</div>
        </div>
        
        <!-- Reasoning Section (Collapsible) -->
        <div class="grading-section">
            <button class="reasoning-toggle-btn" style="width: 100%; padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; justify-content: space-between;">
                <span>🧠 Model Reasoning (Reference)</span>
                <span class="reasoning-arrow">▼</span>
            </button>
            <div class="reasoning-content" style="display: none; margin-top: 0.75rem;">
                ${reasoningTrace ? `
                    <div class="grading-response-box" style="max-height: 200px;">${escapeHtml(reasoningTrace)}</div>
                ` : `
                    <div style="padding: 1rem; background: var(--bg-tertiary); border-radius: 8px; color: var(--text-muted); text-align: center; font-style: italic;">
                        No reasoning trace available
                    </div>
                `}
            </div>
        </div>
        
        <!-- Criteria Grading Section -->
        <div class="grading-section">
            <div class="grading-section-title">✅ Grade Each Criterion ${isReadOnly ? '<span style="color: var(--warning); font-size: 0.8rem;">(Locked)</span>' : ''}</div>
            <div class="grading-criteria-list" data-hunt-id="${huntId}">
                ${(state.criteria || []).map(c => {
                    const existingGrade = existingGrades[c.id];
                    const passActive = existingGrade === 1 ? 'active' : '';
                    const failActive = existingGrade === 0 ? 'active' : '';
                    return `
                        <div class="grading-criterion" data-criterion-id="${c.id}">
                            <span class="grading-criterion-id">${c.id}:</span>
                            <span class="grading-criterion-text">${escapeHtml(c.criteria)}</span>
                            <div class="grading-criterion-buttons" style="${disabledStyle}">
                                <button class="grading-btn grading-btn-pass ${passActive}" data-hunt-id="${huntId}" data-criterion="${c.id}" ${disabledAttr}>
                                    ✅ Pass
                                </button>
                                <button class="grading-btn grading-btn-fail ${failActive}" data-hunt-id="${huntId}" data-criterion="${c.id}" ${disabledAttr}>
                                    ❌ Fail
                                </button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
        
        <!-- Notes Section -->
        <div class="grading-section">
            <div class="grading-section-title">📝 Explanation ${isReadOnly ? '<span style="color: var(--warning); font-size: 0.8rem;">(Locked)</span>' : ''}</div>
            <textarea class="grading-notes-textarea" data-hunt-id="${huntId}" 
                placeholder="Explain your grading decisions..." ${disabledAttr} style="${textareaStyle}">${escapeHtml(existingNotes)}</textarea>
        </div>
        
        <!-- Submit Button -->
        <div class="grading-section">
            ${isReadOnly ? `
                <div style="padding: 0.75rem 1rem; background: var(--bg-tertiary); border-radius: 8px; text-align: center; color: var(--text-muted);">
                    🔒 Review submitted and locked
                </div>
            ` : `
                <button class="btn btn-primary grading-submit-btn" data-hunt-id="${huntId}" data-slot-index="${slotIndex}" data-row-number="${rowNumber}">
                    ✅ Submit Review
                </button>
            `}
            <div class="grading-status" data-hunt-id="${huntId}"></div>
        </div>
        
        <!-- LLM Judge Section (Hidden until revealed) -->
        <div class="llm-judge-section" data-hunt-id="${huntId}" style="display: ${state.llmRevealed ? 'block' : 'none'}; margin-top: 1.5rem; padding: 1.5rem; background: var(--bg-tertiary); border-radius: 12px; border: 2px solid var(--accent-primary);">
            <div class="grading-section-title" style="color: var(--accent-primary);">🤖 LLM Judge Result</div>
            <div style="margin-top: 0.75rem;">
                <span class="score-badge score-${result.judge_score || 0}" style="padding: 0.5rem 1rem;">
                    ${result.judge_score === 0 ? '🟢' : '🔴'} Score: ${result.judge_score ?? '-'}
                </span>
            </div>
            ${result.judge_explanation ? `
                <div style="margin-top: 1rem; padding: 1rem; background: var(--bg-card); border-radius: 8px; font-size: 0.9rem; line-height: 1.6; white-space: pre-wrap;">
                    ${escapeHtml(result.judge_explanation)}
                </div>
            ` : ''}
        </div>
    `;
    
    // Set up event listeners
    setupGradingSlideoutEvents(body, huntId, result, slotIndex, rowNumber);
    
    // Open the slideout (reset right position for opening)
    slideout.style.right = '0';
    slideout.classList.add('open');
    backdrop.classList.add('visible');
    document.body.style.overflow = 'hidden';
    
    // Store current slot for reference
    state.currentGradingSlot = { result, slotIndex, rowNumber, huntId };
}

function setupGradingSlideoutEvents(container, huntId, result, slotIndex, rowNumber) {
    // Reasoning toggle
    const reasoningToggle = container.querySelector('.reasoning-toggle-btn');
    const reasoningContent = container.querySelector('.reasoning-content');
    const reasoningArrow = container.querySelector('.reasoning-arrow');
    
    if (reasoningToggle && reasoningContent) {
        reasoningToggle.addEventListener('click', () => {
            const isHidden = reasoningContent.style.display === 'none';
            reasoningContent.style.display = isHidden ? 'block' : 'none';
            reasoningArrow.textContent = isHidden ? '▲' : '▼';
        });
    }
    
    // Criteria buttons
    container.querySelectorAll('.grading-btn-pass').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const criterion = btn.dataset.criterion;
            const row = btn.closest('.grading-criterion');
            row.querySelector('.grading-btn-pass').classList.add('active');
            row.querySelector('.grading-btn-fail').classList.remove('active');
            
            // Store grade
            if (!state.humanReviews[huntId]) {
                state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            }
            state.humanReviews[huntId].grades[criterion] = 1;
        });
    });
    
    container.querySelectorAll('.grading-btn-fail').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const criterion = btn.dataset.criterion;
            const row = btn.closest('.grading-criterion');
            row.querySelector('.grading-btn-fail').classList.add('active');
            row.querySelector('.grading-btn-pass').classList.remove('active');
            
            // Store grade
            if (!state.humanReviews[huntId]) {
                state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            }
            state.humanReviews[huntId].grades[criterion] = 0;
        });
    });
    
    // Notes textarea
    const notesTextarea = container.querySelector('.grading-notes-textarea');
    if (notesTextarea) {
        notesTextarea.addEventListener('input', () => {
            if (!state.humanReviews[huntId]) {
                state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            }
            state.humanReviews[huntId].notes = notesTextarea.value;
        });
    }
    
    // Submit button
    const submitBtn = container.querySelector('.grading-submit-btn');
    if (submitBtn) {
        submitBtn.addEventListener('click', () => {
            submitGradingReview(huntId, result, slotIndex, rowNumber);
        });
    }
}

function submitGradingReview(huntId, result, slotIndex, rowNumber) {
    const review = state.humanReviews[huntId] || {};
    const grades = review.grades || {};
    const notes = review.notes || '';
    
    // Check if all criteria are graded
    const allGraded = (state.criteria || []).every(c => grades[c.id] !== undefined);
    
    if (!allGraded) {
        showToast('Please grade all criteria before submitting', 'warning');
        return;
    }
    
    // Calculate overall judgment based on grades (all pass = 1, any fail = 0)
    const allPass = Object.values(grades).every(g => g === 1);
    const overallJudgment = allPass ? 1 : 0;
    
    // Convert grades to grading_basis format (PASS/FAIL strings)
    const gradingBasis = {};
    Object.entries(grades).forEach(([key, value]) => {
        gradingBasis[key] = value === 1 ? 'PASS' : 'FAIL';
    });
    
    // Mark as submitted with huntId key (for backwards compatibility)
    state.humanReviews[huntId] = {
        ...review,
        submitted: true
    };
    
    // CRITICAL FIX: Also store with row_number key format for updateReviewProgress()
    const rowKey = `row_${rowNumber}`;
    state.humanReviews[rowKey] = {
        hunt_id: huntId,
        row_number: rowNumber,
        judgment: overallJudgment,
        grading_basis: gradingBasis,
        explanation: notes,
        slotNum: slotIndex + 1,
        timestamp: new Date().toISOString(),
        submitted: true
    };
    
    console.log(`📝 Review submitted: huntId=${huntId}, rowNumber=${rowNumber}, rowKey=${rowKey}`);
    
    // Update status in slideout
    const statusEl = document.querySelector(`.grading-status[data-hunt-id="${huntId}"]`);
    if (statusEl) {
        statusEl.innerHTML = '<span style="color: var(--success);">✅ Review Submitted!</span>';
    }
    
    // Update the compact card
    const card = document.querySelector(`.slot-compact-card[data-hunt-id="${huntId}"]`);
    if (card) {
        card.classList.add('reviewed');
        const statusDiv = card.querySelector('.slot-compact-status');
        if (statusDiv) {
            statusDiv.textContent = '✅ Review Submitted';
            statusDiv.classList.add('reviewed');
        }
        const btn = card.querySelector('.slot-open-btn');
        if (btn) {
            btn.textContent = '📝 Edit';
        }
    }
    
    // Update review progress
    updateReviewProgress();
    
    showToast(`Review for Slot ${slotIndex + 1} submitted!`, 'success');
    
    // Close slideout after a short delay
    setTimeout(() => {
        closeGradingSlideout();
    }, 500);
}

function closeGradingSlideout() {
    const slideout = document.getElementById('gradingSlideout');
    const backdrop = document.getElementById('gradingSlideoutBackdrop');
    
    if (slideout) {
        // Set right position to fully hide based on current width
        const currentWidth = slideout.offsetWidth;
        slideout.style.right = `-${currentWidth + 10}px`;
        slideout.classList.remove('open');
    }
    if (backdrop) {
        backdrop.classList.remove('visible');
    }
    
    document.body.style.overflow = '';
    state.currentGradingSlot = null;
}

// Make slide-out functions available globally
window.openResponseSlideout = openResponseSlideout;
window.closeResponseSlideout = closeResponseSlideout;
window.openSelectionDetailSlideout = openSelectionDetailSlideout;
window.openGradingSlideout = openGradingSlideout;
window.closeGradingSlideout = closeGradingSlideout;

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
    
    // Remove centering from progress section (hunt is done)
    elements.progressSection?.classList.remove('hunt-active');
    
    // FIX 4: Keep model/provider locked even after hunt completes (only unlock on refresh)
    // Don't re-enable model/provider selects here - they stay locked until page refresh
    
    const { completed_hunts, breaks_found } = data;
    
    // NOTE: totalHuntsCount is now the single source of truth (already incremented before hunt started)
    // No need to update accumulatedHuntOffset separately
    
    // Update status (with turn context)
    elements.huntStatus.querySelector('.status-dot').className = 'status-dot completed';
    const turnSuffix = (state.isMultiTurn || state.currentTurn > 1) ? ` — Turn ${state.currentTurn}` : '';
    elements.statusText.textContent = `Completed${turnSuffix}`;
    
    // Reset reveal state for new hunt
    state.llmRevealed = false;
    state.humanReviews = {};
    
    // Update turn-aware UI (journey bar label changes from "Hunting" to "Reviewing")
    if (state.isMultiTurn || state.currentTurn > 1) {
        updateTurnAwareUI();
    }
    
    // Fetch all responses first (we need them for both flows)
    fetchAllResponses().then(() => {
        // Show multi-turn decision panel
        // Trainer chooses: "breaking" (standard flow) or "continue" (multi-turn)
        showMultiTurnDecision();
    });
}

/**
 * Fetch all responses from the session and accumulate them in state.
 * Does NOT show selection UI — that's triggered separately.
 */
async function fetchAllResponses() {
    try {
        const response = await fetch(`/api/results/${state.sessionId}`);
        const data = await response.json();
        
        // Filter out results from previous turns (they're already saved in state.turns)
        const newResponses = (data.results || []).filter(r => 
            !state.previousTurnHuntIds.has(r.hunt_id)
        );
        
        newResponses.forEach(newResponse => {
            const existingIndex = state.allResponses.findIndex(r => r.hunt_id === newResponse.hunt_id);
            if (existingIndex >= 0) {
                state.allResponses[existingIndex] = {
                    ...newResponse,
                    rowNumber: state.allResponses[existingIndex].rowNumber
                };
            } else {
                const newRowNumber = state.allResponses.length;
                state.allResponses.push({
                    ...newResponse,
                    rowNumber: newRowNumber
                });
            }
        });
        
        // Update summary with CUMULATIVE stats
        const cumul = getCumulativeStats();
        
        elements.summarySection?.classList.remove('hidden');
        const summaryTotal = document.getElementById('summaryTotal');
        const summaryBreaks = document.getElementById('summaryBreaks');
        if (summaryTotal) summaryTotal.textContent = cumul.totalHunts;
        if (summaryBreaks) summaryBreaks.textContent = cumul.totalBreaks;
        
    } catch (error) {
        console.error('Error fetching results:', error);
    }
}

async function fetchAllResponsesAndShowSelection(completedHunts, breaksFound) {
    try {
        // Fetch all results from the session
        const response = await fetch(`/api/results/${state.sessionId}`);
        const data = await response.json();
        
        // Filter out results from previous turns, then accumulate current turn
        const newResponses = (data.results || []).filter(r => 
            !state.previousTurnHuntIds.has(r.hunt_id)
        );
        
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
        
        // Count breaks for current turn (for selection logic)
        const totalPasses = state.allResponses.filter(r => {
            const judgeScore = r.judge_score !== undefined && r.judge_score !== null ? Number(r.judge_score) : null;
            const score = r.score !== undefined && r.score !== null ? Number(r.score) : null;
            return (judgeScore !== null && judgeScore > 0) || (score !== null && score > 0);
        }).length;
        
        // Populate summary with CUMULATIVE stats across all turns
        const cumulative = getCumulativeStats();
        elements.summarySection.classList.remove('hidden');
        document.getElementById('summaryTotal').textContent = cumulative.totalHunts;
        document.getElementById('summaryBreaks').textContent = cumulative.totalBreaks;
        
        const successRate = cumulative.totalHunts > 0 ? Math.round((cumulative.totalBreaks / cumulative.totalHunts) * 100) : 0;
        document.getElementById('summarySuccess').textContent = `${successRate}% (${cumulative.totalBreaks}/${cumulative.totalHunts} breaks)`;
        document.getElementById('summaryMet').textContent = cumulative.totalBreaks >= 3 ? '✅ Yes' : '❌ No';
        
        // VALIDATION 1: Need at least 3 breaks (use cumulative)
        const totalBreaks = cumulative.totalBreaks;
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
        
        // Show a selection tip
        renderInsightTip('selectionTipContainer', 'selection');
        
        // Display selection cards (NO auto-selection)
        displaySelectionCards();
        
        showToast(`✅ Criteria met! ${totalBreaks} breaks, ${totalPasses} passes. Select exactly 4 for review.`, 'success');
    } catch (error) {
        console.error('Error fetching results:', error);
        showToast('Error fetching results', 'error');
    }
}


// ============== Turn-Aware UI Functions (Journey Bar, Thread, Badges) ==============

/**
 * Activate a specific turn's tab in the turn history panel.
 * Scrolls to the multi-turn section and clicks the correct tab.
 */
function activateTurnTab(turnNumber) {
    const section = document.getElementById('multiTurnSection');
    if (!section) return;
    
    // Make the section visible if hidden
    section.classList.remove('hidden');
    
    // Find the correct tab button
    const tabBar = document.getElementById('turnHistoryTabs');
    if (tabBar) {
        const tabs = tabBar.querySelectorAll('button');
        tabs.forEach(tab => {
            // Tab text is like "Turn 1 ✓" or "Turn 2 (current)"
            const match = tab.textContent.match(/Turn\s+(\d+)/);
            if (match && parseInt(match[1]) === turnNumber) {
                tab.click();  // Programmatically click to trigger the render
            }
        });
    }
    
    // Scroll to the turn history card
    const historyCard = document.getElementById('turnHistoryCard');
    if (historyCard) {
        historyCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

/**
 * Render the Turn Journey Bar — horizontal stepper showing all turns.
 */
function renderJourneyBar() {
    const bar = document.getElementById('turnJourneyBar');
    if (!bar) return;
    
    bar.innerHTML = '';
    
    // Build list: completed turns + current turn + one future placeholder
    const steps = [];
    state.turns.forEach(t => {
        steps.push({ turnNumber: t.turnNumber || t.turn_number, status: 'completed' });
    });
    steps.push({ turnNumber: state.currentTurn, status: 'active' });
    steps.push({ turnNumber: state.currentTurn + 1, status: 'future' });
    
    steps.forEach((step, idx) => {
        // Add connector before each step (except the first)
        if (idx > 0) {
            const connector = document.createElement('div');
            connector.className = 'journey-connector';
            if (step.status === 'completed' || step.status === 'active') {
                connector.classList.add('completed');
            } else {
                connector.classList.add('dashed');
            }
            bar.appendChild(connector);
        }
        
        const node = document.createElement('div');
        node.className = `journey-node ${step.status}`;
        
        const circle = document.createElement('div');
        circle.className = 'journey-circle';
        const color = getTurnColor(step.turnNumber);
        
        if (step.status === 'completed') {
            circle.style.background = color;
            circle.innerHTML = '&#10003;';
        } else if (step.status === 'active') {
            circle.style.background = color;
            circle.textContent = step.turnNumber;
        } else {
            circle.textContent = '?';
        }
        
        const label = document.createElement('div');
        label.className = 'journey-label';
        if (step.status === 'completed') {
            label.textContent = `Turn ${step.turnNumber}`;
        } else if (step.status === 'active') {
            label.textContent = state.isHunting ? 'Hunting' : 'Active';
        } else {
            label.textContent = 'Next';
        }
        
        node.appendChild(circle);
        node.appendChild(label);
        
        // Click any turn to show its content in the turn history panel
        if (step.status === 'completed' || step.status === 'active') {
            node.addEventListener('click', () => {
                activateTurnTab(step.turnNumber);
            });
        }
        
        bar.appendChild(node);
    });
    
    // Show the bar
    bar.classList.add('visible');
}

/**
 * Render the Conversation Thread — left-rail timeline.
 */
function renderConversationThread() {
    const thread = document.getElementById('conversationThread');
    if (!thread) return;
    
    // Keep the title, clear the rest
    const title = thread.querySelector('.thread-title');
    thread.innerHTML = '';
    if (title) thread.appendChild(title);
    else {
        const t = document.createElement('div');
        t.className = 'thread-title';
        t.textContent = 'Conversation';
        thread.appendChild(t);
    }
    
    // Completed turns
    state.turns.forEach(t => {
        const turnNum = t.turnNumber || t.turn_number;
        const node = document.createElement('div');
        node.className = 'thread-node completed thread-node-enter';
        node.dataset.turn = turnNum;
        
        const color = getTurnColor(turnNum);
        node.style.setProperty('--node-color', color);
        
        node.innerHTML = `
            <div class="thread-turn-label">
                <span class="turn-badge ${getTurnColorClass(turnNum)}" style="font-size:0.6rem; padding:0.1rem 0.4rem;">T${turnNum}</span>
            </div>
            <div class="thread-prompt-preview">${escapeHtml((t.prompt || '').substring(0, 80))}</div>
            ${t.selectedResponse ? `<div class="thread-response-preview" style="border-left-color:${color};">${escapeHtml(t.selectedResponse.substring(0, 80))}</div>` : ''}
            <div class="thread-status done">&#10003; ${(t.results || []).length} hunts</div>
        `;
        
        node.addEventListener('click', () => {
            activateTurnTab(turnNum);
        });
        
        thread.appendChild(node);
    });
    
    // Current turn
    const currentNode = document.createElement('div');
    currentNode.className = 'thread-node active thread-node-enter';
    currentNode.dataset.turn = state.currentTurn;
    const currentColor = getTurnColor(state.currentTurn);
    currentNode.style.setProperty('--node-color', currentColor);
    
    const currentPrompt = state.notebook?.prompt || '';
    const huntCount = state.allResponses?.length || 0;
    
    currentNode.innerHTML = `
        <div class="thread-turn-label">
            <span class="turn-badge ${getTurnColorClass(state.currentTurn)}" style="font-size:0.6rem; padding:0.1rem 0.4rem;">T${state.currentTurn}</span>
        </div>
        <div class="thread-prompt-preview">${escapeHtml(currentPrompt.substring(0, 80))}</div>
        <div class="thread-status hunting">${state.isHunting ? '● Hunting...' : (huntCount > 0 ? `${huntCount} hunts` : 'Ready')}</div>
    `;
    
    thread.appendChild(currentNode);
    
    // Activate the two-column layout and show thread
    const container = document.getElementById('mainContainer');
    if (container) container.classList.add('multi-turn-layout');
    thread.classList.add('visible');
    
    // Hide metadata sidebar to avoid overlap with conversation thread
    if (elements.metadataSidebar) {
        elements.metadataSidebar.style.display = 'none';
        document.body.classList.remove('sidebar-visible');
    }
}

/**
 * Update all turn-aware section headers, progress info, and badges.
 */
function updateTurnAwareUI() {
    const turn = state.currentTurn;
    const color = getTurnColor(turn);
    const colorClass = getTurnColorClass(turn);
    
    // Add class to body/main for CSS-based visibility
    document.body.classList.toggle('multi-turn-active', state.isMultiTurn || turn > 1);
    
    // Update progress section header badge
    const progressBadge = document.getElementById('progressTurnBadge');
    const progressTitle = document.getElementById('progressTitleText');
    if (progressBadge && (state.isMultiTurn || turn > 1)) {
        progressBadge.textContent = `Turn ${turn}`;
        progressBadge.className = `turn-badge section-turn-badge ${colorClass}`;
        progressBadge.style.display = 'inline-flex';
        if (progressTitle) progressTitle.textContent = 'Hunt Progress';
    }
    
    // Update preview section header badge
    const previewBadge = document.getElementById('previewTurnBadge');
    const previewTitle = document.getElementById('previewTitleText');
    if (previewBadge && (state.isMultiTurn || turn > 1)) {
        previewBadge.textContent = `Turn ${turn}`;
        previewBadge.className = `turn-badge section-turn-badge ${colorClass}`;
        previewBadge.style.display = 'inline-flex';
        if (previewTitle) previewTitle.textContent = 'Prompt & Criteria';
    }
    
    // Update per-turn progress info
    const turnInfo = document.getElementById('progressTurnInfo');
    const turnScope = document.getElementById('progressTurnScope');
    const cumulative = document.getElementById('progressCumulative');
    if (turnInfo && (state.isMultiTurn || turn > 1)) {
        turnInfo.style.display = 'flex';
        if (turnScope) turnScope.textContent = `Turn ${turn}`;
        if (cumulative) {
            const globalTotal = state.multiTurnTotalHunts + (state.allResponses?.length || 0);
            cumulative.textContent = globalTotal > 0 ? `${globalTotal} total across ${turn} turns` : '';
        }
    }
    
    // Update progress bar color
    const progressFill = document.getElementById('progressFill');
    if (progressFill && (state.isMultiTurn || turn > 1)) {
        progressFill.style.background = color;
    }
    
    // Update the decision fork "next turn" number
    const decisionNextTurn = document.getElementById('decisionNextTurn');
    if (decisionNextTurn) decisionNextTurn.textContent = turn + 1;
    
    // Render journey bar and thread if multi-turn
    if (state.isMultiTurn || turn > 1) {
        renderJourneyBar();
        renderConversationThread();
    }
}

// ============== Multi-Turn Functions ==============

/**
 * Show the multi-turn decision panel after a hunt completes.
 * Trainer chooses: "This turn is breaking" or "Select good response & continue".
 */
function showMultiTurnDecision() {
    const section = document.getElementById('multiTurnSection');
    if (!section) return;
    
    // Update turn title
    const title = document.getElementById('multiTurnTitle');
    if (title) {
        title.textContent = `Turn ${state.currentTurn} Complete — What Next?`;
    }
    
    // Populate decision summary stats
    const hunts = state.allResponses?.length || 0;
    const breaks = (state.allResponses || []).filter(r => (r.judge_score === 0 || r.score === 0)).length;
    const turnStat = document.getElementById('decisionTurnStat');
    const huntStat = document.getElementById('decisionHuntStat');
    const breakStat = document.getElementById('decisionBreakStat');
    const turnColor = getTurnColor(state.currentTurn);
    
    if (turnStat) turnStat.innerHTML = `<span class="turn-badge ${getTurnColorClass(state.currentTurn)}">Turn ${state.currentTurn}</span> Complete`;
    if (huntStat) huntStat.textContent = `${hunts} hunts`;
    if (breakStat) breakStat.innerHTML = `${breaks} break${breaks !== 1 ? 's' : ''} found`;
    
    // Update "Continue to Turn X" button text
    const nextTurnSpan = document.getElementById('decisionNextTurn');
    if (nextTurnSpan) nextTurnSpan.textContent = state.currentTurn + 1;
    
    // Render the tabbed turn history (shows all completed turns + current)
    renderTurnHistoryTabs();
    
    // Reset panels — show decision card and decision panel
    document.getElementById('multiTurnDecisionCard')?.classList.remove('hidden');
    document.getElementById('multiTurnDecisionPanel').classList.remove('hidden');
    document.getElementById('goodResponsePicker').classList.add('hidden');
    document.getElementById('nextTurnEditor').classList.add('hidden');
    
    // Update turn-aware UI elements
    updateTurnAwareUI();
    
    // Show a multi-turn decision tip
    renderInsightTip('multiTurnTipContainer', 'multiTurn');
    
    // Show the section
    section.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Render the tabbed turn history panel.
 * Each completed turn gets a tab. The current (in-progress) turn also gets a tab.
 * Clicking a tab shows that turn's prompt, criteria, selected response, and judge result.
 */
function renderTurnHistoryTabs() {
    const tabBar = document.getElementById('turnHistoryTabs');
    const contentArea = document.getElementById('turnHistoryContent');
    if (!tabBar || !contentArea) return;
    
    tabBar.innerHTML = '';
    
    // Build list of turns to show: completed turns + current turn
    const allTurns = [];
    
    // Add completed turns from state.turns
    state.turns.forEach(t => {
        allTurns.push({
            turnNumber: t.turnNumber || t.turn_number,
            prompt: t.prompt,
            criteria: t.response_reference || t.criteria,
            selectedResponse: t.selectedResponse || t.selected_response || null,
            judgeResult: t.judgeResult || t.judge_result || null,
            status: 'completed',
            results: t.results || []
        });
    });
    
    // Add current turn (the one that just finished hunting)
    allTurns.push({
        turnNumber: state.currentTurn,
        prompt: state.notebook?.prompt || '',
        criteria: state.notebook?.response_reference || '',
        selectedResponse: null, // Not selected yet
        judgeResult: null,
        status: 'current',
        results: state.allResponses || []
    });
    
    // No turns at all? Hide the history card
    if (allTurns.length === 0) {
        document.getElementById('turnHistoryCard').style.display = 'none';
        return;
    }
    document.getElementById('turnHistoryCard').style.display = '';
    
    // Create tab buttons
    allTurns.forEach((turn, idx) => {
        const tab = document.createElement('button');
        const isCurrent = turn.status === 'current';
        const isActive = idx === allTurns.length - 1; // Default: show latest turn
        const turnColor = getTurnColor(turn.turnNumber);
        
        tab.style.cssText = `
            padding: 0.6rem 1.2rem;
            border: none;
            background: transparent;
            cursor: pointer;
            font-size: 0.85rem;
            font-weight: 600;
            color: ${isActive ? turnColor : 'var(--text-muted)'};
            border-bottom: 3px solid ${isActive ? turnColor : 'transparent'};
            white-space: nowrap;
            transition: all 0.2s;
        `;
        tab.textContent = isCurrent 
            ? `Turn ${turn.turnNumber} (current)` 
            : `Turn ${turn.turnNumber} ✓`;
        
        tab.addEventListener('mouseenter', () => {
            if (!tab.classList.contains('active-turn-tab')) {
                tab.style.color = 'var(--text-primary)';
                tab.style.borderBottomColor = 'var(--border)';
            }
        });
        tab.addEventListener('mouseleave', () => {
            if (!tab.classList.contains('active-turn-tab')) {
                tab.style.color = 'var(--text-muted)';
                tab.style.borderBottomColor = 'transparent';
            }
        });
        
        tab.addEventListener('click', () => {
            // Update active tab styling
            tabBar.querySelectorAll('button').forEach(b => {
                b.style.color = 'var(--text-muted)';
                b.style.borderBottomColor = 'transparent';
                b.classList.remove('active-turn-tab');
            });
            tab.style.color = turnColor;
            tab.style.borderBottomColor = turnColor;
            tab.classList.add('active-turn-tab');
            
            // Render this turn's content
            renderTurnContent(contentArea, turn);
        });
        
        if (isActive) {
            tab.classList.add('active-turn-tab');
        }
        
        tabBar.appendChild(tab);
    });
    
    // Show the latest turn by default
    renderTurnContent(contentArea, allTurns[allTurns.length - 1]);
}

/**
 * Render the content for a single turn tab.
 */
function renderTurnContent(container, turn) {
    const isCurrent = turn.status === 'current';
    
    // Count breaks/passes in results
    const breaks = (turn.results || []).filter(r => 
        (r.judge_score === 0 || r.score === 0)
    ).length;
    const passes = (turn.results || []).filter(r => {
        const s = r.judge_score ?? r.score;
        return s !== null && s !== undefined && s > 0;
    }).length;
    
    let html = '';
    
    // Turn status badge (with per-turn color)
    const turnColor = getTurnColor(turn.turnNumber);
    html += `<div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap;">`;
    html += `<span class="turn-badge ${getTurnColorClass(turn.turnNumber)}">Turn ${turn.turnNumber}</span>`;
    if (turn.results && turn.results.length > 0) {
        html += `<span style="font-size: 0.8rem; color: var(--text-muted);">${turn.results.length} hunts &mdash; ${breaks} breaks, ${passes} passes</span>`;
    }
    if (turn.selectedResponse) {
        html += `<span style="padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; background: rgba(16, 185, 129, 0.15); color: var(--success, #10b981);">Response selected ✓</span>`;
    }
    html += `</div>`;
    
    // Prompt section (border color matches turn color)
    html += `<div style="margin-bottom: 1rem;">`;
    html += `<div style="font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.4rem;">Prompt</div>`;
    html += `<div style="padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px; border-left: 3px solid ${turnColor}; font-size: 0.9rem; white-space: pre-wrap; max-height: 200px; overflow-y: auto;">${escapeHtml(turn.prompt || '')}</div>`;
    html += `</div>`;
    
    // Criteria section
    html += `<div style="margin-bottom: 1rem;">`;
    html += `<div style="font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.4rem;">Criteria / Rubrics</div>`;
    html += `<div style="padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px; border-left: 3px solid ${turnColor}; font-size: 0.9rem; white-space: pre-wrap; max-height: 200px; overflow-y: auto; opacity: 0.9;">${escapeHtml(turn.criteria || '')}</div>`;
    html += `</div>`;
    
    // Selected response (for completed turns)
    if (turn.selectedResponse) {
        html += `<div style="margin-bottom: 1rem;">`;
        html += `<div style="font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.4rem;">Selected Response (carried forward)</div>`;
        html += `<div style="padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px; border-left: 3px solid var(--success, #10b981); font-size: 0.9rem; white-space: pre-wrap; max-height: 300px; overflow-y: auto;">${escapeHtml(turn.selectedResponse)}</div>`;
        html += `</div>`;
    }
    
    // Judge result for the selected response (for completed turns)
    if (turn.judgeResult && turn.judgeResult.score !== undefined) {
        const score = turn.judgeResult.score;
        const criteria = turn.judgeResult.criteria || {};
        const explanation = turn.judgeResult.explanation || '';
        
        html += `<div style="margin-bottom: 1rem;">`;
        html += `<div style="font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.4rem;">Auto-Judge Result for Selected Response <span style="font-weight:400;text-transform:none;letter-spacing:0;">(judged by GPT-5)</span></div>`;
        html += `<div style="padding: 0.75rem; background: var(--bg-tertiary); border-radius: 8px; border-left: 3px solid ${score > 0 ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'}; font-size: 0.9rem;">`;
        html += `<div style="font-weight: 600; margin-bottom: 0.5rem;">Score: ${score} ${score > 0 ? '(PASS)' : '(BREAK)'}</div>`;
        
        if (Object.keys(criteria).length > 0) {
            html += `<div style="margin-bottom: 0.5rem;">`;
            for (const [k, v] of Object.entries(criteria)) {
                const isPassing = String(v).toUpperCase() === 'PASS';
                html += `<span style="display: inline-block; margin: 0.15rem 0.25rem; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; background: ${isPassing ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${isPassing ? 'var(--success,#10b981)' : 'var(--danger,#ef4444)'};">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`;
            }
            html += `</div>`;
        }
        
        if (explanation) {
            html += `<div style="font-size: 0.85rem; color: var(--text-secondary); white-space: pre-wrap; max-height: 100px; overflow-y: auto;">${escapeHtml(explanation)}</div>`;
        }
        html += `</div></div>`;
    }
    
    // For current turn: show a note only if hunts have been run (so the decision panel is visible)
    if (isCurrent && !turn.selectedResponse && turn.results && turn.results.length > 0) {
        html += `<div style="padding: 0.75rem; background: rgba(59, 130, 246, 0.08); border-radius: 8px; border: 1px dashed var(--primary); text-align: center; color: var(--text-muted); font-size: 0.9rem;">`;
        html += `This is the current turn. Use the panel below to mark it as breaking or select a good response to continue.`;
        html += `</div>`;
    } else if (isCurrent && !turn.selectedResponse && (!turn.results || turn.results.length === 0)) {
        html += `<div style="padding: 0.75rem; background: rgba(59, 130, 246, 0.05); border-radius: 8px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">`;
        html += `Awaiting hunts for this turn. Configure and start a hunt above.`;
        html += `</div>`;
    }
    
    container.innerHTML = html;
}

/**
 * Helper: Escape HTML in strings.
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Handle "This Turn is Breaking" button click.
 * Marks the turn as breaking and proceeds to the standard selection/review flow.
 */
async function handleMarkBreaking() {
    try {
        // Call mark-breaking API
        const response = await fetch(`/api/mark-breaking/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error(`Mark breaking failed: ${response.statusText}`);
        }
        
        const data = await response.json();
        state.isMultiTurn = data.is_multi_turn;
        
        // Hide multi-turn section
        document.getElementById('multiTurnSection').classList.add('hidden');
        
        // Count total hunts across all turns
        state.multiTurnTotalHunts = state.turns.reduce((sum, t) => sum + (t.results?.length || 0), 0) + state.allResponses.length;
        
        // Proceed to standard selection flow
        const completedHunts = state.allResponses.length;
        const breaksFound = state.allResponses.filter(r => (r.judge_score === 0 || r.score === 0)).length;
        fetchAllResponsesAndShowSelection(completedHunts, breaksFound);
        
    } catch (error) {
        console.error('Error marking breaking:', error);
        showToast(`Turn ${state.currentTurn} — Error: ${error.message}`, 'error');
    }
}

/**
 * Handle "Select Good Response & Continue" button click.
 * Shows the response picker for selecting a passing response.
 */
function handleContinueToNextTurn() {
    // Hide decision panel, show response picker
    document.getElementById('multiTurnDecisionPanel').classList.add('hidden');
    const picker = document.getElementById('goodResponsePicker');
    picker.classList.remove('hidden');
    
    // Populate response list with ALL responses from current turn
    const list = document.getElementById('goodResponseList');
    list.innerHTML = '';
    
    // Show conversation context (prior turns) if multi-turn
    if (state.conversationHistory.length > 0) {
        const contextDiv = document.createElement('div');
        contextDiv.className = 'response-picker-context';
        let contextHtml = '<div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);margin-bottom:0.4rem;">Conversation so far</div>';
        state.conversationHistory.forEach(msg => {
            const roleClass = msg.role === 'user' ? 'user' : 'assistant';
            contextHtml += `
                <div class="context-message ${roleClass}">
                    <div class="context-message-role">${msg.role}</div>
                    <div class="context-message-text">${escapeHtml((msg.content || '').substring(0, 150))}</div>
                </div>
            `;
        });
        contextDiv.innerHTML = contextHtml;
        list.appendChild(contextDiv);
    }
    
    if (state.allResponses.length === 0) {
        list.innerHTML += '<p style="color: var(--text-muted);">No responses available.</p>';
        return;
    }
    
    state.allResponses.forEach((r, idx) => {
        const score = r.judge_score ?? r.score ?? '?';
        const isPassing = score > 0;
        const shortModel = (r.model || '').split('/').pop();
        
        // Build criteria badges if available
        const judgeCriteria = r.judge_criteria || {};
        let criteriaBadgesHtml = '';
        if (Object.keys(judgeCriteria).length > 0) {
            criteriaBadgesHtml = '<div style="display: flex; flex-wrap: wrap; gap: 0.25rem; margin-bottom: 0.5rem;">';
            for (const [k, v] of Object.entries(judgeCriteria)) {
                const isPass = String(v).toUpperCase() === 'PASS';
                criteriaBadgesHtml += `<span style="display: inline-block; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; background: ${isPass ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)'}; color: ${isPass ? 'var(--success,#10b981)' : 'var(--danger,#ef4444)'};">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`;
            }
            criteriaBadgesHtml += '</div>';
        }
        
        const card = document.createElement('div');
        card.style.cssText = `
            padding: 0.75rem 1rem;
            border-radius: 8px;
            border: 1.5px solid ${isPassing ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'};
            background: ${isPassing ? 'rgba(16, 185, 129, 0.04)' : 'rgba(239, 68, 68, 0.04)'};
            cursor: pointer;
            transition: all 0.2s;
        `;
        card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-1px)'; card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'; });
        card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.boxShadow = ''; });
        
        // Show FULL response content (scrollable)
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <span style="font-weight: 600;">Hunt #${r.hunt_id} — ${shortModel}</span>
                <span style="font-weight: 700; color: ${isPassing ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'};">
                    Score: ${score} ${isPassing ? '(PASS)' : '(BREAK)'}
                </span>
            </div>
            ${criteriaBadgesHtml}
            <div style="font-size: 0.85rem; color: var(--text-secondary); white-space: pre-wrap; max-height: 300px; overflow-y: auto; padding-right: 0.25rem;">${escapeHtml(r.response || '')}</div>
        `;
        
        card.addEventListener('click', () => selectGoodResponse(r));
        list.appendChild(card);
    });
}

/**
 * Select a good response to carry forward to the next turn.
 */
function selectGoodResponse(response) {
    // Store the selected response
    state._selectedGoodResponse = response;
    
    // Show next turn editor
    const editor = document.getElementById('nextTurnEditor');
    editor.classList.remove('hidden');
    
    // Update turn numbers
    const nextTurn = state.currentTurn + 1;
    document.getElementById('nextTurnNumber').textContent = nextTurn;
    document.getElementById('startNextTurnNumber').textContent = nextTurn;
    
    // Pre-populate judge prompt from current turn
    const judgePromptField = document.getElementById('nextTurnJudgePrompt');
    if (judgePromptField && state.notebook?.judge_system_prompt) {
        judgePromptField.placeholder = `Current: ${state.notebook.judge_system_prompt.substring(0, 100)}... (leave empty to reuse)`;
    }
    
    // Clear input fields
    document.getElementById('nextTurnPrompt').value = '';
    document.getElementById('nextTurnCriteria').value = '';
    document.getElementById('nextTurnJudgePrompt').value = '';
    
    // Highlight selected response
    const cards = document.querySelectorAll('#goodResponseList > div');
    cards.forEach(card => { card.style.opacity = '0.5'; });
    const selectedIdx = state.allResponses.findIndex(r => r.hunt_id === response.hunt_id);
    if (selectedIdx >= 0 && cards[selectedIdx]) {
        cards[selectedIdx].style.opacity = '1';
        cards[selectedIdx].style.border = '3px solid var(--primary)';
    }
    
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    showToast(`Turn ${state.currentTurn} — Selected Hunt #${response.hunt_id} as good response. Write Turn ${state.currentTurn + 1} below.`, 'success');
}

/**
 * Start the next turn: call advance-turn API, then start a new hunt.
 */
async function startNextTurn() {
    const nextPrompt = document.getElementById('nextTurnPrompt').value.trim();
    const nextCriteria = document.getElementById('nextTurnCriteria').value.trim();
    const nextJudgePrompt = document.getElementById('nextTurnJudgePrompt').value.trim() || null;
    
    if (!nextPrompt) {
        showToast('Please enter a prompt for the next turn.', 'error');
        return;
    }
    if (!nextCriteria) {
        showToast('Please enter criteria for the next turn.', 'error');
        return;
    }
    
    if (!state._selectedGoodResponse) {
        showToast('Please select a good response first.', 'error');
        return;
    }
    
    try {
        // Call advance-turn API
        const response = await fetch(`/api/advance-turn/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selected_hunt_id: state._selectedGoodResponse.hunt_id,
                next_prompt: nextPrompt,
                next_criteria: nextCriteria,
                next_judge_prompt: nextJudgePrompt
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to advance turn');
        }
        
        const data = await response.json();
        
        // Update local state
        state.currentTurn = data.current_turn;
        state.isMultiTurn = true;
        
        // Build local conversation history
        state.conversationHistory.push(
            { role: 'user', content: state.notebook.prompt },
            { role: 'assistant', content: state._selectedGoodResponse.response }
        );
        
        // Save current turn data locally
        state.turns.push({
            turnNumber: state.currentTurn - 1,
            prompt: state.notebook.prompt,
            response_reference: state.notebook.response_reference,
            selectedResponse: state._selectedGoodResponse.response,
            selectedHuntId: state._selectedGoodResponse.hunt_id,
            judgeResult: {
                score: state._selectedGoodResponse.judge_score,
                criteria: state._selectedGoodResponse.judge_criteria || {},
                explanation: state._selectedGoodResponse.judge_explanation || ''
            },
            results: state.allResponses.map(r => ({
                hunt_id: r.hunt_id,
                response: r.response,
                judge_score: r.judge_score,
                is_breaking: r.is_breaking
            }))
        });
        
        // Track total hunts across turns
        state.multiTurnTotalHunts += state.allResponses.length;
        
        // Update notebook state with new turn data
        state.notebook.prompt = nextPrompt;
        state.notebook.response_reference = nextCriteria;
        // CRITICAL: Update response to the selected good response from this turn
        // This is what gets judged when "Judge Reference" is clicked in the new turn
        if (state._selectedGoodResponse?.response) {
            state.notebook.response = state._selectedGoodResponse.response;
        }
        if (nextJudgePrompt) {
            state.notebook.judge_system_prompt = nextJudgePrompt;
        }
        
        // Track hunt IDs from this turn so they're excluded from future fetches
        state.allResponses.forEach(r => {
            if (r.hunt_id) state.previousTurnHuntIds.add(r.hunt_id);
        });
        
        // Reset hunt state for new turn
        state.allResponses = [];
        state.results = [];
        state.selectedRowNumbers = [];
        state.humanReviews = {};
        state.selectionConfirmed = false;
        state.llmRevealed = false;
        state.referenceValidated = false;
        state._selectedGoodResponse = null;
        
        // RESET per-turn hunt counter (this is the key per-turn limit change)
        state.huntsThisTurn = 0;
        state.huntLimitReached = false;
        
        // Clear the progress table rows for the new turn
        if (elements.resultsTableBody) {
            elements.resultsTableBody.innerHTML = '';
        }
        
        // Hide decision card and other sections, but KEEP turn history visible
        document.getElementById('multiTurnDecisionCard')?.classList.add('hidden');
        document.getElementById('selectionSection')?.classList.add('hidden');
        document.getElementById('resultsSection')?.classList.add('hidden');
        document.getElementById('summarySection')?.classList.add('hidden');
        
        // Re-render turn history tabs (now includes the just-completed turn)
        renderTurnHistoryTabs();
        // Show the multi-turn section (for the history card)
        document.getElementById('multiTurnSection').classList.remove('hidden');
        
        // Update the notebook preview with new prompt/criteria
        populatePreviewTabs(state.notebook);
        
        // Re-enable the reference judge (trainer needs to validate new criteria)
        state.referenceValidated = false;
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = true;
        }
        
        // Clear previous judge results display so old criteria grades don't persist
        if (elements.referenceJudgeResult) {
            elements.referenceJudgeResult.innerHTML = '';
        }
        // Reset initial criteria so judge validates against new turn's criteria
        state.initialCriteria = null;
        
        // Update all turn-aware UI (journey bar, thread, badges, progress info)
        updateTurnAwareUI();
        updateHuntLimitUI();
        
        // Turn transition toast with turn context
        showToast(`Turn ${state.currentTurn} started — ${MAX_HUNTS_PER_NOTEBOOK} hunts available`, 'success');
        
        // Show config section and scroll to it
        elements.configSection?.classList.remove('hidden');
        elements.configSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        
        // Refresh config tip for the new turn (model-aware)
        const selectedModel = elements.modelSelect?.value || '';
        renderInsightTip('configTipContainer', 'config', { model: selectedModel });
        
    } catch (error) {
        console.error('Error advancing turn:', error);
        showToast(`Error: ${error.message}`, 'error');
    }
}

/**
 * Initialize multi-turn event listeners.
 */
function initMultiTurnListeners() {
    const markBreakingBtn = document.getElementById('markBreakingBtn');
    if (markBreakingBtn) {
        markBreakingBtn.addEventListener('click', handleMarkBreaking);
    }
    
    const continueBtn = document.getElementById('continueToNextTurnBtn');
    if (continueBtn) {
        continueBtn.addEventListener('click', handleContinueToNextTurn);
    }
    
    const startNextBtn = document.getElementById('startNextTurnBtn');
    if (startNextBtn) {
        startNextBtn.addEventListener('click', startNextTurn);
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
    
    // Create a cleaner table with better column order
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
    
    // Show all hunts in order (breaking first, then passing)
    const sortedHunts = [...state.allResponses].sort((a, b) => {
        const aJudgeScore = a.judge_score !== undefined && a.judge_score !== null ? Number(a.judge_score) : (a.score !== undefined && a.score !== null ? Number(a.score) : 999);
        const bJudgeScore = b.judge_score !== undefined && b.judge_score !== null ? Number(b.judge_score) : (b.score !== undefined && b.score !== null ? Number(b.score) : 999);
        const aIsBreaking = aJudgeScore === 0;
        const bIsBreaking = bJudgeScore === 0;
        if (aIsBreaking && !bIsBreaking) return -1;
        if (!aIsBreaking && bIsBreaking) return 1;
        return 0;
    });
    
    sortedHunts.forEach((result, index) => {
        const rowNumber = state.allResponses.indexOf(result);
        const isSelected = state.selectedRowNumbers.includes(rowNumber);
        
        // Get slot number if selected
        const slotIndex = isSelected ? state.selectedRowNumbers.indexOf(rowNumber) : -1;
        const slotNumber = slotIndex >= 0 ? slotIndex + 1 : null;
        
        // Determine if breaking or passing
        const judgeScore = result.judge_score !== undefined && result.judge_score !== null ? Number(result.judge_score) : null;
        const score = result.score !== undefined && result.score !== null ? Number(result.score) : null;
        const isBreaking = (judgeScore !== null && judgeScore === 0) || (score !== null && score === 0);
        
        const shortModel = (result.model || 'unknown').split('/').pop();
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
                <span class="model-name">${shortModel}</span>
            </td>
            <td class="col-status">
                <span class="status-badge ${isBreaking ? 'break' : 'pass'}">
                    ${isBreaking ? '✅ BREAK' : '❌ PASS'}
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
        
        // Click handler for row selection (except buttons)
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
        
        // View button opens slide-out panel
        row.querySelector('.view-details-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openSelectionDetailSlideout(rowNumber, result);
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
        
        // Update slot cell (use class selector for correct column)
        const slotCell = row.querySelector('td.col-slot');
        if (slotCell) {
            if (slotNumber) {
                slotCell.innerHTML = `<span class="slot-badge assigned">Slot ${slotNumber}</span>`;
            } else {
                slotCell.innerHTML = `<span class="slot-badge empty">-</span>`;
            }
        }
        
        // Update row selection styling
        if (isSelected) {
            row.classList.add('selected');
        } else {
            row.classList.remove('selected');
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
    
    // Show a results tip
    renderInsightTip('resultsTipContainer', 'results');
    
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
    
    console.log(`📊 updateReviewProgress: ${reviewCount}/${selectedCount} reviews, keys:`, reviewKeys);
    console.log(`📊 humanReviews keys:`, Object.keys(state.humanReviews || {}));
    
    if (elements.reviewProgressText) {
        elements.reviewProgressText.textContent = `${reviewCount} / ${selectedCount} completed`;
        elements.reviewProgressText.style.color = reviewCount === selectedCount ? 'var(--success)' : 'var(--text-primary)';
    }
    
    // Enable reveal button only when all selected reviews are complete
    const allComplete = reviewCount >= selectedCount && selectedCount > 0;
    
    if (elements.revealLLMBtn) {
        elements.revealLLMBtn.disabled = !allComplete || state.llmRevealed;
        elements.revealLLMBtn.style.opacity = (!allComplete || state.llmRevealed) ? '0.5' : '1';
        
        if (state.llmRevealed) {
            elements.revealLLMBtn.textContent = '✅ LLM Judgments Revealed';
            elements.revealLLMBtn.disabled = true;
        } else if (allComplete) {
            elements.revealLLMBtn.textContent = '👁️ Reveal LLM Judgments';
            console.log('✅ All reviews complete! Reveal button enabled.');
        }
    }
    
    // Also enable save button when all reviews complete (not just after reveal)
    if (allComplete && selectedCount === 4 && elements.saveDriveBtn) {
        // Keep save button ready but user still needs to reveal first
        console.log('✅ All 4 reviews complete! Ready to reveal LLM judgments.');
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
    
    // Lock all human review inputs (legacy sections)
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
    
    // Update slot cards to show "View" instead of "Edit" (still clickable to view LLM judgment)
    document.querySelectorAll('.slot-compact-card').forEach(card => {
        card.classList.add('revealed');
        const btn = card.querySelector('.slot-open-btn');
        if (btn) {
            btn.textContent = 'View';
        }
    });
    
    // Enable save button
    elements.saveDriveBtn.disabled = false;
    elements.saveDriveBtn.style.opacity = '1';
    
    // Update progress display
    updateReviewProgress();
    
    showToast('👁️ LLM Judgments revealed! Click any slot to view details. Reviews are locked.', 'success');
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
    card.className = 'slot-compact-card';
    card.dataset.huntId = result.hunt_id;
    card.dataset.slotIndex = slotIndex || 0;
    card.dataset.rowNumber = rowNumber !== undefined ? rowNumber : null;
    
    const shortModel = result.model.split('/').pop();
    const score = result.judge_score ?? 0;
    const isFailed = score === 0;
    const slotNum = slotIndex !== undefined ? slotIndex + 1 : result.hunt_id;
    
    // Check if this slot has been reviewed
    const huntId = result.hunt_id;
    const isReviewed = state.humanReviews && state.humanReviews[huntId] && state.humanReviews[huntId].submitted;
    
    if (isReviewed) {
        card.classList.add('reviewed');
    }
    
    card.innerHTML = `
        <div class="slot-compact-badge">Slot ${slotNum}</div>
        <div class="slot-compact-info">
            <div class="slot-compact-model">${shortModel}</div>
            <div class="slot-compact-status ${isReviewed ? 'reviewed' : ''}">
                ${isReviewed ? '✅ Review Submitted' : `${isFailed ? '🟢 BREAK' : '🔴 PASS'} - Click to Review`}
            </div>
        </div>
        <div class="slot-compact-action">
            <button class="slot-open-btn">
                ${isReviewed ? '📝 Edit' : '⚖️ Grade'}
            </button>
        </div>
    `;
    
    // Click handler - open grading slide-out
    card.addEventListener('click', () => {
        openGradingSlideout(result, slotIndex, rowNumber);
    });
    
    return card;
}

// Legacy createResultCard function for full expandable card (keeping for reference)
function createResultCardFull(result, slotIndex, rowNumber) {
    const card = document.createElement('div');
    card.className = 'expandable-card';
    card.dataset.huntId = result.hunt_id;
    card.dataset.slotIndex = slotIndex || 0;
    card.dataset.rowNumber = rowNumber !== undefined ? rowNumber : null;
    
    const shortModel = result.model.split('/').pop();
    const score = result.judge_score ?? 0;
    const isFailed = score === 0;
    const scoreEmoji = isFailed ? '🟢' : '🔴';
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
    // NOTE: totalHuntsCount is the single source of truth, no separate offset to reset
    state.currentRunStartOffset = 0;  // Reset run offset (will be set correctly in initProgressUI)
    state.originalNotebookJson = null;  // Reset original notebook
    state.blindJudging = {
        queue: [],
        currentResult: null,
        humanJudgments: {}
    };
    state.huntResponseData = {};  // Reset response data for slide-out panel
    
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
    
    // Hide model locked indicator (will be shown again if new notebook has model in metadata)
    hideModelLockedIndicator();
    
    // Refresh model options to remove disabled state
    setTimeout(() => {
        if (elements.modelSelect && elements.providerSelect) {
            updateModelOptions();
        }
    }, 100);
    
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

/**
 * Convert HTML content from contentEditable to plain text while preserving line breaks.
 * Browsers insert <br>, <div>, or <p> tags when user presses Enter.
 * This function converts those back to \n for proper notebook formatting.
 */
function htmlToPlainText(element) {
    if (!element) return '';
    
    // Clone the element to avoid modifying the original
    const clone = element.cloneNode(true);
    
    // Replace <br> tags with newline markers
    clone.querySelectorAll('br').forEach(br => {
        br.replaceWith('\n');
    });
    
    // Replace block elements (div, p, li) with newline + content
    // These elements create new lines in contentEditable
    clone.querySelectorAll('div, p').forEach(block => {
        // Add newline before block content (unless it's the first element)
        const text = block.textContent || '';
        if (block.previousSibling) {
            block.replaceWith('\n' + text);
        } else {
            block.replaceWith(text);
        }
    });
    
    // Handle list items
    clone.querySelectorAll('li').forEach(li => {
        const text = li.textContent || '';
        li.replaceWith('\n• ' + text);
    });
    
    // Get the text content and clean up
    let text = clone.textContent || '';
    
    // Clean up multiple consecutive newlines (but keep double newlines for paragraphs)
    text = text.replace(/\n{3,}/g, '\n\n');
    
    // Trim leading/trailing whitespace but preserve internal structure
    text = text.trim();
    
    return text;
}

// ============== Connection Warm-up ==============

/**
 * Warm up API connections in background for faster hunt execution.
 * Called automatically when notebook is loaded.
 */
async function warmupConnections() {
    try {
        const response = await fetch('/api/warmup-connections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.ok) {
            console.log('🔥 Connection warm-up initiated');
        }
    } catch (error) {
        // Silent fail - warm-up is optional optimization
        console.log('Connection warm-up skipped:', error.message);
    }
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
    
    // Calculate CUMULATIVE breaks and hunts across ALL turns + current turn
    const cumulative = getCumulativeStats();
    const totalHunts = cumulative.totalHunts;
    const breaksFound = cumulative.totalBreaks;
    
    // Populate summary with cumulative data
    document.getElementById('summaryTotal').textContent = totalHunts;
    document.getElementById('summaryBreaks').textContent = breaksFound;
    
    // Show summary tip
    renderInsightTip('summaryTipContainer', 'summary', { type: breaksFound >= 3 ? 'success' : undefined });
    
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
            
            // IMMEDIATE CHECK: Does selected model match metadata?
            const selectedModel = elements.modelSelect.value || '';
            const metadataModel = state.metadataModel || '';
            
            if (metadataModel) {
                // Get model keys for comparison
                const getKey = (s) => {
                    const l = (s || '').toLowerCase();
                    if (l.includes('nemotron')) return 'nemotron';
                    if (l.includes('qwen')) return 'qwen';
                    if (l.includes('llama')) return 'llama';
                    if (l.includes('deepseek')) return 'deepseek';
                    if (l.includes('mistral')) return 'mistral';
                    return l.replace(/[^a-z0-9]/g, '');
                };
                
                const selectedKey = getKey(selectedModel);
                const metadataKey = getKey(metadataModel);
                
                if (selectedKey !== metadataKey) {
                    // MISMATCH - Disable button immediately
                    if (elements.startHuntBtn) {
                        elements.startHuntBtn.disabled = true;
                        elements.startHuntBtn.style.opacity = '0.5';
                        elements.startHuntBtn.style.cursor = 'not-allowed';
                        elements.startHuntBtn.title = `Model mismatch! Metadata requires: ${metadataModel}`;
                    }
                    showToast(`⛔ Wrong model! Metadata requires: ${metadataModel}`, 'error');
                    state.modelMismatchWarning = true;
                } else {
                    // Match - restore button (but other validations may still apply)
                    if (elements.startHuntBtn) {
                        elements.startHuntBtn.style.opacity = '';
                        elements.startHuntBtn.style.cursor = '';
                        // Only enable if reference was validated
                        if (state.referenceValidated && state.modelRefValid) {
                            elements.startHuntBtn.disabled = false;
                            elements.startHuntBtn.title = '';
                        }
                    }
                    state.modelMismatchWarning = false;
                    showToast('Model changed. Previous results cleared.', 'info');
                }
            } else {
                showToast('Model changed. Previous results cleared.', 'info');
            }
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
    
    // Response slide-out panel events
    elements.slideoutCloseBtn?.addEventListener('click', closeResponseSlideout);
    elements.responseSlideoutBackdrop?.addEventListener('click', closeResponseSlideout);
    
    // Grading slide-out panel events
    document.getElementById('gradingSlideoutCloseBtn')?.addEventListener('click', closeGradingSlideout);
    document.getElementById('gradingSlideoutBackdrop')?.addEventListener('click', closeGradingSlideout);
    
    // Close slide-outs with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (elements.responseSlideout?.classList.contains('open')) {
                closeResponseSlideout();
            }
            if (document.getElementById('gradingSlideout')?.classList.contains('open')) {
                closeGradingSlideout();
            }
        }
    });
    
    // Initialize slideout resize functionality
    initSlideoutResize();
}

// ============== Slideout Resize Functionality ==============

function initSlideoutResize() {
    // Response slideout resize
    const responseSlideout = document.getElementById('responseSlideout');
    const responseResizeHandle = document.getElementById('responseSlideoutResizeHandle');
    if (responseSlideout && responseResizeHandle) {
        setupSlideoutResize(responseSlideout, responseResizeHandle, 300, window.innerWidth * 0.95);
    }
    
    // Grading slideout resize
    const gradingSlideout = document.getElementById('gradingSlideout');
    const gradingResizeHandle = document.getElementById('gradingSlideoutResizeHandle');
    if (gradingSlideout && gradingResizeHandle) {
        setupSlideoutResize(gradingSlideout, gradingResizeHandle, 400, window.innerWidth * 0.95);
    }
}

function setupSlideoutResize(slideout, resizeHandle, minWidth, maxWidth) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    // Mouse events
    resizeHandle.addEventListener('mousedown', startResize);
    
    // Touch events for mobile
    resizeHandle.addEventListener('touchstart', startResize, { passive: false });
    
    function startResize(e) {
        e.preventDefault();
        isResizing = true;
        
        // Get starting position (handle both mouse and touch)
        startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
        startWidth = slideout.offsetWidth;
        
        // Add resizing class to disable transitions
        slideout.classList.add('resizing');
        resizeHandle.classList.add('active');
        
        // Prevent text selection during resize
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'ew-resize';
        
        // Add move and end listeners
        document.addEventListener('mousemove', doResize);
        document.addEventListener('mouseup', stopResize);
        document.addEventListener('touchmove', doResize, { passive: false });
        document.addEventListener('touchend', stopResize);
    }
    
    function doResize(e) {
        if (!isResizing) return;
        e.preventDefault();
        
        // Get current position (handle both mouse and touch)
        const currentX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
        
        // Calculate new width (dragging left increases width since panel is on the right)
        const deltaX = startX - currentX;
        let newWidth = startWidth + deltaX;
        
        // Clamp to min/max
        newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
        
        // Apply new width
        slideout.style.width = `${newWidth}px`;
    }
    
    function stopResize() {
        if (!isResizing) return;
        isResizing = false;
        
        // Remove resizing class
        slideout.classList.remove('resizing');
        resizeHandle.classList.remove('active');
        
        // Restore body styles
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        
        // Remove listeners
        document.removeEventListener('mousemove', doResize);
        document.removeEventListener('mouseup', stopResize);
        document.removeEventListener('touchmove', doResize);
        document.removeEventListener('touchend', stopResize);
        
        // Save the width to localStorage for persistence
        const slideoutId = slideout.id;
        if (slideoutId) {
            localStorage.setItem(`${slideoutId}Width`, slideout.style.width);
        }
    }
    
    // Restore saved width on page load
    const savedWidth = localStorage.getItem(`${slideout.id}Width`);
    if (savedWidth) {
        slideout.style.width = savedWidth;
    }
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
        
        // CRITICAL: Update originalNotebookJson so snapshot saves include this cell
        updateOriginalNotebookWithCell('response', newResponse);
        
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
        
        // CRITICAL: Update originalNotebookJson so snapshot saves include this cell
        updateOriginalNotebookWithCell('response', newResponse);
        
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
        
        // CRITICAL: Update originalNotebookJson so snapshot saves include this cell
        updateOriginalNotebookWithCell('response', newResponse);
        
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
    
    // Initialize multi-turn listeners
    initMultiTurnListeners();
    
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
    
    // Helper function to extract model key for comparison
    const getModelKey = (modelStr) => {
        const lower = (modelStr || '').toLowerCase();
        if (lower.includes('nemotron')) return 'nemotron';
        if (lower.includes('qwen')) return 'qwen';
        if (lower.includes('llama')) return 'llama';
        if (lower.includes('deepseek')) return 'deepseek';
        if (lower.includes('mistral')) return 'mistral';
        if (lower.includes('gpt')) return 'gpt';
        if (lower.includes('claude')) return 'claude';
        if (lower.includes('gemini')) return 'gemini';
        return lower.replace(/[^a-z0-9]/g, '');
    };
    
    // Check if metadata specifies a model (for disabling non-matching options)
    const metadataModelKey = state.metadataModel ? getModelKey(state.metadataModel) : null;
    
    // Add new options
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        
        // Check if this model matches the metadata model
        const modelKey = getModelKey(model.id);
        const matchesMetadata = !metadataModelKey || modelKey === metadataModelKey;
        
        // DISABLE non-matching models if metadata specifies a model
        if (metadataModelKey && !matchesMetadata) {
            option.disabled = true;
            option.textContent = `${model.name} 🔒`;
            option.title = `Notebook requires ${state.metadataModel} model. This model is disabled.`;
            option.style.color = 'var(--text-muted)';
        }
        
        // Only set default selection if skipDefaultSelection is false
        if (!skipDefaultSelection) {
            if (model.id === defaultModelId || (models.length > 0 && model.id.includes('qwen'))) {
                // Only select if it matches metadata (or no metadata model)
                if (matchesMetadata) {
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
    
    // Log for debugging
    if (metadataModelKey) {
        console.log(`Updated models for provider: ${provider}, metadata model: ${state.metadataModel} (key: ${metadataModelKey})`);
        console.log(`  Non-matching models are DISABLED`);
    } else {
        console.log(`Updated models for provider: ${provider}, no metadata model restriction`);
    }
    console.log(`  Selected: ${elements.modelSelect.value} (skipDefault: ${skipDefaultSelection})`);
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
    
    // Upload section toggle (collapse/expand)
    const uploadToggle = document.getElementById('uploadToggleHeader');
    if (uploadToggle) {
        uploadToggle.addEventListener('click', () => {
            const body = document.getElementById('uploadBody');
            const chevron = document.getElementById('uploadChevron');
            if (body && chevron) {
                body.classList.toggle('collapsed');
                chevron.classList.toggle('collapsed');
            }
        });
    }
});
