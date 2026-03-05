/**
 * Model Hunter - Configuration & Constants
 *
 * Static values are defaults. Call fetchConfigFromAPI() to merge with server config.
 */

export const VERSION_CHECK_INTERVAL = 30000;

/** Cached config from /api/config (null until fetched) */
let _apiConfig = null;

/**
 * Fetch config from /api/config and merge with static defaults.
 * Returns merged config. Caches result.
 */
export async function fetchConfigFromAPI() {
    if (_apiConfig) return _apiConfig;
    try {
        const r = await fetch('/api/config');
        if (r.ok) _apiConfig = await r.json();
    } catch (_) {}
    return _apiConfig || {};
}

/**
 * Get value: from API config if fetched, else static default.
 */
export function getConfigValue(key, staticDefault) {
    if (_apiConfig?.app?.[key] !== undefined) return _apiConfig.app[key];
    if (_apiConfig?.hunt?.[key] !== undefined) return _apiConfig.hunt[key];
    if (_apiConfig?.features?.[key] !== undefined) return _apiConfig.features[key];
    return staticDefault;
}

/**
 * Check whether a specific admin bypass toggle is ON in server config.
 * Usage: `state.adminMode && adminBypass('hunt_limit')`
 * Returns true if the key is missing (default = bypass when admin).
 */
export function adminBypass(bypassKey) {
    const bypassMap = _apiConfig?.app?.admin_bypass;
    if (!bypassMap || typeof bypassMap !== 'object') return true;
    return bypassMap[bypassKey] !== false;
}

