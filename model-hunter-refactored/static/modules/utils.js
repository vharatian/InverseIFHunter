/**
 * Model Hunter - Utility Functions
 */

import { 
    MIN_EXPLANATION_WORDS, 
    TURN_COLORS, 
    PROVIDER_MODELS, 
    INSIGHT_TIPS,
    HUNT_COUNT_STORAGE_PREFIX
} from './config.js';

export function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

export function countWords(text) {
    return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

export function getWordCountLabel(words) {
    return `Words: ${words} (minimum ${MIN_EXPLANATION_WORDS} required)`;
}

export function getExplanationValidationError(notes) {
    const wordCount = countWords(notes);
    if (wordCount < MIN_EXPLANATION_WORDS) {
        return `Explanation must be at least ${MIN_EXPLANATION_WORDS} words (currently ${wordCount})`;
    }
    return null;
}

export function getIncompleteReviewIssues(reviews) {
    const list = [];
    for (let i = 0; i < reviews.length; i++) {
        const review = reviews[i];
        const reviewNum = i + 1;
        const issues = [];
        const gradingBasis = review.grading_basis || {};
        const gradedCriteria = Object.keys(gradingBasis).filter(k =>
            gradingBasis[k] && (gradingBasis[k].toUpperCase() === 'PASS' || gradingBasis[k].toUpperCase() === 'FAIL')
        );
        if (gradedCriteria.length === 0) issues.push('missing criteria grading');
        const explanation = (review.explanation || '').trim();
        const words = countWords(review.explanation || '');
        if (!explanation) issues.push('missing explanation');
        else if (words < MIN_EXPLANATION_WORDS) issues.push(`explanation too short (minimum ${MIN_EXPLANATION_WORDS} words required)`);
        if (issues.length > 0) list.push(`Slot ${reviewNum}: ${issues.join(', ')}`);
    }
    return list;
}

export function getIncompleteReviewsModalMessage(incompleteList) {
    return `Each review needs criteria grades (PASS/FAIL for each criterion) and an explanation of at least ${MIN_EXPLANATION_WORDS} words.\n\nIncomplete: ${incompleteList.join('; ')}`;
}

export function getTurnColor(turnNumber) {
    return TURN_COLORS[(turnNumber - 1) % TURN_COLORS.length];
}

export function getTurnColorClass(turnNumber) {
    const idx = ((turnNumber - 1) % TURN_COLORS.length) + 1;
    return `turn-color-${idx}`;
}

export function getModelKey(modelStr) {
    if (!modelStr) return null;
    const lower = modelStr.toLowerCase();
    if (lower.includes('nemotron')) return 'nemotron';
    if (lower.includes('qwen')) return 'qwen';
    if (lower.includes('sonnet')) return 'sonnet';
    if (lower.includes('opus')) return 'opus';
    return null;
}

export function getModelDisplayName(modelId) {
    if (!modelId) return 'Unknown';
    for (const list of Object.values(PROVIDER_MODELS)) {
        const found = list.find(m => m.id === modelId);
        if (found) return found.name;
    }
    const lastPart = modelId.split('/').pop() || modelId;
    if (lastPart.startsWith('claude-')) {
        const rest = lastPart.replace(/^claude-/, '');
        return 'Claude ' + rest.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
    }
    return lastPart;
}

export function getJudgeScore(result) {
    return result.judge_score ?? result.score ?? null;
}

export function isBreakingResult(result) {
    const score = getJudgeScore(result);
    return result.is_breaking || score === 0;
}

export function getRandomTip(category, model) {
    // Try model-specific tips for config/hunting categories
    if (model && (category === 'config' || category === 'hunting')) {
        const modelKey = getModelKey(model);
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
 */
export function renderInsightTip(containerId, category, options = {}) {
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
export function startTipRotation(containerId, category, intervalMs = 15000, options = {}) {
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

// Hunt Limit Helpers (LocalStorage only)
function getHuntCountKey(notebookId) {
    return `${HUNT_COUNT_STORAGE_PREFIX}${notebookId || 'unknown'}`;
}

export function loadHuntCount(notebookId) {
    if (!notebookId) return 0;
    const key = getHuntCountKey(notebookId);
    const stored = localStorage.getItem(key);
    return stored ? parseInt(stored, 10) : 0;
}

export function saveHuntCount(notebookId, count) {
    if (!notebookId) return;
    const key = getHuntCountKey(notebookId);
    localStorage.setItem(key, count.toString());
}

export function clearHuntCount(notebookId) {
    if (!notebookId) return;
    const key = getHuntCountKey(notebookId);
    localStorage.removeItem(key);
}

// ============== P7: Error Handling UX ==============

/**
 * Map raw errors to user-friendly messages with Optional hints.
 * @param {Error|string} error - The caught error
 * @param {{ operation?: string, status?: number }} [context] - Optional context
 * @returns {{ message: string, hint?: string, canRetry: boolean }}
 */
export function getUserFriendlyError(error, context = {}) {
    const msg = (error && (error.message || String(error))) || 'Something went wrong';
    const msgLower = msg.toLowerCase();
    const { operation = 'operation', status } = context;

    // Network / connection errors
    if (msgLower.includes('failed to fetch') || msgLower.includes('networkerror') ||
        msgLower.includes('network request failed') || msgLower.includes('load failed')) {
        return {
            message: 'Connection failed. Check your internet connection.',
            hint: 'If the problem persists, the server may be down. Try again in a moment.',
            canRetry: true
        };
    }

    // Timeout
    if (msgLower.includes('timeout') || msgLower.includes('timed out') || msgLower.includes('aborted')) {
        return {
            message: 'Request timed out. The server may be busy.',
            hint: 'Try again in a moment.',
            canRetry: true
        };
    }

    // HTTP status-based (when status is passed from response)
    if (status === 401 || status === 403 || msgLower.includes('unauthorized') || msgLower.includes('forbidden')) {
        return {
            message: 'Session expired or access denied.',
            hint: 'Please reload the notebook to continue.',
            canRetry: false
        };
    }
    if (status === 404 || msgLower.includes('not found')) {
        return {
            message: 'Session not found. It may have expired.',
            hint: 'Please reload the notebook from the Colab URL.',
            canRetry: false
        };
    }
    if (status >= 500 || msgLower.includes('internal server error') || msgLower.includes('502') || msgLower.includes('503')) {
        return {
            message: 'Server error. Please try again in a moment.',
            hint: 'The server is temporarily unavailable.',
            canRetry: true
        };
    }

    // Session / reload hints
    if (msgLower.includes('session expired') || msgLower.includes('reload')) {
        return { message: msg, hint: 'Reload the notebook from the Colab URL.', canRetry: false };
    }

    // JSON / parse errors
    if (msgLower.includes('json') || msgLower.includes('parse') || msgLower.includes('unexpected token')) {
        return {
            message: 'Invalid response from server.',
            hint: 'Try again. If it persists, reload the notebook.',
            canRetry: true
        };
    }

    // Validation errors (keep message, add hint for common cases)
    if (msgLower.includes('criteria') || msgLower.includes('response_reference')) {
        return { message: msg, hint: 'Ensure Model Reference is valid JSON with id and criteria fields.', canRetry: false };
    }

    // Generic: use message if it's user-friendly (short, no stack), else generic
    const isTechnical = msg.includes('at ') || msg.includes('Error:') || msg.length > 80;
    if (isTechnical) {
        return {
            message: `${operation} failed.`,
            hint: 'Try again. If it persists, reload the notebook.',
            canRetry: true
        };
    }

    return { message: msg, canRetry: true };
}
