/**
 * System section
 */
import { api } from '../api.js';
import { esc, formatTime } from '../utils.js';
import { state } from '../state.js';
import { loadAdminList, loadTestAccounts } from '../admin.js';

export async function loadSystem() {
    const system = await api('system');
    if (!system) return;

    const providers = system.provider_health || {};
    document.getElementById('providerTableBody').innerHTML = Object.entries(providers).map(([name, p]) => `
        <tr>
            <td><strong>${esc(name)}</strong></td>
            <td><span class="badge badge-${p.status === 'ok' ? 'success' : p.status === 'degraded' ? 'warning' : 'danger'}">${p.status}</span></td>
            <td>${p.total_calls}</td>
            <td>${p.error_rate}%</td>
            <td>${p.p50_latency}ms</td>
            <td>${p.p95_latency}ms</td>
        </tr>
    `).join('') || '<tr><td colspan="6" style="color:var(--text-muted);">No data</td></tr>';

    const anomalies = system.anomalies || [];
    document.getElementById('anomaliesList').innerHTML = anomalies.length > 0
        ? anomalies.slice(0, 5).map(a => `
            <div class="anomaly-row">
                <span class="badge badge-${a.severity === 'critical' ? 'danger' : 'warning'}">${a.severity}</span>
                <span>${esc(a.description)}</span>
                <span class="anomaly-time">${formatTime(a.timestamp)}</span>
            </div>
        `).join('')
        : '<div style="color:var(--text-muted);font-size:0.82rem;">No anomalies detected</div>';

    document.getElementById('cacheStatus').textContent = `Cache: ${system.cache_age_seconds}s ago (${system.total_events} events, ${system.compute_time_ms}ms)`;

    if (state.isSuperAdmin) {
        document.getElementById('adminManagementCard').style.display = 'block';
        document.getElementById('testAccountCard').style.display = 'block';
        await Promise.all([loadAdminList(), loadTestAccounts()]);
    }
}
