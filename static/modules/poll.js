/**
 * Reusable polling with visibility-aware pause/resume.
 * Pauses when the tab is hidden, resumes immediately when visible.
 *
 * Usage:
 *   import { createPoller } from './poll.js';
 *   const stop = createPoller(() => refresh(), 15000);
 */

/**
 * @param {() => void} fn - Function to call on each tick (and immediately on resume).
 * @param {number} intervalMs - Polling interval in milliseconds.
 * @returns {() => void} stop - Call to permanently stop polling.
 */
export function createPoller(fn, intervalMs) {
    const safeFn = () => {
        try {
            const ret = fn();
            if (ret && typeof ret.catch === 'function') {
                ret.catch(err => console.warn('[poll] async callback error:', err));
            }
        } catch (err) {
            console.warn('[poll] callback error:', err);
        }
    };

    let id = setInterval(safeFn, intervalMs);

    function onVisibility() {
        if (document.hidden) {
            clearInterval(id);
            id = null;
        } else {
            safeFn();
            if (!id) id = setInterval(safeFn, intervalMs);
        }
    }

    document.addEventListener('visibilitychange', onVisibility);

    return function stop() {
        clearInterval(id);
        id = null;
        document.removeEventListener('visibilitychange', onVisibility);
    };
}
