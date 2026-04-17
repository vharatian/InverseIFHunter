/**
 * Admin Panel — Model Hunter
 * Vanilla JS: team management, config editing, tracking, dashboard admin management.
 */

let currentUser = null;

let dbBrowseLastRows = [];
let dbBrowseLastSchema = null;
let dbModalCtx = { mode: 'edit', table: '', pk: '', row: null };
let dbBrowseState = { table: 'sessions', page: 1, limit: 25, search: '', sort: '', order: 'desc', schemaCache: {}, selected: new Set() };
let dbBrowseContainer = null;

// Base path prefix — detects /staging or similar prefix from the current URL.
// E.g. /staging/admin/ → _basePath = '/staging', /admin/ → _basePath = ''
const _basePath = (() => {
    const idx = window.location.pathname.indexOf('/admin');
    return idx > 0 ? window.location.pathname.substring(0, idx) : '';
})();

/** Dashboard service public prefix for Elixir: /dashboard or /staging/dashboard. Direct :8001 uses ''. */
function _dashboardServicePrefix() {
    if (location.port === '8001' || String(location.port) === '8001') return '';
    return _basePath ? `${_basePath}/dashboard` : '/dashboard';
}

// ─── Helpers ─────────────────────────────────────────────────────

function _getCsrfCookie() {
    const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const csrf = _getCsrfCookie();
        if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    const res = await fetch(`${_basePath}/api/admin/${path}`, {
        credentials: 'include',
        headers,
        ...options,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        const detail = err.detail;
        let message;
        if (Array.isArray(detail)) {
            message = detail.map(d => d.msg || d.message || JSON.stringify(d)).join('; ');
        } else {
            message = detail || res.statusText;
        }
        throw new Error(message);
    }
    return res.json();
}

let _adminToastTimer = null;

function toast(msg, type = 'success') {
    const c = document.getElementById('toast-container');
    if (!c) return;
    clearTimeout(_adminToastTimer);
    let el = document.getElementById('admin-toast-singleton');
    if (!el) {
        el = document.createElement('div');
        el.id = 'admin-toast-singleton';
        c.appendChild(el);
    }
    el.className = `toast ${type}`;
    el.textContent = msg;
    el.hidden = false;
    _adminToastTimer = setTimeout(() => {
        el.hidden = true;
    }, 3500);
}

function esc(str) {
    if (str === null || str === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

function attrEsc(str) {
    return esc(str).replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function _initials(email, name) {
    if (name) return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
    return (email || '?').slice(0, 2).toUpperCase();
}

function isSuper() { return currentUser && currentUser.is_super; }

function skeleton(rows = 4) {
    return `<div class="mth-skeleton-list">${Array(rows).fill(0).map((_, i) => `<div class="mth-skeleton" style="height:${12 + (i % 3) * 6}px;margin:${i ? '10px' : '0'} 0;width:${100 - (i * 7) % 40}%"></div>`).join('')}</div>`;
}

function emptyState({ title, hint }) {
    return `<div class="mth-empty"><strong>${esc(title || 'Nothing here yet')}</strong>${hint ? `<span>${esc(hint)}</span>` : ''}</div>`;
}

// ─── Confirm modal (replaces native confirm) ─────────────────────

let _confirmState = null;

function openConfirm({ title = 'Are you sure?', body = '', okLabel = 'Confirm', okClass = 'btn-danger', cancelLabel = 'Cancel' } = {}) {
    return new Promise(resolve => {
        const modal = document.getElementById('confirm-modal');
        if (!modal) return resolve(window.confirm(body || title));
        document.getElementById('confirm-modal-title').textContent = title;
        const bodyEl = document.getElementById('confirm-modal-body');
        bodyEl.textContent = body;
        bodyEl.style.display = body ? '' : 'none';
        const ok = document.getElementById('confirm-modal-ok');
        const cancel = document.getElementById('confirm-modal-cancel');
        ok.textContent = okLabel;
        ok.className = `btn ${okClass}`;
        cancel.textContent = cancelLabel;

        _confirmState = {
            resolve,
            lastFocus: document.activeElement,
            onKey: null,
            onBackdrop: null,
        };

        modal.classList.remove('hidden');
        const close = (result) => {
            modal.classList.add('hidden');
            ok.onclick = null;
            cancel.onclick = null;
            modal.removeEventListener('keydown', _confirmState.onKey);
            modal.removeEventListener('click', _confirmState.onBackdrop);
            const prev = _confirmState.lastFocus;
            _confirmState = null;
            if (prev && typeof prev.focus === 'function') { try { prev.focus(); } catch (_) {} }
            resolve(result);
        };
        ok.onclick = () => close(true);
        cancel.onclick = () => close(false);
        _confirmState.onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(false); }
            else if (e.key === 'Enter') { e.preventDefault(); close(true); }
            else if (e.key === 'Tab') _trapFocus(e, modal);
        };
        _confirmState.onBackdrop = (e) => { if (e.target === modal) close(false); };
        modal.addEventListener('keydown', _confirmState.onKey);
        modal.addEventListener('click', _confirmState.onBackdrop);
        setTimeout(() => ok.focus(), 10);
    });
}

function _trapFocus(e, root) {
    const focusables = root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ─── Auth ────────────────────────────────────────────────────────

async function checkSession() {
    try {
        currentUser = await api('me');
        showPanel();
        loadTeam();
        setupAdminLiveStream();
    }
    catch { showLoginGate(); }
}

// ─── SSE live updates ────────────────────────────────────────────

let _adminStream = null;
let _adminStreamBackoff = 1000;
const _adminSseDebounces = {};

function _adminDebounce(name, fn, ms = 400) {
    clearTimeout(_adminSseDebounces[name]);
    _adminSseDebounces[name] = setTimeout(fn, ms);
}

function _activeAdminTab() {
    const btn = document.querySelector('#tab-nav .tab-btn.active');
    return btn ? btn.dataset.tab : '';
}

function _refreshIfActive(tab, loader) {
    if (_activeAdminTab() === tab) loader();
}

function setupAdminLiveStream() {
    if (typeof EventSource === 'undefined') return;
    if (_adminStream) { try { _adminStream.close(); } catch (_) {} }
    try {
        const url = `${_basePath}/api/admin/stream`;
        const es = new EventSource(url, { withCredentials: true });
        _adminStream = es;

        es.addEventListener('open', () => { _adminStreamBackoff = 1000; });

        es.addEventListener('config', () => {
            _adminDebounce('config', () => _refreshIfActive('config', loadConfig));
        });
        es.addEventListener('team', () => {
            _adminDebounce('team', () => _refreshIfActive('team', loadTeam));
        });
        es.addEventListener('admins', () => {
            _adminDebounce('admins', () => _refreshIfActive('admins', loadDashboardAdmins));
        });
        es.addEventListener('db', () => {
            _adminDebounce('db', () => _refreshIfActive('data', loadDataTab));
        });

        es.onerror = () => {
            es.close();
            _adminStream = null;
            const delay = Math.min(_adminStreamBackoff, 30000);
            _adminStreamBackoff = Math.min(_adminStreamBackoff * 2, 60000);
            setTimeout(setupAdminLiveStream, delay);
        };
    } catch (_) {}
}

function showLoginGate() {
    document.getElementById('login-gate').classList.remove('hidden');
    document.getElementById('admin-panel').classList.add('hidden');
}

function showPanel() {
    document.getElementById('login-gate').classList.add('hidden');
    document.getElementById('admin-panel').classList.remove('hidden');
    document.getElementById('user-email').textContent = currentUser.email;
    const b = document.getElementById('role-badge');
    b.textContent = currentUser.is_super ? 'Super Admin' : 'Admin';
    b.className = `role-badge ${currentUser.is_super ? 'super' : 'admin'}`;
    _applyRoleTabVisibility();
}

function _applyRoleTabVisibility() {
    const superOnly = ['admins', 'data'];
    const su = isSuper();
    const nav = document.getElementById('tab-nav');
    if (!nav) return;
    for (const name of superOnly) {
        const btn = nav.querySelector(`.tab-btn[data-tab="${name}"]`);
        if (!btn) continue;
        btn.hidden = !su;
        if (!su && btn.classList.contains('active')) {
            showTab('team');
        }
    }
}

async function logout() {
    try { await api('logout', { method: 'POST' }); } catch {}
    currentUser = null;
    if (_adminStream) { try { _adminStream.close(); } catch (_) {} _adminStream = null; }
    showLoginGate();
}

// ─── Tab switching ───────────────────────────────────────────────

function showTab(tabName) {
    document.querySelectorAll('#tab-nav .tab-btn').forEach(b => {
        const active = b.dataset.tab === tabName;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
        b.setAttribute('tabindex', active ? '0' : '-1');
    });
    document.querySelectorAll('.content-area > .section').forEach(s => s.classList.toggle('active', s.id === `section-${tabName}`));
    ({ team: loadTeam, config: loadConfig, tracking: loadTracking, admins: loadDashboardAdmins, data: loadDataTab })[tabName]?.();
}

function _initAdminTabKeyboardNav() {
    const tablist = document.getElementById('tab-nav');
    if (!tablist) return;
    tablist.addEventListener('keydown', (e) => {
        const visibleTabs = Array.from(tablist.querySelectorAll('[role="tab"]:not([hidden])'));
        const idx = visibleTabs.indexOf(document.activeElement);
        if (idx < 0) return;
        let next = idx;
        if (e.key === 'ArrowRight') next = (idx + 1) % visibleTabs.length;
        else if (e.key === 'ArrowLeft') next = (idx - 1 + visibleTabs.length) % visibleTabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = visibleTabs.length - 1;
        else return;
        e.preventDefault();
        visibleTabs[next].focus();
        visibleTabs[next].click();
    });
}

// ═════════════════════════════════════════════════════════════════
// TEAM TAB
// ═════════════════════════════════════════════════════════════════

async function loadTeam() {
    const c = document.getElementById('team-content');
    c.innerHTML = skeleton(6);
    try { renderTeam(await api('team'), c); }
    catch (e) { c.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`; }
}

function _teamMemberRow({ email, name, roleClass, badge, su, removeAction }) {
    const nm = name || '';
    return `<div class="team-member-row" data-member-email="${esc(email)}">
        <div class="team-member-avatar ${roleClass}">${esc(_initials(email, nm))}</div>
        <div class="team-member-body">
            <div class="team-member-email">${esc(email)}</div>
            ${nm ? `<div class="team-member-name">${esc(nm)}</div>` : ''}
        </div>
        <span class="team-member-badge ${roleClass}">${badge}</span>
        ${su ? `<button type="button" class="team-member-remove" data-action="${removeAction}" data-email="${esc(email)}" title="Remove">&times;</button>` : ''}
    </div>`;
}

function renderTeam(data, container) {
    let h = '';
    const su = isSuper();
    const pods = data.pods || [];
    const trainerTotal = pods.reduce((n, p) => n + (p.trainers?.length || 0), 0);
    const superAdmins = data.super_admins || [];
    const admins = data.admins || [];

    h += `<div class="team-shell">
        <div class="team-stats">
            <div class="team-stat"><span class="team-stat-value">${pods.length}</span><span class="team-stat-label">Pods</span></div>
            <div class="team-stat"><span class="team-stat-value">${trainerTotal}</span><span class="team-stat-label">Trainers</span></div>
            <div class="team-stat"><span class="team-stat-value">${superAdmins.length}</span><span class="team-stat-label">Super admins</span></div>
            <div class="team-stat"><span class="team-stat-value">${admins.length}</span><span class="team-stat-label">Admins</span></div>
        </div>
        <div class="team-global-grid">`;

    h += `<article class="team-role-card team-role-super">
        <header class="team-role-card-head"><span class="team-role-icon" aria-hidden="true">◆</span><div><h3>Super admins</h3><p class="team-role-desc">Full platform access</p></div></header>
        <div class="team-role-body">`;
    if (superAdmins.length) {
        h += `<div class="team-member-list">${superAdmins.map(sa => _teamMemberRow({
            email: sa.email, name: sa.name || '', roleClass: 'super', badge: 'SA', su, removeAction: 'remove-super-admin',
        })).join('')}</div>`;
    } else {
        h += `<div class="team-empty"><span class="team-empty-title">No super admins</span><span class="team-empty-hint">Add someone who can manage all teams and config.</span></div>`;
    }
    if (su) {
        h += `<div class="team-add-form" data-form="add-super-admin">
            <label class="sr-only" for="sa-email">Email</label><input id="sa-email" type="email" placeholder="Email" data-field="email" autocomplete="off" />
            <label class="sr-only" for="sa-name">Name</label><input id="sa-name" type="text" placeholder="Display name" data-field="name" autocomplete="off" />
            <button type="button" class="btn btn-sm team-add-btn">Add</button>
        </div>`;
    }
    h += `</div></article>`;

    h += `<article class="team-role-card team-role-admin">
        <header class="team-role-card-head"><span class="team-role-icon" aria-hidden="true">◇</span><div><h3>Admins</h3><p class="team-role-desc">Org-wide, pod assignments optional</p></div></header>
        <div class="team-role-body">`;
    if (admins.length) {
        h += `<div class="team-member-list">${admins.map(a => _teamMemberRow({
            email: a.email, name: a.name || '', roleClass: 'admin', badge: 'A', su, removeAction: 'remove-admin',
        })).join('')}</div>`;
    } else {
        h += `<div class="team-empty"><span class="team-empty-title">No admins yet</span><span class="team-empty-hint">Admins help run pods without super-admin powers.</span></div>`;
    }
    if (su) {
        h += `<div class="team-add-form" data-form="add-admin">
            <label class="sr-only" for="ad-email">Email</label><input id="ad-email" type="email" placeholder="Email" data-field="email" autocomplete="off" />
            <label class="sr-only" for="ad-name">Name</label><input id="ad-name" type="text" placeholder="Display name" data-field="name" autocomplete="off" />
            <button type="button" class="btn btn-sm team-add-btn">Add</button>
        </div>`;
    }
    h += `</div></article></div>`;

    h += `<h3 class="team-pods-heading">Pods &amp; trainers</h3><div class="team-pods">`;

    pods.forEach(pod => {
        const lead = pod.pod_lead;
        const rev = pod.reviewer;
        const trainers = pod.trainers || [];
        const firstN = 12;
        const vis = trainers.slice(0, firstN);
        const more = trainers.slice(firstN);
        h += `<article class="pod-card" data-pod="${esc(pod.pod_id)}">
            <header class="pod-card-head">
                <div class="pod-card-title"><h3>${esc(pod.name)}</h3><span class="pod-id-pill" title="Pod id">${esc(pod.pod_id)}</span></div>
                <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
                    <span class="pod-trainer-count">${trainers.length} trainer${trainers.length !== 1 ? 's' : ''}</span>
                    ${su ? `<button type="button" class="btn btn-xs btn-danger" data-action="remove-pod" data-pod="${esc(pod.pod_id)}">Delete pod</button>` : ''}
                </div>
            </header>
            <div class="pod-reviewer-block">
                <span class="pod-reviewer-label">Pod lead</span>
                <div class="pod-reviewer-main">
                    ${lead && lead.email
            ? `<div class="team-member-row pod-reviewer-row" style="flex:1;border:0;padding:0;background:transparent">
                        <div class="team-member-avatar reviewer">${esc(_initials(lead.email, lead.name || ''))}</div>
                        <div class="team-member-body"><div class="team-member-email">${esc(lead.email)}</div>${lead.name ? `<div class="team-member-name">${esc(lead.name)}</div>` : ''}</div>
                       </div>`
            : `<span class="pod-reviewer-none">Unassigned</span>`}
                    ${su ? `<button type="button" class="btn btn-xs btn-ghost pod-change-rev" data-action="set-pod-lead" data-pod="${esc(pod.pod_id)}" data-lead-email="${lead && lead.email ? esc(lead.email) : ''}" data-lead-name="${lead && lead.name ? esc(lead.name) : ''}">${lead && lead.email ? 'Change' : 'Assign'}</button>` : ''}
                    ${su && lead && lead.email ? `<button type="button" class="btn btn-xs btn-ghost" data-action="remove-pod-lead" data-pod="${esc(pod.pod_id)}">Unassign</button>` : ''}
                </div>
            </div>
            <div class="pod-reviewer-block">
                <span class="pod-reviewer-label">Reviewer</span>
                <div class="pod-reviewer-main">
                    ${rev
            ? `<div class="team-member-row pod-reviewer-row" style="flex:1;border:0;padding:0;background:transparent">
                        <div class="team-member-avatar reviewer">${esc(_initials(rev.email, rev.name || ''))}</div>
                        <div class="team-member-body"><div class="team-member-email">${esc(rev.email)}</div>${rev.name ? `<div class="team-member-name">${esc(rev.name)}</div>` : ''}</div>
                       </div>`
            : `<span class="pod-reviewer-none">Unassigned</span>`}
                    ${su ? `<button type="button" class="btn btn-xs btn-ghost pod-change-rev" data-action="set-reviewer" data-pod="${esc(pod.pod_id)}" data-rev-email="${rev ? esc(rev.email) : ''}" data-rev-name="${rev && rev.name ? esc(rev.name) : ''}">${rev ? 'Change' : 'Assign'}</button>` : ''}
                    ${su && rev && rev.email ? `<button type="button" class="btn btn-xs btn-ghost" data-action="remove-pod-reviewer" data-pod="${esc(pod.pod_id)}">Unassign</button>` : ''}
                </div>
            </div>
            ${trainers.length ? `<div class="pod-trainer-tools"><input type="search" class="pod-trainer-filter" placeholder="Filter trainers…" data-pod-filter="${esc(pod.pod_id)}" aria-label="Filter trainers" /></div>` : ''}
            <div class="trainer-chip-list" data-pod-chips="${esc(pod.pod_id)}">`;
        if (!trainers.length) {
            h += `<span class="team-empty inline"><span class="team-empty-hint">No trainers in this pod yet.</span></span>`;
        } else {
            vis.forEach(t => {
                h += `<span class="trainer-chip" data-trainer-email="${esc(t)}">${esc(t)}${su ? `<button type="button" class="remove-btn" data-action="remove-trainer" data-pod="${esc(pod.pod_id)}" data-email="${esc(t)}" aria-label="Remove ${esc(t)}">&times;</button>` : ''}</span>`;
            });
            if (more.length) {
                h += `<details class="trainer-more-details"><summary>+${more.length} more</summary><div class="trainer-more-inner">`;
                more.forEach(t => {
                    h += `<span class="trainer-chip" data-trainer-email="${esc(t)}">${esc(t)}${su ? `<button type="button" class="remove-btn" data-action="remove-trainer" data-pod="${esc(pod.pod_id)}" data-email="${esc(t)}" aria-label="Remove ${esc(t)}">&times;</button>` : ''}</span>`;
                });
                h += `</div></details>`;
            }
        }
        h += `</div>`;
        if (su) {
            h += `<div class="team-add-form pod-add-trainer" data-form="add-trainer" data-pod="${esc(pod.pod_id)}">
                <input type="email" placeholder="trainer@example.com" data-field="email" autocomplete="off" />
                <button type="button" class="btn btn-sm team-add-btn">Add trainer</button>
            </div>`;
        }
        h += `</article>`;
    });

    h += `</div>`;

    if (su) {
        h += `<article class="team-role-card team-create-pod-card">
            <header class="team-role-card-head"><span class="team-role-icon" aria-hidden="true">+</span><div><h3>Create pod</h3><p class="team-role-desc">Lowercase id and a display name</p></div></header>
            <div class="team-add-form create-pod-form" data-form="create-pod">
                <input type="text" placeholder="pod_id (lowercase)" data-field="pod_id" autocomplete="off" />
                <input type="text" placeholder="Display name" data-field="name" autocomplete="off" />
                <button type="button" class="btn btn-sm team-add-btn">Create</button>
            </div>
        </article>`;
    }

    h += `</div>`;
    container.innerHTML = h;
}

async function handleTeamAction(action, params) {
    try {
        switch (action) {
            case 'add-trainer':
                await api(`team/pods/${encodeURIComponent(params.pod)}/trainers`, { method: 'POST', body: JSON.stringify({ email: params.email }) });
                toast('Trainer added'); break;
            case 'remove-trainer':
                await api(`team/pods/${encodeURIComponent(params.pod)}/trainers/${encodeURIComponent(params.email)}`, { method: 'DELETE' });
                toast('Trainer removed'); break;
            case 'remove-admin':
                if (!await openConfirm({ title: 'Remove admin', body: `Remove admin ${params.email}?`, okLabel: 'Remove' })) return;
                await api(`team/admins/${encodeURIComponent(params.email)}`, { method: 'DELETE' });
                toast('Admin removed'); break;
            case 'add-admin':
                await api('team/admins', { method: 'POST', body: JSON.stringify({ email: params.email, name: params.name || '', pods: [] }) });
                toast('Admin added'); break;
            case 'add-super-admin':
                await api('team/super-admins', { method: 'POST', body: JSON.stringify({ email: params.email, name: params.name || '' }) });
                toast('Super admin added'); break;
            case 'remove-super-admin':
                if (!await openConfirm({ title: 'Remove super admin', body: `Remove super admin ${params.email}?`, okLabel: 'Remove' })) return;
                await api(`team/super-admins/${encodeURIComponent(params.email)}`, { method: 'DELETE' });
                toast('Super admin removed'); break;
            case 'create-pod':
                await api('team/pods', { method: 'POST', body: JSON.stringify({ pod_id: params.pod_id, name: params.name }) });
                toast('Pod created'); break;
            case 'remove-pod':
                if (!await openConfirm({ title: 'Delete pod', body: `Delete pod "${params.pod}"? It must be empty (no trainers, reviewer, or pod lead) first.`, okLabel: 'Delete' })) return;
                await api(`team/pods/${encodeURIComponent(params.pod)}`, { method: 'DELETE' });
                toast('Pod removed'); break;
            case 'remove-pod-lead':
                if (!await openConfirm({ title: 'Remove pod lead', body: 'Remove pod lead from this pod?', okLabel: 'Remove' })) return;
                await api(`team/pods/${encodeURIComponent(params.pod)}/pod-lead`, { method: 'DELETE' });
                toast('Pod lead removed'); break;
            case 'remove-pod-reviewer':
                if (!await openConfirm({ title: 'Remove reviewer', body: 'Remove reviewer from this pod?', okLabel: 'Remove' })) return;
                await api(`team/pods/${encodeURIComponent(params.pod)}/reviewer`, { method: 'DELETE' });
                toast('Reviewer removed'); break;
        }
        loadTeam();
    } catch (e) { toast(e.message, 'error'); }
}

// ═════════════════════════════════════════════════════════════════
// CONFIG TAB
// ═════════════════════════════════════════════════════════════════

let _configData = null;

async function loadConfig() {
    const c = document.getElementById('config-content');
    c.innerHTML = skeleton(8);
    try { _configData = await api('config'); renderConfig(_configData, c); }
    catch (e) { c.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`; }
}

function _fmtVal(v) {
    if (v === null || v === undefined) return { t: 'null', c: 'null' };
    if (v === true) return { t: 'true', c: 'bool-true' };
    if (v === false) return { t: 'false', c: 'bool-false' };
    if (typeof v === 'number') return { t: String(v), c: 'number' };
    if (Array.isArray(v)) return { t: v.length === 0 ? '[ ]' : v.every(x => typeof x === 'string' || typeof x === 'number') ? v.join(', ') : `[${v.length} items]`, c: 'list' };
    return { t: String(v), c: '' };
}

function _isObjArray(v) { return Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null; }
function _isSimpleArray(v) { return Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number'); }
function _isLeaf(v) { return v === null || typeof v !== 'object'; }

function _renderArrayEditor(arr, fullKey, sectionName) {
    if (!arr.length) return '<div style="padding:0.5rem 1rem;color:var(--text-muted);font-size:0.75rem">Empty array</div>';
    const keys = Object.keys(arr[0]).filter(k => k !== 'params' && k !== 'prohibited_text');
    let h = `<div class="array-editor" data-array-key="${esc(fullKey)}" data-section="${esc(sectionName)}"><table><thead><tr>`;
    keys.forEach(k => { h += `<th>${esc(k)}</th>`; });
    if (isSuper()) h += '<th></th>';
    h += '</tr></thead><tbody>';
    arr.forEach((item, i) => {
        const stableId = (item && (item.id || item.name || item.key)) != null ? String(item.id || item.name || item.key) : '';
        const idAttr = stableId ? ` data-id="${attrEsc(stableId)}"` : '';
        h += `<tr data-idx="${i}"${idAttr}>`;
        keys.forEach(k => {
            const v = item[k];
            if (isSuper()) {
                if (typeof v === 'boolean') {
                    h += `<td><select data-arr-idx="${i}" data-arr-field="${esc(k)}"><option value="true"${v ? ' selected' : ''}>true</option><option value="false"${!v ? ' selected' : ''}>false</option></select></td>`;
                } else if (Array.isArray(v)) {
                    h += `<td><input data-arr-idx="${i}" data-arr-field="${esc(k)}" value="${esc(JSON.stringify(v))}" /></td>`;
                } else {
                    h += `<td><input data-arr-idx="${i}" data-arr-field="${esc(k)}" value="${esc(v === null ? '' : String(v))}" /></td>`;
                }
            } else {
                const f = _fmtVal(v);
                h += `<td><span class="${f.c}">${esc(f.t)}</span></td>`;
            }
        });
        if (isSuper()) {
            const idAttrBtn = stableId ? ` data-id="${attrEsc(stableId)}"` : '';
            h += `<td><button class="btn btn-xs btn-danger" data-action="remove-array-item" data-array-key="${esc(fullKey)}" data-idx="${i}"${idAttrBtn}>&times;</button></td>`;
        }
        h += '</tr>';
    });
    h += '</tbody></table>';
    if (isSuper()) h += `<div class="add-row"><button class="btn btn-xs btn-ghost" data-action="add-array-item" data-array-key="${esc(fullKey)}">+ Add item</button></div>`;
    h += '</div>';
    return h;
}

function _renderEmailChips(emails, fullKey, sectionName) {
    const list = Array.isArray(emails) ? emails : [];
    let h = `<div class="chip-editor" data-chip-key="${esc(fullKey)}" data-section="${esc(sectionName)}">`;
    list.forEach((em) => {
        h += `<span class="email-chip" data-email="${attrEsc(em)}">${esc(em)}${isSuper() ? `<button class="chip-remove" data-action="remove-chip" data-chip-key="${esc(fullKey)}" data-email="${attrEsc(em)}">&times;</button>` : ''}</span>`;
    });
    if (isSuper()) h += `<span class="chip-add-form"><input type="email" placeholder="add email" data-chip-input="${esc(fullKey)}" /><button class="btn btn-xs" data-action="add-chip" data-chip-key="${esc(fullKey)}">+</button></span>`;
    h += '</div>';
    return h;
}

function _renderNestedDict(obj, prefix, sectionName) {
    let h = '<div class="config-nested">';
    for (const [k, v] of Object.entries(obj)) {
        const fk = prefix ? `${prefix}.${k}` : k;
        if (_isLeaf(v)) {
            const editable = isSuper();
            if (editable && typeof v === 'boolean') {
                h += `<div class="config-sub-row editable"><span class="config-sub-key"><span class="edit-dot"></span>${esc(k)}</span><span class="config-sub-val"><select data-config-key="${esc(fk)}" data-section="${esc(sectionName)}"><option value="true"${v ? ' selected' : ''}>true</option><option value="false"${!v ? ' selected' : ''}>false</option></select></span></div>`;
            } else if (editable) {
                h += `<div class="config-sub-row editable"><span class="config-sub-key"><span class="edit-dot"></span>${esc(k)}</span><span class="config-sub-val"><input data-config-key="${esc(fk)}" data-section="${esc(sectionName)}" value="${esc(v === null ? '' : String(v))}" /></span></div>`;
            } else {
                const f = _fmtVal(v);
                h += `<div class="config-sub-row"><span class="config-sub-key">${esc(k)}</span><span class="config-sub-val ${f.c}">${esc(f.t)}</span></div>`;
            }
        } else if (_isObjArray(v)) {
            h += `<div style="padding:0.3rem 1rem 0 2rem"><strong style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase">${esc(k)}</strong></div>`;
            h += _renderArrayEditor(v, fk, sectionName);
        } else if (_isSimpleArray(v)) {
            if (k === 'allowed_emails' || k.includes('email')) {
                h += `<div class="config-sub-row" style="flex-direction:column;align-items:stretch"><span class="config-sub-key" style="margin-bottom:0.2rem">${esc(k)}</span>${_renderEmailChips(v, fk, sectionName)}</div>`;
            } else {
                const editable = isSuper();
                h += `<div class="config-sub-row${editable ? ' editable' : ''}"><span class="config-sub-key">${editable ? '<span class="edit-dot"></span>' : ''}${esc(k)}</span><span class="config-sub-val">${editable ? `<input data-config-key="${esc(fk)}" data-section="${esc(sectionName)}" value="${esc(JSON.stringify(v))}" />` : `<span class="list">${esc(v.join(', '))}</span>`}</span></div>`;
            }
        } else if (typeof v === 'object' && v !== null) {
            h += `<div style="padding:0.3rem 1rem 0 2rem"><strong style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase">${esc(k)}</strong></div>`;
            h += _renderNestedDict(v, fk, sectionName);
        }
    }
    h += '</div>';
    return h;
}

function _configSectionDomId(slug) {
    return `config-section-${String(slug || 'general').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'general'}`;
}

function applyConfigSearch(query) {
    const root = document.getElementById('config-content');
    if (!root) return;
    const q = query.trim().toLowerCase();
    root.querySelectorAll('.config-section').forEach(sec => {
        if (!q) { sec.style.display = ''; return; }
        const t = sec.textContent.toLowerCase();
        sec.style.display = t.includes(q) ? '' : 'none';
    });
}

let _configSearchTimer;
function scheduleConfigSearch(value) {
    clearTimeout(_configSearchTimer);
    _configSearchTimer = setTimeout(() => applyConfigSearch(value), 100);
}

function renderConfig(data, container) {
    let h = '';
    const sections = Object.entries(data).filter(([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v));
    const topLevel = Object.entries(data).filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v));

    const jumpSlugs = [];
    if (topLevel.length) jumpSlugs.push({ label: 'General', slug: 'general' });
    sections.forEach(([name]) => jumpSlugs.push({ label: name, slug: name }));

    h += `<div class="config-shell">
        <div class="config-toolbar">
            <div class="config-toolbar-search-wrap">
                <input type="search" class="config-search-input" id="config-search" placeholder="Search sections and keys…" autocomplete="off" />
            </div>
            <div class="config-toolbar-actions">
                <button type="button" class="btn btn-ghost btn-sm" data-action="config-expand-all">Expand all</button>
                <button type="button" class="btn btn-ghost btn-sm" data-action="config-collapse-all">Collapse all</button>
                ${isSuper() ? '<button type="button" class="btn btn-ghost btn-sm" id="config-reload-btn">Reload cache</button>' : ''}
            </div>
        </div>`;
    if (jumpSlugs.length) {
        h += `<nav class="config-jump" aria-label="Jump to section">${jumpSlugs.map(({ label, slug }) =>
            `<a class="config-jump-link" href="#${_configSectionDomId(slug)}">${esc(label)}</a>`).join('')}</nav>`;
    }

    function renderEntry(key, val, prefix) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (_isLeaf(val)) {
            const editable = isSuper() && !fullKey.startsWith('secrets.');
            if (editable && typeof val === 'boolean') {
                return `<div class="config-row editable"><span class="config-key"><span class="edit-dot"></span>${esc(key)}</span><span class="config-val"><select data-config-key="${esc(fullKey)}" data-section="${esc(prefix)}"><option value="true"${val ? ' selected' : ''}>true</option><option value="false"${!val ? ' selected' : ''}>false</option></select></span></div>`;
            }
            if (editable) {
                return `<div class="config-row editable"><span class="config-key"><span class="edit-dot"></span>${esc(key)}</span><span class="config-val"><input data-config-key="${esc(fullKey)}" data-section="${esc(prefix)}" value="${esc(val === null ? '' : String(val))}" /></span></div>`;
            }
            const f = _fmtVal(val);
            return `<div class="config-row"><span class="config-key">${esc(key)}</span><span class="config-val ${f.c}">${esc(f.t)}</span></div>`;
        }
        if (_isObjArray(val)) {
            return `<div class="config-row" style="flex-direction:column;align-items:stretch;padding-bottom:0"><div style="display:flex;justify-content:space-between;padding-bottom:0.3rem"><span class="config-key">${esc(key)}</span><span class="config-val list">${val.length} items</span></div>${_renderArrayEditor(val, fullKey, prefix)}</div>`;
        }
        if (_isSimpleArray(val)) {
            if (key === 'allowed_emails' || key.includes('email')) {
                return `<div class="config-row" style="flex-direction:column;align-items:stretch"><span class="config-key" style="margin-bottom:0.2rem">${esc(key)}</span>${_renderEmailChips(val, fullKey, prefix)}</div>`;
            }
            if (key === 'fallback_fields') {
                const editable = isSuper();
                return `<div class="config-row${editable ? ' editable' : ''}"><span class="config-key">${editable ? '<span class="edit-dot"></span>' : ''}${esc(key)}</span><span class="config-val">${editable ? `<input data-config-key="${esc(fullKey)}" data-section="${esc(prefix)}" value="${esc(JSON.stringify(val))}" />` : esc(val.join(', '))}</span></div>`;
            }
            const editable = isSuper();
            return `<div class="config-row${editable ? ' editable' : ''}"><span class="config-key">${editable ? '<span class="edit-dot"></span>' : ''}${esc(key)}</span><span class="config-val">${editable ? `<input data-config-key="${esc(fullKey)}" data-section="${esc(prefix)}" value="${esc(JSON.stringify(val))}" />` : `<span class="list">${esc(val.join(', '))}</span>`}</span></div>`;
        }
        if (typeof val === 'object' && val !== null) {
            const count = Object.keys(val).length;
            return `<div class="config-row" style="flex-direction:column;align-items:stretch;padding-bottom:0"><div style="display:flex;justify-content:space-between;padding-bottom:0.3rem"><span class="config-key">${esc(key)}</span><span class="config-val list">${count} keys</span></div>${_renderNestedDict(val, fullKey, prefix)}</div>`;
        }
        return '';
    }

    function renderSection(name, entries, prefix, collapsed, slugForId) {
        const editableCount = entries.reduce((c, [, v]) => c + (_isLeaf(v) && isSuper() ? 1 : 0) + (typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.values(v).filter(_isLeaf).length : 0), 0);
        const sid = _configSectionDomId(slugForId !== undefined ? slugForId : prefix);
        const accent = String(slugForId !== undefined ? slugForId : (prefix || 'general')).toLowerCase().replace(/[^a-z0-9]/g, '') || 'general';
        return `<div class="config-section config-section--${esc(accent)}" id="${sid}" data-config-section="${esc(prefix)}">
            <div class="config-section-header${collapsed ? ' collapsed' : ''}" role="button" tabindex="0" aria-expanded="${collapsed ? 'false' : 'true'}" data-action="toggle-config-section">
                <div class="config-section-header-main"><span class="config-section-accent-bar" aria-hidden="true"></span>
                <h3>${esc(name)} <span class="count-badge">${entries.length} keys${isSuper() && editableCount ? ` · ${editableCount} editable` : ''}</span></h3></div>
                <span class="chevron" aria-hidden="true">&#x25BC;</span>
            </div>
            <div class="config-section-body${collapsed ? ' collapsed' : ''}">
                ${entries.map(([k, v]) => renderEntry(k, v, prefix)).join('')}
                ${isSuper() ? `<div class="config-actions"><button type="button" class="btn btn-sm btn-success" data-action="save-config-section" data-section="${esc(prefix)}">Save ${esc(name)}</button></div>` : ''}
            </div>
        </div>`;
    }

    if (topLevel.length) h += renderSection('General', topLevel, '', false, 'general');
    const important = ['alignment', 'app', 'hunt', 'features', 'review', 'task_identity', 'reviewer'];
    sections.forEach(([name, obj]) => {
        h += renderSection(name, Object.entries(obj), name, !important.includes(name), name);
    });

    h += '</div>';
    container.innerHTML = h;
    const searchEl = document.getElementById('config-search');
    if (searchEl) searchEl.value = '';
}

async function saveConfigSection(sectionName) {
    const fields = document.querySelectorAll(`[data-section="${sectionName}"][data-config-key]`);
    const updates = {};
    fields.forEach(el => {
        const key = el.dataset.configKey;
        let val = el.value.trim();
        if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (val === 'null') val = null;
        else if (/^\d+$/.test(val)) val = parseInt(val, 10);
        else if (/^\d+\.\d+$/.test(val)) val = parseFloat(val);
        else { try { val = JSON.parse(val); } catch {} }
        updates[key] = val;
    });

    const arrayEditors = document.querySelectorAll(`.array-editor[data-section="${sectionName}"]`);
    arrayEditors.forEach(editor => {
        const arrKey = editor.dataset.arrayKey;
        const rows = editor.querySelectorAll('tbody tr');
        const items = [];
        rows.forEach(row => {
            const item = {};
            row.querySelectorAll('[data-arr-field]').forEach(el => {
                const field = el.dataset.arrField;
                let v = el.value.trim();
                if (v === 'true') v = true;
                else if (v === 'false') v = false;
                else if (v === '') v = null;
                else if (/^\d+$/.test(v)) v = parseInt(v, 10);
                else if (/^\d+\.\d+$/.test(v)) v = parseFloat(v);
                else { try { v = JSON.parse(v); } catch {} }
                item[field] = v;
            });
            const origIdx = parseInt(row.querySelector('[data-arr-idx]')?.dataset.arrIdx);
            const origData = _getNestedVal(_configData, arrKey);
            if (Array.isArray(origData) && origData[origIdx]?.params) item.params = origData[origIdx].params;
            if (Array.isArray(origData) && origData[origIdx]?.prohibited_text) item.prohibited_text = origData[origIdx].prohibited_text;
            items.push(item);
        });
        updates[arrKey] = items;
    });

    const chipEditors = document.querySelectorAll(`.chip-editor[data-section="${sectionName}"]`);
    chipEditors.forEach(editor => {
        const chipKey = editor.dataset.chipKey;
        const chips = [...editor.querySelectorAll('.email-chip')].map(c => c.textContent.replace('×', '').trim());
        updates[chipKey] = chips;
    });

    if (!Object.keys(updates).length) { toast('Nothing to save', 'error'); return; }
    try {
        await api('config', { method: 'PATCH', body: JSON.stringify({ updates }) });
        toast(`Saved ${sectionName || 'config'}`);
        loadConfig();
    } catch (e) { toast(e.message, 'error'); }
}

function _getNestedVal(obj, dottedKey) {
    for (const k of dottedKey.split('.')) { if (!obj || typeof obj !== 'object') return undefined; obj = obj[k]; }
    return obj;
}

function _handleArrayAction(action, key, idx, stableId) {
    if (!_configData) return;
    const arr = _getNestedVal(_configData, key);
    if (!Array.isArray(arr)) return;
    if (action === 'remove') {
        let pos = -1;
        if (stableId) {
            pos = arr.findIndex(x => x && (String(x.id) === stableId || String(x.name) === stableId || String(x.key) === stableId));
        }
        if (pos < 0 && Number.isInteger(idx)) pos = idx;
        if (pos >= 0 && pos < arr.length) arr.splice(pos, 1);
    } else if (action === 'add') {
        const template = arr.length > 0 ? Object.fromEntries(Object.keys(arr[0]).filter(k => k !== 'params' && k !== 'prohibited_text').map(k => [k, ''])) : { id: '', name: '' };
        arr.push(template);
    }
    renderConfig(_configData, document.getElementById('config-content'));
}

function _handleChipAction(action, key, emailOrValue) {
    if (!_configData) return;
    const arr = _getNestedVal(_configData, key);
    if (!Array.isArray(arr)) return;
    if (action === 'remove') {
        const target = String(emailOrValue || '').toLowerCase();
        const i = arr.findIndex(x => String(x).toLowerCase() === target);
        if (i >= 0) arr.splice(i, 1);
    } else if (action === 'add' && emailOrValue) {
        const val = String(emailOrValue).trim().toLowerCase();
        if (val && !arr.some(x => String(x).toLowerCase() === val)) arr.push(val);
    }
    renderConfig(_configData, document.getElementById('config-content'));
}

// ═════════════════════════════════════════════════════════════════
// TRACKING TAB
// ═════════════════════════════════════════════════════════════════

async function loadTracking() {
    const c = document.getElementById('tracking-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const [overview, tokens, criteria, trainers] = await Promise.all([
            api('tracking/overview').catch(() => null),
            api('tracking/tokens').catch(() => null),
            api('tracking/criteria').catch(() => null),
            api('tracking/trainers').catch(() => null),
        ]);
        renderTracking(c, overview, tokens, criteria, trainers);
    } catch (e) { c.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`; }
}

function renderTracking(c, overview, tokens, criteria, trainers) {
    let h = '';
    if (overview) {
        const ov = overview.overview || {}, co = overview.costs || {};
        h += `<div class="summary-cards">
            <div class="card"><div class="card-icon">$</div><div class="card-value">${(co.total_cost ?? 0).toFixed(2)}</div><div class="card-label">Total Cost</div></div>
            <div class="card"><div class="card-value">${ov.total_hunts ?? '—'}</div><div class="card-label">Total Hunts</div></div>
            <div class="card highlight"><div class="card-value">${ov.breaks_found ?? '—'}</div><div class="card-label">Breaks Found</div></div>
            <div class="card"><div class="card-value">${ov.unique_trainers ?? '—'}</div><div class="card-label">Trainers</div></div>
        </div>`;
    }

    h += `<div class="panel"><div class="panel-header"><h3>Token Usage</h3></div>`;
    if (tokens?.by_model) {
        const models = Object.entries(tokens.by_model);
        if (models.length) {
            h += `<table class="data-table"><thead><tr><th>Model</th><th>Calls</th><th>In</th><th>Out</th><th>Cost</th></tr></thead><tbody>`;
            models.forEach(([m, s]) => { h += `<tr><td>${esc(m.split('/').pop())}</td><td>${s.calls ?? 0}</td><td>${(s.tokens_in ?? 0).toLocaleString()}</td><td>${(s.tokens_out ?? 0).toLocaleString()}</td><td>$${(s.cost ?? 0).toFixed(4)}</td></tr>`; });
            h += `<tr style="font-weight:700;border-top:2px solid var(--border)"><td>Total</td><td>${tokens.total_calls ?? 0}</td><td>${(tokens.total_tokens_in ?? 0).toLocaleString()}</td><td>${(tokens.total_tokens_out ?? 0).toLocaleString()}</td><td>$${(tokens.total_cost ?? 0).toFixed(4)}</td></tr></tbody></table>`;
        } else h += '<p>No data.</p>';
    } else h += '<p>Failed to load.</p>';
    h += '</div>';

    h += `<div class="panel"><div class="panel-header"><h3>Criteria Difficulty</h3></div>`;
    const cList = criteria?.criteria || [];
    if (cList.length) {
        h += `<table class="data-table"><thead><tr><th>Criteria</th><th>Evals</th><th>Pass</th><th>Fail</th><th>Fail %</th><th>Difficulty</th></tr></thead><tbody>`;
        cList.forEach(cr => {
            h += `<tr><td>${esc(cr.criteria_id)}</td><td>${cr.total_evaluations}</td><td>${cr.pass_count}</td><td>${cr.fail_count}</td><td>${(cr.fail_rate * 100).toFixed(1)}%</td><td><div style="width:60px;height:6px;background:var(--bg-surface);border-radius:3px;overflow:hidden"><div style="width:${(cr.difficulty_score * 100).toFixed(0)}%;height:100%;background:linear-gradient(90deg,var(--warning),var(--danger))"></div></div></td></tr>`;
        });
        h += '</tbody></table>';
    } else h += '<p>No criteria data.</p>';
    h += '</div>';

    h += `<div class="panel"><div class="panel-header"><h3>Trainer Leaderboard</h3></div>`;
    const lb = (trainers?.leaderboard || []).filter(t => (t.trainer_id || '').length > 0);
    if (lb.length) {
        h += `<table class="data-table"><thead><tr><th>#</th><th>Trainer</th><th>Sessions</th><th>Hunts</th><th>Breaks</th><th>Rate</th></tr></thead><tbody>`;
        lb.forEach((t, i) => { h += `<tr><td>${i + 1}</td><td>${esc(t.trainer_id)}</td><td>${t.total_sessions}</td><td>${t.total_hunts}</td><td><strong>${t.total_breaks}</strong></td><td>${((t.break_rate || 0) * 100).toFixed(1)}%</td></tr>`; });
        h += '</tbody></table>';
    } else h += '<p class="empty-state">No trainer activity yet.</p>';
    h += '</div>';

    c.innerHTML = h;
}

