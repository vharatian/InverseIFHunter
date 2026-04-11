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
        buttons.forEach((b) => {
            const btn = document.createElement('button');
            btn.textContent = b.label;
            btn.style.cssText = b.primary
                ? `background: var(--primary, #2563eb); color: #fff; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600;`
                : `background: transparent; color: var(--text-secondary, #aaa); border: 1px solid var(--border, #555); padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px;`;
            btn.onclick = () => {
                overlay.remove();
                resolve(b.value);
            };
            btnContainer.appendChild(btn);
        });
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
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
            } else if (e.key === 'Escape') {
                cleanup();
                resolve(null);
            }
        };
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        input.focus();
    });
}

const _versionCheck = createIndicatorClickVersionCheck({
    versionUrl: '/api/version',
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
