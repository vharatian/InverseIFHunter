/**
 * Admin and test account management
 */
import { api } from './api.js';
import { esc, formatTime } from './utils.js';

export async function loadAdminList() {
    const admins = await api('admins');
    const list = document.getElementById('adminList');
    if (!list) return;
    if (!admins?.length) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No admins added yet. Only you (super admin) have access.</div>';
    } else {
        list.innerHTML = admins.map(a => `
            <div class="admin-row">
                <div>
                    <strong style="font-size:0.85rem;">${esc(a.name || 'No name')}</strong>
                    <span style="color:var(--text-muted);font-size:0.78rem;margin-left:0.5rem;">${esc(a.email)}</span>
                    <span style="color:var(--text-muted);font-size:0.7rem;margin-left:0.5rem;">added ${formatTime(a.added_at)}</span>
                </div>
                <button class="btn btn-secondary btn-revoke" data-email="${esc(a.email)}">Revoke</button>
            </div>
        `).join('');
    }
}

export async function addAdminAccess() {
    const nameInput = document.getElementById('newAdminName');
    const emailInput = document.getElementById('newAdminEmail');
    const email = emailInput?.value.trim();
    const name = nameInput?.value.trim();
    if (!email) return;

    const res = await fetch('/api/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name })
    });
    if (res.ok) {
        emailInput.value = '';
        nameInput.value = '';
        await loadAdminList();
    }
}

export async function removeAdminAccess(email) {
    if (!confirm(`Revoke dashboard access for ${email}?`)) return;
    const res = await fetch(`/api/admins/${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (res.ok) await loadAdminList();
}

export async function loadTestAccounts() {
    const accounts = await api('test-accounts');
    const list = document.getElementById('testAccountList');
    if (!list) return;
    if (!accounts?.length) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No test accounts added. All activity is included in analytics.</div>';
    } else {
        list.innerHTML = accounts.map(a => `
            <div class="admin-row">
                <div>
                    <strong style="font-size:0.85rem;">${esc(a.name || 'No name')}</strong>
                    <span style="color:var(--text-muted);font-size:0.78rem;margin-left:0.5rem;">${esc(a.email)}</span>
                </div>
                <button class="btn btn-secondary btn-revoke-test" data-email="${esc(a.email)}">Remove</button>
            </div>
        `).join('');
    }
}

export async function addTestAccount() {
    const nameInput = document.getElementById('newTestName');
    const emailInput = document.getElementById('newTestEmail');
    const email = emailInput?.value.trim();
    const name = nameInput?.value.trim();
    if (!email) return;

    const res = await fetch('/api/test-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name })
    });
    if (res.ok) {
        emailInput.value = '';
        nameInput.value = '';
        await loadTestAccounts();
    }
}

export async function removeTestAccount(email) {
    if (!confirm(`Remove ${email} from test accounts? Their data will be included in analytics going forward.`)) return;
    const res = await fetch(`/api/test-accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (res.ok) await loadTestAccounts();
}
