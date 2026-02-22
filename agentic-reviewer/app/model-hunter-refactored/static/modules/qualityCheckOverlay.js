/**
 * Quality Check Overlay — full-screen live QA display.
 * Tabbed UI: Summary, Rules, What Failed, Details.
 */
import { escapeHtml } from './utils.js';
import { RULE_LABELS, renderIssueDetails as renderIssueDetailsShared, buildCopyReport } from './qcShared.js';
import { createTabbedUI } from './qcTabs.js';

/**
 * Render content_checked object as readable HTML.
 */
function renderContentChecked(contentChecked) {
    if (!contentChecked) return '';
    const parts = [];
    if (contentChecked.check) {
        parts.push(`<div class="qc-content-check">${escapeHtml(contentChecked.check)}</div>`);
    }
    if (contentChecked.models && contentChecked.models.length) {
        const unique = [...new Set(contentChecked.models)];
        parts.push(`<div class="qc-content-models">Models: ${escapeHtml(unique.join(', '))}</div>`);
    }
    if (contentChecked.slots && contentChecked.slots.length) {
        const slotSummaries = contentChecked.slots.map((s, i) => {
            const grades = s.human_grades ? Object.entries(s.human_grades).map(([k, v]) => `${k}=${v}`).join(', ') : '—';
            return `Slot ${i + 1} (${s.model}): ${grades}`;
        });
        parts.push(`<div class="qc-content-slots">${slotSummaries.map(s => escapeHtml(s)).join('<br>')}</div>`);
    }
    if (contentChecked.criteria && contentChecked.criteria.length) {
        const crits = contentChecked.criteria.map(c => `${c.id}: ${(c.desc || '').slice(0, 80)}`).join('; ');
        parts.push(`<div class="qc-content-criteria">Criteria: ${escapeHtml(crits)}</div>`);
    }
    if (contentChecked.prompt_preview) {
        parts.push(`<div class="qc-content-prompt">Prompt: ${escapeHtml(contentChecked.prompt_preview)}</div>`);
    }
    return parts.length ? `<div class="qc-content-checked">${parts.join('')}</div>` : '';
}

/**
 * Create the overlay DOM structure with tabs.
 */
function createOverlayDom() {
    const overlay = document.createElement('div');
    overlay.className = 'qc-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Quality check in progress');

    const panel = document.createElement('div');
    panel.className = 'qc-panel';

    const tabs = createTabbedUI({
        tabIds: ['summary', 'rules', 'failed', 'details'],
        tabLabels: ['Summary', 'Rules', 'What Failed', 'Details'],
        defaultTab: 'summary',
    });

    const headerHtml = `
        <div class="qc-header">
            <h2 class="qc-title">Quality check before saving</h2>
            <p class="qc-subtitle">Verifying your data meets quality standards. Checking each rule live.</p>
            <div class="qc-progress-wrap" aria-live="polite">
                <div class="qc-progress-bar"><div class="qc-progress-fill"></div></div>
                <span class="qc-progress-text">Starting…</span>
            </div>
        </div>
    `;

    tabs.panes.summary.innerHTML = '<div class="qc-summary-pane"></div>';
    tabs.panes.rules.innerHTML = '<div class="qc-rules" role="list"></div>';
    tabs.panes.failed.innerHTML = '<div class="qc-eval-pane"></div>';
    tabs.panes.details.innerHTML = '<div class="qc-details-pane"></div>';

    const actionsEl = document.createElement('div');
    actionsEl.className = 'qc-actions';

    panel.innerHTML = headerHtml;
    panel.appendChild(tabs.container);
    panel.appendChild(actionsEl);
    overlay.appendChild(panel);

    return { overlay, panel, tabs };
}

/**
 * Add or update a rule card in the overlay.
 */
