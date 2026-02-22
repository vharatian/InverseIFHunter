/**
 * In-app notifications for the trainer app.
 * Bell icon with unread badge, dropdown panel, polling.
 */
import { createPoller } from './poll.js';

const POLL_INTERVAL = 15000;
let _poller = null;
let _onNavigate = null;

export function initNotifications({ onNavigateToTask } = {}) {
    _onNavigate = onNavigateToTask || null;
    const bell = document.getElementById('notifBell');
    if (!bell) return;

    bell.addEventListener('click', _togglePanel);

    document.addEventListener('click', (e) => {
        const panel = document.getElementById('notifPanel');
        if (panel && !panel.hidden && !panel.contains(e.target) && !bell.contains(e.target)) {
            panel.hidden = true;
        }
    });

    const markAllBtn = document.getElementById('notifMarkAllRead');
    if (markAllBtn) markAllBtn.addEventListener('click', _markAllRead);

    _poller = createPoller(_fetchAndRender, POLL_INTERVAL);
    _fetchAndRender();
}

export function stopNotifications() {
    if (_poller) { _poller(); _poller = null; }
}

function _getEmail() {
    return (localStorage.getItem('trainer_email') || '').trim().toLowerCase();
}

function _headers() {
    const email = _getEmail();
    const h = { 'Content-Type': 'application/json' };
    if (email) h['X-Trainer-Email'] = email;
    return h;
}

async function _fetchAndRender() {
    const email = _getEmail();
    if (!email) return;
    try {
        const res = await fetch('/api/notifications', { headers: _headers() });
        if (!res.ok) return;
        const data = await res.json();
        _renderBadge(data.unread_count || 0);
        _renderPanel(data.notifications || []);
    } catch { /* silent */ }
}

function _renderBadge(count) {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
}

function _renderPanel(notifications) {
    const list = document.getElementById('notifList');
    if (!list) return;
    if (notifications.length === 0) {
        list.innerHTML = '<li class="notif-empty">No notifications</li>';
        return;
    }
    list.innerHTML = notifications.map(n => {
        const icon = _iconForType(n.type);
        const time = _relativeTime(n.created_at);
        const readCls = n.read ? 'notif-read' : 'notif-unread';
        const taskLabel = n.task_display_id ? `<span class="notif-task-id">${_esc(n.task_display_id)}</span>` : '';
        return `<li class="notif-item ${readCls}" data-id="${_esc(n.id)}" data-session="${_esc(n.session_id)}">
            <span class="notif-icon">${icon}</span>
            <div class="notif-body">
                <div class="notif-message">${taskLabel} ${_esc(n.message)}</div>
                <div class="notif-time">${time}</div>
            </div>
        </li>`;
    }).join('');

    list.querySelectorAll('.notif-item').forEach(li => {
        li.addEventListener('click', () => {
            const id = li.dataset.id;
            const sessionId = li.dataset.session;
            _markRead(id);
            if (_onNavigate && sessionId) _onNavigate(sessionId);
            const panel = document.getElementById('notifPanel');
            if (panel) panel.hidden = true;
        });
    });
}

function _togglePanel() {
    const panel = document.getElementById('notifPanel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) _fetchAndRender();
}

async function _markRead(notifId) {
    try {
        await fetch(`/api/notifications/${notifId}/read`, { method: 'POST', headers: _headers() });
        _fetchAndRender();
    } catch { /* silent */ }
}

async function _markAllRead() {
    try {
        await fetch('/api/notifications/read-all', { method: 'POST', headers: _headers() });
        _fetchAndRender();
    } catch { /* silent */ }
}

function _iconForType(type) {
    switch (type) {
        case 'task_returned': return '\u21A9';
        case 'task_approved': return '\u2714';
        case 'task_rejected': return '\u2718';
        case 'task_colab_saved': return '\uD83D\uDCBE';
        default: return '\uD83D\uDD14';
    }
}

function _relativeTime(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
}
