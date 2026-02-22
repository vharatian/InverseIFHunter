/**
 * Sessions section
 */
import { api } from '../api.js';
import { esc, formatTime } from '../utils.js';
import { TABLE_MAX_ROWS } from '../config.js';

export async function loadSessions() {
    const sessions = await api('sessions?limit=50');
    if (!sessions) return;
    const rows = sessions.slice(0, TABLE_MAX_ROWS);
    document.getElementById('sessionsTableBody').innerHTML = rows.map(s => `
        <tr data-session-id="${esc(s.session_id)}">
            <td style="font-family:monospace;font-size:0.78rem;">${s.session_id.slice(0, 8)}</td>
            <td>${esc(s.filename || '-')}</td>
            <td>${esc(s.trainer_name || s.trainer_id || '-')}<br><span style="font-size:0.72rem;color:var(--text-muted);">${esc(s.trainer_email || '')}</span></td>
            <td style="font-size:0.75rem;">${formatTime(s.created_at)}</td>
            <td style="font-size:0.75rem;">${formatTime(s.last_accessed)}</td>
        </tr>
    `).join('');
}

export async function loadSessionReplay(sessionId) {
    const events = await api(`session-replay/${sessionId}`);
    if (!events) return;

    document.getElementById('replaySessionId').textContent = sessionId.slice(0, 8);
    const card = document.getElementById('sessionReplayCard');
    card.style.display = 'block';

    const timeline = document.getElementById('replayTimeline');
    timeline.innerHTML = events.map(e => {
        const cls = e.type === 'hunt_result' && e.data?.is_breaking ? 'break' :
            e.type === 'hunt_result' && e.data?.score === 1 ? 'success' :
            e.data?.error ? 'error' : '';
        const detail = formatEventDetail(e);
        return `<div class="replay-event ${cls}">
            <span class="replay-event-time">${formatTime(e.timestamp)}</span>
            <div class="replay-event-type">${e.type.replace(/_/g, ' ')}</div>
            <div class="replay-event-detail">${detail}</div>
        </div>`;
    }).join('');

    card.scrollIntoView({ behavior: 'smooth' });
}

function formatEventDetail(e) {
    const d = e.data || {};
    switch (e.type) {
        case 'session_created': return `Notebook: ${esc(d.notebook || '-')} (${d.source || 'unknown'})`;
        case 'hunt_start': return `${d.workers || '?'} workers, target: ${d.target_breaks || '?'} breaks`;
        case 'hunt_result': return `Hunt #${d.hunt_id || '?'}: ${d.is_breaking ? '🔴 BREAK' : d.score === 1 ? '🟢 PASS' : d.error ? '⚠️ ERROR' : '⏳'}`;
        case 'hunt_complete': return `${d.completed_hunts || 0} hunts, ${d.breaks_found || 0} breaks`;
        case 'api_call_end': return `${d.provider || ''} ${d.model?.split('/').pop() || ''} ${d.latency_ms || 0}ms ${d.success ? '✓' : '✗'}`;
        default: return JSON.stringify(d).slice(0, 100);
    }
}
