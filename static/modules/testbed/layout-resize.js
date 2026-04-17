/**
 * testbed/layout-resize.js — Draggable split-pane resizer, autogrow, word count.
 */

import { state } from '../state.js';
import { tbState } from './store.js';
import { SPLIT_KEY } from './constants.js';

export function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 60) + 'px';
}

/** Update the word count display below the testbed prompt textarea. */
export function updateTestbedWordCount() {
    const el = document.getElementById('tbPromptWordCount');
    if (!el) return;
    const ta = document.getElementById('tbSharedPrompt');
    const text = ta?.value || '';
    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;

    const turnAboveOne = (state.currentTurn || 1) > 1 || state.isMultiTurn;
    const range = state.promptLengthRange;

    let label = `${wordCount} word${wordCount !== 1 ? 's' : ''}`;
    let cls = 'tb-wc-neutral';

    if (!turnAboveOne && range) {
        label += ` · target: ${range.min}–${range.max}`;
        if (wordCount >= range.min && wordCount <= range.max) {
            cls = 'tb-wc-ok';
        } else {
            cls = 'tb-wc-bad';
        }
    }

    el.textContent = label;
    el.className = 'tb-word-count ' + cls;
}

export function destroyResizer() {
    if (tbState.resizerCleanup) { tbState.resizerCleanup(); tbState.resizerCleanup = null; }
}

export function applySavedSplit() {
    const layout = document.querySelector('.tb-layout');
    if (!layout) return;
    const saved = localStorage.getItem(SPLIT_KEY);
    const pct   = saved ? parseFloat(saved) : 42;
    layout.style.gridTemplateColumns = `${pct}% 6px 1fr`;
}

export function initResizer(runId) {
    destroyResizer();
    const handle = document.getElementById('tbResizeHandle');
    const layout = document.getElementById(`tbLayout-${runId}`);
    if (!handle || !layout) return;

    applySavedSplit();

    let dragging  = false;
    let startX    = 0;
    let startPct  = 42;

    function onMouseDown(e) {
        e.preventDefault();
        dragging = true;
        startX   = e.clientX;
        const cols  = getComputedStyle(layout).gridTemplateColumns.split(' ');
        startPct    = parseFloat(cols[0]) / layout.offsetWidth * 100;
        document.body.style.cursor      = 'col-resize';
        document.body.style.userSelect  = 'none';
    }

    function onMouseMove(e) {
        if (!dragging) return;
        const dx    = e.clientX - startX;
        const pct   = Math.min(70, Math.max(20, startPct + (dx / layout.offsetWidth) * 100));
        layout.style.gridTemplateColumns = `${pct}% 6px 1fr`;
    }

    function onMouseUp() {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor     = '';
        document.body.style.userSelect = '';
        const cols = getComputedStyle(layout).gridTemplateColumns.split(' ');
        const pct  = parseFloat(cols[0]) / layout.offsetWidth * 100;
        localStorage.setItem(SPLIT_KEY, pct.toFixed(1));
    }

    handle.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);

    tbState.resizerCleanup = () => {
        handle.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup',   onMouseUp);
    };
}
