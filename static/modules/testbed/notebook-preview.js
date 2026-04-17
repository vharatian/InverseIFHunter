/**
 * testbed/notebook-preview.js — Notion-style read-only notebook preview overlay shown
 * after Save & Preview validates; "Continue to Hunt" dismisses and scrolls to hunt config.
 */

import { state } from '../state.js';
import { escapeHtml, renderMarkdownSafe } from '../utils.js';
import { tbState, getActiveRun, getSharedLeft, criteriaStringToChips } from './store.js';
import { showTestbed, hideTestbed } from './render-chrome.js';

export function showNotebookPreview(run) {
    const configSection = document.getElementById('configSection');
    if (configSection) configSection.classList.remove('hidden');

    if (tbState.previewDismissed) {
        hideTestbed();
        if (configSection) {
            setTimeout(() => configSection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
        }
        return;
    }

    document.getElementById('tbNotebookPreviewOverlay')?.remove();

    const nb = state.notebook || {};
    const left         = getSharedLeft();
    const promptMd     = left.prompt         || '';
    const responseMd   = left.idealResponse  || '';
    const reasoningMd  = left.modelReasoning || '';
    const criterias    = left.criteriaChips?.length
        ? left.criteriaChips
        : criteriaStringToChips(nb.response_reference || '');
    const judgePrompt = left.judgePrompt  || '';

    const md = (s) => renderMarkdownSafe(s);

    const scorePill = run?.score != null
        ? `<span class="nbp-score-pill ${run.score === run.maxScore ? 'nbp-score-perfect' : ''}">${run.score}/${run.maxScore ?? '?'} judge score</span>`
        : '';

    const criteriaItems = criterias.length
        ? criterias.map((c, i) => `
            <div class="nbp-criteria-item">
                <span class="nbp-criteria-num">C${i + 1}</span>
                <span class="nbp-criteria-text">${escapeHtml(c)}</span>
            </div>`).join('')
        : '<span class="nbp-empty">No criteria defined</span>';

    const metaTags = [
        nb.category   && `<span class="nbp-tag">${escapeHtml(nb.category)}</span>`,
        nb.difficulty && `<span class="nbp-tag nbp-tag-diff">${escapeHtml(nb.difficulty)}</span>`,
        nb.domain     && `<span class="nbp-tag">${escapeHtml(nb.domain)}</span>`,
        nb.language   && `<span class="nbp-tag">${escapeHtml(nb.language)}</span>`,
        nb.task_type  && `<span class="nbp-tag">${escapeHtml(nb.task_type)}</span>`,
    ].filter(Boolean).join('');

    const overlay = document.createElement('div');
    overlay.id = 'tbNotebookPreviewOverlay';
    overlay.className = 'nbp-overlay';
    overlay.innerHTML = `
        <!-- Top nav bar -->
        <nav class="nbp-nav">
            <div class="nbp-nav-left">
                <span class="nbp-nav-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </span>
                <span class="nbp-nav-title">${escapeHtml(nb.title || 'Notebook')}</span>
                <span class="nbp-nav-badge">Preview</span>
            </div>
            <div class="nbp-nav-actions">
                <button class="nbp-btn-ghost" id="nbpEditBtn">← Edit in Testbed</button>
                <button class="nbp-btn-primary" id="nbpContinueBtn">Continue to Hunt</button>
            </div>
        </nav>

        <!-- Scrollable doc body -->
        <div class="nbp-scroll">
            <div class="nbp-doc">

                  <!-- Title + meta tags -->
                  <header class="nbp-doc-header">
                      ${nb.title ? `<h1 class="nbp-doc-title">${escapeHtml(nb.title)}</h1>` : ''}
                      ${metaTags ? `<div class="nbp-tags-row">${metaTags}</div>` : ''}
                      <p class="nbp-doc-hint">Ideal response committed — read only. Happy with it? Continue to set up the hunt.</p>
                  </header>

                <!-- Two-column: Prompt | Response -->
                <section class="nbp-split-section">
                    <div class="nbp-split-col">
                        <div class="nbp-section-label">
                            <span class="nbp-section-dot nbp-dot-prompt"></span>
                            Prompt
                        </div>
                        <div class="nbp-prose">${md(promptMd) || '<span class="nbp-empty">No prompt</span>'}</div>
                    </div>
                    <div class="nbp-split-divider"></div>
                    <div class="nbp-split-col">
                        <div class="nbp-section-label">
                            <span class="nbp-section-dot nbp-dot-response"></span>
                            Ideal Response
                            ${scorePill}
                        </div>
                        <div class="nbp-prose">${md(responseMd) || '<span class="nbp-empty">No response</span>'}</div>
                    </div>
                </section>

                ${reasoningMd ? `
                <!-- Model Reasoning -->
                <section class="nbp-section">
                    <div class="nbp-section-label">
                        <span class="nbp-section-dot nbp-dot-judge"></span>
                        Model Reasoning
                    </div>
                    <div class="nbp-prose">${md(reasoningMd)}</div>
                </section>` : ''}

                <!-- Criteria -->
                <section class="nbp-section">
                    <div class="nbp-section-label">
                        <span class="nbp-section-dot nbp-dot-criteria"></span>
                        Evaluation Criteria
                    </div>
                    <div class="nbp-criteria-list">${criteriaItems}</div>
                </section>

                ${judgePrompt ? `
                <!-- Judge Prompt (collapsible) -->
                <section class="nbp-section">
                    <details class="nbp-collapsible">
                        <summary class="nbp-section-label nbp-collapsible-trigger">
                            <span class="nbp-section-dot nbp-dot-judge"></span>
                            Judge System Prompt
                            <span class="nbp-collapse-arrow">›</span>
                        </summary>
                        <pre class="nbp-judge-pre">${escapeHtml(judgePrompt)}</pre>
                    </details>
                </section>` : ''}


            </div>
        </div>`;

    document.body.appendChild(overlay);

    const doEdit = () => { overlay.remove(); showTestbed(); };
    const doContinue = () => {
        tbState.previewDismissed = true;
        overlay.remove();
        hideTestbed();

        if (configSection) {
            setTimeout(() => configSection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
        }
    };

    document.getElementById('nbpEditBtn')?.addEventListener('click', doEdit);
    document.getElementById('nbpContinueBtn')?.addEventListener('click', doContinue);

    const onEsc = (e) => {
        if (e.key === 'Escape') { doEdit(); window.removeEventListener('keydown', onEsc); }
    };
    window.addEventListener('keydown', onEsc);
}

export function goBackToNotebook() {
    tbState.previewDismissed = false;
    showNotebookPreview(getActiveRun());
}
