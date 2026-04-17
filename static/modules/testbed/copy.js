/**
 * testbed/copy.js — Copy-button helpers for testbed panels.
 */

import { tbState, getSharedLeft } from './store.js';
import { COPY_SVG, CHECK_SVG } from './constants.js';

export function tbCopyBtn(src, title, runId) {
    const runAttr = runId != null ? ` data-copy-run="${runId}"` : '';
    return `<button class="tb-copy-btn" data-copy-src="${src}" type="button" title="${title}" tabindex="-1"${runAttr}>${COPY_SVG}</button>`;
}

export function handleTbCopy(e) {
    const btn = e.target.closest('.tb-copy-btn');
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();

    const src   = btn.dataset.copySrc;
    const runId = btn.dataset.copyRun;
    let text    = '';

    if (src === 'tbSharedPrompt') {
        text = document.getElementById('tbSharedPrompt')?.value || getSharedLeft().prompt || '';
    } else if (src === 'tbSharedIdeal') {
        text = document.getElementById('tbSharedIdeal')?.value || getSharedLeft().idealResponse || '';
    } else if (src === 'tbSharedReasoning') {
        text = document.getElementById('tbSharedReasoning')?.value || getSharedLeft().modelReasoning || '';
    } else if (src === 'criteria') {
        const chips = getSharedLeft().criteriaChips || [];
        text = chips.filter(c => c.trim()).map((c, i) => `C${i + 1}: ${c}`).join('\n');
    } else if (src === 'tbSharedJudge') {
        text = document.getElementById('tbSharedJudge')?.value || getSharedLeft().judgePrompt || '';
    } else if (src === 'response' && runId) {
        const run = tbState.runs.find(r => r.id === runId);
        text = run?.response || '';
    } else if (src === 'reasoning' && runId) {
        const run = tbState.runs.find(r => r.id === runId);
        text = run?.reasoningTrace || '';
    }

    if (!text.trim()) return;

    const _flash = () => {
        btn.innerHTML = CHECK_SVG;
        btn.classList.add('tb-copy-done');
        setTimeout(() => { btn.innerHTML = COPY_SVG; btn.classList.remove('tb-copy-done'); }, 1500);
    };

    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(_flash).catch(() => {});
    } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (_) {}
        ta.remove();
        _flash();
    }
}