/** Static fallback when global.yaml hunt.provider_models is not set. Prefer getProviderModels() after fetchConfigFromAPI(). */
export const PROVIDER_MODELS = {
    'openrouter': [
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
        { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5' },
        { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
        { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
        { id: 'openai/gpt-5.2-pro', name: 'GPT 5.2 Pro' },
        { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)' },
        { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron-3-Nano (Fast)' },
        { id: 'qwen/qwen3-235b-a22b-thinking-2507', name: 'Qwen3-235B (Thinking)' },
    ],
    'fireworks': [
        { id: 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507', name: 'Qwen3-235B (Thinking)' }
    ]
};

/** Judge models fallback when global.yaml hunt.judge_models is not set. */
const JUDGE_MODELS_FALLBACK = [
    { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
    { id: 'openai/gpt-5.2-pro', name: 'GPT 5.2 Pro' },
    { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' }
];

/** Provider model list for trainer "Model" dropdown. From global.yaml hunt.provider_models when available. */
export function getProviderModels() {
    const fromConfig = _apiConfig?.hunt?.provider_models;
    if (fromConfig && typeof fromConfig === 'object') return fromConfig;
    return PROVIDER_MODELS;
}

/** Judge model list for trainer "Evaluation Model" dropdown. From global.yaml hunt.judge_models when available.
 * Config can be provider-keyed (judge_models.openrouter) or a flat array. Pass provider for keyed config. */
export function getJudgeModels(provider = 'openrouter') {
    const fromConfig = _apiConfig?.hunt?.judge_models;
    if (!fromConfig || typeof fromConfig !== 'object') return JUDGE_MODELS_FALLBACK;
    // Provider-keyed: { openrouter: [...], fireworks: [...] }
    if (!Array.isArray(fromConfig)) {
        const list = fromConfig[provider] || fromConfig['openrouter'] || [];
        return Array.isArray(list) && list.length > 0 ? list : JUDGE_MODELS_FALLBACK;
    }
    return fromConfig.length > 0 ? fromConfig : JUDGE_MODELS_FALLBACK;
}

export const MAX_HUNTS_PER_NOTEBOOK = 16;

/** Admin mode password — must be set server-side via ADMIN_MODE_PASSWORD env var. */
export const ADMIN_MODE_PASSWORD = '';
export const HUNT_COUNT_STORAGE_PREFIX = 'modelHunter_huntCount_';
export const TIPS_PAUSED_KEY = 'modelHunter_tipsPaused';
export const MIN_EXPLANATION_WORDS = 10;

export const TURN_COLORS = [
    '#2383e2',  // Turn 1: Blue (Notion)
    '#9065e0',  // Turn 2: Purple
    '#e8a441',  // Turn 3: Amber
    '#eb5757',  // Turn 4: Red
    '#4dab9a',  // Turn 5: Teal
    '#3b82f6',  // Turn 6: Blue alt
];

export const INSIGHT_TIPS = {
    // Config / pre-hunt tips
    config: [
        { text: '<strong>More criteria = more breaks.</strong> Tasks with 8+ criteria break models nearly twice as often as tasks with 3.', icon: '💡' },
        { text: '<strong>Format-specific criteria are the most effective.</strong> Requiring exact word placement, bullet counts, or bold/italic formatting trips models up consistently.', icon: '✨' },
        { text: 'Don\'t worry if the first few hunts pass — the average break rate is about 1 in 4. Keep going.', icon: '📊' },
        { text: '<strong>Specificity matters.</strong> Vague criteria like "good response" rarely break models. Precise, measurable criteria do.', icon: '🎯' },
        { text: 'Try combining factual accuracy criteria with strict formatting requirements — models struggle to satisfy both simultaneously.', icon: '💡' },
    ],
    // Model-specific tips
    nemotron: [
        { text: 'Nemotron has a lower break rate (24%). It\'s faster but more resilient — focus on strict formatting and structured output criteria.', icon: '🤖' },
        { text: 'Nemotron struggles most with multi-step instructions. Try criteria that require a specific sequence of actions.', icon: '🔍' },
    ],
    qwen: [
        { text: 'Qwen has a higher break rate (30%) but is slower. It\'s weaker on character-level precision — try exact word count or position requirements.', icon: '🤖' },
        { text: 'Qwen\'s reasoning is strong but its output formatting is exploitable. Use criteria that demand precise structure.', icon: '🔍' },
    ],
    // During hunting
    hunting: [
        { text: 'The judge evaluates each criterion independently. A response can pass 4 out of 5 criteria and still break on the last one.', icon: '⏳' },
        { text: 'Each hunt is a fresh generation — the model doesn\'t remember previous attempts. Every try is independent.', icon: '🔬' },
        { text: 'If you\'re getting all passes, consider tightening your criteria wording or adding a formatting constraint.', icon: '📈' },
    ],
    // Post-hunt / results
    results: [
        { text: 'Look at which specific criteria failed. This tells you the model\'s weak point — double down on it in the next turn.', icon: '🔎' },
        { text: 'If no breaks were found, try rephrasing one criterion to be more specific rather than adding entirely new ones.', icon: '🎯' },
        { text: '<strong>Quality over quantity.</strong> 3–4 well-written criteria that target specific weaknesses outperform 10 generic ones.', icon: '🏆' },
    ],
    // Selection tips
    selection: [
        { text: 'Pick responses where the model <strong>confidently gave wrong output</strong> — these are the most valuable for training.', icon: '✅' },
        { text: 'A mix of <strong>3 breaking + 1 passing</strong> gives reviewers contrast to see exactly where the model\'s boundary is.', icon: '⚖️' },
    ],
    // Multi-turn decision
    multiTurn: [
        { text: 'Refining your prompt across turns often uncovers <strong>deeper model weaknesses</strong> than repeating the same one.', icon: '💡' },
        { text: 'In the next turn, try adding a formatting criterion if you haven\'t — it\'s the most common way to find breaks.', icon: '✨' },
        { text: 'Review which criteria passed in this turn. The ones that barely passed are good targets to make stricter.', icon: '📊' },
    ],
    // Summary / final
    summary: [
        { text: 'Great work! Every break you find helps improve the model\'s safety and reliability.', icon: '🎉', type: 'success' },
        { text: 'Consider trying a different model next time — each model has different blind spots.', icon: '🤖' },
        { text: 'The most effective trainers iterate on their criteria between turns rather than changing prompts entirely.', icon: '🧭' },
    ],
};
