/**
 * Admin Mode — Logo drag-down activation with particle burst + password modal.
 *
 * Drag the header logo (concentric-circles icon) downward ~80 px to reveal
 * a password prompt.  While dragging a "charging" aura grows around the logo;
 * on threshold a particle burst erupts outward and the modal slides in.
 *
 * Config keys (global.yaml → app.admin_mode_enabled, app.admin_mode_password,
 * app.admin_bypass.*) control what gets unlocked.
 */

import { state } from './state.js';
import { getConfigValue, fetchConfigFromAPI, adminBypass, ADMIN_MODE_PASSWORD } from './config.js';
import { showToast } from './celebrations.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const DRAG_THRESHOLD = 80;          // px of downward drag to trigger
const PARTICLE_COUNT = 28;
const AURA_MAX_SCALE = 2.4;

// ─── State ───────────────────────────────────────────────────────────────────
let _dragging = false;
let _startY   = 0;
let _progress = 0;               // 0 → 1
let _auraEl   = null;
let _brandEl  = null;

// ─── Public API ──────────────────────────────────────────────────────────────

export function initAdminMode() {
    _brandEl = document.getElementById('headerBrand');
    if (!_brandEl) return;

    _auraEl = document.createElement('span');
    _auraEl.className = 'admin-aura';
    _brandEl.style.position = 'relative';
    _brandEl.prepend(_auraEl);

    _brandEl.addEventListener('pointerdown', _onPointerDown, { passive: false });
    document.addEventListener('pointermove', _onPointerMove, { passive: false });
    document.addEventListener('pointerup',   _onPointerUp);
    document.addEventListener('pointercancel', _onPointerUp);

    if (localStorage.getItem('modelHunter_adminMode') === '1') {
        activateAdminMode();
    }
}

/**
 * Turn admin mode ON (called after successful password).
 * Applies visual indicator + enables hunt button.
 */
export function activateAdminMode() {
    state.adminMode = true;
    localStorage.setItem('modelHunter_adminMode', '1');
    _showAdminIndicator(true);

    const huntBtn = document.getElementById('startHuntBtn');
    if (huntBtn && adminBypass('reference_validation')) {
        huntBtn.disabled = false;
        huntBtn.title = 'Admin mode — all locks bypassed';
    }
    showToast('Admin mode ON — locks bypassed', 'success');
}

export function deactivateAdminMode() {
    state.adminMode = false;
    localStorage.removeItem('modelHunter_adminMode');
    _showAdminIndicator(false);
    // Re-apply locks
    try {
        import('./notebook.js').then(m => m.refreshValidationState?.());
    } catch (_) {}
    showToast('Admin mode OFF — locks restored', 'info');
}

// ─── Drag handling ───────────────────────────────────────────────────────────

function _onPointerDown(e) {
    if (state.adminMode) return;
    _dragging = true;
    _startY   = e.clientY;
    _progress = 0;
    _brandEl.setPointerCapture(e.pointerId);
    _auraEl.classList.add('admin-aura-active');
    e.preventDefault();
}

function _onPointerMove(e) {
    if (!_dragging) return;
    const dy = Math.max(0, e.clientY - _startY);
    _progress = Math.min(dy / DRAG_THRESHOLD, 1);

    // Scale aura + opacity proportional to drag progress
    const scale = 1 + _progress * (AURA_MAX_SCALE - 1);
    _auraEl.style.transform = `scale(${scale})`;
    _auraEl.style.opacity   = (0.15 + _progress * 0.85).toFixed(2);

    // Slight downward translate on the logo itself (elastic feel)
    _brandEl.style.transform = `translateY(${dy * 0.25}px)`;
}

function _onPointerUp(e) {
    if (!_dragging) return;
    _dragging = false;
    _brandEl.style.transform = '';
    _auraEl.classList.remove('admin-aura-active');
    _auraEl.style.transform = '';
    _auraEl.style.opacity   = '0';

    if (_progress >= 1) {
        _fireParticleBurst();
        setTimeout(() => _showPasswordModal(), 350);
    }
    _progress = 0;
}

