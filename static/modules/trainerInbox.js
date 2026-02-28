/**
 * Trainer inbox: shows returned/rejected tasks so the trainer knows what needs attention.
 * Fetches from GET /api/trainer-inbox and renders a compact list.
 */
import { createPoller } from './poll.js';

const INBOX_ID = 'trainerInbox';
const LIST_ID = 'trainerInboxList';
const COUNT_ID = 'trainerInboxCount';
const REFRESH_ID = 'trainerInboxRefresh';

export async function refreshTrainerInbox() {
    const container = document.getElementById(INBOX_ID);
    const listEl = document.getElementById(LIST_ID);
    const countEl = document.getElementById(COUNT_ID);
    if (!container || !listEl) return;

    try {
        const res = await fetch('/api/trainer-inbox', { cache: 'no-store' });
        if (!res.ok) { container.classList.add('hidden'); return; }
        const data = await res.json();
        const tasks = data.tasks || [];

        if (tasks.length === 0) {
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');
        if (countEl) countEl.textContent = tasks.length;
        listEl.innerHTML = '';

        for (const task of tasks) {
            const li = document.createElement('li');
            li.style.cssText = 'padding: 0.35rem 0; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 0.5rem;';

            const statusBadge = task.review_status === 'rejected'
                ? '<span style="font-size:0.7rem; font-weight:600; text-transform:uppercase; padding:0.1rem 0.4rem; border-radius:3px; background:rgba(235,87,87,0.12); color:var(--danger);">rejected</span>'
                : '<span style="font-size:0.7rem; font-weight:600; text-transform:uppercase; padding:0.1rem 0.4rem; border-radius:3px; background:rgba(235,176,52,0.15); color:#ebb034;">returned</span>';

            const comment = task.review_feedback?.overall_comment || '';
            const preview = comment.length > 80 ? comment.slice(0, 80) + '\u2026' : comment;

            const taskId = task.task_display_id || '';
            const idLabel = taskId
                ? `<code style="font-size:0.8rem; font-weight:700; color:var(--accent);">${_escapeHtml(taskId)}</code><span style="font-size:0.68rem; color:var(--text-muted); font-family:var(--font-mono);">${task.session_id.slice(0, 8)}</span>`
                : `<code style="font-size:0.8rem; color:var(--text-primary);">${task.session_id.slice(0, 12)}\u2026</code>`;

            li.innerHTML = `
                ${idLabel}
                ${statusBadge}
                ${preview ? `<span style="color:var(--text-muted); font-size:0.8rem;">${_escapeHtml(preview)}</span>` : ''}
            `;
            listEl.appendChild(li);
        }
    } catch {
        container.classList.add('hidden');
    }
}

export function initTrainerInbox() {
    const btn = document.getElementById(REFRESH_ID);
    if (btn) btn.addEventListener('click', refreshTrainerInbox);
    refreshTrainerInbox();
    createPoller(refreshTrainerInbox, 30_000);
}

function _escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}