function upsertRuleCard(rulesEl, ruleId, data) {
    let card = rulesEl.querySelector(`[data-rule="${ruleId}"]`);
    const labels = RULE_LABELS[ruleId] || { title: ruleId, description: '' };
    const title = labels.title || ruleId;
    const desc = data?.description || labels.description || '';

    if (!card) {
        card = document.createElement('div');
        card.className = 'qc-rule-card';
        card.setAttribute('data-rule', ruleId);
        card.setAttribute('role', 'listitem');
        rulesEl.appendChild(card);
    }

    const status = data?.passed === true ? 'pass' : data?.passed === false ? 'fail' : 'running';
    const statusIcon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '⏳';
    const statusClass = `qc-status-${status}`;

    let contentHtml = '';
    if (data?.content_checked) {
        contentHtml = renderContentChecked(data.content_checked);
    }

    let rationaleHtml = '';
    if (data?.rationale) {
        rationaleHtml = `<div class="qc-rationale">${escapeHtml(data.rationale)}</div>`;
    }
    if (data?.issue?.message) {
        rationaleHtml += `<div class="qc-issue-message">${escapeHtml(data.issue.message)}</div>`;
    }
    if (data?.issue?.hint) {
        rationaleHtml += `<div class="qc-issue-hint">Hint: ${escapeHtml(data.issue.hint)}</div>`;
    }

    let councilHtml = '';
    const councilVotes = data?.council_votes || data?.issue?.details?.council_votes || [];
    const hasCouncilSection = card.querySelector('.qc-council-section');
    if (hasCouncilSection) {
        councilHtml = '';
    } else if (councilVotes.length) {
        councilHtml = '<div class="qc-council-votes"><div class="qc-council-title">LLM Council votes:</div><div class="qc-council-list">' +
            councilVotes.map(v => `<span class="qc-vote qc-vote-${(v.vote || '').toLowerCase()}" title="${escapeHtml(v.model_id || v.model || '')}">${escapeHtml(v.model_id || v.model || '?')}: ${escapeHtml(v.vote || '?')}</span>`).join('') +
            '</div></div>';
    } else if (status === 'running' && ['human_llm_grade_alignment', 'metadata_prompt_alignment', 'metadata_taxonomy_alignment', 'human_explanation_justifies_grade', 'safety_context_aware', 'qc_cfa_criteria_valid'].includes(ruleId)) {
        councilHtml = '<div class="qc-council-votes"><div class="qc-council-title">LLM Council votes (live):</div><div class="qc-council-list qc-council-waiting">Calling models…</div></div>';
    }

    const existingCouncil = card.querySelector('.qc-council-section');
    card.innerHTML = `
        <div class="qc-rule-header">
            <span class="qc-rule-title">${escapeHtml(title)}</span>
            <span class="qc-rule-status ${statusClass}">${statusIcon} ${status === 'running' ? 'Checking...' : status === 'pass' ? 'Passed' : 'Failed'}</span>
        </div>
        <div class="qc-rule-desc">${escapeHtml(desc)}</div>
        ${contentHtml}
        ${councilHtml}
        ${rationaleHtml}
    `;
    if (existingCouncil) card.appendChild(existingCouncil);
}

/**
 * Ensure council section exists and show the prompt (collapsible).
 */
function setCouncilPrompt(rulesEl, ruleId, prompt) {
    const card = rulesEl.querySelector(`[data-rule="${ruleId}"]`);
    if (!card) return;
    card.querySelector('.qc-council-votes')?.remove();
    card.querySelector('.qc-council-section')?.remove();
    const section = document.createElement('div');
    section.className = 'qc-council-section';
    section.innerHTML = `
        <details class="qc-collapsible" open>
            <summary class="qc-collapsible-summary">Prompt sent to council</summary>
            <pre class="qc-council-prompt-body">${escapeHtml(prompt || '')}</pre>
        </details>
        <div class="qc-council-models"></div>
    `;
    card.appendChild(section);
}

/**
 * Start a model's response block (model_id heading).
 */
function startCouncilModel(rulesEl, ruleId, modelId) {
    const card = rulesEl.querySelector(`[data-rule="${ruleId}"]`);
    if (!card) return;
    let modelsEl = card.querySelector('.qc-council-models');
    if (!modelsEl) return;
    const modelCard = document.createElement('div');
    modelCard.className = 'qc-council-model-card';
    modelCard.setAttribute('data-model', modelId);
    modelCard.innerHTML = `
        <div class="qc-council-model-header">${escapeHtml(modelId || '?')} — thinking…</div>
        <details class="qc-collapsible qc-model-reasoning">
            <summary class="qc-collapsible-summary">Reasoning</summary>
            <div class="qc-council-model-response"></div>
        </details>
        <div class="qc-council-model-verdict"></div>
    `;
    modelsEl.appendChild(modelCard);
}