// ═════════════════════════════════════════════════════════════════
// DASHBOARD ADMINS TAB
// ═════════════════════════════════════════════════════════════════

async function loadDashboardAdmins() {
    const c = document.getElementById('admins-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const [admins, testAccounts] = await Promise.all([
            api('dashboard-admins').catch(() => null),
            api('test-accounts').catch(() => null),
        ]);
        renderDashboardAdmins(c, admins, testAccounts);
    } catch (e) { c.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`; }
}

function renderDashboardAdmins(c, admins, testAccounts) {
    let h = '';
    const adminList = Array.isArray(admins) ? admins : admins?.admins || [];
    const testList = Array.isArray(testAccounts) ? testAccounts : testAccounts?.accounts || [];

    h += `<div class="panel"><div class="panel-header"><h3>Dashboard Admins</h3><span style="font-size:0.7rem;color:var(--text-muted)">${adminList.length} admin${adminList.length !== 1 ? 's' : ''}</span></div>`;
    if (adminList.length) {
        adminList.forEach(a => {
            const email = typeof a === 'string' ? a : a.email || '';
            const name = typeof a === 'object' ? a.name || '' : '';
            const added = typeof a === 'object' && a.added_at ? new Date(a.added_at).toLocaleDateString() : '';
            h += `<div class="account-item">
                <div class="account-info"><div class="avatar">${_initials(email, name)}</div><div class="account-details"><div class="name">${esc(name || email.split('@')[0])}</div><div class="email">${esc(email)}</div>${added ? `<div class="meta">Added ${added}</div>` : ''}</div></div>
                <button class="btn btn-xs btn-danger" data-action="remove-dashboard-admin" data-email="${esc(email)}">Remove</button>
            </div>`;
        });
    } else {
        h += '<div style="padding:0.75rem 1rem"><p class="empty-state">No dashboard admins added yet.</p></div>';
    }
    h += `<div class="panel-body"><div class="inline-form" data-form="add-dashboard-admin"><input type="email" placeholder="admin@example.com" data-field="email" /><input type="text" placeholder="Name" data-field="name" style="max-width:140px" /><button class="btn btn-sm">Add Admin</button></div></div></div>`;

    h += `<div class="panel"><div class="panel-header"><h3>Test Accounts</h3><span style="font-size:0.7rem;color:var(--text-muted)">Excluded from analytics</span></div>`;
    if (testList.length) {
        testList.forEach(a => {
            const email = typeof a === 'string' ? a : a.email || '';
            const name = typeof a === 'object' ? a.name || '' : '';
            h += `<div class="account-item">
                <div class="account-info"><div class="avatar" style="background:var(--warning-bg);color:var(--warning)">${_initials(email, name)}</div><div class="account-details"><div class="name">${esc(name || email.split('@')[0])}</div><div class="email">${esc(email)}</div></div></div>
                <button class="btn btn-xs btn-danger" data-action="remove-test-account" data-email="${esc(email)}">Remove</button>
            </div>`;
        });
    } else {
        h += '<div style="padding:0.75rem 1rem"><p class="empty-state">No test accounts. All activity included in analytics.</p></div>';
    }
    h += `<div class="panel-body"><div class="inline-form" data-form="add-test-account"><input type="email" placeholder="test@example.com" data-field="email" /><input type="text" placeholder="Name" data-field="name" style="max-width:140px" /><button class="btn btn-sm">Add Account</button></div></div></div>`;

    c.innerHTML = h;
}

async function handleAdminsAction(action, params) {
    try {
        switch (action) {
            case 'add-dashboard-admin':
                await api('dashboard-admins', { method: 'POST', body: JSON.stringify({ email: params.email, name: params.name || '' }) });
                toast('Admin added'); break;
            case 'remove-dashboard-admin':
                if (!await openConfirm({ title: 'Remove admin', body: `Remove ${params.email}?`, okLabel: 'Remove' })) return;
                await api(`dashboard-admins/${encodeURIComponent(params.email)}`, { method: 'DELETE' });
                toast('Admin removed'); break;
            case 'add-test-account':
                await api('test-accounts', { method: 'POST', body: JSON.stringify({ email: params.email, name: params.name || '' }) });
                toast('Test account added'); break;
            case 'remove-test-account':
                if (!await openConfirm({ title: 'Remove test account', body: `Remove ${params.email}?`, okLabel: 'Remove' })) return;
                await api(`test-accounts/${encodeURIComponent(params.email)}`, { method: 'DELETE' });
                toast('Removed'); break;
        }
        loadDashboardAdmins();
    } catch (e) { toast(e.message, 'error'); }
}

// ═════════════════════════════════════════════════════════════════
// EVENT DELEGATION
// ═════════════════════════════════════════════════════════════════
// DATA TAB
// ═════════════════════════════════════════════════════════════════

async function loadDataTab() {
    const c = document.getElementById('data-content');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const stats = await api('data/stats');
        renderDataTab(stats, c);
    } catch (e) { c.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`; }
}

