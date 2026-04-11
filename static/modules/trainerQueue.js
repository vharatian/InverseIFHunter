/**
 * Trainer Queue — Phase 4 homepage.
 *
 * Fetches GET /api/trainer-queue and renders:
 *   - Time-aware greeting
 *   - Smart focus card (most relevant next action)
 *   - Momentum strip (approved / submitted / drafts counts)
 *   - "Needs attention" (returned + active drafts)
 *   - "With reviewer" (submitted)
 *   - "Completed" (approved + rejected)
 *   - Empty state when no tasks
 *
 * Exports: initTrainerQueue, refreshQueue, showQueueView, showTaskView
 */
import { createPoller } from './poll.js';
import { state } from './state.js';
import { ADMIN_MODE_PASSWORD, getConfigValue } from './config.js';

// ── DOM refs (cached on init) ───────────────────────────────────
let els = {};

function cacheDom() {
    const id = (s) => document.getElementById(s);
    els = {
        view:             id('trainerQueueView'),
        taskView:         id('trainerTaskView'),
        greeting:         id('tqGreeting'),
        greetingSub:      id('tqGreetingSub'),
        focusCard:        id('tqFocusCard'),
        focusIcon:        id('tqFocusIcon'),
        focusTitle:       id('tqFocusTitle'),
        focusDetail:      id('tqFocusDetail'),
        focusBtn:         id('tqFocusBtn'),
        momentumApproved: id('tqMomentumApproved'),
        momentumSubmitted:id('tqMomentumSubmitted'),
        momentumDrafts:   id('tqMomentumDrafts'),
        momentum:         id('tqMomentum'),
        tabs:             id('tqTabs'),
        empty:            id('tqEmpty'),
        newTaskBtn:       id('tqNewTaskBtn'),
        backBtn:          id('tqBackBtn'),
    };

    // Tab panels and lists keyed by tab name
    _panels = {
        returned:  { panel: id('tqPanelReturned'),  list: id('tqReturnedList'),  empty: id('tqPanelReturnedEmpty'),  count: id('tqTabCountReturned') },
        waiting:   { panel: id('tqPanelWaiting'),   list: id('tqWaitingList'),   empty: id('tqPanelWaitingEmpty'),   count: id('tqTabCountWaiting') },
        drafts:    { panel: id('tqPanelDrafts'),    list: id('tqDraftsList'),    empty: id('tqPanelDraftsEmpty'),    count: id('tqTabCountDrafts') },
        completed: { panel: id('tqPanelCompleted'),  list: id('tqCompletedList'), empty: id('tqPanelCompletedEmpty'), count: id('tqTabCountCompleted') },
    };
}

// ── State ───────────────────────────────────────────────────────
let _onOpenTask = null;   // callback(sessionId) — set from app.js
let _onNewTask = null;    // callback() — set from app.js
let _stopPoller = null;
let _panels = {};         // populated by cacheDom
let _activeTab = 'returned';

// ── Public API ──────────────────────────────────────────────────

export function initTrainerQueue({ onOpenTask, onNewTask }) {
    cacheDom();
    _onOpenTask = onOpenTask;
    _onNewTask = onNewTask;

    if (els.newTaskBtn) els.newTaskBtn.addEventListener('click', () => _onNewTask?.());
    if (els.backBtn)    els.backBtn.addEventListener('click', showQueueView);

    // Tab switching
    if (els.tabs) {
        els.tabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.tq-tab');
            if (!btn) return;
            switchTab(btn.dataset.tab);
        });
    }

    showSkeletons();
    refreshQueue();
    _stopPoller = createPoller(refreshQueue, 30_000);
}

export async function refreshQueue() {
    try {
        const email = localStorage.getItem('trainer_email') || '';
        const res = await fetch('api/trainer-queue', {
            cache: 'no-store',
            headers: email ? { 'X-Trainer-Email': email } : {},
        });
        if (!res.ok) return;
        const data = await res.json();
        render(data);
    } catch { /* silent */ }
}

