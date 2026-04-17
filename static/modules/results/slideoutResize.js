/**
 * results/slideoutResize.js — Persisted drag-resize for response/grading slideouts + grading keyboard shortcuts.
 */

import { state } from '../state.js';
import { countWords, getWordCountLabel } from '../utils.js';
import { MIN_EXPLANATION_WORDS } from '../config.js';
import { updateGradingProgressHeader } from './gradingSlideout.js';

export function initSlideoutResize() {
    const responseSlideout = document.getElementById('responseSlideout');
    const responseResizeHandle = document.getElementById('responseSlideoutResizeHandle');
    if (responseSlideout && responseResizeHandle) {
        setupSlideoutResize(responseSlideout, responseResizeHandle, 300, window.innerWidth * 0.95);
    }

    const gradingSlideout = document.getElementById('gradingSlideout');
    const gradingResizeHandle = document.getElementById('gradingSlideoutResizeHandle');
    if (gradingSlideout && gradingResizeHandle) {
        setupSlideoutResize(gradingSlideout, gradingResizeHandle, 400, window.innerWidth * 0.95);
    }

    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('gradingSlideout')?.classList.contains('open')) return;
        if (document.activeElement?.closest('textarea, input')) return;
        const key = (e.key || '').toLowerCase();
        if (key !== 'p' && key !== 'f') return;
        const slot = state.currentGradingSlot;
        if (!slot || state.llmRevealed) return;
        const { huntId } = slot;
        const container = document.getElementById('gradingSlideoutBody');
        if (!container) return;
        const row = document.activeElement?.closest('.grading-criterion');
        if (!row) return;
        const criterionId = row.dataset.criterionId;
        const passBtn = row.querySelector('.grading-btn-pass');
        const failBtn = row.querySelector('.grading-btn-fail');
        if (!criterionId || !passBtn || !failBtn) return;
        e.preventDefault();
        if (key === 'p') {
            passBtn.classList.add('active');
            failBtn.classList.remove('active');
            if (!state.humanReviews[huntId]) state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            state.humanReviews[huntId].grades[criterionId] = 1;
        } else {
            failBtn.classList.add('active');
            passBtn.classList.remove('active');
            if (!state.humanReviews[huntId]) state.humanReviews[huntId] = { grades: {}, notes: '', submitted: false };
            state.humanReviews[huntId].grades[criterionId] = 0;
        }
        updateGradingProgressHeader(huntId);
        const notesTextarea = container.querySelector('.grading-notes-textarea');
        const wordCountEl = container.querySelector('.grading-word-count');
        const submitBtn = container.querySelector('.grading-submit-btn');
        const criteriaIds = (state.criteria || []).map(c => c.id);
        const grades = (state.humanReviews[huntId] || {}).grades || {};
        const words = countWords(notesTextarea?.value || '');
        const allGraded = criteriaIds.every(id => grades[id] !== undefined);
        const canSubmit = allGraded && words >= MIN_EXPLANATION_WORDS;
        if (wordCountEl) {
            wordCountEl.textContent = getWordCountLabel(words);
            wordCountEl.style.color = words >= MIN_EXPLANATION_WORDS ? 'var(--success)' : 'var(--text-muted)';
        }
        if (submitBtn) {
            submitBtn.disabled = !canSubmit;
            submitBtn.style.opacity = canSubmit ? '1' : '0.7';
        }
        const next = Array.from(container.querySelectorAll('.grading-criterion')).find(r => grades[r.dataset.criterionId] === undefined);
        if (next) next.focus();
    });
}

function setupSlideoutResize(slideout, resizeHandle, minWidth, maxWidth) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizeHandle.addEventListener('mousedown', startResize);
    resizeHandle.addEventListener('touchstart', startResize, { passive: false });

    function startResize(e) {
        e.preventDefault();
        isResizing = true;

        startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
        startWidth = slideout.offsetWidth;

        slideout.classList.add('resizing');
        resizeHandle.classList.add('active');

        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'ew-resize';

        document.addEventListener('mousemove', doResize);
        document.addEventListener('mouseup', stopResize);
        document.addEventListener('touchmove', doResize, { passive: false });
        document.addEventListener('touchend', stopResize);
    }

    function doResize(e) {
        if (!isResizing) return;
        e.preventDefault();

        const currentX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
        const deltaX = startX - currentX;
        let newWidth = startWidth + deltaX;
        newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
        slideout.style.width = `${newWidth}px`;
    }

    function stopResize() {
        if (!isResizing) return;
        isResizing = false;

        slideout.classList.remove('resizing');
        resizeHandle.classList.remove('active');

        document.body.style.userSelect = '';
        document.body.style.cursor = '';

        document.removeEventListener('mousemove', doResize);
        document.removeEventListener('mouseup', stopResize);
        document.removeEventListener('touchmove', doResize);
        document.removeEventListener('touchend', stopResize);

        const slideoutId = slideout.id;
        if (slideoutId) {
            localStorage.setItem(`${slideoutId}Width`, slideout.style.width);
        }
    }

    const savedWidth = localStorage.getItem(`${slideout.id}Width`);
    if (savedWidth) {
        slideout.style.width = savedWidth;
    }
}