/**
 * Append a chunk to a model's streaming response.
 */
function appendCouncilModelChunk(rulesEl, ruleId, modelId, chunk) {
    const card = rulesEl.querySelector(`[data-rule="${ruleId}"]`);
    if (!card) return;
    const modelCard = card.querySelector(`.qc-council-model-card[data-model="${modelId}"]`);
    if (!modelCard) return;
    const respEl = modelCard.querySelector('.qc-council-model-response');
    if (!respEl) return;
    const span = document.createElement('span');
    span.textContent = chunk;
    respEl.appendChild(span);
}

/**
 * Set a model's verdict and final response.
 */
function setCouncilModelVerdict(rulesEl, ruleId, modelId, vote, response) {
    const card = rulesEl.querySelector(`[data-rule="${ruleId}"]`);
    if (!card) return;
    const modelCard = card.querySelector(`.qc-council-model-card[data-model="${modelId}"]`);
    if (!modelCard) return;
    const header = modelCard.querySelector('.qc-council-model-header');
    const verdictEl = modelCard.querySelector('.qc-council-model-verdict');
    if (header) header.textContent = `${modelId || '?'}`;
    if (verdictEl) {
        verdictEl.innerHTML = `<span class="qc-vote qc-vote-${(vote || 'unclear').toLowerCase()}">Verdict: ${escapeHtml(vote || '?')}</span>`;
        verdictEl.classList.add('qc-verdict-visible');
    }
}

/** @deprecated — kept for backward compat if old events arrive */
function appendCouncilVote(rulesEl, ruleId, modelId, vote) {
    const card = rulesEl.querySelector(`[data-rule="${ruleId}"]`);
    if (!card) return;
    let list = card.querySelector('.qc-council-list');
    if (!list) {
        const wrap = document.createElement('div');
        wrap.className = 'qc-council-votes';
        wrap.innerHTML = '<div class="qc-council-title">LLM Council votes (live):</div><div class="qc-council-list"></div>';
        list = wrap.querySelector('.qc-council-list');
        card.appendChild(wrap);
    }
    list.classList.remove('qc-council-waiting');
    if (list.textContent === 'Calling models…') list.textContent = '';
    const span = document.createElement('span');
    span.className = `qc-vote qc-vote-${(vote || 'unclear').toLowerCase()}`;
    span.title = modelId || '';
    span.textContent = `${modelId || '?'}: ${vote || '?'}`;
    list.appendChild(span);
}

/**
 * Update progress bar and text.
 */
function updateProgress(panel, rulesDone, totalRules, isComplete) {
    const wrap = panel.querySelector('.qc-progress-wrap');
    if (!wrap) return;
    const fill = wrap.querySelector('.qc-progress-fill');
    const text = wrap.querySelector('.qc-progress-text');
    if (!fill || !text) return;
    if (isComplete) {
        fill.style.width = '100%';
        text.textContent = `All ${totalRules} rules checked.`;
    } else if (totalRules > 0) {
        const pct = Math.round((rulesDone / totalRules) * 100);
        fill.style.width = `${pct}%`;
        text.textContent = `Checking ${rulesDone + 1} of ${totalRules}…`;
    }
}

/**
 * Stream quality check and update overlay in real time.
 */
