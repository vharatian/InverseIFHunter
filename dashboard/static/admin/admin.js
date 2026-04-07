/**
 * Admin Panel — Model Hunter
 * Vanilla JS: team management, config editing, tracking, dashboard admin management.
 */

let currentUser = null;

// Base path prefix — detects /staging or similar prefix from the current URL.
// E.g. /staging/admin/ → _basePath = '/staging', /admin/ → _basePath = ''
const _basePath = (() => {
    const idx = window.location.pathname.indexOf('/admin');
    return idx > 0 ? window.location.pathname.substring(0, idx) : '';
})();

// ─── Helpers ─────────────────────────────────────────────────────

async function api(path, options = {}) {
    const res = await fetch(`${_basePath}/api/admin/${path}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...options.headers },
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

function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

function esc(str) {
    if (str === null || str === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

function isSuper() { return currentUser && currentUser.is_super; }

// ─── Auth ────────────────────────────────────────────────────────

async function checkSession() {
    try { currentUser = await api('me'); showPanel(); loadTeam(); }
    catch { showLoginGate(); }
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
}

async function logout() {
    try { await api('logout', { method: 'POST' }); } catch {}
    currentUser = null;
    showLoginGate();
}

// ─── Tab switching ───────────────────────────────────────────────

function showTab(tabName) {
    document.querySelectorAll('#tab-nav .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.content-area > .section').forEach(s => s.classList.toggle('active', s.id === `section-${tabName}`));
    ({ team: loadTeam, config: loadConfig, tracking: loadTracking, admins: loadDashboardAdmins })[tabName]?.();
}

// ═════════════════════════════════════════════════════════════════
// TEAM TAB
// ═════════════════════════════════════════════════════════════════

async function loadTeam() {
    const c = document.getElementById('team-content');
    c.innerHTML = '<div class="loading">Loading team...</div>';
    try { renderTeam(await api('team'), c); }
    catch (e) { c.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`; }
}