function renderDataTab(stats, container) {
    container.innerHTML = `
        <div class="summary-cards" style="margin-bottom:1.5rem;">
            <div class="summary-card"><div class="summary-value">${stats.total_sessions}</div><div class="summary-label">Total Sessions</div></div>
            <div class="summary-card"><div class="summary-value">${stats.submitted_sessions}</div><div class="summary-label">Submitted / Approved</div></div>
            <div class="summary-card"><div class="summary-value">${stats.draft_sessions}</div><div class="summary-label">Draft / In-Progress</div></div>
            <div class="summary-card"><div class="summary-value">${stats.total_hunt_results}</div><div class="summary-label">Hunt Results</div></div>
            <div class="summary-card"><div class="summary-value">${stats.total_trainers ?? 0}</div><div class="summary-label">Trainer rows (PG)</div></div>
        </div>
        <div class="card" style="margin-bottom:1rem;">
            <div class="card-header"><h3>Delete Single Session</h3></div>
            <div style="padding:1rem;display:flex;gap:0.5rem;align-items:flex-end;">
                <div class="form-group" style="flex:1;margin:0;">
                    <label for="delete-session-id">Session ID</label>
                    <input type="text" id="delete-session-id" placeholder="e.g. a3f2b91c" />
                </div>
                <button class="btn btn-danger btn-sm" id="delete-session-btn">Delete</button>
            </div>
        </div>
        <div class="card" style="margin-bottom:1rem;">
            <div class="card-header"><h3>Wipe Draft / Test Sessions</h3></div>
            <div style="padding:1rem;">
                <p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.75rem;">
                    Removes all sessions that are NOT submitted or approved. Submitted and approved sessions are preserved.
                </p>
                <div style="display:flex;gap:0.5rem;align-items:flex-end;">
                    <div class="form-group" style="margin:0;">
                        <label for="wipe-days">Older than (days, optional)</label>
                        <input type="number" id="wipe-days" placeholder="All" min="1" style="width:100px;" />
                    </div>
                    <button class="btn btn-danger btn-sm" id="wipe-sessions-btn">Wipe Drafts</button>
                </div>
            </div>
        </div>
        <div class="card db-browse-card">
            <div class="card-header"><h3>Database browser</h3></div>
            <div id="db-browse-root" style="padding:0 0 1rem;">
                <div class="db-sub-tabs" id="db-sub-tabs"></div>
                <div class="db-toolbar">
                    <div class="form-group">
                        <label for="db-browse-search">Search</label>
                        <input type="text" id="db-browse-search" placeholder="Filter rows…" style="min-width:180px;" />
                    </div>
                    <div class="form-group">
                        <label for="db-browse-sort">Sort</label>
                        <select id="db-browse-sort"></select>
                    </div>
                    <div class="form-group">
                        <label for="db-browse-order">Order</label>
                        <select id="db-browse-order"><option value="desc">desc</option><option value="asc">asc</option></select>
                    </div>
                    <div class="form-group">
                        <label for="db-browse-limit">Per page</label>
                        <select id="db-browse-limit"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select>
                    </div>
                    <div class="db-toolbar-actions">
                        <button type="button" class="btn btn-sm btn-danger" id="db-browse-bulk-del" disabled>Delete selected</button>
                        <button type="button" class="btn btn-sm btn-ghost hidden" id="db-browse-sync-trainers" title="Upsert trainers from sessions.metadata emails and link trainer_id">Sync trainers from sessions</button>
                        <button type="button" class="btn btn-sm" id="db-browse-add">Add row</button>
                    </div>
                </div>
                <div id="db-browse-table-wrap" class="db-table-wrap"><div class="loading">Loading…</div></div>
                <div id="db-browse-pager"></div>
            </div>
        </div>
    `;
    document.getElementById('delete-session-btn').addEventListener('click', async () => {
        const sid = document.getElementById('delete-session-id').value.trim();
        if (!sid) { toast('Enter a session ID', 'error'); return; }
        if (!await openConfirm({ title: 'Delete session', body: `Delete session ${sid}? This cannot be undone.`, okLabel: 'Delete' })) return;
        try {
            await api(`data/session/${encodeURIComponent(sid)}`, { method: 'DELETE' });
            toast(`Session ${sid} deleted`);
            loadDataTab();
        } catch (e) { toast(e.message, 'error'); }
    });
    document.getElementById('wipe-sessions-btn').addEventListener('click', async () => {
        const days = document.getElementById('wipe-days').value;
        const msg = days
            ? `Wipe all draft sessions older than ${days} days?`
            : 'Wipe ALL draft/in-progress sessions? Submitted & approved are safe.';
        if (!await openConfirm({ title: 'Wipe sessions', body: msg, okLabel: 'Wipe' })) return;
        try {
            const body = { confirm: 'yes' };
            if (days) body.older_than_days = parseInt(days);
            const result = await api('data/wipe-sessions', { method: 'POST', body: JSON.stringify(body) });
            toast(`Wiped: ${result.sessions}, results: ${result.results}`);
            loadDataTab();
        } catch (e) { toast(e.message, 'error'); }
    });
    initDbBrowse(container);
}

