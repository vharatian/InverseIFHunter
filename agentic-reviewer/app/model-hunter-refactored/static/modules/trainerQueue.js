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

    refreshQueue();
    _stopPoller = createPoller(refreshQueue, 30_000);
}

export async function refreshQueue() {
    try {
        const email = localStorage.getItem('trainer_email') || '';
        const res = await fetch('/api/trainer-queue', {
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
            '💬',
            `Feedback on ${taskLabel(t)}`,
            preview || 'Reviewer returned this task — take a look',
            t.session_id,
        );
    } else if (drafts.length > 0) {
        const t = drafts[0];
        setFocusCard(
            '📝',
            `Continue ${taskLabel(t)}`,
            stageLabel(t),
            t.session_id,
        );
    } else if (submitted.length > 0) {
        setFocusCard('⏳', 'Tasks with reviewer', `${submitted.length} task${submitted.length !== 1 ? 's' : ''} under review`, null);
    } else if (approved.length > 0) {
        setFocusCard('✅', 'All caught up', 'Everything is approved. Nice work.', null);
    } else {
        toggle(els.focusCard, false);
        return;
    }
    toggle(els.focusCard, true);
}

function setFocusCard(icon, title, detail, sessionId) {
    if (els.focusIcon)   els.focusIcon.textContent = icon;
    if (els.focusTitle)  els.focusTitle.textContent = title;
    if (els.focusDetail) els.focusDetail.textContent = detail;
    if (els.focusBtn) {
        els.focusBtn.style.display = sessionId ? '' : 'none';
        els.focusBtn.onclick = sessionId ? () => openTask(sessionId) : null;
    }
}

// ── Momentum strip ──────────────────────────────────────────────

function renderMomentum(sessions) {
    const approved  = sessions.filter(s => s.review_status === 'approved').length;
    const submitted = sessions.filter(s => s.review_status === 'submitted').length;
    const drafts    = sessions.filter(s => s.review_status === 'draft').length;

    if (els.momentumApproved)  els.momentumApproved.textContent  = `✅ ${approved} approved`;
    if (els.momentumSubmitted) els.momentumSubmitted.textContent = `⏳ ${submitted} under review`;
    if (els.momentumDrafts)    els.momentumDrafts.textContent    = `📝 ${drafts} draft${drafts !== 1 ? 's' : ''}`;
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
    // Show/hide empty message
    toggle(p.empty, tasks.length === 0);
    if (p.list) toggle(p.list, tasks.length > 0);
}

// ── Task card ───────────────────────────────────────────────────

const JOURNEY_STEPS = ['Load', 'Hunt', 'Select', 'Review', 'QC', 'Submit', 'Approved'];

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

    let journeyHtml = '';
    if (showJourney && t.review_status === 'draft') {
        journeyHtml = `<div class="tq-journey">${buildJourneyTrail(t)}</div>`;
    }

    let feedbackHtml = '';
    if (t.review_status === 'returned' && t.review_feedback?.overall_comment) {
        const fb = t.review_feedback.overall_comment;
        const preview = fb.length > 100 ? fb.slice(0, 100) + '…' : fb;
        feedbackHtml = `<div class="tq-card-feedback">💬 ${esc(preview)}</div>`;
    }

    card.innerHTML = `
        <div class="tq-card-top">
            <span class="tq-card-label">${label}</span>
            ${statusBadge}
        </div>
        ${promptPrev}
        ${journeyHtml}
        ${feedbackHtml}
    `;
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
    if (t.review_status === 'approved') return 6;
    if (t.review_status === 'submitted') return 5;
    if (t.qc_done) return 5;
    if (t.review_count >= 4) return 4;
    if (t.completed_hunts > 0 && t.review_count > 0) return 3;
    if (t.completed_hunts > 0) return 2;
    if (t.total_hunts > 0) return 1;
    return 0;
}

// ── Helpers ─────────────────────────────────────────────────────

function taskLabel(t) {
    return t.task_display_id || t.session_id.slice(0, 10);
}

function stageLabel(t) {
    const step = computeStep(t);
    const labels = [
        'Ready to load notebook',
        'Hunting in progress…',
        'Select 4 responses',
        'Human review in progress',
        'Quality check needed',
        'Ready to submit for review',
        'Approved',
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
