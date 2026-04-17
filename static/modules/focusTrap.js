/**
 * focusTrap.js — minimal WAI-ARIA authoring-practices focus trap.
 *
 * Usage:
 *     import { createFocusTrap } from './focusTrap.js';
 *     const trap = createFocusTrap(overlayEl, { onEscape: close });
 *     // ...later when closing the modal:
 *     trap.release();
 *
 * Behaviour:
 *   - Stores the previously focused element on creation.
 *   - Moves focus to `initialFocus` if provided, else the first focusable
 *     descendant of `container`, else `container` itself (tabindex -1 added).
 *   - Cycles Tab / Shift+Tab inside `container`.
 *   - Invokes `onEscape` when the Escape key is pressed (if provided).
 *   - On `release()`: removes listeners and restores focus to the previously
 *     focused element when it is still connected to the DOM.
 *
 * Notes:
 *   - Assumes a single active container. Nested modals open a new trap and
 *     restore the prior focus chain via the browser's natural focus history.
 *   - Elements inside the container whose offsetParent is null (visually
 *     hidden) are filtered out of the tab cycle.
 */

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    'audio[controls]',
    'video[controls]',
    '[contenteditable]:not([contenteditable="false"])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

function _collectFocusable(container) {
    if (!container) return [];
    const nodes = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
    return nodes.filter((el) => {
        if (el.hasAttribute('disabled')) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        // offsetParent is null for display:none elements (but not for fixed).
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        return true;
    });
}

/**
 * @param {HTMLElement} container
 * @param {{ onEscape?: () => void, initialFocus?: HTMLElement }} [options]
 * @returns {{ release: () => void, update: () => void }}
 */
export function createFocusTrap(container, options = {}) {
    if (!container || typeof container.querySelectorAll !== 'function') {
        return { release: () => {}, update: () => {} };
    }

    const { onEscape, initialFocus } = options;
    const previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;

    let focusables = _collectFocusable(container);

    // Ensure the container itself can receive focus as a last resort.
    if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1');
    }

    const target =
        (initialFocus && typeof initialFocus.focus === 'function' && initialFocus) ||
        focusables[0] ||
        container;
    try { target.focus({ preventScroll: false }); } catch { /* ignore */ }

    function _onKeydown(e) {
        if (e.key === 'Escape' && typeof onEscape === 'function') {
            e.preventDefault();
            e.stopPropagation();
            onEscape();
            return;
        }
        if (e.key !== 'Tab') return;

        focusables = _collectFocusable(container);
        if (focusables.length === 0) {
            e.preventDefault();
            container.focus();
            return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (e.shiftKey) {
            if (active === first || !container.contains(active)) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (active === last || !container.contains(active)) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    function _onFocusIn(e) {
        if (!container.contains(e.target)) {
            focusables = _collectFocusable(container);
            (focusables[0] || container).focus();
        }
    }

    document.addEventListener('keydown', _onKeydown, true);
    document.addEventListener('focusin', _onFocusIn, true);

    return {
        release() {
            document.removeEventListener('keydown', _onKeydown, true);
            document.removeEventListener('focusin', _onFocusIn, true);
            if (previouslyFocused && document.body.contains(previouslyFocused)) {
                try { previouslyFocused.focus({ preventScroll: true }); } catch { /* ignore */ }
            }
        },
        update() {
            focusables = _collectFocusable(container);
        },
    };
}
