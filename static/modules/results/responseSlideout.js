/**
 * results/responseSlideout.js — Response preview slide-out (both hunt-level and selection-level).
 */

import { state } from '../state.js';
import { getModelDisplayName } from '../utils.js';
import { showToast } from '../celebrations.js?v=43';
import { createFocusTrap } from '../focusTrap.js';
import { isResultBreaking, isResultError } from './resultModel.js';

let _responseSlideoutTrap = null;

export function openResponseSlideout(rowNum) {
    const data = state.huntResponseData[rowNum];
    if (!data) {
        console.warn(`No response data found for row ${rowNum}`);
        showToast('Response data not available yet', 'warning');
        return;
    }

    const slideout = document.getElementById('responseSlideout');
    const backdrop = document.getElementById('responseSlideoutBackdrop');
    const titleEl = document.getElementById('slideoutTitle');
    const modelEl = document.getElementById('slideoutModel');
    const statusEl = document.getElementById('slideoutStatus');
    const scoreEl = document.getElementById('slideoutScore');
    const responseTextEl = document.getElementById('slideoutResponseText');

    if (!slideout) {
        console.error('Slideout panel element not found!');
        showToast('Error: Panel not found', 'error');
        return;
    }

    if (titleEl) titleEl.textContent = `Hunt #${data.huntNum} Response`;
    if (modelEl) modelEl.textContent = getModelDisplayName(data.model);

    if (statusEl) {
        statusEl.textContent = data.status;
        statusEl.className = 'response-slideout-meta-value';
        if (data.status === 'completed') {
            statusEl.classList.add(data.is_breaking ? 'pass' : 'fail');
        }
    }

    if (scoreEl) {
        if (data.sample_label === 'ERROR') {
            scoreEl.textContent = 'MISSING CRITERIA';
            scoreEl.className = 'response-slideout-meta-value';
            scoreEl.style.color = 'var(--warning)';
        } else if (data.score !== null && data.score !== undefined) {
            scoreEl.textContent = isResultBreaking(data) ? 'BREAKING' : 'PASSING';
            scoreEl.className = 'response-slideout-meta-value';
            scoreEl.classList.add(isResultBreaking(data) ? 'pass' : 'fail');
        } else {
            scoreEl.textContent = '-';
            scoreEl.className = 'response-slideout-meta-value';
        }
    }

    if (responseTextEl) responseTextEl.textContent = data.response || 'No response';

    slideout.style.right = '0';
    slideout.classList.add('open');
    slideout.setAttribute('role', 'dialog');
    slideout.setAttribute('aria-modal', 'true');
    if (backdrop) backdrop.classList.add('visible');

    document.body.style.overflow = 'hidden';

    if (_responseSlideoutTrap) { try { _responseSlideoutTrap.release(); } catch { /* ignore */ } }
    _responseSlideoutTrap = createFocusTrap(slideout, { onEscape: closeResponseSlideout });
}

export function closeResponseSlideout() {
    const slideout = document.getElementById('responseSlideout');
    const backdrop = document.getElementById('responseSlideoutBackdrop');

    if (slideout) {
        const currentWidth = slideout.offsetWidth;
        slideout.style.right = `-${currentWidth + 10}px`;
        slideout.classList.remove('open');
    }
    if (backdrop) backdrop.classList.remove('visible');

    document.body.style.overflow = '';

    if (_responseSlideoutTrap) {
        try { _responseSlideoutTrap.release(); } catch { /* ignore */ }
        _responseSlideoutTrap = null;
    }
}

export function openSelectionDetailSlideout(rowNumber, result) {
    const slideout = document.getElementById('responseSlideout');
    const backdrop = document.getElementById('responseSlideoutBackdrop');
    const titleEl = document.getElementById('slideoutTitle');
    const modelEl = document.getElementById('slideoutModel');
    const statusEl = document.getElementById('slideoutStatus');
    const scoreEl = document.getElementById('slideoutScore');
    const responseTextEl = document.getElementById('slideoutResponseText');

    if (!slideout) {
        console.error('Slideout panel element not found!');
        return;
    }

    const breaking = isResultBreaking(result);
    const error = isResultError(result);

    if (titleEl) titleEl.textContent = `Hunt #${rowNumber + 1} Response`;
    if (modelEl) modelEl.textContent = getModelDisplayName(result.model);

    if (statusEl) {
        if (error) {
            statusEl.textContent = 'MISSING CRITERIA';
            statusEl.className = 'response-slideout-meta-value';
            statusEl.style.color = 'var(--warning)';
        } else {
            statusEl.textContent = breaking ? 'BREAK' : 'PASS';
            statusEl.className = 'response-slideout-meta-value';
            statusEl.classList.add(breaking ? 'pass' : 'fail');
        }
    }

    if (scoreEl) {
        const displayScore = result.judge_score !== null ? result.judge_score : (result.score !== null ? result.score : '-');
        scoreEl.textContent = displayScore;
        scoreEl.className = 'response-slideout-meta-value';
        if (displayScore !== '-') {
            scoreEl.classList.add(displayScore === 0 ? 'pass' : 'fail');
        }
    }

    if (responseTextEl) responseTextEl.textContent = result.response || 'No response available';

    slideout.style.right = '0';
    slideout.classList.add('open');
    slideout.setAttribute('role', 'dialog');
    slideout.setAttribute('aria-modal', 'true');
    if (backdrop) backdrop.classList.add('visible');

    document.body.style.overflow = 'hidden';

    if (_responseSlideoutTrap) { try { _responseSlideoutTrap.release(); } catch { /* ignore */ } }
    _responseSlideoutTrap = createFocusTrap(slideout, { onEscape: closeResponseSlideout });
}
