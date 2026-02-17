/**
 * Model Hunter - API & Version Management
 * @module api
 * 
 * Handles version checking, update prompts, and the generic modal system.
 * Uses escapeHtml from utils.js (accessed at call-time via window or import).
 */

import { VERSION_CHECK_INTERVAL } from './config.js';
import { escapeHtml, debugLog } from './utils.js';

// ============== Version Check & Update Prompt ==============
let currentVersion = null;
let pendingUpdateVersion = null; // Tracks if there's a new version available


export async function checkVersion() {
    try {
        const response = await fetch('/api/version');
        const data = await response.json();
        
        if (currentVersion === null) {
            // First check - just store the version
            currentVersion = data.version;
            debugLog('📦 App version:', currentVersion);
        } else if (data.version !== currentVersion) {
            // Version changed - show prompt immediately so user sees it without having to click Start Hunt
            pendingUpdateVersion = data.version;
            debugLog('🔄 New version detected:', data.version);
            showUpdatePrompt();
        }
    } catch (e) {
        // Silently fail - server might be updating
    }
}

export function hasPendingUpdate() {
    return pendingUpdateVersion !== null;
}

export function showUpdatePrompt() {
    return new Promise((resolve) => {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'update-prompt-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;
        
        // Create dialog
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: var(--bg-secondary, #1e1e2e);
            border-radius: 12px;
            padding: 24px 32px;
            max-width: 450px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.4);
            border: 1px solid var(--border, #333);
        `;
        
        dialog.innerHTML = `
            <div style="font-size: 48px; margin-bottom: 16px;">🔄</div>
            <h3 style="margin: 0 0 12px 0; color: var(--text-primary, #fff); font-size: 18px;">New Version Available</h3>
            <p style="margin: 0 0 24px 0; color: var(--text-secondary, #aaa); font-size: 14px; line-height: 1.5;">
                A new version is available. Refreshing is recommended so you get the latest changes.
            </p>
            <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="update-refresh-btn" style="
                    background: linear-gradient(90deg, #2563eb, #7c3aed);
                    color: white;
                    border: none;
                    padding: 10px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-weight: 600;
                    font-size: 14px;
                ">Refresh Now</button>
                <button id="update-continue-btn" style="
                    background: transparent;
                    color: var(--text-secondary, #aaa);
                    border: 1px solid var(--border, #444);
                    padding: 10px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                ">Continue with current version for now</button>
            </div>
        `;
        
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        
        // Handle buttons
        dialog.querySelector('#update-refresh-btn').onclick = async () => {
            const ok = await showAppModal({
                title: 'Refresh page?',
                message: 'Refreshing will reload the page. Any unsaved changes will be lost and cannot be recovered.\n\nOK to refresh, Cancel to go back.',
                buttons: [
                    { label: 'Cancel', primary: false, value: false },
                    { label: 'OK', primary: true, value: true }
                ]
            });
            if (ok) {
                window.location.reload();
            }
        };

        dialog.querySelector('#update-continue-btn').onclick = () => {
            overlay.remove();
            resolve(true); // Continue with action
        };
    });
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

/**
 * Initialize version checking. Called on DOMContentLoaded.
 */
export function initVersionCheck() {
    checkVersion();
    setInterval(checkVersion, VERSION_CHECK_INTERVAL);
}
