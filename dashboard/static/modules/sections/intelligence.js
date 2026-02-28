/**
 * Intelligence section
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { CRITERIA_MAX_ROWS, FAILURE_REASONS_MAX, JUDGE_DRIFT_WEEKS } from '../config.js';

let _whatIfInitialized = false;

export async function loadIntelligence() {
    const [criteria, judge, prompts, mlInfo] = await Promise.all([
        api('criteria'), api('judge'), api('prompts'), api('ml-info')
    ]);

    if (criteria?.criteria_stats) {
        const rows = criteria.criteria_stats.slice(0, CRITERIA_MAX_ROWS);
        document.getElementById('criteriaTableBody').innerHTML = rows.map(c => `
            <tr>
                <td>${esc(c.id)}</td>
                <td><span class="badge badge-${c.type === 'formatting' ? 'warning' : c.type === 'safety' ? 'danger' : 'muted'}">${c.type}</span></td>
                <td><strong>${c.fail_rate}%</strong></td>
                <td>${c.total}</td>
            </tr>
        `).join('');
    }

    if (judge?.drift?.length > 0) {
        renderJudgeDrift(judge.drift.slice(-JUDGE_DRIFT_WEEKS));
    }

    if (judge?.top_failure_reasons) {
        const rows = judge.top_failure_reasons.slice(0, FAILURE_REASONS_MAX);
        document.getElementById('failureReasonsList').innerHTML = rows.map(r => `
            <div class="list-row">
                <span>${esc(r.reason)}</span>
                <span class="badge badge-danger">${r.count}</span>
            </div>
        `).join('') || '<div style="color:var(--text-muted);font-size:0.82rem;">No failure data yet</div>';
    }

    if (prompts?.clusters) {
        document.getElementById('promptClusterBody').innerHTML = prompts.clusters.map(c => `
            <tr>
                <td><strong>${esc(c.name)}</strong></td>
                <td style="font-size:0.75rem;color:var(--text-muted);">${c.top_terms?.join(', ') || ''}</td>
                <td>${c.count}</td>
            </tr>
        `).join('') || '<tr><td colspan="3" style="color:var(--text-muted);">Need 10+ prompts for clustering</td></tr>';
    }

    if (prompts?.domains) {
        document.getElementById('domainList').innerHTML = prompts.domains.map(d => `
            <div class="list-row">
                <span class="badge badge-accent">${d.domain}</span>
                <span>${d.count} sessions</span>
            </div>
        `).join('') || '<div style="color:var(--text-muted);font-size:0.82rem;">No data yet</div>';
    }

    document.getElementById('whatifStatus').textContent = mlInfo?.loaded
        ? `Model loaded (${mlInfo.accuracy || 'unknown'} accuracy, ${mlInfo.n_samples || '?'} samples)`
        : 'ML model not loaded - predictions unavailable';

    setupWhatIf(mlInfo?.loaded);
}

function renderJudgeDrift(drift) {
    const container = document.getElementById('judgeDriftBars');
    if (!container) return;
    if (drift.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No judge data yet</div>';
        return;
    }
    container.innerHTML = drift.map(d => {
        const pct = Math.min(d.pass_rate, 100);
        const color = pct > 60 ? 'var(--success)' : pct > 40 ? 'var(--warning)' : 'var(--danger)';
        return `<div class="drift-row">
            <span class="drift-week">${esc(d.week)}</span>
            <div class="drift-bar-bg"><div class="drift-bar-fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="drift-pct">${d.pass_rate}%</span>
        </div>`;
    }).join('');
}

function setupWhatIf(mlLoaded) {
    if (!mlLoaded || _whatIfInitialized) return;
    _whatIfInitialized = true;
    ['whatifCriteria', 'whatifModel', 'whatifFormatting', 'whatifBudget'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', runWhatIf);
    });
    runWhatIf();
}

async function runWhatIf() {
    const criteria = parseInt(document.getElementById('whatifCriteria')?.value || 5);
    const model = parseInt(document.getElementById('whatifModel')?.value || 1);
    const formatting = parseInt(document.getElementById('whatifFormatting')?.value || 0);
    const budget = parseInt(document.getElementById('whatifBudget')?.value || 90);

    document.getElementById('whatifCriteriaVal').textContent = criteria;
    document.getElementById('whatifBudgetVal').textContent = budget + '%';

    const features = {
        num_criteria: criteria, model_is_qwen: model,
        has_formatting_criteria: formatting, reasoning_budget: budget / 100
    };

    try {
        const res = await fetch('/api/what-if', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base_features: { num_criteria: 5, model_is_qwen: 1, has_formatting_criteria: 0, reasoning_budget: 0.9 }, changes: features })
        });
        if (res.ok) {
            const data = await res.json();
            if (data.new_probability !== undefined) {
                const prob = (data.new_probability * 100).toFixed(1);
                const el = document.getElementById('whatifProb');
                el.textContent = prob + '%';
                el.style.color = data.new_probability > 0.7 ? 'var(--success)' : data.new_probability > 0.4 ? 'var(--warning)' : 'var(--danger)';
                const deltaEl = document.getElementById('whatifDelta');
                if (data.delta != null && deltaEl) {
                    const d = (data.delta * 100).toFixed(1);
                    deltaEl.textContent = `${data.delta > 0 ? '+' : ''}${d}% vs baseline`;
                    deltaEl.style.color = data.delta > 0 ? 'var(--success)' : 'var(--danger)';
                }
            }
        }
    } catch {}
}
