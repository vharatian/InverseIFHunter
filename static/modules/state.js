/**
 * Model Hunter - Application State
 * @module state
 * 
 * Central mutable state object and helpers.
 * All properties are read/written directly by legacy app.js via window.state.
 */

/**
 * The single source of truth for frontend application state.
 * Exposed to window.state by the module bridge in index.html.
 */
export const state = {
    sessionId: null,
    notebook: null,
    referenceValidated: false,  // Must pass reference judge before hunt
    criteria: null,              // Current criteria from response_reference
    initialCriteria: null,       // Original criteria when notebook was first loaded (NEVER overwrite)
    config: {
        parallel_workers: 4,
        target_breaks: 4,
        pass_threshold: 0.5,
        passing_mode: false,
        hunt_mode: 'break_50',
        models: ['qwen/qwen3-235b-a22b-thinking-2507'],
        reasoning_budget_percent: 0.9,
        max_retries: 3,
        judge_model: 'openai/gpt-5.2',
        custom_judge_system_prompt: null
    },
    results: [],
    isHunting: false,
    humanReviews: {},  // Explicit init
    
    // Response selection state
    allResponses: [],       // All hunt responses (accumulated across runs)
    selectedRowNumbers: [], // Row numbers (0-based indices) of 4 selected hunts for review
    llmRevealed: false,     // Whether LLM judgments have been revealed

    // Criteria alignment gate (pre-reveal); see alignment.js
    alignmentPhase: 'idle', // idle = not yet verified via Refresh alignment; passed / re_review after check
    alignmentReReviewRounds: 0,
    alignmentFlaggedRowNumber: null,
    alignmentLastSnapshot: null,
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
    selectionSectionCollapsed: true,  // Select Responses for Review section collapsed (auto-collapsed when selection confirmed)

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
    
    // Admin mode (testing only: 5-click Task ID + password)
    adminMode: false,
    
    // Multi-turn state
    currentTurn: 1,
    conversationHistory: [],  // [{role: "user", content: ...}, {role: "assistant", content: ...}]
    turns: [],                // [{turnNumber, prompt, criteria, selectedResponse, ...}]
    isMultiTurn: false,       // Activates when trainer advances to turn 2
    multiTurnTotalHunts: 0,   // Total hunts across all turns
    huntsThisTurn: 0,         // Hunts in the CURRENT turn (resets on new turn)
    previousTurnHuntIds: new Set(),  // hunt_ids from completed turns (excluded from current turn fetch)

    // Reviewer feedback (overall + section_feedback) — set by sessionHydrator and reviewSync
    reviewFeedback: null
};


/**
 * Reset all turn-level state. Called when advancing to a new turn.
 * NOTE: totalHuntsCount and currentRunStartOffset are NOT reset here.
 * They track the global accumulated count (for unique hunt IDs across turns).
 * Only huntsThisTurn is reset (for per-turn limit enforcement).
 */
export function resetTurnState() {
    state.allResponses = [];
    state.results = [];
    state.selectedRowNumbers = [];
    state.humanReviews = {};
    state.selectionConfirmed = false;
    state.llmRevealed = false;
    state.alignmentPhase = 'idle';
    state.alignmentReReviewRounds = 0;
    state.alignmentFlaggedRowNumber = null;
    state.alignmentLastSnapshot = null;
    state.referenceValidated = false;
    state._selectedGoodResponse = null;
    state.huntsThisTurn = 0;
    state.huntLimitReached = false;
}


/**
 * Compute cumulative hunt statistics across ALL completed turns + current turn.
 * Returns { totalHunts, totalBreaks }
 * 
 * Uses sample_label / is_breaking (set by classify_sample) — never raw scores.
 * MISSING criteria → sample_label "ERROR" → not counted as break.
 */
export function getCumulativeStats() {
    let prevHunts = 0;
    let prevBreaks = 0;
    if (state.turns && state.turns.length > 0) {
        state.turns.forEach(t => {
            const results = t.results || [];
            prevHunts += t.huntCount || results.length;
            prevBreaks += results.filter(r => {
                if (r.sample_label) return r.sample_label === 'BREAK';
                return r.is_breaking === true;
            }).length;
        });
    }

    const currentHunts = state.huntsThisTurn || state.allResponses.length;
    const currentBreaks = state.allResponses.filter(r => {
        if (r.sample_label) return r.sample_label === 'BREAK';
        return r.is_breaking === true;
    }).length;

    return {
        totalHunts: prevHunts + currentHunts,
        totalBreaks: prevBreaks + currentBreaks
    };
}
