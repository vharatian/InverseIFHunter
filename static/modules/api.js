/**
 * Model Hunter - API & Version Management
 * @module api
 * 
 * Handles version checking, update prompts, and the generic modal system.
 * Uses escapeHtml from utils.js (accessed at call-time via window or import).
 */

import { VERSION_CHECK_INTERVAL } from './config.js';
import { escapeHtml } from './utils.js';
import { createIndicatorClickVersionCheck } from '../js/updates/version-check.mjs';
import { createFocusTrap } from './focusTrap.js';

// ============== Unified fetch wrapper with trace-id propagation ==============

/**
 * Error raised by apiFetch when the response is not ok.
 * Carries the server-side trace id when present so toasts can surface it.
 */
export class ApiError extends Error {
    constructor(message, { status, traceId, body, url } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.traceId = traceId || '';
        this.body = body;
        this.url = url;
    }
}

function _extractTraceId(response) {
    try {
        return response.headers.get('X-Trace-Id') || '';
    } catch {
        return '';
    }
}

async function _readBodySafe(response) {
    try {
        const text = await response.text();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    } catch {
        return null;
    }
}

/**
 * Thin fetch wrapper.
 *   - Throws ApiError with `.traceId` on non-2xx responses.
 *   - Returns the original Response on success (caller calls .json()/.text()).
 *   - Surfaces network errors as ApiError with status=0.
 *
 * NEW code should prefer apiFetch over raw fetch so showError can render
 * the trace id chip automatically.
 */
export async function apiFetch(input, init) {
    let response;
    try {
        response = await fetch(input, init);
    } catch (err) {
        throw new ApiError(err?.message || 'Network request failed', {
            status: 0,
            traceId: '',
            url: typeof input === 'string' ? input : input?.url,
        });
    }
    if (!response.ok) {
        const traceId = _extractTraceId(response);
        const body = await _readBodySafe(response);
        const detail =
            (body && typeof body === 'object' && (body.error?.message || body.detail)) ||
            (typeof body === 'string' && body) ||
            `HTTP ${response.status}`;
        throw new ApiError(String(detail), {
            status: response.status,
            traceId,
            body,
            url: response.url,
        });
    }
    return response;
}

/**
 * Centered modal with blurred backdrop. Use instead of alert/confirm for consistent UX.
 * @param {{ title: string, message: string, buttons: Array<{ label: string, primary?: boolean, value: any }> }} options
 * @returns {Promise<any>} Resolves with the value of the clicked button.
 */
export function showAppModal(options) {
    return new Promise((resolve) => {
        const { title, message, buttons } = options;
        const overlay = document.createElement('div');
        overlay.className = 'app-modal-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', title || 'Dialog');
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10001;
        `;
        const dialog = document.createElement('div');
        dialog.className = 'app-modal-dialog';
        dialog.style.cssText = `
            background: var(--bg-secondary, #1e1e2e);
            border-radius: 12px;
            padding: 24px 28px;
            max-width: 440px;
            width: 90%;
            box-shadow: 0 10px 40px rgba(0,0,0,0.4);
            border: 1px solid var(--border, #333);
        `;
        const messageHtml = (message || '').split('\n').map(line => escapeHtml(line)).join('<br>');
        dialog.innerHTML = `
            <h3 class="app-modal-title" style="margin:0 0 12px 0; color: var(--text-primary, #fff); font-size: 17px;">${escapeHtml(title)}</h3>
            <p class="app-modal-message" style="margin:0 0 20px 0; color: var(--text-secondary, #ccc); font-size: 14px; line-height: 1.5;">${messageHtml}</p>
            <div class="app-modal-buttons" style="display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap;"></div>
        `;
        const btnContainer = dialog.querySelector('.app-modal-buttons');
        const closeWith = (value) => {
            try { trap.release(); } catch { /* ignore */ }
            overlay.remove();
            resolve(value);
        };
        buttons.forEach((b) => {
            const btn = document.createElement('button');
            btn.textContent = b.label;
            btn.style.cssText = b.primary
                ? `background: var(--primary, #2563eb); color: #fff; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600;`
                : `background: transparent; color: var(--text-secondary, #aaa); border: 1px solid var(--border, #555); padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px;`;
            btn.onclick = () => closeWith(b.value);
            btnContainer.appendChild(btn);
        });
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        // Focus trap: traps Tab inside, Escape resolves with undefined
        // (caller treats undefined as cancel), restores focus on close.
        const trap = createFocusTrap(dialog, { onEscape: () => closeWith(undefined) });
    });
}

