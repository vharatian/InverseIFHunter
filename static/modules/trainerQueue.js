/**
 * Trainer Queue — Phase 4 homepage.
 *
 * Fetches GET /api/trainer-queue and renders:
 *   - Time-aware greeting
 *   - Smart focus card (most relevant next action)
 *   - Momentum strip (in progress / completed submitted counts)
 *   - "In progress" (drafts + returned)
 *   - "Completed" (submitted to reviewer)
 *   - Empty state when no tasks
 *
 * Exports: initTrainerQueue, refreshQueue, showQueueView, showTaskView
 */
import { createPoller } from './poll.js';
import { state } from './state.js';
import { ADMIN_MODE_PASSWORD, getConfigValue } from './config.js';
import { getAdminPassword } from './adminMode.js';
import { showUndoToast, showError, showToast } from './celebrations.js?v=43';
import { apiFetch } from './api.js';

// ── DOM refs (cached on init) ───────────────────────────────────
let els = {};

function cacheDom() {
    const id = (s) => document.getElementById(s);
    els = {
        view:             id('trainerQueueView'),
        taskView:         id('trainerTaskView'),
        greeting:         id('tqGreeting'),
        greetingSub:      id('tqGreetingSub'),
        eyebrow:          id('tqEyebrow'),
        focusCard:        id('tqFocusCard'),
        focusIcon:        id('tqFocusIcon'),
        focusTitle:       id('tqFocusTitle'),
        focusDetail:      id('tqFocusDetail'),
        focusBtn:         id('tqFocusBtn'),
        statInProgress:   id('tqStatInProgress'),
        statUnderReview:  id('tqStatUnderReview'),
        statDone:         id('tqStatDone'),
        tabs:             id('tqTabs'),
        empty:            id('tqEmpty'),
        newTaskBtn:       id('tqNewTaskBtn'),
        backBtn:          id('tqBackBtn'),
    };

    // Tab panels and lists keyed by tab name
    _panels = {
        drafts:    { panel: id('tqPanelDrafts'),    list: id('tqDraftsList'),    empty: id('tqPanelDraftsEmpty'),    count: id('tqTabCountDrafts') },
        completed: { panel: id('tqPanelCompleted'),  list: id('tqCompletedList'), empty: id('tqPanelCompletedEmpty'), count: id('tqTabCountCompleted') },
    };
}

// ── State ───────────────────────────────────────────────────────
let _onOpenTask = null;   // callback(sessionId) — set from app.js
let _onNewTask = null;    // callback() — set from app.js
let _stopPoller = null;
let _panels = {};         // populated by cacheDom
let _activeTab = 'drafts';

// ── Public API ──────────────────────────────────────────────────