async function streamQualityCheck(overlay, panel, sessionId, selectedHuntIds, humanReviews) {
    const rulesEl = panel.querySelector('.qc-rules');
    if (!rulesEl) return { passed: false, issues: [], evaluation: null, total_rules: 0, rules_data: [] };
    const summaryEl = panel.querySelector('.qc-summary');
    const actionsEl = panel.querySelector('.qc-actions');
    let totalRules = 0;
    let rulesDone = 0;

    const res = await fetch(`/api/review-final-stream/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            selected_hunt_ids: selectedHuntIds,
            human_reviews: humanReviews,
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.message || `Quality check failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = { passed: false, issues: [], evaluation: null, total_rules: 0, rules_data: [] };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'rule_start') {
                    totalRules++;
                    updateProgress(panel, rulesDone, totalRules, false);
                    upsertRuleCard(rulesEl, data.rule_id, {
                        description: data.description,
                        content_checked: data.content_checked,
                        passed: undefined,
                    });
                } else if (data.type === 'council_prompt') {
                    setCouncilPrompt(rulesEl, data.rule_id, data.prompt);
                } else if (data.type === 'council_model_start') {
                    startCouncilModel(rulesEl, data.rule_id, data.model_id);
                } else if (data.type === 'council_model_chunk') {
                    appendCouncilModelChunk(rulesEl, data.rule_id, data.model_id, data.chunk);
                } else if (data.type === 'council_model_verdict') {
                    setCouncilModelVerdict(rulesEl, data.rule_id, data.model_id, data.vote, data.response);
                } else if (data.type === 'council_vote') {
                    appendCouncilVote(rulesEl, data.rule_id, data.model_id, data.vote);
                } else if (data.type === 'rule_done') {
                    rulesDone++;
                    updateProgress(panel, rulesDone, totalRules, false);
                    result.rules_data.push({
                        rule_id: data.rule_id,
                        passed: data.passed,
                        content_checked: data.content_checked,
                        issue: data.issue,
                    });
                    upsertRuleCard(rulesEl, data.rule_id, {
                        description: data.description,
                        content_checked: data.content_checked,
                        rationale: data.rationale,
                        issue: data.issue,
                        passed: data.passed,
                        council_votes: data.council_votes,
                    });
                } else if (data.type === 'complete') {
                    updateProgress(panel, rulesDone, totalRules, true);
                    result.passed = data.passed;
                    result.issues = data.issues || [];
                    result.evaluation = data.evaluation || null;
                    result.total_rules = totalRules;
                } else if (data.type === 'error') {
                    throw new Error(data.message || 'Stream error');
                }
            } catch (e) {
                if (e instanceof SyntaxError) continue;
                throw e;
            }
        }
    }

    return result;
}

/**
 * Render slot-by-slot evaluation (human vs LLM) in the modal.
 */
function renderEvaluationInModal(panel, result) {
    const issues = result.issues || [];

    let html = '<div class="qc-eval-section">';
    const total = result.total_rules || issues.length;
    html += `<div class="qc-eval-title">What failed <span class="qc-eval-count">(${issues.length} of ${total} rules)</span></div>`;
    issues.forEach(i => {
        html += renderIssueDetailsShared(i);
    });
    html += '</div>';
    return html;
}

/**
 * Show final summary, evaluation details (when failed), and action buttons.
 */
function showSummaryAndActions(panel, result, onClose, overlay, tabs) {
    const summaryPane = panel.querySelector('.qc-summary-pane');
    const actionsEl = panel.querySelector('.qc-actions');
    const evalPane = panel.querySelector('.qc-eval-pane');
    const detailsPane = panel.querySelector('.qc-details-pane');
    const totalRules = result.total_rules || 0;
    const failCount = (result.issues || []).length;

    if (result.passed) {
        if (summaryPane) summaryPane.innerHTML = '<div class="qc-summary qc-summary-pass"><span class="qc-summary-pass">✓ All checks passed. Ready to save.</span></div>';
        if (tabs) tabs.showTab('summary');
    } else {
        const summaryText = totalRules > 0
            ? `✗ ${failCount} of ${totalRules} rules failed. Check the "What Failed" tab.`
            : '✗ Quality check did not pass. Check the "What Failed" tab.';
        if (summaryPane) summaryPane.innerHTML = `<div class="qc-summary qc-summary-fail"><span class="qc-summary-fail">${summaryText}</span></div>`;
        if (evalPane) evalPane.innerHTML = renderEvaluationInModal(panel, result);
        if (detailsPane) {
            const evaluation = result.evaluation || {};
            const prompt = evaluation.prompt || '';
            const criteria = evaluation.criteria || [];
            detailsPane.innerHTML = prompt || criteria.length
                ? `<pre class="qc-eval-prompt">${escapeHtml(prompt)}</pre>` +
                  (criteria.length ? '<div class="qc-eval-criteria">' + criteria.map(c => `<div><strong>${escapeHtml(c.id || '?')}</strong>: ${escapeHtml((c.description || '').slice(0, 150))}</div>`).join('') + '</div>' : '')
                : '<p class="qc-eval-empty">No details.</p>';
        }
        if (tabs) tabs.showTab('failed');
    }

    actionsEl.innerHTML = '';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'qc-btn qc-btn-primary';
    closeBtn.textContent = result.passed ? 'Continue with save' : 'Close';
    closeBtn.onclick = () => onClose(result);
    actionsEl.appendChild(closeBtn);

    if (!result.passed) {
        const saveAnywayBtn = document.createElement('button');
        saveAnywayBtn.className = 'qc-btn qc-btn-secondary';
        saveAnywayBtn.textContent = 'Save anyway';
        saveAnywayBtn.title = 'Override and proceed with save (human has final authority)';
        saveAnywayBtn.onclick = () => onClose({ ...result, overridden: true });
        actionsEl.appendChild(saveAnywayBtn);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'qc-btn qc-btn-ghost';
        copyBtn.textContent = 'Copy report';
        copyBtn.onclick = async () => {
            try {
                await navigator.clipboard.writeText(buildCopyReport(result));
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy report'; }, 1500);
            } catch (e) {
                copyBtn.textContent = 'Copy failed';
            }
        };
        actionsEl.appendChild(copyBtn);
    }

    setupOverlayKeyboard(overlay, result, onClose);
    const primaryBtn = actionsEl.querySelector('.qc-btn-primary');
    if (primaryBtn) primaryBtn.focus();
}

