/**
 * Quality Check — inline runner (below grading section, no modal).
 * Streams QC into the persistent section.
 */
import { escapeHtml } from './utils.js';
import { RULE_LABELS, renderContentChecked, renderIssueDetails, buildCopyReport } from './qcShared.js';
import { createTabbedUI } from './qcTabs.js';
import { renderQCPersistentSection } from './qcPersistentSection.js';

/**
 * Create inline panel DOM (same structure as overlay but for inline display).
 */
function createInlinePanel() {
    const panel = document.createElement('div');
    panel.className = 'qc-panel qc-panel-inline';

    const headerHtml = `
        <div class="qc-header">
            <h2 class="qc-title">Quality check</h2>
            <p class="qc-subtitle">Verifying your data meets quality standards. Checking each rule live.</p>
            <div class="qc-progress-wrap" aria-live="polite">
                <div class="qc-progress-bar"><div class="qc-progress-fill"></div></div>
                <span class="qc-progress-text">Starting…</span>
            </div>
        </div>
    `;

    const rulesEl = document.createElement('div');
    rulesEl.className = 'qc-rules';
    rulesEl.setAttribute('role', 'list');

    panel.innerHTML = headerHtml;
    panel.appendChild(rulesEl);
    return { panel, rulesEl };
}

/**
 * Add or update a rule card (mirrors qualityCheckOverlay logic).
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
    if (data?.rationale) rationaleHtml = `<div class="qc-rationale">${escapeHtml(data.rationale)}</div>`;
    if (data?.issue?.message) rationaleHtml += `<div class="qc-issue-message">${escapeHtml(data.issue.message)}</div>`;
    if (data?.issue?.hint) rationaleHtml += `<div class="qc-issue-hint">Hint: ${escapeHtml(data.issue.hint)}</div>`;

    let councilHtml = '';
    const councilVotes = data?.council_votes || data?.issue?.details?.council_votes || [];
    const chairmanModel = data?.chairman_model;
    const chairmanVerdict = data?.chairman_verdict;
    const chairmanRationale = data?.chairman_rationale;
    const hasChairman = chairmanModel && chairmanVerdict != null;
    if (councilVotes.length || hasChairman) {
        councilHtml = '<div class="qc-council-votes"><div class="qc-council-title">Council votes:</div><div class="qc-council-list">' +
            councilVotes.map(v => `<span class="qc-vote qc-vote-${(v.vote || '').toLowerCase()}" title="${escapeHtml(v.model_id || v.model || '')}">${escapeHtml(v.model_id || v.model || '?')}: ${escapeHtml(v.vote || '?')}</span>`).join('') +
            '</div></div>';
        if (hasChairman) {
            councilHtml += '<div class="qc-chairman-section"><div class="qc-council-title">Chairman (' + escapeHtml(chairmanModel) + '):</div>' +
                '<div class="qc-chairman-rationale">' + escapeHtml((chairmanRationale || '').trim() || '(no reasoning)') + '</div>' +
                '<div class="qc-chairman-verdict qc-vote qc-vote-' + (chairmanVerdict || '').toLowerCase() + '">' + escapeHtml(chairmanVerdict || '?') + '</div></div>';
        }
    } else if (status === 'running' && ['human_llm_grade_alignment', 'metadata_prompt_alignment', 'metadata_taxonomy_alignment', 'human_explanation_justifies_grade', 'safety_context_aware', 'qc_cfa_criteria_valid'].includes(ruleId)) {
        councilHtml = '<div class="qc-council-votes"><div class="qc-council-title">Council votes (live):</div><div class="qc-council-list qc-council-waiting">Calling models…</div></div>';
    }

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
}

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
 * Stream QC and render into parent. Returns { passed, issues, evaluation, total_rules, rules_data }.
 */