export function initTrainerQueue({ onOpenTask, onNewTask }) {
    _onOpenTask = onOpenTask;
    _onNewTask = onNewTask;
    if (_stopPoller) return; // already initialised; just refresh callbacks
    cacheDom();

    if (els.newTaskBtn) els.newTaskBtn.addEventListener('click', () => _onNewTask?.());
    if (els.backBtn)    els.backBtn.addEventListener('click', showQueueView);

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

export function stopTrainerQueue() {
    if (_stopPoller) { _stopPoller(); _stopPoller = null; }
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

    // "X tasks done today" pill belongs to the task view only (queue view
    // has its own momentum strip).
    const todayPill = document.getElementById('taskDoneToday');
    if (todayPill) todayPill.classList.add('hidden');

    // Hide multi-turn UI elements that belong to the task view
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

    const todayPill = document.getElementById('taskDoneToday');
    if (todayPill) todayPill.classList.remove('hidden');

    // If we're re-entering the task view after a prior submit (button was
    // morphed into "+ New Task"), snap it back to the Submit-to-Colab
    // baseline. Whatever workflow stage we end up in will re-enable it as
    // needed (llmRevealAndReviewCards.js / selectionConfirmAndProgress.js).
    const submitBtn = document.getElementById('submitColabBtn');
    if (submitBtn && submitBtn.dataset.mode === 'new-task') {
        submitBtn.dataset.mode = 'submit';
        submitBtn.textContent = 'Submit to Colab';
        submitBtn.classList.remove('btn-primary');
        submitBtn.classList.add('btn-success');
        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.5';
        submitBtn.title = 'Reveal AI Evaluation first to enable';
    }
}

// ── Render ──────────────────────────────────────────────────────

function render(data) {
    const sessions = data.sessions || [];

    const drafts       = sessions.filter(s => s.review_status === 'draft');
    const submitted    = sessions.filter(s => s.review_status === 'submitted');
    const inProgressRv = sessions.filter(s => s.review_status === 'in_progress');
    const completed    = sessions.filter(s => s.review_status === 'completed' || s.review_status === 'approved');
    const awaiting     = [...submitted, ...inProgressRv].sort((a, b) => _sessionSortKey(b) - _sessionSortKey(a));
    const sentOut      = [...awaiting, ...completed].sort((a, b) => _sessionSortKey(b) - _sessionSortKey(a));

    renderGreeting(sessions, drafts.length, awaiting.length, completed.length);
    renderStats(drafts.length, awaiting.length, completed.length);

    renderFocusCard(drafts, submitted, completed);

    const draftsSorted = [...drafts].sort((a, b) => _sessionSortKey(b) - _sessionSortKey(a));
    renderPanel('drafts',    draftsSorted, true);
    renderPanel('completed', sentOut, false);

    // Auto-select first non-empty tab if current tab is empty
    const counts = { drafts: draftsSorted.length, completed: sentOut.length };
    if (counts[_activeTab] === 0) {
        const first = Object.keys(counts).find(k => counts[k] > 0);
        if (first) switchTab(first);
    }

    const hasAny = sessions.length > 0;
    toggle(els.empty, !hasAny);
    toggle(els.tabs, hasAny);
}

// ── Greeting ────────────────────────────────────────────────────

function renderGreeting(sessions, draftsN, awaitingN, completedN) {
    const name = localStorage.getItem('trainer_name') || '';
    const hour = new Date().getHours();
    let timeWord = 'Good evening';
    if (hour < 12)      timeWord = 'Good morning';
    else if (hour < 17) timeWord = 'Good afternoon';

    const display = name ? `${timeWord}, ${name} 👋` : `${timeWord} 👋`;
    if (els.greeting) els.greeting.textContent = display;

    if (els.eyebrow) els.eyebrow.textContent = name ? `Trainer · ${name}` : 'Trainer';

    let sub = 'Load a notebook, run the hunt, and submit for review.';
    if (completedN > 0 && draftsN > 0) {
        sub = `${completedN} task${completedN !== 1 ? 's' : ''} completed · ${draftsN} in progress. Keep going.`;
    } else if (completedN > 0) {
        sub = `${completedN} task${completedN !== 1 ? 's' : ''} completed. Nice work.`;
    } else if (awaitingN > 0) {
        sub = `${awaitingN} task${awaitingN !== 1 ? 's' : ''} with your reviewer. Start another while you wait.`;
    } else if (draftsN > 0) {
        sub = `${draftsN} draft${draftsN !== 1 ? 's' : ''} in progress — pick up where you left off.`;
    }
    if (els.greetingSub) els.greetingSub.textContent = sub;

    void sessions;
}

function renderStats(draftsN, awaitingN, completedN) {
    if (els.statInProgress) els.statInProgress.textContent = String(draftsN);
    if (els.statUnderReview) els.statUnderReview.textContent = String(awaitingN);
    if (els.statDone) els.statDone.textContent = String(completedN);
}

// ── Focus card ──────────────────────────────────────────────────

function renderFocusCard(drafts, submitted, completed) {
    if (drafts.length > 0) {
        const t = drafts[0];
        setFocusCard(
            'draft',
            draftFocusTitle(t),
            stageLabel(t),
            t.session_id,
            'Continue',
        );
    } else if (submitted.length > 0) {
        setFocusCard('waiting', 'Tasks with reviewer', `${submitted.length} task${submitted.length !== 1 ? 's' : ''} under review`, null, null);
    } else if (completed.length > 0) {
        setFocusCard('approved', 'All caught up', 'Everything is completed. Nice work.', null, null);
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
    drafts: {
        svg: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
        title: 'Nothing in progress',
        sub: 'No drafts or returned tasks. Start a new task to begin.',
    },
    completed: {
        svg: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
        title: 'Nothing submitted yet',
        sub: 'Submit a task from the workflow to send it for review.',
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
    if (t.review_status === 'completed' || t.review_status === 'approved') card.classList.add('tq-card-approved');
    if (t.review_status === 'in_progress') card.classList.add('tq-card-in-progress');

    const isActionable = t.review_status === 'draft';
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

    const feedbackHtml = '';

    // Admin users: trash icon to delete any session.
    // All trainers: cross (×) to delete their own drafts in progress.
    let deleteBtn = '';
    if (state.adminMode) {
        deleteBtn = `<button class="tq-card-delete" title="Delete session" data-sid="${t.session_id}" data-mode="admin">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>`;
    } else if (t.review_status === 'draft') {
        deleteBtn = `<button class="tq-card-delete tq-card-delete-x" title="Delete draft" aria-label="Delete draft" data-sid="${t.session_id}" data-mode="trainer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>`;
    }

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
            if (delEl.dataset.mode === 'trainer') {
                _confirmDeleteDraftAsTrainer(t.session_id, label, card);
            } else {
                _confirmDeleteSession(t.session_id, label, card);
            }
        });
    }

    return card;
}

