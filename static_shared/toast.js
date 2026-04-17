/**
 * Shared toast / modal primitives with aria-live announcements and reduced-motion support.
 * No external dependencies.
 */
import { escapeHtml } from './escape.js';

let _containerId = 'shared-toast-container';

function _container() {
    let el = document.getElementById(_containerId);
    if (el) return el;
    el = document.createElement('div');
    el.id = _containerId;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.style.cssText = 'position:fixed;bottom:1rem;right:1rem;z-index:9999;display:flex;flex-direction:column;gap:0.5rem;pointer-events:none;';
    document.body.appendChild(el);
    return el;
}

/** Show a toast. kind: 'info' | 'success' | 'warn' | 'error'. */
export function toast(message, kind = 'info', timeoutMs = 3500) {
    const wrap = document.createElement('div');
    const bg = kind === 'error' ? '#b91c1c' : kind === 'warn' ? '#b45309' : kind === 'success' ? '#065f46' : '#1f2937';
    wrap.style.cssText = `background:${bg};color:#fff;padding:0.6rem 0.9rem;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.2);font-size:0.9rem;max-width:24rem;pointer-events:auto;transition:opacity 160ms ease;`;
    wrap.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    wrap.textContent = String(message == null ? '' : message);
    _container().appendChild(wrap);
    const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(() => {
        if (reduceMotion) { wrap.remove(); return; }
        wrap.style.opacity = '0';
        setTimeout(() => wrap.remove(), 180);
    }, timeoutMs);
    wrap.addEventListener('click', () => { clearTimeout(t); wrap.remove(); });
    return () => { clearTimeout(t); wrap.remove(); };
}

/**
 * Show a simple confirm modal. Returns a Promise<boolean>.
 * options: { title, message, confirmLabel, cancelLabel }
 */
export function confirmModal(options = {}) {
    const { title = 'Confirm', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel' } = options;
    return new Promise((resolve) => {
        const prev = document.activeElement;
        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', title);
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;';
        overlay.innerHTML = `
            <div style="background:#111827;color:#f3f4f6;border:1px solid #374151;border-radius:8px;padding:1.25rem;min-width:320px;max-width:90vw;box-shadow:0 20px 50px rgba(0,0,0,0.4);">
                <h3 style="margin:0 0 0.5rem 0;font-size:1rem;">${escapeHtml(title)}</h3>
                <p style="margin:0 0 1rem 0;white-space:pre-wrap;font-size:0.9rem;color:#d1d5db;">${escapeHtml(message)}</p>
                <div style="display:flex;justify-content:flex-end;gap:0.5rem;">
                    <button type="button" data-action="cancel" style="padding:0.4rem 0.8rem;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer;">${escapeHtml(cancelLabel)}</button>
                    <button type="button" data-action="confirm" style="padding:0.4rem 0.8rem;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>`;
        const cleanup = (val) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
            if (prev && typeof prev.focus === 'function') { try { prev.focus(); } catch {} }
            resolve(val);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
            else if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
        };
        overlay.addEventListener('click', (e) => {
            const a = e.target.closest('[data-action]');
            if (!a) return;
            cleanup(a.dataset.action === 'confirm');
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
        overlay.querySelector('[data-action="confirm"]').focus();
    });
}
