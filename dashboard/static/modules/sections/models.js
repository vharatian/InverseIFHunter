/**
 * Models section
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { TABLE_MAX_ROWS } from '../config.js';

export async function loadModels() {
    const models = await api('models');
    if (!models) return;

    const rows = models.slice(0, TABLE_MAX_ROWS);
    document.getElementById('modelsTableBody').innerHTML = rows.map(m => `
        <tr>
            <td><strong>${esc(m.model.split('/').pop())}</strong></td>
            <td>${m.hunts}</td>
            <td>${m.breaks}</td>
            <td><strong>${m.break_rate}%</strong></td>
            <td>${m.p50_latency}ms</td>
            <td>${m.p95_latency}ms</td>
        </tr>
    `).join('');

    const modelsWithVuln = models.filter(m => m.vulnerability && Object.keys(m.vulnerability).length > 0);
    if (modelsWithVuln.length > 0 && typeof Plotly !== 'undefined') {
        const allTypes = [...new Set(modelsWithVuln.flatMap(m => Object.keys(m.vulnerability)))];
        const traces = modelsWithVuln.map(m => ({
            y: allTypes,
            x: allTypes.map(t => m.vulnerability[t] || 0),
            name: m.model.split('/').pop(),
            type: 'bar',
            orientation: 'h',
        }));
        Plotly.newPlot('vulnerabilityChart', traces, {
            barmode: 'group',
            paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
            font: { color: '#9ca3af', size: 11 },
            margin: { l: 100, r: 20, t: 10, b: 40 },
            xaxis: { title: 'Fail Rate %', gridcolor: '#2a2d3a' },
            yaxis: { gridcolor: '#2a2d3a' },
            legend: { orientation: 'h', y: -0.2 }
        }, { responsive: true });
    }
}