function buildStatusBadge(status) {
    const map = {
        draft:       ['Draft',          'tq-badge-draft'],
        submitted:   ['Awaiting review', 'tq-badge-submitted'],
        in_progress: ['Being reviewed', 'tq-badge-in-progress'],
        completed:   ['Completed',      'tq-badge-approved'],
        approved:    ['Completed',      'tq-badge-approved'],
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

/**
 * Optimistic delete with a 5-second client-side undo window.
 *
 *   1. Hide the card immediately (optimistic) and show an undo toast.
 *   2. If the trainer clicks Undo within 5s: restore the card, no API call.
 *   3. Otherwise the DELETE fires. On failure we restore the card and
 *      surface the trace id via showError.
 *
 * Backend stays unchanged — the undo window lives entirely on the client.
 */
async function _confirmDeleteSession(sessionId, label, cardEl) {
    if (!confirm(`Delete session "${label}" (${sessionId})?\n\nThis removes it from Redis and PostgreSQL.`)) return;

    const prevDisplay = cardEl ? cardEl.style.display : '';
    if (cardEl) cardEl.style.display = 'none';

    showUndoToast({
        message: `Deleting "${label}"…`,
        delayMs: 5000,
        undoLabel: 'Undo',
        onUndo: () => {
            if (cardEl) cardEl.style.display = prevDisplay;
            showToast(`Kept "${label}"`, 'info');
        },
        onCommit: async () => {
            const pwd = getAdminPassword() || getConfigValue('admin_mode_password', ADMIN_MODE_PASSWORD);
            await apiFetch(`api/admin/session/${sessionId}`, {
                method: 'DELETE',
                headers: { 'X-Admin-Password': pwd || '' },
            });
            showToast(`Deleted "${label}"`, 'success');
            refreshQueue();
        },
        onCommitError: (err) => {
            if (cardEl) cardEl.style.display = prevDisplay;
            showError(err, { operation: 'Delete session' });
        },
    });
}

/**
 * Trainer-initiated delete for a draft card: confirm() dialog then hard
 * delete via the trainer endpoint (no admin password). Backend enforces
 * that only draft sessions can be removed through this path.
 */
async function _confirmDeleteDraftAsTrainer(sessionId, label, cardEl) {
    const ok = await _showDeleteConfirmModal(label);
    if (!ok) return;

    const prevDisplay = cardEl ? cardEl.style.display : '';
    if (cardEl) cardEl.style.display = 'none';

    try {
        await apiFetch(`api/trainer/session/${sessionId}`, { method: 'DELETE' });
        showToast(`Deleted draft "${label}"`, 'success');
        refreshQueue();
    } catch (err) {
        if (cardEl) cardEl.style.display = prevDisplay;
        showError(err, { operation: 'Delete draft' });
    }
}

/**
 * Themed confirm dialog for destructive draft deletion. Returns a Promise
 * that resolves to true on confirm, false on cancel / escape / backdrop click.
 */
function _showDeleteConfirmModal(label) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'tq-confirm-overlay';
        const safeLabel = _escForHtml(label);
        overlay.innerHTML = `
            <div class="tq-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="tqConfirmTitle">
                <div class="tq-confirm-icon" aria-hidden="true">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                </div>
                <h3 id="tqConfirmTitle" class="tq-confirm-title">Delete this draft?</h3>
                <p class="tq-confirm-desc">
                    <span class="tq-confirm-label">"${safeLabel}"</span>
                    will be removed from your in-progress tasks.
                </p>
                <p class="tq-confirm-warning">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    This action cannot be undone.
                </p>
                <div class="tq-confirm-actions">
                    <button type="button" class="tq-confirm-btn tq-confirm-cancel" id="tqConfirmCancel">Cancel</button>
                    <button type="button" class="tq-confirm-btn tq-confirm-delete" id="tqConfirmDelete">Delete draft</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const cancelBtn = overlay.querySelector('#tqConfirmCancel');
        const deleteBtn = overlay.querySelector('#tqConfirmDelete');
        const prevFocus = document.activeElement;

        requestAnimationFrame(() => {
            overlay.classList.add('tq-confirm-visible');
            deleteBtn?.focus();
        });

        let settled = false;
        const close = (result) => {
            if (settled) return;
            settled = true;
            overlay.classList.remove('tq-confirm-visible');
            document.removeEventListener('keydown', onKey, true);
            setTimeout(() => {
                overlay.remove();
                if (prevFocus && typeof prevFocus.focus === 'function') {
                    try { prevFocus.focus(); } catch { /* ignore */ }
                }
                resolve(result);
            }, 180);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(false); }
            else if (e.key === 'Enter') { e.preventDefault(); close(true); }
            else if (e.key === 'Tab') {
                const focusables = [cancelBtn, deleteBtn].filter(Boolean);
                if (!focusables.length) return;
                const i = focusables.indexOf(document.activeElement);
                const next = e.shiftKey
                    ? focusables[(i - 1 + focusables.length) % focusables.length]
                    : focusables[(i + 1) % focusables.length];
                e.preventDefault();
                next.focus();
            }
        };

        cancelBtn.addEventListener('click', () => close(false));
        deleteBtn.addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        document.addEventListener('keydown', onKey, true);
    });
}

function _escForHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// ── Helpers ─────────────────────────────────────────────────────

function taskLabel(t) {
    if (t.task_display_id) return t.task_display_id;
    if (t.prompt_preview) return t.prompt_preview.slice(0, 50);
    return t.session_id.slice(0, 10);
}

/** Focus card title: "Continue '…prompt…'" with single-quoted prompt body. */
function draftFocusTitle(t) {
    const raw = (t.prompt_preview && t.prompt_preview.trim()) || t.task_display_id || taskLabel(t);
    const max = 120;
    const body = raw.length > max ? raw.slice(0, max) + '…' : raw;
    return `Continue '${body}'`;
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

function _sessionSortKey(s) {
    const u = s?.updated_at;
    if (u == null) return 0;
    if (typeof u === 'number') return u < 1e12 ? u * 1000 : u;
    const ms = Date.parse(u);
    return Number.isFinite(ms) ? ms : 0;
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
