/**
 * Session hydrator — loads full session state from Redis and populates the trainer UI.
 *
 * Called when a trainer clicks a task from the queue. Replaces the old
 * "please reload the notebook URL" toast with full hydration.
 */
import { state } from './state.js';
import { elements } from './dom.js';
import { escapeHtml } from './utils.js';
import { adminBypass, getSelectionSlots, getHuntModeById } from './config.js';
import { refreshReviewSync } from './reviewSync.js';
import { populatePreviewTabs, parseCriteria, validateModelReferenceAndCriteria } from './notebook.js';
import {
    displaySelectionCards,
    displaySelectedForReview,
    updateReviewProgress,
    collapseSelectionSectionCard,
    disableSelectionCheckboxes,
} from './results.js';
import { syncHuntModeFromConfig } from './hunt.js';
import { resetTestbed, showTestbed } from './testbed.js';

/**
 * Fetch full session state from backend and hydrate the UI.
 * @param {string} sessionId
 * @returns {Promise<{ok: boolean, reviewStatus: string, revisionFlags: string[]}>}
 */
export async function hydrateSession(sessionId) {
    const res = await fetch(`/api/session/${sessionId}/full-state`, { cache: 'no-store' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Failed to load session (${res.status})`);
    }
    const data = await res.json();

    if (!data || typeof data !== 'object') {
        throw new Error('Server returned empty session data');
    }

    // Populate state
    state.sessionId = sessionId;
    state.notebook = data.notebook || {};
    if (data.colab_url) state.notebook.url = data.colab_url;
    state.originalNotebookJson = data.notebook ? JSON.stringify(data.notebook) : null;
    state.config = _mergeConfig(data.config);
    state.humanReviews = data.human_reviews || {};
    state.allResponses = data.all_results || [];
    state.results = data.results || [];
    state.conversationHistory = data.conversation_history || [];
    state.turns = data.turns || [];
    state.currentTurn = data.meta?.current_turn || 1;
    state.isMultiTurn = (state.currentTurn > 1 || state.turns.length > 0);

    // Persist to localStorage
    localStorage.setItem('modelHunter_sessionId', sessionId);

    // Hydrate DOM sections — each guard against missing data internally
    _hydrateNotebookSection(data.notebook);
    _hydrateResultsSection(data.all_results || []);
    _hydrateReviewsSection(data.human_reviews || {});
    _hydrateMetaInfo(data);

    // Restore section visibility based on hydrated state
    _restoreSectionVisibility();

    // Sync "Find Breaking Responses" button: if session has hunt results, treat reference as already validated
    const hasResults = (data.results && data.results.length > 0) || (data.all_results && data.all_results.length > 0);
    if (hasResults && state.modelRefValid) {
        state.referenceValidated = true;
    }
    const responseRef = typeof data.notebook?.response_reference === 'string'
        ? data.notebook.response_reference
        : (data.notebook?.response_reference ? JSON.stringify(data.notebook.response_reference) : '');
    validateModelReferenceAndCriteria(responseRef);

    // Reviewer feedback for review sync block and per-slot display
    state.reviewFeedback = data.feedback || null;

    // Revision flags from reviewer feedback
    const revisionFlags = Array.isArray(data.feedback?.revision_flags)
        ? data.feedback.revision_flags : [];
    if (revisionFlags.length > 0) {
        _applySectionLocks(revisionFlags, data.feedback || null);
    }

    // Refresh review sync block
    refreshReviewSync(sessionId);

    return {
        ok: true,
        reviewStatus: data.review_status || 'draft',
        revisionFlags,
    };
}


function _mergeConfig(serverConfig) {
    if (!serverConfig || typeof serverConfig !== 'object') return state.config;
    return {
        ...state.config,
        parallel_workers: serverConfig.parallel_workers ?? state.config.parallel_workers,
        target_breaks: serverConfig.target_breaks ?? state.config.target_breaks,
        models: serverConfig.models ?? state.config.models,
        reasoning_budget_percent: serverConfig.reasoning_budget_percent ?? state.config.reasoning_budget_percent,
        max_retries: serverConfig.max_retries ?? state.config.max_retries,
        judge_model: serverConfig.judge_model ?? state.config.judge_model,
        custom_judge_system_prompt: serverConfig.custom_judge_system_prompt ?? state.config.custom_judge_system_prompt,
        pass_threshold: serverConfig.pass_threshold ?? state.config.pass_threshold ?? 0.5,
        passing_mode: serverConfig.passing_mode ?? state.config.passing_mode ?? false,
        hunt_mode: serverConfig.hunt_mode ?? state.config.hunt_mode ?? 'break_50',
    };
}


function _hydrateNotebookSection(notebook) {
    if (!notebook) return;

    const metadata = notebook.metadata || {};
    state.metadata = metadata;

    // Populate markdown editors and preview tabs (prompt, response, criteria, judge)
    populatePreviewTabs(notebook);

    // Populate metadata sidebar
    _populateMetadataSidebar(metadata);

    // Populate criteria
    if (notebook.response_reference) {
        try {
            const parsed = parseCriteria(
                typeof notebook.response_reference === 'string'
                    ? notebook.response_reference
                    : JSON.stringify(notebook.response_reference)
            );
            if (parsed?.length) {
                state.criteria = parsed;
                state.initialCriteria = parsed;
            }
        } catch { /* ignore parse errors */ }
    }
}


/**
 * Show/hide UI sections to match the hydrated state.
 * Replicates the section transitions that normally happen during interactive use.
 */
function _restoreSectionVisibility() {
    // 1. Collapse upload section — notebook is already loaded
    if (state.notebook) {
        const uploadBody = document.getElementById('uploadBody');
        const uploadChevron = document.getElementById('uploadChevron');
        const uploadHeaderText = document.getElementById('uploadHeaderText');
        if (uploadBody) uploadBody.classList.add('collapsed');
        if (uploadChevron) uploadChevron.classList.add('collapsed');
        if (uploadHeaderText) uploadHeaderText.textContent = 'Notebook Loaded';

        // Show config section (prompt, criteria, hunt config)
        if (elements.configSection) elements.configSection.classList.remove('hidden');
        syncHuntModeFromConfig();

        // Auto-open Testbed when no hunt results exist (user is still in editing phase)
        if (state.allResponses.length === 0) {
            resetTestbed();
            showTestbed();
        }
    }

    // 2. If hunt results exist, show selection section
    if (state.allResponses.length > 0) {
        if (elements.selectionSection) {
            elements.selectionSection.classList.remove('hidden');
            displaySelectionCards();
        }
    }

    // 3. If 4 selections confirmed, show the review results section
    if (state.selectionConfirmed && state.selectedRowNumbers.length === 4) {
        if (elements.resultsSection) elements.resultsSection.classList.remove('hidden');
        displaySelectedForReview();
        updateReviewProgress();

        // Collapse selection section (it's locked now)
        collapseSelectionSectionCard(state.selectedRowNumbers.length);
        disableSelectionCheckboxes();
    }
}


function _populateMetadataSidebar(metadata) {
    if (!metadata || typeof metadata !== 'object') return;
    const sidebar = document.getElementById('metadataSidebar');
    if (!sidebar) return;

    const fields = [
        { key: 'Task ID', el: 'metaTaskId' },
        { key: 'Domain', el: 'metaDomain' },
        { key: 'Use Case', el: 'metaUseCase' },
        { key: 'L1 Taxonomy', el: 'metaTaxonomy' },
        { key: 'Model', el: 'metaModel' },
    ];
    for (const f of fields) {
        const el = document.getElementById(f.el);
        if (el) el.textContent = metadata[f.key] || '';
    }
    sidebar.style.display = '';
}


function _hydrateResultsSection(allResults) {
    if (!allResults || allResults.length === 0) return;

    state.allResponses = allResults;
    state.totalHuntsCount = allResults.length;

    // Build hunt_id → array index lookup so we can map huntId-keyed reviews
    // back to row numbers. Backend auto-save stores reviews with huntId keys
    // (e.g. "1", "2") while the frontend uses row_N keys (e.g. "row_0").
    const huntIdToIndex = {};
    allResults.forEach((r, i) => {
        if (r.hunt_id !== undefined && r.hunt_id !== null) {
            huntIdToIndex[String(r.hunt_id)] = i;
        }
    });

    const selectedRows = new Set();
    const reviews = state.humanReviews || {};
    const normalizedReviews = {};

    for (const [key, val] of Object.entries(reviews)) {
        if (!val || typeof val !== 'object') {
            normalizedReviews[key] = val;
            continue;
        }

        // Preferred: row_N key with review data
        if (key.startsWith('row_')) {
            const rowNum = parseInt(key.replace('row_', ''), 10);
            if (!isNaN(rowNum) && (val.hunt_id !== undefined || val.judgment !== undefined)) {
                selectedRows.add(rowNum);
            }
            normalizedReviews[key] = val;
            continue;
        }

        // Fallback: huntId key from auto-save — map back to row index
        if (val.judgment !== undefined || val.grading_basis) {
            let rowIdx = val.row_number;
            if (rowIdx === undefined || rowIdx === null) {
                rowIdx = huntIdToIndex[key];
            }
            if (rowIdx !== undefined && rowIdx !== null) {
                selectedRows.add(rowIdx);
                // Normalize to row_N format so downstream functions work
                const rowKey = `row_${rowIdx}`;
                if (!normalizedReviews[rowKey]) {
                    normalizedReviews[rowKey] = { ...val, hunt_id: val.hunt_id ?? parseInt(key, 10), row_number: rowIdx };
                }
            }
            normalizedReviews[key] = val;
            continue;
        }

        normalizedReviews[key] = val;
    }

    state.humanReviews = normalizedReviews;
    state.selectedRowNumbers = [...selectedRows].sort((a, b) => a - b);
    const hydrateMode = getHuntModeById(state.config?.hunt_mode || 'break_50');
    const hydrateSlots = getSelectionSlots();
    const hydrateMinBreaking = state.config?.min_breaking_required ?? 0;
    const hydrateRequired = (hydrateMode.type === 'passing' || hydrateMode.count_based || hydrateMinBreaking === 0)
        ? 1 : hydrateSlots;
    if (state.selectedRowNumbers.length >= hydrateRequired) {
        state.selectionConfirmed = true;
    }

    // Populate hunt response data map
    allResults.forEach((r, i) => {
        state.huntResponseData[i] = {
            model: r.model_id || r.model || '',
            status: r.status || '',
            score: r.judge_score ?? r.score ?? null,
            response: r.response || r.model_response || '',
        };
    });
}


function _hydrateReviewsSection(reviews) {
    if (!reviews || typeof reviews !== 'object') return;
    state.humanReviews = reviews;
}


function _hydrateMetaInfo(data) {
    const statusBanner = document.getElementById('reviewSyncStatus');
    if (statusBanner) {
        const round = data.review_round || 0;
        const max = data.max_rounds || 5;
        const roundInfo = round > 0 ? ` (Round ${round} of ${max})` : '';
        statusBanner.textContent = `Review status: ${data.review_status || 'draft'}${roundInfo}`;
    }
}


/** Revision flags that refer only to judgement (selection, grades, explanations, QC). When all flags are in this set, prompt/model ref/judge are locked. */
const JUDGEMENT_ONLY_FLAGS = new Set([
    'selection', 'qc',
    'slot_1_grade', 'slot_1_explanation', 'slot_2_grade', 'slot_2_explanation',
    'slot_3_grade', 'slot_3_explanation', 'slot_4_grade', 'slot_4_explanation'
]);

/**
 * Lock sections that are NOT in the revision_flags list.
 * Unlocked sections: those the reviewer flagged for revision.
 * @param {string[]} flags - e.g. ["slot_2_grade", "slot_3_explanation", "selection"]
 * @param {object} [feedback] - Reviewer feedback (for prompt_feedback, model_reference_feedback, judge_system_prompt_feedback when config is locked)
 */
function _applySectionLocks(flags, feedback) {
    const flagSet = new Set(flags);

    // Selection section
    const selectionSection = document.getElementById('selectionSection');
    if (selectionSection) {
        const locked = !flagSet.has('selection');
        _setLocked(selectionSection, locked);
    }

    // Per-slot grade and explanation sections
    for (let i = 1; i <= 4; i++) {
        const gradeSection = document.getElementById(`slot${i}GradeSection`) ||
            document.querySelector(`[data-slot="${i}"] .grading-section`);
        if (gradeSection) {
            _setLocked(gradeSection, !flagSet.has(`slot_${i}_grade`));
        }

        const explSection = document.getElementById(`slot${i}ExplanationSection`) ||
            document.querySelector(`[data-slot="${i}"] .explanation-section`);
        if (explSection) {
            _setLocked(explSection, !flagSet.has(`slot_${i}_explanation`));
        }
    }

    // QC section
    const qcSection = document.getElementById('qcSection') || document.getElementById('qualityCheckSection');
    if (qcSection) {
        _setLocked(qcSection, !flagSet.has('qc'));
    }

    // When only judgement is flagged, lock prompt / model reference / judge
    // Admin bypass: skip section locks entirely
    const isJudgementOnly = flags.length > 0 && flags.every(f => JUDGEMENT_ONLY_FLAGS.has(f));
    if (isJudgementOnly && feedback && typeof feedback === 'object' && !(state.adminMode && adminBypass('section_locks'))) {
        _lockConfigSectionsAndShowFeedback(feedback);
    } else {
        _unlockConfigSections();
    }
}

/**
 * Lock notebook-editing sections and store reviewer feedback in state.
 * Old preview card panels have been removed — the Testbed reads feedback from state.
 */
function _lockConfigSectionsAndShowFeedback(feedback) {
    state._reviewerConfigFeedback = {
        prompt: (feedback.prompt_feedback || '').trim(),
        modelRef: (feedback.model_reference_feedback || '').trim(),
        judge: (feedback.judge_system_prompt_feedback || '').trim(),
    };
}

function _unlockConfigSections() {
    state._reviewerConfigFeedback = null;
}

function _setLocked(element, locked) {
    if (!element) return;
    if (locked) {
        element.classList.add('section-locked');
        element.querySelectorAll('input, textarea, select, button').forEach(el => {
            if (!el.classList.contains('section-lock-bypass')) {
                el.disabled = true;
            }
        });
        if (!element.querySelector('.lock-indicator')) {
            const indicator = document.createElement('div');
            indicator.className = 'lock-indicator';
            indicator.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Locked — not flagged for revision';
            element.prepend(indicator);
        }
    } else {
        element.classList.remove('section-locked');
        element.querySelectorAll('input, textarea, select, button').forEach(el => {
            el.disabled = false;
        });
        const indicator = element.querySelector('.lock-indicator');
        if (indicator) indicator.remove();
    }
}


/**
 * Apply section locks from revision flags and feedback (e.g. when poll returns "returned" status).
 * Call from reviewSync so locks apply without full re-hydration.
 * @param {string[]} revisionFlags
 * @param {object} [feedback]
 */
export function applySectionLocksFromFeedback(revisionFlags, feedback) {
    if (Array.isArray(revisionFlags) && revisionFlags.length > 0) {
        _applySectionLocks(revisionFlags, feedback || null);
    } else {
        _unlockConfigSections();
    }
}

/**
 * Remove all section locks (called when moving to a new task or draft).
 */
export function clearSectionLocks() {
    document.querySelectorAll('.section-locked').forEach(el => {
        _setLocked(el, false);
    });
    _unlockConfigSections();
}