async function streamQualityCheckInline(panel, rulesEl, sessionId, selectedHuntIds, humanReviews) {
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
    let totalRules = 0;
    const result = { passed: false, issues: [], evaluation: null, total_rules: 0, rules_data: [] };

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
                    updateProgress(panel, result.rules_data.length, totalRules, false);
                    upsertRuleCard(rulesEl, data.rule_id, {
                        description: data.description,
                        content_checked: data.content_checked,
                        passed: undefined,
                    });
                } else if (data.type === 'council_model_start') {
                    const card = rulesEl.querySelector(`[data-rule="${data.rule_id}"]`);
                    if (card) {
                        let list = card.querySelector('.qc-council-list');
                        if (list) {
                            list.classList.remove('qc-council-waiting');
                            if (list.textContent === 'Calling models…') list.textContent = '';
                            const span = document.createElement('span');
                            span.className = 'qc-vote qc-vote-pending';
                            span.setAttribute('data-model-id', data.model_id || '');
                            span.title = data.model_id || '';
                            span.textContent = `${data.model_id || '?'}: …`;
                            list.appendChild(span);
                        }
                    }
                } else if (data.type === 'council_model_chunk') {
                    // Council member reasoning not shown — only chairman reasoning is displayed
                } else if (data.type === 'council_vote' || data.type === 'council_model_verdict') {
                    const card = rulesEl.querySelector(`[data-rule="${data.rule_id}"]`);
                    if (card) {
                        let list = card.querySelector('.qc-council-list');
                        if (list) {
                            list.classList.remove('qc-council-waiting');
                            const span = [...list.querySelectorAll('span[data-model-id]')].find(s => (s.getAttribute('data-model-id') || '') === (data.model_id || ''));
                            if (span) {
                                span.textContent = `${data.model_id || '?'}: ${data.vote || '?'}`;
                                span.className = `qc-vote qc-vote-${(data.vote || 'unclear').toLowerCase()}`;
                            } else {
                                const newSpan = document.createElement('span');
                                newSpan.className = `qc-vote qc-vote-${(data.vote || 'unclear').toLowerCase()}`;
                                newSpan.title = data.model_id || '';
                                newSpan.textContent = `${data.model_id || '?'}: ${data.vote || '?'}`;
                                list.appendChild(newSpan);
                            }
                        }
                    }
                } else if (data.type === 'council_chairman_start') {
                    const card = rulesEl.querySelector(`[data-rule="${data.rule_id}"]`);
                    if (card) {
                        let votesDiv = card.querySelector('.qc-council-votes');
                        if (votesDiv && !card.querySelector('.qc-chairman-section')) {
                            const chairmanSection = document.createElement('div');
                            chairmanSection.className = 'qc-chairman-section';
                            chairmanSection.innerHTML = '<div class="qc-council-title">Chairman (' + escapeHtml(data.model_id || '?') + '):</div><div class="qc-chairman-rationale qc-council-waiting">Reasoning…</div><div class="qc-chairman-verdict qc-vote qc-vote-pending">…</div>';
                            votesDiv.after(chairmanSection);
                        }
                    }
                } else if (data.type === 'council_chairman_verdict') {
                    const card = rulesEl.querySelector(`[data-rule="${data.rule_id}"]`);
                    if (card) {
                        const section = card.querySelector('.qc-chairman-section');
                        if (section) {
                            const rationaleEl = section.querySelector('.qc-chairman-rationale');
                            const verdictEl = section.querySelector('.qc-chairman-verdict');
                            if (rationaleEl) {
                                rationaleEl.textContent = (data.rationale || '').trim() || '(no reasoning)';
                                rationaleEl.classList.remove('qc-council-waiting');
                            }
                            if (verdictEl) {
                                const v = data.passed ? 'PASS' : 'FAIL';
                                verdictEl.textContent = v;
                                verdictEl.className = `qc-chairman-verdict qc-vote qc-vote-${v.toLowerCase()}`;
                            }
                        }
                    }
                } else if (data.type === 'rule_done') {
                    const councilVotes = data.council_votes || (data.issue?.details?.council_votes || []).map(v => ({
                        model: v.model || v.model_id,
                        model_id: v.model_id || v.model,
                        vote: v.vote,
                    }));
                    result.rules_data.push({
                        rule_id: data.rule_id,
                        passed: data.passed,
                        content_checked: data.content_checked,
                        issue: data.issue,
                        council_votes: councilVotes,
                        council_responses: data.council_responses || {},
                        chairman_model: data.chairman_model,
                        chairman_verdict: data.chairman_verdict,
                        chairman_rationale: data.chairman_rationale,
                    });
                    updateProgress(panel, result.rules_data.length, totalRules, false);
                    upsertRuleCard(rulesEl, data.rule_id, {
                        description: data.description,
                        content_checked: data.content_checked,
                        rationale: data.rationale,
                        issue: data.issue,
                        passed: data.passed,
                        council_votes: councilVotes,
                        council_responses: data.council_responses || {},
                        chairman_model: data.chairman_model,
                        chairman_verdict: data.chairman_verdict,
                        chairman_rationale: data.chairman_rationale,
                    });
                } else if (data.type === 'complete') {
                    result.passed = data.passed;
                    result.issues = data.issues || [];
                    result.evaluation = data.evaluation || null;
                    result.total_rules = totalRules || result.rules_data.length;
                    updateProgress(panel, result.rules_data.length, result.total_rules, true);
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
 * Run quality check inline below the grading section.
 * @param {HTMLElement} parent - qcPersistentParent
 * @param {string} sessionId
 * @param {number[]} selectedHuntIds
 * @param {Object} humanReviews
 * @param {Function} onComplete - (result) => void, called when done
 * @param {Function} storeEvaluation - (payload) => void
 * @returns {Promise<{ passed, issues, overridden? }>}
 */
export async function runQualityCheckInline(parent, sessionId, selectedHuntIds, humanReviews, onComplete, storeEvaluation) {
    if (!parent) throw new Error('QC parent element required');

    document.getElementById('qcPersistentSection')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'qcPersistentSection';
    wrap.className = 'qc-persistent-section qc-inline-running';

    const { panel, rulesEl } = createInlinePanel();
    wrap.appendChild(panel);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'qc-inline-actions';
    actionsRow.style.cssText = 'margin-top: 1rem; display: flex; gap: 0.75rem; flex-wrap: wrap;';
    wrap.appendChild(actionsRow);

    parent.appendChild(wrap);

    try {
        const result = await streamQualityCheckInline(panel, rulesEl, sessionId, selectedHuntIds, humanReviews);

        if (storeEvaluation) storeEvaluation(result);

        wrap.classList.remove('qc-inline-running');
        wrap.remove();
        renderQCPersistentSection(parent, result, sessionId);

        const finalWrap = document.getElementById('qcPersistentSection');
        if (finalWrap) {
            const actionsContainer = document.createElement('div');
            actionsContainer.className = 'qc-inline-save-actions';
            actionsContainer.style.cssText = 'margin-top: 1rem; display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center;';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn btn-secondary';
            copyBtn.textContent = 'Copy report';
            copyBtn.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(buildCopyReport(result));
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy report'; }, 1500);
                } catch (_) {}
            };
            actionsContainer.appendChild(copyBtn);

            const header = finalWrap.querySelector('.qc-persistent-header');
            if (header) header.after(actionsContainer);
            else finalWrap.appendChild(actionsContainer);
        }

        if (onComplete) onComplete(result);
        return result;
    } catch (err) {
        wrap.classList.remove('qc-inline-running');
        const progText = wrap.querySelector('.qc-progress-text');
        if (progText) {
            progText.textContent = `Error: ${err.message}`;
            progText.style.color = 'var(--danger)';
        }
        actionsRow.innerHTML = '';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn btn-secondary';
        closeBtn.textContent = 'Close';
        closeBtn.onclick = () => wrap.remove();
        actionsRow.appendChild(closeBtn);
        throw err;
    }
}