// ─── Particle burst ──────────────────────────────────────────────────────────

function _fireParticleBurst() {
    const rect = _brandEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top  + rect.height / 2;
    const container = document.createElement('div');
    container.className = 'admin-particle-container';
    container.style.cssText = `position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:100000;`;
    document.body.appendChild(container);

    const colors = ['#7c6cf0', '#a78bfa', '#60a5fa', '#f472b6', '#34d399', '#fbbf24'];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = document.createElement('span');
        p.className = 'admin-particle';
        const angle  = (Math.PI * 2 * i) / PARTICLE_COUNT + (Math.random() - 0.5) * 0.4;
        const dist   = 60 + Math.random() * 90;
        const dx     = Math.cos(angle) * dist;
        const dy     = Math.sin(angle) * dist;
        const size   = 4 + Math.random() * 5;
        p.style.cssText = `
            position:absolute;
            left:${cx}px; top:${cy}px;
            width:${size}px; height:${size}px;
            background:${colors[i % colors.length]};
            border-radius:50%;
            --dx:${dx}px; --dy:${dy}px;
        `;
        container.appendChild(p);
    }

    // Shockwave ring
    const ring = document.createElement('span');
    ring.className = 'admin-shockwave';
    ring.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;`;
    container.appendChild(ring);

    setTimeout(() => container.remove(), 900);
}

// ─── Password modal ──────────────────────────────────────────────────────────

async function _showPasswordModal() {
    await fetchConfigFromAPI();
    if (!getConfigValue('admin_mode_enabled', true)) {
        showToast('Admin mode is disabled in config', 'info');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'admin-modal-overlay';
    overlay.innerHTML = `
        <div class="admin-modal">
            <div class="admin-modal-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0110 0v4"/>
                </svg>
            </div>
            <h3 class="admin-modal-title">Admin Mode</h3>
            <p class="admin-modal-desc">All validation locks will be bypassed.</p>
            <input type="password" class="admin-modal-input" id="adminPwdInput"
                   placeholder="Enter password" autocomplete="off" spellcheck="false" />
            <div class="admin-modal-actions">
                <button class="admin-modal-btn admin-modal-cancel" id="adminCancelBtn">Cancel</button>
                <button class="admin-modal-btn admin-modal-confirm" id="adminConfirmBtn">Unlock</button>
            </div>
            <div class="admin-modal-error hidden" id="adminPwdError">Incorrect password</div>
        </div>`;
    document.body.appendChild(overlay);

    // Focus input after animation
    requestAnimationFrame(() => {
        overlay.classList.add('admin-modal-visible');
        setTimeout(() => document.getElementById('adminPwdInput')?.focus(), 200);
    });

    const close = () => { overlay.classList.remove('admin-modal-visible'); setTimeout(() => overlay.remove(), 250); };

    document.getElementById('adminCancelBtn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const submit = () => {
        const pwd = document.getElementById('adminPwdInput').value;
        const expected = getConfigValue('admin_mode_password', ADMIN_MODE_PASSWORD);
        if (pwd === expected) {
            close();
            activateAdminMode();
        } else {
            const errEl = document.getElementById('adminPwdError');
            errEl?.classList.remove('hidden');
            document.getElementById('adminPwdInput')?.select();
            setTimeout(() => errEl?.classList.add('hidden'), 2000);
        }
    };

    document.getElementById('adminConfirmBtn').addEventListener('click', submit);
    document.getElementById('adminPwdInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') close();
    });
}

// ─── Indicator (green badge in header) ───────────────────────────────────────

function _showAdminIndicator(on) {
    // Reuse existing #adminModeIndicator badge
    const el = document.getElementById('adminModeIndicator');
    if (!el) return;
    if (on) {
        el.classList.remove('hidden');
        // Add glow ring to logo
        _brandEl?.classList.add('admin-brand-active');
    } else {
        el.classList.add('hidden');
        _brandEl?.classList.remove('admin-brand-active');
    }
}