/**
 * Setup keyboard shortcuts for overlay.
 */
function setupOverlayKeyboard(overlay, result, onClose) {
    const handler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose(result);
            overlay.removeEventListener('keydown', handler);
        } else if (e.key === 'Enter' && !e.target.matches('textarea, input')) {
            e.preventDefault();
            const primaryBtn = overlay.querySelector('.qc-btn-primary');
            if (primaryBtn) primaryBtn.click();
            overlay.removeEventListener('keydown', handler);
        }
    };
    overlay.addEventListener('keydown', handler);
}

/**
 * Setup focus trap and initial focus when overlay is shown.
 */
function setupOverlayAccessibility(overlay, panel) {
    overlay.setAttribute('aria-live', 'polite');
}

/**
 * Run quality check with full-screen overlay. Returns Promise<{ passed, issues, evaluation }>.
 * Everything stays in the modal — no navigation to evaluation page.
 *
 * @param {string} sessionId
 * @param {number[]} selectedHuntIds
 * @param {Record<string, { grades: Record<string, string>, explanation: string, submitted: boolean }>} humanReviews
 * @param {Function} storeEvaluation - (payload) => void — optional, for backwards compat
 */
export async function runQualityCheckOverlay(sessionId, selectedHuntIds, humanReviews, storeEvaluation, _openEvaluationSameWindow) {
    const { overlay, panel, tabs } = createOverlayDom();
    document.body.appendChild(overlay);
    setupOverlayAccessibility(overlay, panel);

    return new Promise((resolve, reject) => {
        const handleClose = (res) => {
            overlay.remove();
            resolve(res);
        };
        streamQualityCheck(overlay, panel, sessionId, selectedHuntIds, humanReviews)
            .then((result) => {
                if (storeEvaluation) storeEvaluation(result);
                showSummaryAndActions(panel, result, handleClose, overlay, tabs);
            })
            .catch((err) => {
                const summaryPane = panel.querySelector('.qc-summary-pane');
                const actionsEl = panel.querySelector('.qc-actions');
                if (summaryPane) summaryPane.innerHTML = `<div class="qc-summary qc-summary-fail"><span class="qc-summary-fail">Error: ${escapeHtml(err.message)}</span></div>`;
                if (tabs) tabs.showTab('summary');
                if (actionsEl) {
                    actionsEl.innerHTML = '';
                    const closeBtn = document.createElement('button');
                    closeBtn.className = 'qc-btn qc-btn-primary';
                    closeBtn.textContent = 'Close';
                    closeBtn.onclick = () => handleClose({ passed: false, issues: [{ rule_id: 'error', message: err.message }], evaluation: null });
                    actionsEl.appendChild(closeBtn);
                }
            });
    });
}