const DB_TABLES = ['sessions', 'hunt_results', 'trainers', 'qc_runs'];

function _dbPath(p) {
    return `data/browse/${p}`;
}

async function loadDbBrowseSchema(table) {
    if (dbBrowseState.schemaCache[table]) return dbBrowseState.schemaCache[table];
    const s = await api(_dbPath(`${table}/schema`));
    dbBrowseState.schemaCache[table] = s;
    return s;
}

function _dbIsNumericType(dt) {
    if (!dt) return false;
    return dt === 'integer' || dt === 'bigint' || dt === 'smallint' || dt === 'double precision' || dt === 'real'
        || String(dt).includes('numeric');
}

function _dbFieldInputHtml(col, val, mode) {
    const id = `dbf-${col.name}`;
    const ro = col.is_pk && mode === 'edit';
    const v = val !== undefined && val !== null ? val : '';
    if (col.data_type === 'jsonb') {
        const tv = (v === '' || v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
        return `<div class="form-group"><label for="${id}">${esc(col.name)}</label><textarea id="${id}" data-dbf="${esc(col.name)}" data-jsonb="1" ${ro ? 'readonly' : ''}>${esc(tv)}</textarea></div>`;
    }
    if (col.data_type === 'boolean') {
        const chk = v === true || v === 'true';
        return `<div class="form-group"><label><input type="checkbox" id="${id}" data-dbf="${esc(col.name)}" ${chk ? 'checked' : ''} ${ro ? 'disabled' : ''} /> ${esc(col.name)}</label></div>`;
    }
    if (_dbIsNumericType(col.data_type)) {
        return `<div class="form-group"><label for="${id}">${esc(col.name)}</label><input type="number" step="any" id="${id}" data-dbf="${esc(col.name)}" value="${esc(v)}" ${ro ? 'readonly' : ''} /></div>`;
    }
    if (String(col.data_type || '').includes('timestamp') || col.data_type === 'date') {
        return `<div class="form-group"><label for="${id}">${esc(col.name)}</label><input type="text" id="${id}" data-dbf="${esc(col.name)}" value="${esc(v)}" placeholder="ISO-8601" ${ro ? 'readonly' : ''} /></div>`;
    }
    if (col.data_type === 'uuid' || String(col.data_type || '').includes('uuid')) {
        const hideAddUuidPk = mode === 'add' && col.is_pk && (col.data_type === 'uuid' || String(col.data_type || '').includes('uuid'));
        if (hideAddUuidPk) {
            return `<div class="form-group"><label>${esc(col.name)}</label><p style="font-size:0.75rem;color:var(--text-secondary);">Auto-generated UUID on save</p><input type="hidden" id="${id}" data-dbf="${esc(col.name)}" value="" /></div>`;
        }
        return `<div class="form-group"><label for="${id}">${esc(col.name)}</label><input type="text" id="${id}" data-dbf="${esc(col.name)}" value="${esc(v)}" ${ro ? 'readonly' : ''} /></div>`;
    }
    const longText = /prompt|response|reasoning|explanation|judge_output|error|trace/i.test(col.name);
    if (longText || String(v).length > 120) {
        return `<div class="form-group"><label for="${id}">${esc(col.name)}</label><textarea id="${id}" data-dbf="${esc(col.name)}" ${ro ? 'readonly' : ''}>${esc(v)}</textarea></div>`;
    }
    return `<div class="form-group"><label for="${id}">${esc(col.name)}</label><input type="text" id="${id}" data-dbf="${esc(col.name)}" value="${esc(v)}" ${ro ? 'readonly' : ''} /></div>`;
}

function _dbCollectPayload(schema) {
    const out = {};
    for (const col of schema.columns) {
        const el = document.getElementById(`dbf-${col.name}`);
        if (!el) continue;
        if (col.data_type === 'jsonb') {
            const s = el.value.trim();
            if (!s) out[col.name] = null;
            else {
                try { out[col.name] = JSON.parse(s); }
                catch (e) { throw new Error(`Invalid JSON in ${col.name}: ${e.message}`); }
            }
            continue;
        }
        if (col.data_type === 'boolean') {
            out[col.name] = el.checked;
            continue;
        }
        if (_dbIsNumericType(col.data_type)) {
            const raw = el.value.trim();
            if (raw === '') out[col.name] = null;
            else if (col.data_type === 'integer' || col.data_type === 'bigint' || col.data_type === 'smallint') out[col.name] = parseInt(raw, 10);
            else out[col.name] = parseFloat(raw);
            continue;
        }
        const raw = el.value;
        if (raw === '' && col.nullable && !col.is_pk) out[col.name] = null;
        else out[col.name] = raw;
    }
    return out;
}

let _dbModalLastFocus = null;
let _dbModalKeyHandler = null;

function openDbModal(mode, table, schema, row) {
    dbBrowseLastSchema = schema;
    dbModalCtx = { mode, table, pk: schema.pk, row: row || null };
    const title = document.getElementById('db-row-modal-title');
    const sub = document.getElementById('db-row-modal-sub');
    const fields = document.getElementById('db-row-modal-fields');
    const delBtn = document.getElementById('db-row-modal-delete');
    title.textContent = mode === 'add' ? `Add row — ${table}` : `Edit row — ${table}`;
    sub.textContent = mode === 'edit' && row ? `${schema.pk}: ${row[schema.pk]}` : '';
    let h = '';
    for (const col of schema.columns) {
        const val = mode === 'edit' && row ? row[col.name] : undefined;
        h += _dbFieldInputHtml(col, val, mode);
    }
    fields.innerHTML = h;
    delBtn.style.display = mode === 'edit' ? '' : 'none';
    const modal = document.getElementById('db-row-modal');
    modal.classList.remove('hidden');
    _dbModalLastFocus = document.activeElement;
    _dbModalKeyHandler = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeDbModal(); }
        else if (e.key === 'Tab') _trapFocus(e, modal);
    };
    modal.addEventListener('keydown', _dbModalKeyHandler);
    setTimeout(() => {
        const first = modal.querySelector('input:not([type=hidden]), select, textarea, button:not([disabled])');
        if (first) first.focus();
    }, 10);
}

