/**
 * testbed/render-chips.js — Criteria chip editor rendering and events.
 */

import { escapeHtml } from '../utils.js';
import { getSharedLeft } from './store.js';

export function renderCriteriaChips(disabled) {
    const left = getSharedLeft();
    const chips = left.criteriaChips;
    const items = chips.map((text, i) => `
        <div class="tb-chip" data-chip-idx="${i}">
            <span class="tb-chip-num">C${i + 1}</span>
            <textarea
                class="tb-chip-input"
                rows="1"
                placeholder="Criterion ${i + 1} description…"
                data-chip-idx="${i}"
                ${disabled ? 'disabled' : ''}
            >${escapeHtml(text)}</textarea>
            ${disabled ? '' : `<button class="tb-chip-del" data-chip-idx="${i}" title="Remove C${i + 1}">×</button>`}
        </div>
    `).join('');

    const nextNum = chips.length + 1;
    const addBtn  = disabled ? '' : `
        <button class="tb-chip-add" id="tbSharedChipAdd">
            <span class="tb-chip-add-icon">+</span>
            <span>C${nextNum}</span>
        </button>`;

    const count     = chips.filter(c => c.trim()).length;
    const MIN       = 3;
    const countOk   = count >= MIN;
    const countClass = countOk ? 'count-ok' : (count > 0 ? 'count-warn' : '');
    const countLabel = countOk
        ? `${count} criteria`
        : `${count} / ${MIN} minimum`;
    const countBadge = `<div class="tb-criteria-count ${countClass}" id="tbCriteriaCount">
        <span class="tb-criteria-count-dot"></span>
        <span>${countLabel}</span>
    </div>`;

    return `<div class="tb-chips-container" id="tbSharedChips">${items}${addBtn}${countBadge}</div>`;
}

function autoResizeChip(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function updateCriteriaCount() {
    const badge = document.getElementById('tbCriteriaCount');
    if (!badge) return;
    const chips = getSharedLeft().criteriaChips;
    const count = chips.filter(c => c.trim()).length;
    const MIN   = 3;
    const ok    = count >= MIN;
    badge.className = `tb-criteria-count ${ok ? 'count-ok' : (count > 0 ? 'count-warn' : '')}`;
    badge.querySelector('span:last-child').textContent = ok
        ? `${count} criteria`
        : `${count} / ${MIN} minimum`;
}

export function wireChipEvents() {
    const left      = getSharedLeft();
    const container = document.getElementById('tbSharedChips');
    if (!container) return;

    container.querySelectorAll('.tb-chip-input').forEach(inp => {
        autoResizeChip(inp);
        inp.addEventListener('input', () => {
            const idx = parseInt(inp.dataset.chipIdx, 10);
            left.criteriaChips[idx] = inp.value;
            autoResizeChip(inp);
            const addBtn = container.querySelector('.tb-chip-add span:last-child');
            if (addBtn) addBtn.textContent = `C${left.criteriaChips.length + 1}`;
            updateCriteriaCount();
        });
        inp.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                document.getElementById('tbSharedChipAdd')?.click();
            }
        });
    });

    container.querySelectorAll('.tb-chip-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.chipIdx, 10);
            left.criteriaChips.splice(idx, 1);
            const field = container.closest('.tb-field');
            if (field) {
                field.querySelector('.tb-chips-container').outerHTML = renderCriteriaChips(false);
                const newContainer = document.getElementById('tbSharedChips');
                if (newContainer) wireChipEvents();
            }
        });
    });

    const addBtn = document.getElementById('tbSharedChipAdd');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            left.criteriaChips.push('');
            const field = container.closest('.tb-field');
            if (field) {
                const wrapper = field.querySelector('.tb-chips-container');
                if (wrapper) wrapper.outerHTML = renderCriteriaChips(false);
                const newContainer = document.getElementById('tbSharedChips');
                if (newContainer) {
                    wireChipEvents();
                    const inputs = newContainer.querySelectorAll('.tb-chip-input');
                    if (inputs.length) inputs[inputs.length - 1].focus();
                }
            }
        });
    }
}