export function showQueueView() {
    if (els.view)     els.view.classList.remove('hidden');
    if (els.taskView) els.taskView.classList.add('hidden');
    if (els.backBtn)  els.backBtn.classList.add('hidden');

    // Hide metadata sidebar and remove body offset so queue isn't shifted right
    const sidebar = document.getElementById('metadataSidebar');
    if (sidebar) sidebar.style.display = 'none';
    document.body.classList.remove('sidebar-visible');

    // Hide the task info chip when returning to queue
    const taskInfoChip = document.getElementById('taskInfoChip');
    if (taskInfoChip) taskInfoChip.classList.add('hidden');

    // Hide multi-turn UI elements that belong to the task view
    const thread = document.getElementById('conversationThread');
    if (thread) thread.classList.remove('visible');

    const journeyBar = document.getElementById('turnJourneyBar');
    if (journeyBar) journeyBar.classList.remove('visible');

    const container = document.getElementById('mainContainer');
    if (container) container.classList.remove('multi-turn-layout');

    refreshQueue();
}

export function showTaskView() {
    if (els.view)     els.view.classList.add('hidden');
    if (els.taskView) els.taskView.classList.remove('hidden');
    if (els.backBtn)  els.backBtn.classList.remove('hidden');
}

// ── Render ──────────────────────────────────────────────────────

function render(data) {
    const sessions = data.sessions || [];
    renderGreeting(sessions);
    renderMomentum(sessions);

    const returned  = sessions.filter(s => s.review_status === 'returned');
    const rejected  = sessions.filter(s => s.review_status === 'rejected');
    const drafts    = sessions.filter(s => s.review_status === 'draft');
    const submitted = sessions.filter(s => s.review_status === 'submitted');
    const approved  = sessions.filter(s => s.review_status === 'approved');

    renderFocusCard(returned, drafts, submitted, approved);

    renderPanel('returned',  returned, false);
    renderPanel('waiting',   submitted, false);
    renderPanel('drafts',    drafts, true);
    renderPanel('completed', [...approved, ...rejected], false);

    // Auto-select first non-empty tab if current tab is empty
    const counts = { returned: returned.length, waiting: submitted.length, drafts: drafts.length, completed: approved.length + rejected.length };
    if (counts[_activeTab] === 0) {
        const first = Object.keys(counts).find(k => counts[k] > 0);
        if (first) switchTab(first);
    }

    const hasAny = sessions.length > 0;
    toggle(els.empty, !hasAny);
    toggle(els.tabs, hasAny);
    toggle(els.momentum, hasAny);
}

// ── Greeting ────────────────────────────────────────────────────

function renderGreeting(sessions) {
    const name = localStorage.getItem('trainer_name') || '';
    const hour = new Date().getHours();
    let timeWord = 'Good evening';
    if (hour < 12)      timeWord = 'Good morning';
    else if (hour < 17) timeWord = 'Good afternoon';

    const display = name ? `${timeWord}, ${name}` : timeWord;
    if (els.greeting) els.greeting.textContent = display;

    const approvedCount = sessions.filter(s => s.review_status === 'approved').length;
    const returnedCount = sessions.filter(s => s.review_status === 'returned').length;
    let sub = '';
    if (approvedCount > 0 && returnedCount > 0) {
        sub = `${approvedCount} task${approvedCount !== 1 ? 's' : ''} approved · ${returnedCount} need${returnedCount !== 1 ? '' : 's'} a revision`;
    } else if (approvedCount > 0) {
        sub = `${approvedCount} task${approvedCount !== 1 ? 's' : ''} approved. Nice work.`;
    } else if (returnedCount > 0) {
        sub = `${returnedCount} task${returnedCount !== 1 ? 's' : ''} returned with feedback`;
    }
    if (els.greetingSub) els.greetingSub.textContent = sub;
}

