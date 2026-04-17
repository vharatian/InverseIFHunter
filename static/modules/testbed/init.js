/**
 * testbed/init.js — one-time document-level wiring on app startup.
 */

import { showTestbed } from './render-chrome.js';
import { handleTbCopy } from './copy.js';

export function initTestbed() {
    const btn = document.getElementById('navTestbedBtn');
    if (btn && !btn.disabled && !btn._testbedWired) {
        btn._testbedWired = true;
        btn.addEventListener('click', () => showTestbed());
    }

    // Delegated listener for all copy buttons — wired once at init
    if (!document._tbCopyWired) {
        document._tbCopyWired = true;
        document.addEventListener('click', handleTbCopy, true);
    }

    // Delegated listener for judge-result collapse toggles.
    if (!document._tbJudgeToggleWired) {
        document._tbJudgeToggleWired = true;
        document.addEventListener('click', (e) => {
            const hdr = e.target.closest('[data-tb-toggle]');
            if (!hdr) return;
            const body = document.getElementById(hdr.dataset.tbToggle);
            const arrow = hdr.querySelector('.tb-judge-toggle');
            if (!body) return;
            if (body.classList.contains('collapsed')) {
                body.classList.remove('collapsed');
                if (arrow) arrow.textContent = '▾';
            } else {
                body.classList.add('collapsed');
                if (arrow) arrow.textContent = '▸';
            }
        });
    }
}
