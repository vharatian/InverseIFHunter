import { elements } from '../dom.js';
import { state } from '../state.js';
import { getProviderModels } from '../config.js';
import { clearHuntCount, getModelDisplayName, renderInsightTip } from '../utils.js';
import { showToast } from '../celebrations.js?v=43';
import { clearPreviousResults, warmupConnections } from '../results.js';
import { resetHuntTiming, unlockHuntMode, updateHuntLimitUI } from '../hunt.js';
import { startHeartbeat } from '../auth.js';
import { updateModelOptions, validateModelMatch } from '../editors.js';
import { populatePreviewTabs } from './metadata-ui.js';

export async function handleNotebookLoaded(data, isUrl = false, overrideUrl = null) {
    clearPreviousResults();

    import('../testbed.js').then(({ resetTestbed, hideTestbed, showTestbed }) => {
        hideTestbed();
        resetTestbed();
        showTestbed();
    }).catch(() => {/* testbed not loaded yet, no-op */});

    warmupConnections();

    state.sessionId = data.session_id;
    state.notebook = data.notebook;
    resetHuntTiming();

    startHeartbeat();
    state.originalNotebookJson = data.original_notebook_json || null;
    if (isUrl && data.notebook) {
        state.notebook.url = overrideUrl || elements.colabUrlInput?.value || null;
    }

    const notebookUrl = overrideUrl || elements.colabUrlInput?.value || '';
    const fileIdMatch = notebookUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || notebookUrl.match(/drive\/([a-zA-Z0-9_-]+)/);
    state.notebookId = fileIdMatch ? fileIdMatch[1] : data.session_id;

    clearHuntCount(state.notebookId);
    state.totalHuntsCount = 0;
    state.huntsThisTurn = 0;
    state.huntLimitReached = false;

    unlockHuntMode();

    updateHuntLimitUI();

    if (data.session_id) {
        localStorage.setItem('modelHunter_sessionId', data.session_id);
        const { syncTurnStatusFromBackend } = await import('./ingest.js');
        await syncTurnStatusFromBackend(data.session_id);
    }

    elements.configSection.classList.remove('hidden');

    if (elements.saveDriveContainer) {
        if (isUrl) {
            elements.saveDriveContainer.classList.remove('hidden');
        } else {
            elements.saveDriveContainer.classList.add('hidden');
        }
    }

    if (elements.uploadSection) elements.uploadSection.classList.add('hidden');

    elements.configSection.classList.add('hidden');

    renderInsightTip('configTipContainer', 'config');

    let modelPrefix = null;
    let modelSource = null;

    const isPlaceholderMetadataModel = (s) => {
        if (!s || typeof s !== 'string') return true;
        const v = s.trim().toLowerCase();
        return /^(model|none|n\/a|n_a|tbd|\?|—|--|-|)$/i.test(v);
    };

    if (data.notebook.metadata) {
        const metadata = data.notebook.metadata;

        let rawModel = metadata.Model || metadata.model || metadata['Model'] || metadata['model'];

        if (!rawModel) {
            const modelKey = Object.keys(metadata).find(k => k.toLowerCase() === 'model');
            if (modelKey) {
                rawModel = metadata[modelKey];
            }
        }

        if (rawModel) {
            modelPrefix = rawModel.toString().trim().replace(/^[-:\s]+/, '').trim();
            if (modelPrefix && isPlaceholderMetadataModel(modelPrefix)) {
                modelPrefix = null;
            } else if (modelPrefix) {
                modelSource = 'metadata';
            } else {
                console.warn(`Model value in metadata was empty after cleaning: "${rawModel}"`);
            }
        } else {
        }
    } else {
    }

    if (!modelPrefix && data.notebook.model_prefix) {
        modelPrefix = data.notebook.model_prefix;
        modelSource = 'model_slots';
    }

    if (modelSource === 'metadata' && data.notebook.model_prefix &&
        modelPrefix.toLowerCase() !== data.notebook.model_prefix.toLowerCase()) {
        console.warn(`CONFLICT: Metadata says "${modelPrefix}" but model_slots say "${data.notebook.model_prefix}". Using metadata (PRIORITY).`);
    }

    if (!modelPrefix) {
        modelPrefix = 'qwen';
        modelSource = 'default';
    }


    if (modelPrefix) {
        const modelPrefixLower = modelPrefix.toLowerCase().trim();
        let modelId = null;
        let provider = 'openrouter';
        let matchedNotebookFamily = false;


        if (modelPrefixLower === 'nemotron' || modelPrefixLower.includes('nemotron')) {
            modelId = 'nvidia/nemotron-3-nano-30b-a3b';
            provider = 'openrouter';
            matchedNotebookFamily = true;
        } else if (modelPrefixLower === 'qwen' || modelPrefixLower.includes('qwen')) {
            if (getProviderModels()['openrouter']?.some(m => m.id.includes('qwen'))) {
                modelId = 'qwen/qwen3-235b-a22b-thinking-2507';
                provider = 'openrouter';
                matchedNotebookFamily = true;
            } else if (getProviderModels()['fireworks']?.some(m => m.id.includes('qwen'))) {
                modelId = 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507';
                provider = 'fireworks';
                matchedNotebookFamily = true;
            }
        } else if (modelPrefixLower === 'sonnet' || modelPrefixLower.includes('sonnet')) {
            modelId = 'anthropic/claude-sonnet-4.5';
            provider = 'openrouter';
            matchedNotebookFamily = true;
        } else if (modelPrefixLower === 'opus' || modelPrefixLower.includes('opus')) {
            modelId = 'anthropic/claude-opus-4.5';
            provider = 'openrouter';
            matchedNotebookFamily = true;
        } else {
            console.warn(`Unknown model prefix: "${modelPrefix}". Will use default (Qwen).`);
            modelId = 'qwen/qwen3-235b-a22b-thinking-2507';
            provider = 'openrouter';
            matchedNotebookFamily = false;
        }

        const fromNotebook =
            matchedNotebookFamily && (modelSource === 'metadata' || modelSource === 'model_slots');

        if (modelId && elements.providerSelect && elements.modelSelect) {
            state._preselectedModelId = modelId;
            state.config.models = [modelId];
            elements.providerSelect.value = provider;
            updateModelOptions(false);
            elements.modelSelect.value = modelId;
            const displayName = getModelDisplayName(modelId);
            const toastMsg = fromNotebook
                ? `Model from notebook: ${displayName}`
                : `Using default model: ${displayName}`;
            showToast(toastMsg, 'info');
        } else {
            console.warn('Provider or model select elements not found');
        }
    } else {
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

    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = false;
        elements.startHuntBtn.title = '';
    }

    populatePreviewTabs(data.notebook);

    showToast('Notebook loaded successfully', 'success');
}
