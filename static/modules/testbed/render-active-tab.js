/**
 * testbed/render-active-tab.js — Render the active run's right-panel content.
 */

import { escapeHtml, renderMarkdownSafe } from '../utils.js';
import { getProviderModels, getJudgeModels } from '../config.js';
import { tbState, getActiveRun, getSharedLeft } from './store.js';
import { tbCopyBtn } from './copy.js';
import { renderCriteriaChips, wireChipEvents } from './render-chips.js';
import { parseJudgeExplanation } from './store.js';
import { autoGrow, updateTestbedWordCount, applySavedSplit, initResizer } from './layout-resize.js';
import { renderTabBar } from './render-chrome.js';
import { triggerGenerate, triggerJudge } from './actions.js';

function renderJudgeResult(run) {
    const jr = run.judgeResult;
    if (!jr) return '';

    const criteria     = jr.criteria || {};
    const overallScore = jr.overall_score ?? jr.score ?? null;
    const explanation  = jr.overall_explanation || jr.explanation || '';
    const parsed       = parseJudgeExplanation(explanation, criteria);

    const passingCount = parsed.filter(p => p.status === 'PASS').length;
    const totalCount   = parsed.length;
    const allPass      = passingCount === totalCount && totalCount > 0;
    const verdict      = jr.verdict || (allPass ? 'PASSING' : totalCount > 0 ? 'BREAKING' : '');
    const verdictCls   = verdict === 'BREAKING' ? 'tb-verdict-break' : verdict === 'PASSING' ? 'tb-verdict-pass' : '';

    const criteriaCards = parsed.map(({ id, status, explanation: expl }) => {
        const isPass   = status === 'PASS';
        const isMissing = status === 'MISSING';
        const icon     = isMissing ? '[MISSING]' : isPass ? '[PASS]' : '[FAIL]';
        const color    = isMissing ? 'var(--warning, #f59e0b)' : isPass ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
        return `<div style="margin-bottom: 0.5rem; padding: 0.65rem 0.75rem; background: var(--bg-primary); border-radius: 8px; border-left: 4px solid ${color};">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: ${expl ? '0.25rem' : '0'};">
                <span style="font-weight: 700; font-size: 0.88rem;">${icon} ${escapeHtml(id)}</span>
                <span style="color: ${color}; font-weight: 600; font-size: 0.82rem;">${escapeHtml(status)}</span>
            </div>
            ${expl ? `<div style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">${escapeHtml(expl)}</div>` : ''}
        </div>`;
    }).join('');

    const collapseId = `tbJudgeCollapse-${run.id}`;
    return `<div class="tb-judge-result tb-judge-collapsible">
        <div class="tb-judge-header" style="cursor:pointer;" data-tb-toggle="${collapseId}">
            <span class="tb-judge-toggle" style="font-size:0.75rem;color:var(--text-muted);">▾</span>
            <span class="tb-judge-label">Judge Result</span>
            ${verdict ? `<span class="tb-verdict ${verdictCls}">${verdict}</span>` : ''}
            <span class="tb-overall-score">${passingCount}/${totalCount} Passing</span>
        </div>
        <div id="${collapseId}" class="tb-judge-body">
            ${criteriaCards}
        </div>
    </div>`;
}

function buildJudgeModelOptions(selectedModel) {
    return getJudgeModels().map(m => {
        const sel = m.id === selectedModel ? 'selected' : '';
        return `<option value="${escapeHtml(m.id)}" ${sel}>${escapeHtml(m.name)}</option>`;
    }).join('');
}

function renderStatusBanner(run) {
    if (run.status === 'generating') {
        return `<div class="tb-status-banner tb-banner-generating">
            <span class="tb-spinner"></span>
            <span>Connecting to model… this may take a moment.</span>
        </div>`;
    }
    if (run.status === 'streaming') {
        return `<div class="tb-status-banner tb-banner-generating">
            <span class="tb-spinner"></span>
            <span>Streaming response… switch tabs freely — this run keeps going in the background.</span>
        </div>`;
    }
    if (run.status === 'judging') {
        const judgeLabel = getJudgeModels().find(m => m.id === run.judgeModel)?.name || run.judgeModel || 'judge model';
        return `<div class="tb-status-banner tb-banner-judging">
            <span class="tb-spinner"></span>
            <span>Judging with ${judgeLabel}…</span>
        </div>`;
    }
    if (run.status === 'error') {
        return `<div class="tb-status-banner tb-banner-error">
            <strong>Something went wrong:</strong> ${escapeHtml(run.errorMessage || 'Unknown error. Please try again.')}
        </div>`;
    }
    return '';
}

function buildModelOptions(selectedModel) {
    const seen = new Set();
    const options = [];
    for (const [provider, models] of Object.entries(getProviderModels())) {
        for (const m of models) {
            if (seen.has(m.name)) continue;
            seen.add(m.name);
            const sel = m.id === selectedModel ? 'selected' : '';
            const label = provider === 'openrouter' ? m.name : `${m.name} (${provider})`;
            options.push(`<option value="${escapeHtml(m.id)}" data-provider="${provider}" ${sel}>${escapeHtml(label)}</option>`);
        }
    }
    return options.join('');
}

export function renderActiveTab() {
    const content = document.getElementById('testbedTabContent');
    if (!content) return;

    const run = getActiveRun();
    if (!run) {
        content.innerHTML = '<div class="tb-empty">No run selected. Click "+ New Run" to start.</div>';
        return;
    }

    const left         = getSharedLeft();
    const isGenerating = run.status === 'generating';
    const isStreaming   = run.status === 'streaming';
    const isJudging    = run.status === 'judging';
    const isBusy       = isGenerating || isStreaming || isJudging;
    const hasResponse   = run.response && run.response.trim().length > 0;
    const isEditing     = run.responseEditing;
    const hasReasoning  = run.reasoningTrace && run.reasoningTrace.trim().length > 0;
    const isEditingReas = run.reasoningEditing;

    let responseArea;
    if (isStreaming) {
        responseArea = `<div class="tb-response-stream" id="tbStreamArea-${run.id}">${escapeHtml(run.response || '')}<span class="tb-stream-cursor"></span></div>`;
    } else if (hasResponse) {
        responseArea = isEditing
            ? `<textarea
                class="tb-response-edit-ta"
                id="tbResponseEdit-${run.id}"
                spellcheck="false"
              >${escapeHtml(run.response)}</textarea>`
            : `<div class="tb-response-markdown">${renderMarkdownSafe(run.response)}</div>`;
    } else {
        responseArea = `<div class="tb-response-placeholder">
               <div class="tb-placeholder-icon">◎</div>
               <div>Response will appear here after generation.</div>
           </div>`;
    }

    const reasoningSection = hasReasoning
        ? `<div class="tb-reasoning-section">
               <div class="tb-reasoning-hdr">
               <button class="tb-reasoning-collapse-btn" id="tbReasoningCollapseBtn-${run.id}" type="button">
                   <span class="tb-reasoning-collapse-icon">▶</span>
                   <span>Model Reasoning</span>
                   <span class="tb-reasoning-badge">${run.reasoningTrace.length.toLocaleString()} chars</span>
                   <span class="tb-reasoning-collapse-hint">click to expand</span>
                   ${isEditingReas
                       ? `<span class="tb-edit-toggle tb-edit-active tb-reasoning-edit-toggle" id="tbReasoningEditToggle-${run.id}" title="View rendered">View</span>`
                       : `<span class="tb-edit-toggle tb-reasoning-edit-toggle" id="tbReasoningEditToggle-${run.id}" title="Edit reasoning">Edit</span>`}
               </button>
               ${tbCopyBtn('reasoning', 'Copy model reasoning', run.id)}
               </div>
               <div class="tb-collapsible-body tb-collapsed tb-reasoning-body" id="tbReasoningBody-${run.id}">
                   ${isEditingReas
                       ? `<textarea
                           class="tb-response-edit-ta tb-reasoning-edit-ta"
                           id="tbReasoningEdit-${run.id}"
                           spellcheck="false"
                         >${escapeHtml(run.reasoningTrace)}</textarea>`
                       : `<div class="tb-response-markdown tb-reasoning-content">${renderMarkdownSafe(run.reasoningTrace)}</div>`}
               </div>
           </div>`
        : '';

    content.innerHTML = `
    <div class="tb-layout" data-run-id="${run.id}" id="tbLayout-${run.id}">

        <!-- ═══ LEFT PANEL (shared across all runs) ══════════════════════════ -->
        <div class="tb-left" id="tbSharedLeft">
            <div class="tb-left-scroll">

                <div class="tb-panel-header">
                    <span class="tb-panel-icon"></span>
                    <span class="tb-panel-title">Prompt &amp; Settings</span>
                    <span class="tb-panel-note">Shared across all runs</span>
                </div>

                <!-- Prompt -->
                <div class="tb-field">
                    <div class="tb-label-row">
                        <label class="tb-label" for="tbSharedPrompt">Prompt</label>
                        ${tbCopyBtn('tbSharedPrompt', 'Copy prompt')}
                    </div>
                    <textarea
                        class="tb-textarea tb-textarea-prompt tb-autogrow"
                        id="tbSharedPrompt"
                        placeholder="Enter your prompt here…"
                        rows="4"
                    >${escapeHtml(left.prompt)}</textarea>
                    <div class="tb-word-count" id="tbPromptWordCount"></div>
                </div>

                <!-- Ideal Response (collapsible) -->
                <div class="tb-field tb-field-collapsible">
                    <div class="tb-collapsible-hdr">
                    <button class="tb-judge-collapse-btn" id="tbIdealCollapseBtn" type="button">
                        <span class="tb-judge-collapse-icon">${left.idealResponse ? '▼' : '▶'}</span>
                        <span>Ideal Response</span>
                        <span class="tb-judge-collapse-hint">${left.idealResponse ? 'click to collapse' : 'click to expand / edit'}</span>
                    </button>
                    ${tbCopyBtn('tbSharedIdeal', 'Copy ideal response')}
                    </div>
                    <div class="tb-collapsible-body ${left.idealResponse ? '' : 'tb-collapsed'}" id="tbSharedIdealBody">
                        <textarea
                            class="tb-textarea tb-textarea-judge"
                            id="tbSharedIdeal"
                            placeholder="Enter the ideal / standard response here…"
                            rows="8"
                        >${escapeHtml(left.idealResponse)}</textarea>
                    </div>
                </div>

                <!-- Criteria chips -->
                <div class="tb-field">
                    <div class="tb-label-row">
                        <label class="tb-label">Criteria</label>
                        ${tbCopyBtn('criteria', 'Copy criteria (C1: ..., C2: ...)')}
                    </div>
                    ${renderCriteriaChips(false)}
                </div>

                <!-- Judge System Prompt (collapsible, default pre-filled) -->
                <div class="tb-field tb-field-collapsible">
                    <div class="tb-collapsible-hdr">
                    <button class="tb-judge-collapse-btn" id="tbJudgeCollapseBtn" type="button">
                        <span class="tb-judge-collapse-icon">▶</span>
                        <span>Judge System Prompt</span>
                        <span class="tb-judge-collapse-hint">click to expand / edit</span>
                    </button>
                    ${tbCopyBtn('tbSharedJudge', 'Copy judge system prompt')}
                    </div>
                    <div class="tb-collapsible-body tb-collapsed" id="tbSharedJudgeBody">
                        <textarea
                            class="tb-textarea tb-textarea-judge"
                            id="tbSharedJudge"
                            rows="12"
                        >${escapeHtml(left.judgePrompt)}</textarea>
                    </div>
                </div>

            </div><!-- /.tb-left-scroll -->

            <!-- Sticky footer: generate -->
            <div class="tb-left-footer">
                <button
                    class="btn btn-primary tb-generate-btn"
                    id="tbGenerateBtn-${run.id}"
                    ${isBusy ? 'disabled' : ''}
                >
                    ${isGenerating
                        ? '<span class="tb-btn-spinner"></span> Generating…'
                        : hasResponse ? '↺ Regenerate Response' : '▶ Generate Response'}
                </button>
            </div>
        </div><!-- /.tb-left -->

        <!-- ═══ RESIZE HANDLE ════════════════════════════════════════════════ -->
        <div class="tb-resize-handle" id="tbResizeHandle" title="Drag to resize panels">
            <div class="tb-resize-grip"></div>
        </div>

        <!-- ═══ RIGHT PANEL (per-run) ════════════════════════════════════════ -->
        <div class="tb-right" id="tbRight-${run.id}">

            <div class="tb-right-header">
                <div class="tb-panel-header">
                    <span class="tb-panel-icon"></span>
                    <span class="tb-panel-title">Model Response</span>
                    ${tbCopyBtn('response', 'Copy model response', run.id)}

                    <!-- Model & Judge Model dropdowns inline in header -->
                    <div class="tb-header-dropdowns">
                        <div class="tb-header-dropdown-group">
                            <label class="tb-header-label" for="tbModelSel-${run.id}">Model</label>
                            <select class="tb-select tb-select-inline" id="tbModelSel-${run.id}" ${isBusy ? 'disabled' : ''}>
                                ${buildModelOptions(run.model)}
                            </select>
                        </div>
                        <div class="tb-header-dropdown-group">
                            <label class="tb-header-label" for="tbJudgeModelSel-${run.id}">Judge Model</label>
                            <select class="tb-select tb-select-inline" id="tbJudgeModelSel-${run.id}" ${isBusy ? 'disabled' : ''}>
                                ${buildJudgeModelOptions(run.judgeModel)}
                            </select>
                        </div>
                    </div>

                    ${hasResponse
                        ? `<button class="tb-edit-toggle ${isEditing ? 'tb-edit-active' : ''}" id="tbEditToggle-${run.id}" title="${isEditing ? 'View rendered' : 'Edit response'}">
                               ${isEditing ? 'View' : 'Edit'}
                           </button>`
                        : ''}
                    ${run.status !== 'idle'
                        ? `<span class="tb-run-status-pill tb-pill-${run.status}">${run.status}</span>`
                        : ''}
                </div>
                ${renderStatusBanner(run)}
            </div>

            <div class="tb-right-body">
                <div class="tb-response-area ${!hasResponse ? 'tb-response-empty' : ''}">
                    ${responseArea}
                </div>
                ${reasoningSection}
                ${run.judgeResult ? renderJudgeResult(run) : ''}
            </div>

            <!-- Sticky action bar -->
            <div class="tb-right-footer">
                <div class="tb-response-actions">
                    <button
                        class="btn btn-secondary tb-judge-btn"
                        id="tbJudgeBtn-${run.id}"
                        ${isBusy || !hasResponse ? 'disabled' : ''}
                        title="${!hasResponse ? 'Generate a response first' : 'Judge this response against your criteria'}"
                    >
                        ${isJudging ? `<span class="tb-btn-spinner"></span> Judging with ${getJudgeModels().find(m => m.id === run.judgeModel)?.name || 'judge'}…` : 'Judge Model Response'}
                    </button>
                    <button
                        class="btn btn-secondary tb-regen-btn"
                        id="tbRegenBtn-${run.id}"
                        ${isBusy ? 'disabled' : ''}
                        title="Generate a new response"
                    >
                        ${isGenerating ? '<span class="tb-btn-spinner"></span> Generating…' : '↺ Regenerate'}
                    </button>

                </div>
            </div>

        </div><!-- /.tb-right -->

    </div>`;

    // Auto-grow textareas
    content.querySelectorAll('.tb-autogrow').forEach(ta => {
        autoGrow(ta);
        ta.addEventListener('input', () => autoGrow(ta));
    });

    document.getElementById('tbSharedPrompt')?.addEventListener('input', (e) => {
        getSharedLeft().prompt = e.target.value;
        updateTestbedWordCount();
    });
    updateTestbedWordCount();

    document.getElementById('tbSharedIdeal')?.addEventListener('input', (e) => {
        getSharedLeft().idealResponse = e.target.value;
    });

    document.getElementById('tbIdealCollapseBtn')?.addEventListener('click', () => {
        const body = document.getElementById('tbSharedIdealBody');
        const icon = document.querySelector('#tbIdealCollapseBtn .tb-judge-collapse-icon');
        const hint = document.querySelector('#tbIdealCollapseBtn .tb-judge-collapse-hint');
        if (body) {
            const isCollapsed = body.classList.toggle('tb-collapsed');
            if (icon) icon.textContent = isCollapsed ? '▶' : '▼';
            if (hint) hint.textContent = isCollapsed ? 'click to expand / edit' : 'click to collapse';
        }
    });

    document.getElementById('tbSharedJudge')?.addEventListener('input', (e) => {
        getSharedLeft().judgePrompt = e.target.value;
    });

    document.getElementById('tbJudgeCollapseBtn')?.addEventListener('click', () => {
        const body = document.getElementById('tbSharedJudgeBody');
        const icon = document.querySelector('#tbJudgeCollapseBtn .tb-judge-collapse-icon');
        if (body) {
            const isCollapsed = body.classList.toggle('tb-collapsed');
            if (icon) icon.textContent = isCollapsed ? '▶' : '▼';
        }
    });

    document.getElementById(`tbModelSel-${run.id}`)?.addEventListener('change', (e) => {
        const opt    = e.target.options[e.target.selectedIndex];
        run.model    = e.target.value;
        run.provider = opt.dataset.provider || run.provider;
        renderTabBar();
    });

    document.getElementById(`tbJudgeModelSel-${run.id}`)?.addEventListener('change', (e) => {
        run.judgeModel = e.target.value;
    });

    wireChipEvents();

    document.getElementById(`tbGenerateBtn-${run.id}`)?.addEventListener('click', () => {
        triggerGenerate(run);
    });

    document.getElementById(`tbRegenBtn-${run.id}`)?.addEventListener('click', () => {
        triggerGenerate(run);
    });

    document.getElementById(`tbJudgeBtn-${run.id}`)?.addEventListener('click', () => triggerJudge(run));

    document.getElementById(`tbEditToggle-${run.id}`)?.addEventListener('click', () => {
        if (run.responseEditing) {
            const ta = document.getElementById(`tbResponseEdit-${run.id}`);
            if (ta) run.response = ta.value;
        }
        run.responseEditing = !run.responseEditing;
        renderActiveTab();
        requestAnimationFrame(applySavedSplit);
    });

    const responseEditTa = document.getElementById(`tbResponseEdit-${run.id}`);
    if (responseEditTa) {
        responseEditTa.addEventListener('input', () => {
            run.response = responseEditTa.value;
        });
    }

    document.getElementById(`tbReasoningCollapseBtn-${run.id}`)?.addEventListener('click', (e) => {
        if (e.target.closest('.tb-reasoning-edit-toggle')) return;
        const body = document.getElementById(`tbReasoningBody-${run.id}`);
        const icon = document.querySelector(`#tbReasoningCollapseBtn-${run.id} .tb-reasoning-collapse-icon`);
        const hint = document.querySelector(`#tbReasoningCollapseBtn-${run.id} .tb-reasoning-collapse-hint`);
        if (body) {
            const isCollapsed = body.classList.toggle('tb-collapsed');
            if (icon) icon.textContent = isCollapsed ? '▶' : '▼';
            if (hint) hint.textContent = isCollapsed ? 'click to expand' : 'click to collapse';
        }
    });

    document.getElementById(`tbReasoningEditToggle-${run.id}`)?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (run.reasoningEditing) {
            const ta = document.getElementById(`tbReasoningEdit-${run.id}`);
            if (ta) run.reasoningTrace = ta.value;
        }
        run.reasoningEditing = !run.reasoningEditing;
        renderActiveTab();
        requestAnimationFrame(applySavedSplit);
    });

    const reasoningEditTa = document.getElementById(`tbReasoningEdit-${run.id}`);
    if (reasoningEditTa) {
        reasoningEditTa.addEventListener('input', () => {
            run.reasoningTrace = reasoningEditTa.value;
        });
    }

    initResizer(run.id);
}
