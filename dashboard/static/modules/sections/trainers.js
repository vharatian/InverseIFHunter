/**
 * Trainers section
 */
import { api } from '../api.js';
import { esc, formatTime, metricCard } from '../utils.js';
import { TABLE_MAX_ROWS } from '../config.js';

export async function loadTrainers() {
    const [trainers, online] = await Promise.all([api('trainers'), api('online-trainers')]);

    const roster = document.getElementById('onlineRoster');
    if (online?.length > 0) {
        roster.innerHTML = online.map(t => `
            <div style="display:inline-flex;align-items:center;gap:0.4rem;padding:0.3rem 0.7rem;margin:0.2rem;background:var(--bg-hover);border-radius:20px;font-size:0.8rem;">
                <span class="status-dot ${t.status}"></span>${esc(t.name)}
            </div>
        `).join('');
    } else {
        roster.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No trainers online</div>';
    }

    const tbody = document.getElementById('trainerTableBody');
    if (trainers?.length > 0) {
        const rows = trainers.slice(0, TABLE_MAX_ROWS);
        tbody.innerHTML = rows.map((t, i) => `
            <tr data-email="${esc(t.email)}">
                <td>${i + 1}</td>
                <td><strong>${esc(t.name)}</strong></td>
                <td style="color:var(--text-muted);font-size:0.78rem;">${esc(t.email)}</td>
                <td><span class="status-dot ${t.status}"></span>${t.status}</td>
                <td>${t.active_hours}h</td>
                <td>${t.total_hunts}</td>
                <td>${t.total_breaks}</td>
                <td><strong>${t.breaks_per_hour}</strong></td>
                <td style="font-size:0.75rem;color:var(--text-muted);">${formatTime(t.last_seen)}</td>
            </tr>
        `).join('');
    } else {
        tbody.innerHTML = '<tr><td colspan="9" style="color:var(--text-muted);">No trainers yet</td></tr>';
    }
}

export async function openTrainerDrilldown(email) {
    const data = await api(`trainer/${encodeURIComponent(email)}`);
    if (!data) return;

    const panel = document.getElementById('drilldownPanel');
    const content = document.getElementById('drilldownContent');

    let calendarHtml = '';
    if (data.calendar?.length > 0) {
        calendarHtml = '<div class="calendar-heatmap">' + data.calendar.map(d => {
            const level = d.count === 0 ? '' : d.count <= 3 ? 'level-1' : d.count <= 8 ? 'level-2' : d.count <= 15 ? 'level-3' : 'level-4';
            return `<div class="calendar-cell ${level}" title="${d.date}: ${d.count} events"></div>`;
        }).join('') + '</div>';
    }

    content.innerHTML = `
        <h3 style="margin-bottom:0.5rem;">${esc(data.name)}</h3>
        <p style="color:var(--text-muted);font-size:0.82rem;margin-bottom:1rem;">${esc(data.email)}</p>
        <div class="metrics-grid" style="grid-template-columns:repeat(3,1fr);">
            ${metricCard('Active Hours', data.active_hours + 'h', '', '')}
            ${metricCard('Breaks/Hour', data.breaks_per_hour, '', '')}
            ${metricCard('Total Breaks', data.total_breaks, '', '')}
        </div>
        <div class="card" style="margin-top:1rem;">
            <div class="card-title" style="margin-bottom:0.5rem;">Insight</div>
            <p style="font-size:0.85rem;color:var(--text-secondary);">${esc(data.insight)}</p>
        </div>
        <div class="card" style="margin-top:1rem;">
            <div class="card-title" style="margin-bottom:0.5rem;">Activity Calendar (90 days)</div>
            ${calendarHtml}
        </div>
    `;

    panel.classList.add('open');
    document.getElementById('drilldownBackdrop').classList.add('open');
}