/**
 * Prompt for password (admin mode). Returns entered string or null if cancelled.
 * @param {{ title: string, message?: string }} options
 * @returns {Promise<string|null>}
 */
export function showPasswordPrompt(options) {
    return new Promise((resolve) => {
        const { title, message } = options || {};
        const overlay = document.createElement('div');
        overlay.className = 'app-modal-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', title || 'Enter password');
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10001;
        `;
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: var(--bg-secondary, #1e1e2e);
            border-radius: 12px;
            padding: 24px 28px;
            max-width: 380px;
            width: 90%;
            box-shadow: 0 10px 40px rgba(0,0,0,0.4);
            border: 1px solid var(--border, #333);
        `;
        dialog.innerHTML = `
            <h3 style="margin:0 0 12px 0; color: var(--text-primary, #fff); font-size: 17px;">${escapeHtml(title || 'Enter password')}</h3>
            ${message ? `<p style="margin:0 0 16px 0; color: var(--text-secondary, #ccc); font-size: 14px;">${escapeHtml(message)}</p>` : ''}
            <input type="password" id="adminPasswordInput" autocomplete="off" placeholder="Password" style="
                width: 100%;
                padding: 10px 14px;
                border: 1px solid var(--border, #555);
                border-radius: 8px;
                background: var(--bg-primary, #111);
                color: var(--text-primary, #fff);
                font-size: 14px;
                margin-bottom: 16px;
                box-sizing: border-box;
            ">
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button id="adminPasswordCancel" style="background: transparent; color: var(--text-secondary, #aaa); border: 1px solid var(--border, #555); padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px;">Cancel</button>
                <button id="adminPasswordSubmit" style="background: var(--primary, #2563eb); color: #fff; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600;">Submit</button>
            </div>
        `;
        const input = dialog.querySelector('#adminPasswordInput');
        const submitBtn = dialog.querySelector('#adminPasswordSubmit');
        const cancelBtn = dialog.querySelector('#adminPasswordCancel');
        const cleanup = () => {
            try { trap.release(); } catch { /* ignore */ }
            overlay.remove();
        };
        submitBtn.onclick = () => {
            cleanup();
            resolve(input.value.trim());
        };
        cancelBtn.onclick = () => {
            cleanup();
            resolve(null);
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                cleanup();
                resolve(input.value.trim());
            }
            // Escape is handled by the focus trap → onEscape below.
        };
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        const trap = createFocusTrap(dialog, {
            initialFocus: input,
            onEscape: () => {
                cleanup();
                resolve(null);
            },
        });
    });
}

const _versionCheck = createIndicatorClickVersionCheck({
    versionUrl: 'api/version',
    intervalMs: VERSION_CHECK_INTERVAL,
    indicatorId: 'updateIndicator',
    showModal: async () =>
        showAppModal({
            title: 'New Update Available',
            message:
                'A new version of Model Hunter is ready.\n\n' +
                'Refreshing will reload the app and any unsaved progress will be lost.\n\n' +
                'Tip: If you are in the middle of a task, finish and submit it first. ' +
                'Update before starting your next task, not during one.',
            buttons: [
                { label: 'Not Now', primary: false, value: false },
                { label: 'Update Now', primary: true, value: true },
            ],
        }),
});

export async function checkVersion() {
    return _versionCheck.checkVersion();
}

export function hasPendingUpdate() {
    return _versionCheck.hasPendingUpdate();
}

export function initVersionCheck() {
    return _versionCheck.initVersionCheck();
}
