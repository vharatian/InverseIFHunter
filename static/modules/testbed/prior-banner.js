/**
 * testbed/prior-banner.js — Collapsible banner showing prior-turn prompt + selected response.
 */

import { state } from '../state.js';
import { renderMarkdownSafe } from '../utils.js';
import { BANNER_COLLAPSE_KEY } from './constants.js';

export function renderPriorConversationBanner() {
    const container = document.getElementById('priorConversationBanner');
    if (!container) return;

    const turns = state.turns || [];
    if (turns.length === 0) {
        container.classList.add('hidden');
        container.innerHTML = '';
        return;
    }

    const isCollapsed = localStorage.getItem(BANNER_COLLAPSE_KEY) === 'true';
    const md = (s) => renderMarkdownSafe(s);

    const turnsHtml = turns.map((t, idx) => {
        const n          = t.turnNumber ?? t.turn_number ?? idx + 1;
        const isMostRecent = idx === turns.length - 1;
        const prompt     = t.prompt || '';
        const response   = t.selectedResponse || '';
        return `<div class="pcb-turn ${isMostRecent ? 'pcb-turn-recent' : ''}">
            <div class="pcb-turn-header">
                <span class="pcb-turn-badge ${isMostRecent ? 'pcb-badge-recent' : ''}">Turn ${n}</span>
                ${isMostRecent ? '<span class="pcb-recent-tag">Most recent</span>' : ''}
            </div>
            <div class="pcb-turn-body">
                <div class="pcb-section">
                    <div class="pcb-section-label">Prompt</div>
                    <div class="pcb-prose">${md(prompt) || '<span class="pcb-empty">—</span>'}</div>
                </div>
                <div class="pcb-section">
                    <div class="pcb-section-label">Selected Response</div>
                    <div class="pcb-prose">${md(response) || '<span class="pcb-empty">—</span>'}</div>
                </div>
            </div>
        </div>`;
    }).join('');

    container.className = 'pcb-banner' + (isCollapsed ? ' pcb-collapsed' : '');
    container.innerHTML = `
        <div class="pcb-header" id="pcbToggle">
            <span class="pcb-icon"></span>
            <span class="pcb-title">Prior Conversation (${turns.length} turn${turns.length > 1 ? 's' : ''})</span>
            <span class="pcb-chevron">${isCollapsed ? '▶' : '▼'}</span>
        </div>
        <div class="pcb-body" id="pcbBody" ${isCollapsed ? 'style="display:none"' : ''}>
            ${turnsHtml}
        </div>`;

    document.getElementById('pcbToggle')?.addEventListener('click', () => {
        const body    = document.getElementById('pcbBody');
        const chevron = container.querySelector('.pcb-chevron');
        const nowCollapsed = body.style.display === 'none' ? false : true;
        body.style.display = nowCollapsed ? 'none' : '';
        if (chevron) chevron.textContent = nowCollapsed ? '▶' : '▼';
        container.classList.toggle('pcb-collapsed', nowCollapsed);
        localStorage.setItem(BANNER_COLLAPSE_KEY, String(nowCollapsed));
    });
}
