/**
 * Quality Check — persistent section below gradings.
 * Shows last QC result so trainers can review anytime.
 */
import { escapeHtml } from './utils.js';
import { RULE_LABELS, renderContentChecked, renderIssueDetails, buildCopyReport } from './qcShared.js';
import { createTabbedUI } from './qcTabs.js';

const STORAGE_KEY_PREFIX = 'quality_check_evaluation_';

/**
 * Get stored evaluation for session.
 */
export function getStoredEvaluation(sessionId) {
    if (!sessionId) return null;
    try {
        const raw = sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${sessionId}`);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/**
 * Render the persistent Quality Check section HTML.
 */
function renderPersistentSection(result, sessionId) {
    const totalRules = result.total_rules || 0;
    const failCount = (result.issues || []).length;
    const passed = result.passed;

    const summaryHtml = passed
        ? '<span class="qc-summary-pass">✓ All checks passed.</span>'
        : `<span class="qc-summary-fail">✗ ${failCount} of ${totalRules} rules failed.</span>`;

    const rulesData = result.rules_data || [];
    const rulesHtml = rulesData.map(r => {
        const labels = RULE_LABELS[r.rule_id] || {};
        const status = r.passed === true ? 'pass' : r.passed === false ? 'fail' : 'pending';
        const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '—';
        const content = renderContentChecked(r.content_checked);
        return `<div class="qc-rule-card qc-rule-${status}" data-rule="${escapeHtml(r.rule_id)}">
            <div class="qc-rule-header">
                <span class="qc-rule-title">${escapeHtml(labels.title || r.rule_id)}</span>
                <span class="qc-rule-status qc-status-${status}">${icon} ${status === 'pass' ? 'Passed' : status === 'fail' ? 'Failed' : '—'}</span>
            </div>
            ${content || ''}
        </div>`;
    }).join('');

    const failedHtml = (result.issues || []).length
        ? (result.issues || []).map(i => renderIssueDetails(i)).join('')
        : '<p class="qc-eval-empty">No issues.</p>';

    const evaluation = result.evaluation || {};
    const prompt = evaluation.prompt || '';
    const criteria = evaluation.criteria || [];
    const detailsHtml = prompt || criteria.length
        ? `<pre class="qc-eval-prompt">${escapeHtml(prompt)}</pre>
           ${criteria.length ? '<div class="qc-eval-criteria">' + criteria.map(c => `<div><strong>${escapeHtml(c.id || '?')}</strong>: ${escapeHtml((c.description || '').slice(0, 150))}</div>`).join('') + '</div>' : ''}`
        : '<p class="qc-eval-empty">No details.</p>';

    return { summaryHtml, rulesHtml, failedHtml, detailsHtml, rulesData: result.rules_data || [] };
}

/**
 * Create and mount the persistent Quality Check section.
 * @param {HTMLElement} parent - Parent to append to (e.g. results card)
 * @param {Object} result - QC result { passed, issues, evaluation, total_rules, rules_data }
 * @param {string} sessionId
 */
export function renderQCPersistentSection(parent, result, sessionId) {
    if (!parent || !result) return null;

    document.getElementById('qcPersistentSection')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'qcPersistentSection';
    wrap.className = 'qc-persistent-section';

    const { summaryHtml, rulesHtml, failedHtml, detailsHtml, rulesData } = renderPersistentSection(result, sessionId);

    const ruleTabIds = (rulesData || []).map(r => `rule_${r.rule_id}`);
    const ruleTabLabels = (rulesData || []).map(r => {
        const labels = RULE_LABELS[r.rule_id] || {};
        const status = r.passed === true ? '✓' : r.passed === false ? '✗' : '—';
        return `${status} ${labels.title || r.rule_id}`;
    });
    const tabIds = ['summary', ...ruleTabIds, 'failed', 'details'];
    const tabLabels = ['Summary', ...ruleTabLabels, 'What Failed', 'Details'];

    const tabs = createTabbedUI({
        tabIds,
        tabLabels,
        defaultTab: result.passed ? 'summary' : 'failed',
    });

    tabs.panes.summary.innerHTML = `
        <div class="qc-summary ${result.passed ? 'qc-summary-pass' : 'qc-summary-fail'}">${summaryHtml}</div>
        <p class="qc-persistent-hint">Last quality check result. Re-run by clicking "Proceed to Quality Check".</p>
    `;
    (rulesData || []).forEach((r) => {
        const content = renderContentChecked(r.content_checked);
        const labels = RULE_LABELS[r.rule_id] || {};
        const paneId = `rule_${r.rule_id}`;
        const councilVotes = r.council_votes || r.issue?.details?.council_votes || [];
        const chairmanModel = r.chairman_model;
        const chairmanVerdict = r.chairman_verdict;
        const chairmanRationale = r.chairman_rationale;
        const hasChairman = chairmanModel && chairmanVerdict != null;
        let councilHtml = '';
        if (councilVotes.length || hasChairman) {
            councilHtml = '<div class="qc-council-votes"><div class="qc-council-title">Council votes:</div><div class="qc-council-list">' +
                councilVotes.map(v => `<span class="qc-vote qc-vote-${(v.vote || '').toLowerCase()}">${escapeHtml(v.model || v.model_id || '?')}: ${escapeHtml(v.vote || '?')}</span>`).join('') +
                '</div></div>';
            if (hasChairman) {
                councilHtml += '<div class="qc-chairman-section"><div class="qc-council-title">Chairman (' + escapeHtml(chairmanModel) + '):</div>' +
                    '<div class="qc-chairman-rationale">' + escapeHtml((chairmanRationale || '').trim() || '(no reasoning)') + '</div>' +
                    '<div class="qc-chairman-verdict qc-vote qc-vote-' + (chairmanVerdict || '').toLowerCase() + '">' + escapeHtml(chairmanVerdict || '?') + '</div></div>';
            }
        }
        if (tabs.panes[paneId]) {
            tabs.panes[paneId].innerHTML = `
                <div class="qc-rule-card qc-rule-${r.passed === true ? 'pass' : r.passed === false ? 'fail' : 'pending'}" data-rule="${escapeHtml(r.rule_id)}">
                    <div class="qc-rule-header">
                        <span class="qc-rule-title">${escapeHtml(labels.title || r.rule_id)}</span>
                        <span class="qc-rule-status qc-status-${r.passed === true ? 'pass' : r.passed === false ? 'fail' : 'pending'}">${r.passed === true ? '✓ Passed' : r.passed === false ? '✗ Failed' : '—'}</span>
                    </div>
                    <div class="qc-rule-desc">${escapeHtml(labels.description || '')}</div>
                    ${content || ''}
                    ${councilHtml}
                </div>
            `;
        }
    });
    tabs.panes.failed.innerHTML = `
        <div class="qc-eval-section">
            <div class="qc-eval-title">What failed <span class="qc-eval-count">(${(result.issues || []).length} of ${result.total_rules || 0} rules)</span></div>
            ${failedHtml}
        </div>
    `;
    tabs.panes.details.innerHTML = `<div class="qc-eval-details-pane">${detailsHtml}</div>`;

    const header = document.createElement('div');
    header.className = 'qc-persistent-header';
    header.innerHTML = `
        <h3 class="qc-persistent-title"><span class="qc-persistent-icon">✓</span> Quality Check</h3>
        <button class="qc-btn qc-btn-ghost qc-copy-report-btn" title="Copy report">Copy report</button>
    `;
    header.querySelector('.qc-copy-report-btn').onclick = async () => {
        try {
            await navigator.clipboard.writeText(buildCopyReport(result));
            const btn = header.querySelector('.qc-copy-report-btn');
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy report'; }, 1500);
        } catch (_) {}
    };

    wrap.appendChild(header);
    wrap.appendChild(tabs.container);
    parent.appendChild(wrap);
    return wrap;
}

/**
 * Update existing persistent section with new result.
 */
export function updateQCPersistentSection(result, sessionId) {
    const wrap = document.getElementById('qcPersistentSection');
    if (!wrap) return;
    wrap.remove();
    const parent = document.getElementById('qcPersistentParent');
    if (parent) renderQCPersistentSection(parent, result, sessionId);
}
