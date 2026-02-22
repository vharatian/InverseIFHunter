/**
 * Quality Check — shared constants and helpers.
 * Used by overlay and persistent section.
 */
import { escapeHtml } from './utils.js';

export const RULE_LABELS = {
    model_consistency: { title: 'Model consistency', description: 'All 4 selected responses must be from the same model.' },
    human_llm_grade_alignment: { title: 'Human vs LLM grade alignment', description: 'Human grades and LLM judge results should be broadly aligned.' },
    metadata_prompt_alignment: { title: 'Prompt matches metadata', description: 'Prompt content aligns with claimed Domain and Use Case.' },
    metadata_taxonomy_alignment: { title: 'Taxonomy alignment', description: 'L1 Taxonomy is consistent with Domain and Use Case.' },
    human_explanation_justifies_grade: { title: 'Explanation quality', description: 'Human explanations are substantive and justify grades.' },
    safety_context_aware: { title: 'Safety check', description: 'Prompt does not request prohibited content (context-aware).' },
    qc_cfa_criteria_valid: { title: 'QC/CFA criteria', description: 'Criteria are valid for QC/CFA taxonomies.' },
};

export function renderContentChecked(contentChecked) {
    if (!contentChecked) return '';
    const parts = [];
    if (contentChecked.check) parts.push(`<div class="qc-content-check">${escapeHtml(contentChecked.check)}</div>`);
    if (contentChecked.models?.length) parts.push(`<div class="qc-content-models">Models: ${escapeHtml([...new Set(contentChecked.models)].join(', '))}</div>`);
    if (contentChecked.slots?.length) {
        const slotSummaries = contentChecked.slots.map((s, i) => {
            const slotNum = s.slot ?? i + 1;
            const label = s.model ? `Slot ${slotNum} (${s.model})` : `Slot ${slotNum}`;
            if (s.explanation !== undefined) {
                return `${label}: ${s.explanation ? s.explanation : '—'}`;
            }
            const grades = s.human_grades ? Object.entries(s.human_grades).map(([k, v]) => `${k}=${v}`).join(', ') : '—';
            return `${label}: ${grades}`;
        });
        parts.push(`<div class="qc-content-slots">${slotSummaries.map(s => escapeHtml(s)).join('<br>')}</div>`);
    }
    if (contentChecked.criteria?.length) {
        const crits = contentChecked.criteria.map(c => `${c.id}: ${(c.desc || '').slice(0, 80)}`).join('; ');
        parts.push(`<div class="qc-content-criteria">Criteria: ${escapeHtml(crits)}</div>`);
    }
    if (contentChecked.prompt_preview) parts.push(`<div class="qc-content-prompt">Prompt: ${escapeHtml(contentChecked.prompt_preview)}</div>`);
    return parts.length ? `<div class="qc-content-checked">${parts.join('')}</div>` : '';
}

export function renderIssueDetails(issue) {
    const labels = RULE_LABELS[issue.rule_id] || {};
    const title = labels.title || issue.rule_id;
    const d = issue.details || {};
    let html = `<div class="qc-eval-issue-block" data-rule="${escapeHtml(issue.rule_id)}">`;
    html += `<div class="qc-eval-issue-header"><strong>${escapeHtml(title)}</strong></div>`;
    html += `<div class="qc-eval-issue-message">${escapeHtml(issue.message)}</div>`;
    if (issue.hint) html += `<div class="qc-eval-hint">Hint: ${escapeHtml(issue.hint)}</div>`;
    if (issue.rule_id === 'model_consistency' && d.slots) {
        const models = [...new Set(d.slots.map(s => s.model).filter(Boolean))];
        if (models.length) html += `<div class="qc-eval-hint">Models: ${escapeHtml(models.join(', '))}</div>`;
    }
    if (d.council_votes?.length) {
        html += '<div class="qc-eval-council-inline">';
        d.council_votes.forEach(v => {
            const vote = v.vote || '?';
            html += `<span class="qc-vote qc-vote-${vote.toLowerCase()}">${escapeHtml(v.model || v.model_id || '?')}: ${escapeHtml(vote)}</span>`;
        });
        html += '</div>';
    }
    if (issue.rule_id === 'human_llm_grade_alignment' && d.slots?.length) {
        html += '<div class="qc-eval-subtitle">Slot-by-slot: Human vs LLM</div>';
        d.slots.forEach(slot => {
            const hasDisagreement = (slot.disagreements || []).length > 0;
            const humanGrades = slot.human_grades || {};
            const llmCriteria = slot.llm_judge_criteria || {};
            const allKeys = new Set([...Object.keys(humanGrades), ...Object.keys(llmCriteria)]);
            let critHtml = '';
            allKeys.forEach(cid => {
                const h = (humanGrades[cid] || '').toLowerCase();
                const l = (llmCriteria[cid] || '').toLowerCase();
                const isMismatch = h && l && h !== l;
                const cls = isMismatch ? 'qc-eval-crit mismatch' : (h || l) === 'pass' ? 'qc-eval-crit pass' : 'qc-eval-crit fail';
                const label = isMismatch ? `${cid}: You=${h} vs LLM=${l}` : `${cid}: ${h || l || '—'}`;
                critHtml += `<span class="${cls}">${escapeHtml(label)}</span>`;
            });
            html += `<div class="qc-eval-slot ${hasDisagreement ? 'has-disagreement' : ''}">`;
            html += `<div class="qc-eval-slot-header">Slot ${slot.slot || '?'} — ${escapeHtml(slot.model || '')} ${hasDisagreement ? '<span class="qc-eval-mismatch-badge">Disagreement</span>' : ''}</div>`;
            html += `<div class="qc-eval-slot-criteria">${critHtml || '<span class="qc-eval-empty">No criteria</span>'}</div>`;
            if (slot.human_explanation) html += `<div class="qc-eval-slot-explanation"><strong>Your explanation:</strong> ${escapeHtml(slot.human_explanation)}</div>`;
            if (slot.llm_judge_explanation) html += `<div class="qc-eval-slot-explanation"><strong>LLM:</strong> ${escapeHtml(slot.llm_judge_explanation)}</div>`;
            html += '</div>';
        });
    }
    if (issue.rule_id === 'human_explanation_justifies_grade' && d.slots?.length) {
        html += '<div class="qc-eval-subtitle">Slots with explanations</div>';
        d.slots.forEach(s => {
            html += `<div class="qc-eval-slot"><div class="qc-eval-slot-header">Slot ${s.slot || '?'}</div>`;
            html += `<div class="qc-eval-slot-explanation">${escapeHtml(s.explanation || '(empty)')}</div></div>`;
        });
    }
    if (d.prompt_preview) html += `<div class="qc-eval-hint">Prompt: ${escapeHtml(d.prompt_preview)}</div>`;
    if (d.domain || d.use_case || d.l1_taxonomy) {
        html += `<div class="qc-eval-hint">Metadata: Domain=${escapeHtml(d.domain || '—')}, Use Case=${escapeHtml(d.use_case || '—')}, L1=${escapeHtml(d.l1_taxonomy || '—')}</div>`;
    }
    html += '</div>';
    return html;
}

export function buildCopyReport(result) {
    const lines = ['Quality Check Report', '==================', result.passed ? 'Result: PASSED' : 'Result: FAILED', ''];
    (result.issues || []).forEach((i, idx) => {
        const labels = RULE_LABELS[i.rule_id] || {};
        lines.push(`${idx + 1}. ${labels.title || i.rule_id}`, `   ${i.message}`, i.hint ? `   Hint: ${i.hint}` : '', '');
    });
    return lines.join('\n');
}
