/**
 * Costs section
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { metricCard } from '../utils.js';
import { BURN_RATE_DAYS } from '../config.js';

export async function loadCosts() {
    const costs = await api('costs');
    if (!costs) return;

    document.getElementById('costMetrics').innerHTML = [
        metricCard('Total Cost', `$${costs.total_cost?.toFixed(2) || '0.00'}`, '', ''),
        metricCard('Cost Per Break', `$${costs.cost_per_break?.toFixed(4) || '0.00'}`, '', ''),
        metricCard('Total Breaks', costs.total_breaks || 0, '', ''),
    ].join('');

    const byModel = (costs.by_model || []).slice(0, 10);
    document.getElementById('costByModel').innerHTML = byModel.map(m => `
        <div class="list-row">
            <span>${esc(m.model.split('/').pop())}</span>
            <strong>$${m.cost.toFixed(4)}</strong>
        </div>
    `).join('') || '<div style="color:var(--text-muted);">No cost data</div>';

    const byTrainer = (costs.by_trainer || []).slice(0, 8);
    document.getElementById('costByTrainer').innerHTML = byTrainer.map(t => `
        <div class="list-row">
            <span>${esc(t.name || t.email)}</span>
            <strong>$${t.cost.toFixed(4)}</strong>
        </div>
    `).join('') || '<div style="color:var(--text-muted);">No data</div>';

    const burnContainer = document.getElementById('burnRateBars');
    const burnRate = (costs.burn_rate || []).slice(-BURN_RATE_DAYS);
    if (burnRate.length > 0 && burnContainer) {
        const maxCost = Math.max(...burnRate.map(d => d.cost), 0.001);
        burnContainer.innerHTML = burnRate.map(d => {
            const pct = Math.min((d.cost / maxCost) * 100, 100);
            return `<div class="burn-row">
                <span class="burn-date">${d.date.slice(5)}</span>
                <div class="burn-bar-bg"><div class="burn-bar-fill" style="width:${pct}%"></div></div>
                <span class="burn-val">$${d.cost.toFixed(3)}</span>
            </div>`;
        }).join('');
    } else if (burnContainer) {
        burnContainer.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No cost data yet</div>';
    }
}
