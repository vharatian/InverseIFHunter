/**
 * Command Center section
 */
import { api } from '../api.js';
import { metricCard, deltaClass, deltaText, esc } from '../utils.js';
import { startLiveFeed } from '../live-feed.js';

export async function loadCommandCenter() {
    const [overview, anomalies, online] = await Promise.all([
        api('overview'), api('anomalies'), api('online-trainers')
    ]);

    const banner = document.getElementById('anomalyBanner');
    if (anomalies?.length > 0) {
        const worst = anomalies.find(a => a.severity === 'critical') || anomalies[0];
        document.getElementById('anomalyText').textContent = worst.description;
        banner.className = `anomaly-banner visible ${worst.severity}`;
    } else {
        banner.className = 'anomaly-banner';
    }

    if (overview) {
        document.getElementById('overviewMetrics').innerHTML = [
            metricCard('Active Trainers', overview.active_trainers, '', overview.idle_trainers ? `+${overview.idle_trainers} idle` : ''),
            metricCard('Sessions Today', overview.sessions_today, deltaClass(overview.sessions_delta), deltaText(overview.sessions_delta)),
            metricCard('Hunts Today', overview.hunts_today, deltaClass(overview.hunts_delta), deltaText(overview.hunts_delta)),
            metricCard('Breaks Today', overview.breaks_today, deltaClass(overview.breaks_delta), deltaText(overview.breaks_delta)),
            metricCard('Cost Today', `$${overview.cost_today?.toFixed(2) || '0.00'}`, '', ''),
        ].join('');
    }

    const list = document.getElementById('activeTrainersList');
    if (online?.length > 0) {
        list.innerHTML = online.map(t => `
            <div class="feed-event">
                <span class="status-dot ${t.status}"></span>
                <span style="font-weight:600;">${esc(t.name)}</span>
                <span style="color:var(--text-muted);font-size:0.75rem;">${esc(t.email)}</span>
            </div>
        `).join('');
    } else {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No trainers currently active</div>';
    }

    startLiveFeed();
}