function renderTeam(data, container) {
    let h = '';
    const su = isSuper();

    if (data.super_admins?.length) {
        h += `<div class="card"><h3>Super Admins</h3>${data.super_admins.map(sa =>
            `<span class="trainer-chip"><span class="role-badge super" style="margin:0">SA</span> ${esc(sa.email || sa.name)}</span>`
        ).join('')}</div>`;
    }

    const admins = data.admins || [];
    h += `<div class="card"><h3>Admins</h3>`;
    if (admins.length) {
        h += admins.map(a => `<span class="trainer-chip"><span class="role-badge admin" style="margin:0">A</span> ${esc(a.email)}${a.name ? ` (${esc(a.name)})` : ''}${su ? `<button class="remove-btn" data-action="remove-admin" data-email="${esc(a.email)}">&times;</button>` : ''}</span>`).join('');
    } else {
        h += '<p class="empty-state">No admins yet.</p>';
    }
    if (su) h += `<div class="inline-form" data-form="add-admin"><input type="email" placeholder="admin@example.com" data-field="email" /><input type="text" placeholder="Name" data-field="name" style="max-width:120px" /><button class="btn btn-sm">Add</button></div>`;
    h += '</div>';

    (data.pods || []).forEach(pod => {
        const rev = pod.reviewer;
        h += `<div class="card" data-pod="${esc(pod.pod_id)}">
            <h3>${esc(pod.name)} <span style="color:var(--text-muted);font-size:0.7rem;font-weight:400">${esc(pod.pod_id)}</span></h3>
            <div class="pod-meta">Reviewer: ${rev ? `${esc(rev.email)}${rev.name ? ` (${esc(rev.name)})` : ''}` : '<em>None</em>'}${su ? ` <button class="btn btn-xs btn-ghost" data-action="set-reviewer" data-pod="${esc(pod.pod_id)}">Change</button>` : ''}</div>
            <div><strong style="font-size:0.8rem">Trainers (${pod.trainers.length})</strong><div style="margin-top:0.2rem">${pod.trainers.length ? pod.trainers.map(t => `<span class="trainer-chip">${esc(t)}${su ? `<button class="remove-btn" data-action="remove-trainer" data-pod="${esc(pod.pod_id)}" data-email="${esc(t)}">&times;</button>` : ''}</span>`).join('') : '<span class="empty-state">No trainers</span>'}</div>${su ? `<div class="inline-form" data-form="add-trainer" data-pod="${esc(pod.pod_id)}"><input type="email" placeholder="trainer@example.com" data-field="email" /><button class="btn btn-sm">Add</button></div>` : ''}</div>
        </div>`;
    });

    if (su) {
        h += `<div class="card" style="border-style:dashed"><h3>Create Pod</h3><div class="inline-form" data-form="create-pod"><input type="text" placeholder="pod_id (lowercase)" data-field="pod_id" style="max-width:140px" /><input type="text" placeholder="Display name" data-field="name" /><button class="btn btn-sm">Create</button></div></div>`;
    }

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
            case 'set-reviewer': {
                const email = prompt('Reviewer email:');
                if (!email) return;
                const name = prompt('Reviewer name (optional):') || '';
                await api(`team/pods/${encodeURIComponent(params.pod)}/reviewer`, { method: 'PUT', body: JSON.stringify({ email, name }) });
                toast('Reviewer updated'); break;
            }
            case 'remove-admin':
                if (!confirm(`Remove admin ${params.email}?`)) return;
                await api(`team/admins/${encodeURIComponent(params.email)}`, { method: 'DELETE' });
                toast('Admin removed'); break;
            case 'add-admin':
                await api('team/admins', { method: 'POST', body: JSON.stringify({ email: params.email, name: params.name || '', pods: [] }) });
                toast('Admin added'); break;
            case 'create-pod':
                await api('team/pods', { method: 'POST', body: JSON.stringify({ pod_id: params.pod_id, name: params.name }) });
                toast('Pod created'); break;
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
    c.innerHTML = '<div class="loading">Loading config...</div>';
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
        h += '<tr>';
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
        if (isSuper()) h += `<td><button class="btn btn-xs btn-danger" data-action="remove-array-item" data-array-key="${esc(fullKey)}" data-idx="${i}">&times;</button></td>`;
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
    list.forEach((em, i) => {
        h += `<span class="email-chip">${esc(em)}${isSuper() ? `<button class="chip-remove" data-action="remove-chip" data-chip-key="${esc(fullKey)}" data-idx="${i}">&times;</button>` : ''}</span>`;
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

function renderConfig(data, container) {
    let h = '';
    if (isSuper()) h += `<div style="margin-bottom:0.75rem;display:flex;justify-content:flex-end"><button class="btn btn-ghost btn-sm" id="config-reload-btn">Reload cache</button></div>`;

    const sections = Object.entries(data).filter(([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v));
    const topLevel = Object.entries(data).filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v));

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

    function renderSection(name, entries, prefix, collapsed) {
        const editableCount = entries.reduce((c, [, v]) => c + (_isLeaf(v) && isSuper() ? 1 : 0) + (typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.values(v).filter(_isLeaf).length : 0), 0);
        return `<div class="config-section" data-config-section="${esc(prefix)}">
            <div class="config-section-header${collapsed ? ' collapsed' : ''}" onclick="this.classList.toggle('collapsed');this.nextElementSibling.classList.toggle('collapsed')">
                <h3>${esc(name)} <span class="count-badge">${entries.length} keys${isSuper() && editableCount ? ` · ${editableCount} editable` : ''}</span></h3>
                <span class="chevron">&#x25BC;</span>
            </div>
            <div class="config-section-body${collapsed ? ' collapsed' : ''}">
                ${entries.map(([k, v]) => renderEntry(k, v, prefix)).join('')}
                ${isSuper() ? `<div class="config-actions"><button class="btn btn-sm btn-success" data-action="save-config-section" data-section="${esc(prefix)}">Save ${esc(name)}</button></div>` : ''}
            </div>
        </div>`;
    }

    if (topLevel.length) h += renderSection('General', topLevel, '', false);
    const important = ['alignment', 'app', 'hunt', 'features', 'review', 'task_identity', 'reviewer'];
    sections.forEach(([name, obj]) => {
        h += renderSection(name, Object.entries(obj), name, !important.includes(name));
    });

    container.innerHTML = h;
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

function _handleArrayAction(action, key, idx) {
    if (!_configData) return;
    const arr = _getNestedVal(_configData, key);
    if (!Array.isArray(arr)) return;
    if (action === 'remove') {
        arr.splice(idx, 1);
    } else if (action === 'add') {
        const template = arr.length > 0 ? Object.fromEntries(Object.keys(arr[0]).filter(k => k !== 'params' && k !== 'prohibited_text').map(k => [k, ''])) : { id: '', name: '' };
        arr.push(template);
    }
    renderConfig(_configData, document.getElementById('config-content'));
}

function _handleChipAction(action, key, idx, value) {
    if (!_configData) return;
    const arr = _getNestedVal(_configData, key);
    if (!Array.isArray(arr)) return;
    if (action === 'remove') arr.splice(idx, 1);
    else if (action === 'add' && value) arr.push(value.trim().toLowerCase());
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
            <div class="card"><div class="card-icon">$</div><div class="card-value">$${(co.total_cost ?? 0).toFixed(2)}</div><div class="card-label">Total Cost</div></div>
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
    const lb = (trainers?.leaderboard || []).filter(t => { const id = t.trainer_id || ''; return id.includes('@') || (id.length > 3 && !id.startsWith('trainer_') && !id.startsWith('file_')); });
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

function _initials(email, name) {
    if (name) return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    return (email || '?').slice(0, 2).toUpperCase();
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
                if (!confirm(`Remove ${params.email}?`)) return;
                await api(`dashboard-admins/${encodeURIComponent(params.email)}`, { method: 'DELETE' });
                toast('Admin removed'); break;
            case 'add-test-account':
                await api('test-accounts', { method: 'POST', body: JSON.stringify({ email: params.email, name: params.name || '' }) });
                toast('Test account added'); break;
            case 'remove-test-account':
                if (!confirm(`Remove ${params.email}?`)) return;
                await api(`test-accounts/${encodeURIComponent(params.email)}`, { method: 'DELETE' });
                toast('Removed'); break;
        }
        loadDashboardAdmins();
    } catch (e) { toast(e.message, 'error'); }
}

// ═════════════════════════════════════════════════════════════════
// EVENT DELEGATION
// ═════════════════════════════════════════════════════════════════

function init() {
    checkSession();

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
    document.getElementById('tab-nav').addEventListener('click', e => { const b = e.target.closest('.tab-btn'); if (b?.dataset.tab) showTab(b.dataset.tab); });

    document.addEventListener('click', e => {
        const t = e.target;
        const action = t.dataset?.action;

        if (action === 'remove-trainer') { handleTeamAction('remove-trainer', { pod: t.dataset.pod, email: t.dataset.email }); return; }
        if (action === 'remove-admin') { handleTeamAction('remove-admin', { email: t.dataset.email }); return; }
        if (action === 'set-reviewer') { handleTeamAction('set-reviewer', { pod: t.dataset.pod }); return; }
        if (action === 'remove-dashboard-admin') { handleAdminsAction('remove-dashboard-admin', { email: t.dataset.email }); return; }
        if (action === 'remove-test-account') { handleAdminsAction('remove-test-account', { email: t.dataset.email }); return; }
        if (action === 'save-config-section') { saveConfigSection(t.dataset.section); return; }
        if (t.id === 'config-reload-btn') { api('config/reload', { method: 'POST' }).then(() => { toast('Cache reloaded'); loadConfig(); }).catch(e => toast(e.message, 'error')); return; }
        if (action === 'remove-array-item') { _handleArrayAction('remove', t.dataset.arrayKey, parseInt(t.dataset.idx)); return; }
        if (action === 'add-array-item') { _handleArrayAction('add', t.dataset.arrayKey); return; }
        if (action === 'remove-chip') { _handleChipAction('remove', t.dataset.chipKey, parseInt(t.dataset.idx)); return; }
        if (action === 'add-chip') {
            const input = document.querySelector(`[data-chip-input="${t.dataset.chipKey}"]`);
            if (input?.value.trim()) { _handleChipAction('add', t.dataset.chipKey, null, input.value); }
            return;
        }

        const form = t.closest('[data-form]');
        if (form && t.tagName === 'BUTTON') {
            const ft = form.dataset.form, fields = {};
            form.querySelectorAll('[data-field]').forEach(inp => { fields[inp.dataset.field] = inp.value.trim(); });
            if (ft === 'add-trainer') { if (!fields.email) { toast('Email required', 'error'); return; } handleTeamAction('add-trainer', { pod: form.dataset.pod, email: fields.email }); }
            else if (ft === 'add-admin') { if (!fields.email) { toast('Email required', 'error'); return; } handleTeamAction('add-admin', { email: fields.email, name: fields.name }); }
            else if (ft === 'create-pod') { if (!fields.pod_id || !fields.name) { toast('Both fields required', 'error'); return; } handleTeamAction('create-pod', { pod_id: fields.pod_id, name: fields.name }); }
            else if (ft === 'add-dashboard-admin') { if (!fields.email) { toast('Email required', 'error'); return; } handleAdminsAction('add-dashboard-admin', { email: fields.email, name: fields.name }); }
            else if (ft === 'add-test-account') { if (!fields.email) { toast('Email required', 'error'); return; } handleAdminsAction('add-test-account', { email: fields.email, name: fields.name }); }
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