function closeDbModal() {
    const modal = document.getElementById('db-row-modal');
    modal.classList.add('hidden');
    if (_dbModalKeyHandler) {
        modal.removeEventListener('keydown', _dbModalKeyHandler);
        _dbModalKeyHandler = null;
    }
    if (_dbModalLastFocus && typeof _dbModalLastFocus.focus === 'function') {
        try { _dbModalLastFocus.focus(); } catch (_) {}
    }
    _dbModalLastFocus = null;
}

async function saveDbModal() {
    const { mode, table, pk, row } = dbModalCtx;
    let s = dbBrowseLastSchema;
    if (!s || s.table !== table) {
        try { s = await loadDbBrowseSchema(table); dbBrowseLastSchema = s; }
        catch (e) { toast(e.message, 'error'); return; }
    }
    try {
        if (mode === 'add') {
            const body = _dbCollectPayload(s);
            const pkCol = s.columns.find(c => c.name === s.pk);
            if (pkCol && (pkCol.data_type === 'uuid' || String(pkCol.data_type || '').includes('uuid'))) {
                if (body[s.pk] === '' || body[s.pk] == null) delete body[s.pk];
            }
            await api(_dbPath(table), { method: 'POST', body: JSON.stringify(body) });
            toast('Row created');
        } else {
            const rid = row[pk];
            const body = _dbCollectPayload(s);
            delete body[pk];
            await api(_dbPath(`${table}/${encodeURIComponent(String(rid))}`), { method: 'PUT', body: JSON.stringify(body) });
            toast('Row updated');
        }
        closeDbModal();
        if (dbBrowseContainer) refreshDbBrowse(dbBrowseContainer);
    } catch (e) { toast(e.message, 'error'); }
}

