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
    let id = setInterval(fn, intervalMs);

    function onVisibility() {
        if (document.hidden) {
            clearInterval(id);
            id = null;
        } else {
            fn();
            if (!id) id = setInterval(fn, intervalMs);
        }
    }

    document.addEventListener('visibilitychange', onVisibility);

    return function stop() {
        clearInterval(id);
        id = null;
        document.removeEventListener('visibilitychange', onVisibility);
    };
}