// ── Focus card ──────────────────────────────────────────────────

function renderFocusCard(returned, drafts, submitted, approved) {
    if (returned.length > 0) {
        const t = returned[0];
        const comment = t.review_feedback?.overall_comment || '';
        const preview = comment.length > 90 ? comment.slice(0, 90) + '…' : comment;
        setFocusCard(
            'feedback',
            `Feedback on ${taskLabel(t)}`,
            preview || 'Reviewer returned this task — take a look',
            t.session_id,
            'Review feedback',
        );
    } else if (drafts.length > 0) {
        const t = drafts[0];
        setFocusCard(
            'draft',
            `Continue ${taskLabel(t)}`,
            stageLabel(t),
            t.session_id,
            'Continue',
        );
    } else if (submitted.length > 0) {
        setFocusCard('waiting', 'Tasks with reviewer', `${submitted.length} task${submitted.length !== 1 ? 's' : ''} under review`, null, null);
    } else if (approved.length > 0) {
        setFocusCard('approved', 'All caught up', 'Everything is approved. Nice work.', null, null);
    } else {
        toggle(els.focusCard, false);
        return;
    }
    toggle(els.focusCard, true);
}

const FOCUS_ICONS = {
    feedback: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    draft:    `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
    waiting:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    approved: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

function setFocusCard(iconType, title, detail, sessionId, btnLabel) {
    if (els.focusIcon)   els.focusIcon.innerHTML = FOCUS_ICONS[iconType] || FOCUS_ICONS.draft;
    if (els.focusIcon)   els.focusIcon.setAttribute('data-type', iconType);
    if (els.focusTitle)  els.focusTitle.textContent = title;
    if (els.focusDetail) els.focusDetail.textContent = detail;
    if (els.focusBtn) {
        els.focusBtn.style.display = sessionId ? '' : 'none';
        els.focusBtn.textContent = btnLabel || 'Open';
        els.focusBtn.onclick = sessionId ? () => openTask(sessionId) : null;
    }
}

// ── Momentum strip ──────────────────────────────────────────────

function renderMomentum(sessions) {
    const approved  = sessions.filter(s => s.review_status === 'approved').length;
    const submitted = sessions.filter(s => s.review_status === 'submitted').length;
    const drafts    = sessions.filter(s => s.review_status === 'draft').length;

    const svgCheck = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    const svgClock = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const svgEdit  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

    if (els.momentumApproved)  els.momentumApproved.innerHTML  = `${svgCheck}<span>${approved}</span><span class="tq-momentum-label">approved</span>`;
    if (els.momentumSubmitted) els.momentumSubmitted.innerHTML = `${svgClock}<span>${submitted}</span><span class="tq-momentum-label">with reviewer</span>`;
    if (els.momentumDrafts)    els.momentumDrafts.innerHTML    = `${svgEdit}<span>${drafts}</span><span class="tq-momentum-label">in progress</span>`;
}

// ── Tab switching ───────────────────────────────────────────────

function switchTab(tabName) {
    if (!_panels[tabName]) return;
    _activeTab = tabName;
    // Update tab buttons
    if (els.tabs) {
        for (const btn of els.tabs.querySelectorAll('.tq-tab')) {
            btn.classList.toggle('tq-tab-active', btn.dataset.tab === tabName);
        }
    }
    // Show/hide panels
    for (const [name, p] of Object.entries(_panels)) {
        toggle(p.panel, name === tabName);
    }
}

// ── Panel rendering ─────────────────────────────────────────────

function renderPanel(name, tasks, showJourney) {
    const p = _panels[name];
    if (!p) return;
    // Update count badge on tab
    if (p.count) p.count.textContent = tasks.length > 0 ? tasks.length : '';
    // Render list
    if (p.list) {
        p.list.innerHTML = '';
        for (const t of tasks) p.list.appendChild(buildTaskCard(t, showJourney));
    }
    // Show/hide empty state
    const isEmpty = tasks.length === 0;
    if (p.empty) {
        if (isEmpty) {
            p.empty.innerHTML = buildEmptyState(name);
            p.empty.classList.remove('hidden');
        } else {
            p.empty.classList.add('hidden');
        }
    }
    if (p.list) toggle(p.list, !isEmpty);
}

const EMPTY_STATE_CONFIG = {
    returned: {
        svg: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"><polyline points="20 6 9 17 4 12"/></svg>`,
        title: 'All clear',
        sub: 'No returned tasks. Keep it up.',
    },
    waiting: {
        svg: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
        title: 'Nothing pending review',
        sub: 'Submit a task to send it to a reviewer.',
    },
    drafts: {
        svg: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
        title: 'No drafts in progress',
        sub: 'Start a new task to begin.',
    },
    completed: {
        svg: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/></svg>`,
        title: 'No completed tasks yet',
        sub: 'Approved tasks will appear here.',
    },
};

function buildEmptyState(name) {
    const cfg = EMPTY_STATE_CONFIG[name] || { svg: '', title: 'No tasks', sub: '' };
    return `<div class="tq-empty-state">
        <div class="tq-empty-state-icon">${cfg.svg}</div>
        <div class="tq-empty-state-title">${cfg.title}</div>
        <div class="tq-empty-state-sub">${cfg.sub}</div>
    </div>`;
}

export function showSkeletons() {
    for (const [, p] of Object.entries(_panels)) {
        if (p.list) {
            p.list.innerHTML = [1,2,3].map(() => `
                <div class="tq-skeleton-card">
                    <div class="tq-skeleton-line tq-skeleton-title"></div>
                    <div class="tq-skeleton-line tq-skeleton-sub"></div>
                    <div class="tq-skeleton-chips">
                        <div class="tq-skeleton-chip"></div>
                        <div class="tq-skeleton-chip"></div>
                    </div>
                </div>
            `).join('');
        }
    }
}

// ── Task card ───────────────────────────────────────────────────

const JOURNEY_STEPS = ['Load', 'Hunt', 'Select', 'Review', 'Submit'];

function buildTaskCard(t, showJourney) {
    const card = document.createElement('div');
    card.className = 'tq-task-card';
    if (t.review_status === 'returned') card.classList.add('tq-card-returned');
    if (t.review_status === 'approved') card.classList.add('tq-card-approved');
    if (t.review_status === 'rejected') card.classList.add('tq-card-rejected');

    const isActionable = t.review_status === 'draft' || t.review_status === 'returned';
    card.style.cursor = isActionable ? 'pointer' : 'default';
    if (isActionable) card.addEventListener('click', () => openTask(t.session_id));

    const statusBadge = buildStatusBadge(t.review_status);
    const label = esc(taskLabel(t));
    const promptPrev = t.prompt_preview ? `<span class="tq-card-prompt">${esc(t.prompt_preview)}</span>` : '';

    // Chips row: domain, turn count, relative time
    const chips = [];
    if (t.domain) chips.push(`<span class="tq-chip tq-chip-domain">${esc(t.domain)}</span>`);
    if (t.total_turns > 1) chips.push(`<span class="tq-chip tq-chip-turns">${t.total_turns} turns</span>`);
    const relTime = t.updated_at ? _relativeTime(t.updated_at) : null;
    if (relTime) chips.push(`<span class="tq-chip tq-chip-time">${relTime}</span>`);
    const chipsHtml = chips.length ? `<div class="tq-card-chips">${chips.join('')}</div>` : '';

    let journeyHtml = '';
    if (showJourney && t.review_status === 'draft') {
        journeyHtml = `<div class="tq-journey">${buildJourneyTrail(t)}</div>`;
    }

    let feedbackHtml = '';
    if (t.review_status === 'returned' && t.review_feedback?.overall_comment) {
        const fb = t.review_feedback.overall_comment;
        const preview = fb.length > 100 ? fb.slice(0, 100) + '…' : fb;
        feedbackHtml = `<div class="tq-card-feedback">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            ${esc(preview)}
        </div>`;
    }

    const deleteBtn = state.adminMode
        ? `<button class="tq-card-delete" title="Delete session" data-sid="${t.session_id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>`
        : '';

    card.innerHTML = `
        <div class="tq-card-top">
            <span class="tq-card-label">${label}</span>
            <span style="display:flex;align-items:center;gap:0.35rem;">
                ${deleteBtn}
                ${statusBadge}
            </span>
        </div>
        ${promptPrev}
        ${chipsHtml}
        ${journeyHtml}
        ${feedbackHtml}
    `;

    const delEl = card.querySelector('.tq-card-delete');
    if (delEl) {
        delEl.addEventListener('click', (e) => {
            e.stopPropagation();
            _confirmDeleteSession(t.session_id, label);
        });
    }

    return card;
}