async function deleteDbModalRow() {
    const { table, pk, row } = dbModalCtx;
    if (!row) return;
    if (!await openConfirm({ title: 'Delete row', body: 'Delete this row?', okLabel: 'Delete' })) return;
    const rid = row[pk];
    try {
        await api(_dbPath(`${table}/${encodeURIComponent(String(rid))}`), { method: 'DELETE' });
        toast('Row deleted');
        closeDbModal();
        if (dbBrowseContainer) refreshDbBrowse(dbBrowseContainer);
    } catch (e) { toast(e.message, 'error'); }
}

function _dbCellPreview(val) {
    if (val === null || val === undefined) return '—';
    if (typeof val === 'object') {
        const j = JSON.stringify(val);
        return j.length > 90 ? j.slice(0, 87) + '…' : j;
    }
    const s = String(val);
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

function _dbCellTitle(val) {
    if (val === null || val === undefined) return '';
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > 1600 ? `${flat.slice(0, 1597)}…` : flat;
}

function _dbUpdateBulkDeleteButton(container) {
    const btn = container.querySelector('#db-browse-bulk-del');
    if (!btn) return;
    const n = dbBrowseState.selected.size;
    btn.disabled = n === 0;
    btn.textContent = n ? `Delete selected (${n})` : 'Delete selected';
}

function _dbUpdateSelectAllState(wrap) {
    const selAll = wrap.querySelector('#db-browse-select-all');
    if (!selAll || !dbBrowseLastRows.length) return;
    const pk = dbBrowseLastSchema?.pk;
    if (!pk) return;
    const onPage = dbBrowseLastRows.map(r => String(r[pk]));
    const nSel = onPage.filter(id => dbBrowseState.selected.has(id)).length;
    selAll.checked = nSel === onPage.length && onPage.length > 0;
    selAll.indeterminate = nSel > 0 && nSel < onPage.length;
}

async function dbBrowseBulkDelete(container) {
    const ids = [...dbBrowseState.selected];
    if (!ids.length) return;
    if (!await openConfirm({ title: 'Delete rows', body: `Permanently delete ${ids.length} row(s) from "${dbBrowseState.table}"?`, okLabel: 'Delete' })) return;
    try {
        const r = await api(_dbPath(`${dbBrowseState.table}/bulk-delete`), {
            method: 'POST',
            body: JSON.stringify({ ids, confirm: 'yes' }),
        });
        dbBrowseState.selected.clear();
        toast(`Deleted ${r.deleted} row(s)`);
        if (dbBrowseContainer) refreshDbBrowse(dbBrowseContainer);
        try {
            const stats = await api('data/stats');
            const cards = document.querySelectorAll('#data-content .summary-card .summary-value');
            if (cards.length >= 5) {
                cards[0].textContent = stats.total_sessions;
                cards[1].textContent = stats.submitted_sessions;
                cards[2].textContent = stats.draft_sessions;
                cards[3].textContent = stats.total_hunt_results;
                cards[4].textContent = stats.total_trainers ?? 0;
            }
        } catch (_) { /* ignore */ }
    } catch (e) { toast(e.message, 'error'); }
}

async function dbBrowseSyncTrainers(container) {
    if (!await openConfirm({ title: 'Sync trainers', body: 'Upsert trainer rows from session metadata emails and link sessions.trainer_id?', okLabel: 'Sync', okClass: 'btn-primary' })) return;
    try {
        const r = await api('data/sync-trainers-from-sessions', { method: 'POST', body: '{}' });
        toast(`Trainers ${r.trainers_before} → ${r.trainers_after}; sessions updated: ${r.sessions_updated}`);
        loadDataTab();
    } catch (e) { toast(e.message, 'error'); }
}

function renderDbTableHtml(schema, listData) {
    const cols = schema.columns.slice(0, 12);
    const pk = schema.pk;
    let th = `<th class="db-col-check"><input type="checkbox" id="db-browse-select-all" aria-label="Select all on this page" /></th>`;
    th += cols.map(c => `<th title="${attrEsc(c.name)}"><span class="db-th-inner">${esc(c.name)}</span></th>`).join('');
    th += '<th class="db-cell-actions"> </th>';
    const rows = listData.rows || [];
    dbBrowseLastRows = rows;
    dbBrowseLastSchema = schema;
    let tr = '';
    rows.forEach((row, i) => {
        const pkStr = String(row[pk]);
        const checked = dbBrowseState.selected.has(pkStr) ? 'checked' : '';
        let tds = `<td class="db-cell-check" data-db-stop-propagation="1"><input type="checkbox" class="db-row-select" data-db-pk="${attrEsc(pkStr)}" ${checked} aria-label="Select row" /></td>`;
        tds += cols.map((c) => {
            const v = row[c.name];
            const jsonish = c.data_type === 'jsonb' || /json|history|notebook|config|reviews|turns|payload|metadata|blob/i.test(c.name);
            const cls = jsonish ? 'db-cell-json' : '';
            const tip = _dbCellTitle(v);
            const tit = tip ? ` title="${attrEsc(tip)}"` : '';
            return `<td class="db-cell-data ${cls}"${tit}>${esc(_dbCellPreview(v))}</td>`;
        }).join('');
        tds += `<td class="db-cell-actions"><button type="button" class="btn btn-xs btn-danger db-row-del" data-row-index="${i}">Del</button></td>`;
        tr += `<tr class="db-row" data-row-index="${i}">${tds}</tr>`;
    });
    const colSpan = cols.length + 2;
    return `<table class="db-table"><thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${colSpan}" style="padding:1rem;color:var(--text-muted)">No rows</td></tr>`}</tbody></table>`;
}

function renderDbPagerHtml(listData) {
    const total = listData.total || 0;
    const page = listData.page || 1;
    const limit = listData.limit || 25;
    const pages = Math.max(1, Math.ceil(total / limit));
    return `
        <div class="db-pager">
            <span>${total} rows</span>
            <span>Page ${page} / ${pages}</span>
            <button type="button" class="btn btn-xs" id="db-pager-prev" ${page <= 1 ? 'disabled' : ''}>Prev</button>
            <button type="button" class="btn btn-xs" id="db-pager-next" ${page >= pages ? 'disabled' : ''}>Next</button>
        </div>
    `;
}

function syncDbToolbar(schema) {
    const sortSel = document.getElementById('db-browse-sort');
    const orderSel = document.getElementById('db-browse-order');
    const limitSel = document.getElementById('db-browse-limit');
    if (!sortSel) return;
    const sortable = schema.sortable || [];
    sortSel.innerHTML = sortable.map(s => `<option value="${esc(s)}" ${s === dbBrowseState.sort ? 'selected' : ''}>${esc(s)}</option>`).join('');
    if (!dbBrowseState.sort && sortable.length) dbBrowseState.sort = sortable[0];
    sortSel.value = dbBrowseState.sort || sortable[0] || '';
    orderSel.value = dbBrowseState.order;
    limitSel.value = String(dbBrowseState.limit);
}

async function refreshDbBrowse(container) {
    const wrap = container.querySelector('#db-browse-table-wrap');
    const pager = container.querySelector('#db-browse-pager');
    if (!wrap) return;
    wrap.innerHTML = '<div class="loading">Loading…</div>';
    try {
        const schema = await loadDbBrowseSchema(dbBrowseState.table);
        syncDbToolbar(schema);
        const params = new URLSearchParams();
        params.set('page', String(dbBrowseState.page));
        params.set('limit', String(dbBrowseState.limit));
        params.set('order', dbBrowseState.order);
        if (dbBrowseState.search) params.set('search', dbBrowseState.search);
        if (dbBrowseState.sort) params.set('sort', dbBrowseState.sort);
        const listData = await api(_dbPath(`${dbBrowseState.table}?${params}`));
        wrap.innerHTML = renderDbTableHtml(schema, listData);
        if (pager) pager.innerHTML = renderDbPagerHtml(listData);
        const syncBtn = container.querySelector('#db-browse-sync-trainers');
        if (syncBtn) syncBtn.classList.toggle('hidden', dbBrowseState.table !== 'trainers');
        _dbUpdateBulkDeleteButton(container);
        const selAll = wrap.querySelector('#db-browse-select-all');
        if (selAll) {
            selAll.addEventListener('change', () => {
                const on = selAll.checked;
                (listData.rows || []).forEach((r) => {
                    const id = String(r[schema.pk]);
                    if (on) dbBrowseState.selected.add(id);
                    else dbBrowseState.selected.delete(id);
                });
                wrap.querySelectorAll('.db-row-select').forEach((cb) => { cb.checked = on; });
                _dbUpdateBulkDeleteButton(container);
            });
        }
        wrap.querySelectorAll('.db-row-select').forEach((cb) => {
            cb.addEventListener('click', (ev) => ev.stopPropagation());
            cb.addEventListener('change', () => {
                const id = cb.getAttribute('data-db-pk');
                if (!id) return;
                if (cb.checked) dbBrowseState.selected.add(id);
                else dbBrowseState.selected.delete(id);
                _dbUpdateBulkDeleteButton(container);
                _dbUpdateSelectAllState(wrap);
            });
        });
        _dbUpdateSelectAllState(wrap);
        wrap.querySelectorAll('.db-row').forEach((tr) => {
            tr.addEventListener('click', (e) => {
                if (e.target.closest('.db-row-del') || e.target.closest('.db-row-select') || e.target.closest('.db-cell-check')) return;
                const i = parseInt(tr.dataset.rowIndex, 10);
                openDbModal('edit', dbBrowseState.table, schema, dbBrowseLastRows[i]);
            });
        });
        wrap.querySelectorAll('.db-row-del').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const i = parseInt(btn.dataset.rowIndex, 10);
                const row = dbBrowseLastRows[i];
                const pk = schema.pk;
                if (!row) return;
                if (!await openConfirm({ title: 'Delete row', body: `Delete row ${row[pk]}?`, okLabel: 'Delete' })) return;
                try {
                    await api(_dbPath(`${dbBrowseState.table}/${encodeURIComponent(String(row[pk]))}`), { method: 'DELETE' });
                    toast('Row deleted');
                    dbBrowseState.selected.delete(String(row[pk]));
                    refreshDbBrowse(container);
                } catch (err) { toast(err.message, 'error'); }
            });
        });
        const prev = container.querySelector('#db-pager-prev');
        const next = container.querySelector('#db-pager-next');
        if (prev) prev.onclick = () => { dbBrowseState.page = Math.max(1, dbBrowseState.page - 1); refreshDbBrowse(container); };
        if (next) next.onclick = () => { dbBrowseState.page += 1; refreshDbBrowse(container); };
    } catch (e) {
        wrap.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
        if (pager) pager.innerHTML = '';
    }
}

function initDbBrowse(container) {
    dbBrowseContainer = container;
    dbBrowseState = { table: 'sessions', page: 1, limit: 25, search: '', sort: '', order: 'desc', schemaCache: {}, selected: new Set() };
    const tabs = container.querySelector('#db-sub-tabs');
    if (!tabs) return;
    tabs.innerHTML = DB_TABLES.map(t => `<button type="button" class="db-sub-tab ${t === dbBrowseState.table ? 'active' : ''}" data-db-table="${t}">${t}</button>`).join('');
    tabs.querySelectorAll('.db-sub-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            dbBrowseState.table = btn.dataset.dbTable;
            dbBrowseState.page = 1;
            dbBrowseState.search = '';
            dbBrowseState.sort = '';
            dbBrowseState.selected = new Set();
            tabs.querySelectorAll('.db-sub-tab').forEach(b => b.classList.toggle('active', b.dataset.dbTable === dbBrowseState.table));
            const search = container.querySelector('#db-browse-search');
            if (search) search.value = '';
            refreshDbBrowse(container);
        });
    });
    const searchIn = container.querySelector('#db-browse-search');
    const debounced = debounce(() => {
        dbBrowseState.search = searchIn.value.trim();
        dbBrowseState.page = 1;
        dbBrowseState.selected.clear();
        refreshDbBrowse(container);
    }, 350);
    searchIn.addEventListener('input', debounced);
    container.querySelector('#db-browse-sort').addEventListener('change', (e) => {
        dbBrowseState.sort = e.target.value;
        dbBrowseState.page = 1;
        dbBrowseState.selected.clear();
        refreshDbBrowse(container);
    });
    container.querySelector('#db-browse-order').addEventListener('change', (e) => {
        dbBrowseState.order = e.target.value;
        dbBrowseState.page = 1;
        dbBrowseState.selected.clear();
        refreshDbBrowse(container);
    });
    container.querySelector('#db-browse-limit').addEventListener('change', (e) => {
        dbBrowseState.limit = parseInt(e.target.value, 10);
        dbBrowseState.page = 1;
        dbBrowseState.selected.clear();
        refreshDbBrowse(container);
    });
    container.querySelector('#db-browse-add').addEventListener('click', async () => {
        try {
            const schema = await loadDbBrowseSchema(dbBrowseState.table);
            openDbModal('add', dbBrowseState.table, schema, null);
        } catch (e) { toast(e.message, 'error'); }
    });
    const bulkBtn = container.querySelector('#db-browse-bulk-del');
    if (bulkBtn) bulkBtn.addEventListener('click', () => dbBrowseBulkDelete(container));
    const syncTr = container.querySelector('#db-browse-sync-trainers');
    if (syncTr) syncTr.addEventListener('click', () => dbBrowseSyncTrainers(container));
    refreshDbBrowse(container);
}

// ═════════════════════════════════════════════════════════════════

function init() {
    checkSession();

    const dashLink = document.getElementById('admin-dashboard-link');
    if (dashLink) dashLink.href = _dashboardServicePrefix() + '/';

    document.body.addEventListener('click', (e) => {
        const stop = e.target.closest('[data-db-stop-propagation]');
        if (stop) { e.stopPropagation(); }
        const hdr = e.target.closest('[data-action="toggle-config-section"]');
        if (hdr) {
            hdr.classList.toggle('collapsed');
            if (hdr.nextElementSibling) hdr.nextElementSibling.classList.toggle('collapsed');
            hdr.setAttribute('aria-expanded', (!hdr.classList.contains('collapsed')).toString());
        }
    });
    document.body.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const hdr = e.target.closest('[data-action="toggle-config-section"]');
        if (hdr) {
            e.preventDefault();
            hdr.click();
        }
    });

    const superToggle = document.getElementById('super-toggle');
    const passwordGroup = document.getElementById('password-group');
    const loginBtn = document.getElementById('login-btn');
    const loginError = document.getElementById('login-error');

    if (superToggle.checked) passwordGroup.classList.remove('hidden');
    superToggle.addEventListener('change', () => passwordGroup.classList.toggle('hidden', !superToggle.checked));

    loginBtn.addEventListener('click', async () => {
        loginError.textContent = '';
        loginBtn.disabled = true;
        try {
            if (superToggle.checked) {
                const pw = document.getElementById('login-password').value;
                if (!pw) { loginError.textContent = 'Password required'; return; }
                await api('login', { method: 'POST', body: JSON.stringify({ password: pw }) });
            } else {
                const em = document.getElementById('login-email').value.trim();
                if (!em) { loginError.textContent = 'Email required'; return; }
                await api('login-email', { method: 'POST', body: JSON.stringify({ email: em }) });
            }
            await checkSession();
        } catch (e) { loginError.textContent = e.message; }
        finally { loginBtn.disabled = false; }
    });

    document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
    document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('db-row-modal-cancel').addEventListener('click', closeDbModal);
    document.getElementById('db-row-modal').addEventListener('click', (e) => { if (e.target.id === 'db-row-modal') closeDbModal(); });
    document.getElementById('db-row-modal-save').addEventListener('click', () => saveDbModal());
    document.getElementById('db-row-modal-delete').addEventListener('click', () => deleteDbModalRow());
    document.getElementById('tab-nav').addEventListener('click', e => { const b = e.target.closest('.tab-btn'); if (b?.dataset.tab) showTab(b.dataset.tab); });
    _initAdminTabKeyboardNav();

    document.addEventListener('input', e => {
        if (e.target.classList?.contains('pod-trainer-filter')) {
            const card = e.target.closest('.pod-card');
            const q = e.target.value.trim().toLowerCase();
            if (!card) return;
            const root = card.querySelector('.trainer-chip-list');
            if (!root) return;
            const det = root.querySelector('.trainer-more-details');
            if (!q) {
                root.querySelectorAll('.trainer-chip').forEach(chip => { chip.style.display = ''; });
                if (det) det.style.display = '';
            } else {
                root.querySelectorAll('.trainer-chip').forEach(chip => {
                    const em = (chip.dataset.trainerEmail || '').toLowerCase();
                    chip.style.display = em.includes(q) ? '' : 'none';
                });
                if (det) {
                    const any = [...det.querySelectorAll('.trainer-chip')].some(c => c.style.display !== 'none');
                    det.open = any;
                    det.style.display = any ? '' : 'none';
                }
            }
        }
        if (e.target.id === 'config-search') scheduleConfigSearch(e.target.value);
    });

    document.addEventListener('click', e => {
        const act = e.target.closest('[data-action]');
        const action = act?.dataset?.action;
        const t = e.target;

        if (action === 'remove-trainer') { handleTeamAction('remove-trainer', { pod: act.dataset.pod, email: act.dataset.email }); return; }
        if (action === 'remove-admin') { handleTeamAction('remove-admin', { email: act.dataset.email }); return; }
        if (action === 'remove-super-admin') { handleTeamAction('remove-super-admin', { email: act.dataset.email }); return; }
        if (action === 'set-reviewer') {
            openTeamReviewerModal(act.dataset.pod, act.dataset.revEmail || '', act.dataset.revName || '', 'reviewer');
            return;
        }
        if (action === 'set-pod-lead') {
            openTeamReviewerModal(act.dataset.pod, act.dataset.leadEmail || '', act.dataset.leadName || '', 'pod-lead');
            return;
        }
        if (action === 'remove-pod') { handleTeamAction('remove-pod', { pod: act.dataset.pod }); return; }
        if (action === 'remove-pod-lead') { handleTeamAction('remove-pod-lead', { pod: act.dataset.pod }); return; }
        if (action === 'remove-pod-reviewer') { handleTeamAction('remove-pod-reviewer', { pod: act.dataset.pod }); return; }
        if (action === 'remove-dashboard-admin') { handleAdminsAction('remove-dashboard-admin', { email: act.dataset.email }); return; }
        if (action === 'remove-test-account') { handleAdminsAction('remove-test-account', { email: act.dataset.email }); return; }
        if (action === 'save-config-section') { saveConfigSection(act.dataset.section); return; }
        if (action === 'config-expand-all') {
            document.querySelectorAll('#config-content .config-section-header').forEach(h => { h.classList.remove('collapsed'); h.setAttribute('aria-expanded', 'true'); });
            document.querySelectorAll('#config-content .config-section-body').forEach(b => b.classList.remove('collapsed'));
            return;
        }
        if (action === 'config-collapse-all') {
            document.querySelectorAll('#config-content .config-section-header').forEach(h => { h.classList.add('collapsed'); h.setAttribute('aria-expanded', 'false'); });
            document.querySelectorAll('#config-content .config-section-body').forEach(b => b.classList.add('collapsed'));
            return;
        }
        if (t.id === 'config-reload-btn' || act?.id === 'config-reload-btn') { api('config/reload', { method: 'POST' }).then(() => { toast('Cache reloaded'); loadConfig(); }).catch(err => toast(err.message, 'error')); return; }
        if (action === 'remove-array-item') { _handleArrayAction('remove', act.dataset.arrayKey, parseInt(act.dataset.idx, 10), act.dataset.id || ''); return; }
        if (action === 'add-array-item') { _handleArrayAction('add', act.dataset.arrayKey); return; }
        if (action === 'remove-chip') { _handleChipAction('remove', act.dataset.chipKey, act.dataset.email); return; }
        if (action === 'add-chip') {
            const input = document.querySelector(`[data-chip-input="${act.dataset.chipKey}"]`);
            if (input?.value.trim()) { _handleChipAction('add', act.dataset.chipKey, input.value); }
            return;
        }

        const formBtn = e.target.closest('[data-form] button');
        const form = formBtn?.closest('[data-form]');
        if (form && formBtn) {
            const ft = form.dataset.form, fields = {};
            form.querySelectorAll('[data-field]').forEach(inp => { fields[inp.dataset.field] = inp.value.trim(); });
            if (ft === 'add-trainer') { if (!fields.email) { toast('Email required', 'error'); return; } handleTeamAction('add-trainer', { pod: form.dataset.pod, email: fields.email }); }
            else if (ft === 'add-admin') { if (!fields.email) { toast('Email required', 'error'); return; } handleTeamAction('add-admin', { email: fields.email, name: fields.name }); }
            else if (ft === 'add-super-admin') { if (!fields.email) { toast('Email required', 'error'); return; } handleTeamAction('add-super-admin', { email: fields.email, name: fields.name }); }
            else if (ft === 'create-pod') { if (!fields.pod_id || !fields.name) { toast('Both fields required', 'error'); return; } handleTeamAction('create-pod', { pod_id: fields.pod_id, name: fields.name }); }
            else if (ft === 'add-dashboard-admin') { if (!fields.email) { toast('Email required', 'error'); return; } handleAdminsAction('add-dashboard-admin', { email: fields.email, name: fields.name }); }
            else if (ft === 'add-test-account') { if (!fields.email) { toast('Email required', 'error'); return; } handleAdminsAction('add-test-account', { email: fields.email, name: fields.name }); }
        }
    });

    wireTeamReviewerModal();
}

function openTeamReviewerModal(podId, email, name, modalMode = 'reviewer') {
    const modal = document.getElementById('team-reviewer-modal');
    if (!modal) return;
    document.getElementById('reviewer-modal-pod').value = podId || '';
    const modeEl = document.getElementById('reviewer-modal-mode');
    if (modeEl) modeEl.value = modalMode === 'pod-lead' ? 'pod-lead' : 'reviewer';
    const title = document.getElementById('reviewer-modal-title');
    if (title) title.textContent = modalMode === 'pod-lead' ? 'Pod lead' : 'Reviewer';
    const sub = document.getElementById('reviewer-modal-pod-label');
    if (sub) sub.textContent = podId ? `Pod: ${podId}` : '';
    document.getElementById('reviewer-modal-email').value = email || '';
    document.getElementById('reviewer-modal-name').value = name || '';
    modal.classList.remove('hidden');
    document.getElementById('reviewer-modal-email')?.focus();
}

function closeTeamReviewerModal() {
    document.getElementById('team-reviewer-modal')?.classList.add('hidden');
}

function wireTeamReviewerModal() {
    const modal = document.getElementById('team-reviewer-modal');
    if (!modal || modal.dataset.wired === '1') return;
    modal.dataset.wired = '1';
    modal.querySelector('[data-reviewer-dismiss]')?.addEventListener('click', closeTeamReviewerModal);
    modal.querySelector('#reviewer-modal-save')?.addEventListener('click', async () => {
        const pod = document.getElementById('reviewer-modal-pod').value;
        const em = document.getElementById('reviewer-modal-email').value.trim();
        const nm = document.getElementById('reviewer-modal-name').value.trim();
        const mode = document.getElementById('reviewer-modal-mode')?.value || 'reviewer';
        if (!em) { toast(mode === 'pod-lead' ? 'Pod lead email required' : 'Reviewer email required', 'error'); return; }
        try {
            if (mode === 'pod-lead') {
                await api(`team/pods/${encodeURIComponent(pod)}/pod-lead`, { method: 'PUT', body: JSON.stringify({ email: em, name: nm }) });
                toast('Pod lead updated');
            } else {
                await api(`team/pods/${encodeURIComponent(pod)}/reviewer`, { method: 'PUT', body: JSON.stringify({ email: em, name: nm }) });
                toast('Reviewer updated');
            }
            closeTeamReviewerModal();
            loadTeam();
        } catch (err) { toast(err.message, 'error'); }
    });
    modal.addEventListener('click', e => { if (e.target === modal) closeTeamReviewerModal(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !document.getElementById('team-reviewer-modal')?.classList.contains('hidden')) closeTeamReviewerModal();
    });
}

if (window.location.search.includes('_v=')) {
    window.history.replaceState(null, '', window.location.pathname);
}

function initAdminVersionCheck() {
    const d = _dashboardServicePrefix();
    import(`${d}/updates-assets/version-check.mjs`)
        .then(({ createIndicatorClickVersionCheck, showSimpleUpdateModal }) => {
            const vc = createIndicatorClickVersionCheck({
                versionUrl: `${d}/api/version`,
                intervalMs: 30000,
                indicatorId: 'adminUpdateIndicator',
                showModal: async () =>
                    showSimpleUpdateModal({
                        title: 'New update available',
                        message:
                            'A new version of the admin panel is ready.\n\nRefreshing will reload the page and reset your current view.',
                        confirmLabel: 'Update now',
                        cancelLabel: 'Not now',
                    }),
            });
            vc.initVersionCheck();
        })
        .catch((e) => console.error('[admin version-check]', e));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

initAdminVersionCheck();
