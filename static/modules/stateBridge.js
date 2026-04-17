/**
 * stateBridge.js — minimal pubsub over the existing `state` object.
 *
 * The app's source of truth remains [state.js](./state.js). This bridge
 * adds a tiny publish/subscribe layer on top so Lit components can
 * subscribe to named keys and re-render when imperative code mutates state
 * and calls `notify(key)`.
 *
 * Intentionally NOT a reactive proxy — explicit notifications keep the
 * blast radius of rewrites small and let us migrate incrementally.
 *
 *   import { state } from './state.js';
 *   import { subscribe, notify, bindController } from './stateBridge.js';
 *
 *   // In a Lit component:
 *   class MyEl extends LitElement {
 *       constructor() {
 *           super();
 *           this._unsubscribe = subscribe('results', () => this.requestUpdate());
 *       }
 *       disconnectedCallback() {
 *           super.disconnectedCallback();
 *           this._unsubscribe?.();
 *       }
 *   }
 *
 *   // In imperative code that mutates state:
 *   state.results.push(newResult);
 *   notify('results');
 */

/** @type {Map<string, Set<() => void>>} */
const _listeners = new Map();

/**
 * Subscribe to a state key. Returns an unsubscribe function.
 * @param {string} key
 * @param {() => void} fn
 */
export function subscribe(key, fn) {
    if (typeof key !== 'string' || typeof fn !== 'function') {
        return () => {};
    }
    let bucket = _listeners.get(key);
    if (!bucket) {
        bucket = new Set();
        _listeners.set(key, bucket);
    }
    bucket.add(fn);
    return () => {
        const b = _listeners.get(key);
        if (!b) return;
        b.delete(fn);
        if (b.size === 0) _listeners.delete(key);
    };
}

/**
 * Notify all subscribers for a key. Swallows individual listener errors.
 * @param {string} key
 */
export function notify(key) {
    const bucket = _listeners.get(key);
    if (!bucket || bucket.size === 0) return;
    bucket.forEach((fn) => {
        try { fn(); } catch (err) {
            console.error(`[stateBridge] listener for "${key}" threw`, err);
        }
    });
}

/**
 * Notify several keys at once. Useful after batched imperative updates.
 * @param {string[]} keys
 */
export function notifyAll(keys) {
    if (!Array.isArray(keys)) return;
    keys.forEach(notify);
}

/**
 * Convenience: bind a Lit host to one or more state keys. Returns the
 * host so callers can chain. Host is expected to expose `requestUpdate()`
 * (true for LitElement and ReactiveControllerHost).
 *
 * @param {{ requestUpdate: () => void, addController?: Function }} host
 * @param {string | string[]} keys
 */
export function bindController(host, keys) {
    const keyList = Array.isArray(keys) ? keys : [keys];
    const unsubs = [];
    const controller = {
        hostConnected() {
            const cb = () => host.requestUpdate();
            keyList.forEach((k) => unsubs.push(subscribe(k, cb)));
        },
        hostDisconnected() {
            while (unsubs.length) {
                try { unsubs.pop()(); } catch { /* ignore */ }
            }
        },
    };
    if (typeof host.addController === 'function') {
        host.addController(controller);
    } else {
        // Fallback for non-Lit hosts — subscribe immediately.
        controller.hostConnected();
    }
    return host;
}

/** Test helper — removes every subscriber. Do not call in app code. */
export function _resetForTests() {
    _listeners.clear();
}