function buildStatusBadge(status) {
    const map = {
        draft:     ['Draft',        'tq-badge-draft'],
        submitted: ['Under review', 'tq-badge-submitted'],
        returned:  ['Returned',     'tq-badge-returned'],
        approved:  ['Approved',     'tq-badge-approved'],
        rejected:  ['Rejected',     'tq-badge-rejected'],
    };
    const [text, cls] = map[status] || [status, ''];
    return `<span class="tq-badge ${cls}">${text}</span>`;
}

function buildJourneyTrail(t) {
    const step = computeStep(t);
    return JOURNEY_STEPS.map((name, i) => {
        let cls = 'tq-step';
        if (i < step)  cls += ' tq-step-done';
        if (i === step) cls += ' tq-step-current';
        return `<span class="${cls}">${name}</span>`;
    }).join('<span class="tq-step-dot">·</span>');
}

function computeStep(t) {
    if (t.review_status === 'submitted') return 4;
    if (t.review_count >= 4) return 3;
    if (t.completed_hunts > 0 && t.review_count > 0) return 3;
    if (t.completed_hunts > 0) return 2;
    if (t.total_hunts > 0) return 1;
    return 0;
}

// ── Admin: delete session ────────────────────────────────────────

async function _confirmDeleteSession(sessionId, label) {
    if (!confirm(`Delete session "${label}" (${sessionId})?\n\nThis removes it from Redis and PostgreSQL. Cannot be undone.`)) return;
    try {
        const pwd = getConfigValue('admin_mode_password', ADMIN_MODE_PASSWORD);
        const res = await fetch(`api/admin/session/${sessionId}`, {
            method: 'DELETE',
            headers: { 'X-Admin-Password': localStorage.getItem('modelHunter_adminPwd') || pwd },
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.detail || 'Delete failed');
            return;
        }
        refreshQueue();
    } catch (e) {
        alert('Delete failed: ' + (e.message || e));
    }
}

// ── Helpers ─────────────────────────────────────────────────────

function taskLabel(t) {
    if (t.task_display_id) return t.task_display_id;
    if (t.prompt_preview) return t.prompt_preview.slice(0, 50);
    return t.session_id.slice(0, 10);
}

function stageLabel(t) {
    const step = computeStep(t);
    const labels = [
        'Ready to load notebook',
        'Hunting in progress…',
        'Select 4 responses',
        'Human review in progress',
        'Ready to submit',
    ];
    return labels[step] || '';
}

function openTask(sessionId) {
    if (_onOpenTask) _onOpenTask(sessionId);
}

function toggle(el, show) {
    if (!el) return;
    el.classList.toggle('hidden', !show);
}

function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function _relativeTime(ts) {
    try {
        const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
        const diff = Math.floor((Date.now() - date.getTime()) / 1000);
        if (diff < 60)    return 'just now';
        if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    } catch { return null; }
}
