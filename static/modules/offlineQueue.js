/**
 * offlineQueue.js — Offline-aware write queue with IndexedDB persistence.
 *
 * Detects online/offline state, queues failed writes when offline,
 * flushes on reconnect with conflict checks (review_status comparison).
 *
 * Usage:
 *   import { enqueue, isOnline, onStatusChange, initOfflineQueue } from './offlineQueue.js';
 *   initOfflineQueue();
 *   // When a save fails due to network:
 *   await enqueue({ type: 'save-reviews', url, options, sessionId });
 */

import { state } from './state.js';

const DB_NAME = 'mh_offline_queue';
const DB_VERSION = 1;
const STORE_NAME = 'pending_writes';
const MAX_QUEUE_SIZE = 50;

let _db = null;
let _online = navigator.onLine;
let _flushing = false;
const _listeners = [];
let _queueInited = false;
let _offlinePoll = null;
let _reachDebounce = null;

/**
 * True reachability: Chrome profiles sometimes leave navigator.onLine stuck false
 * (VPN, extensions, flaky Wi‑Fi) while the app can still reach the server.
 */
async function _probeReachability() {
    try {
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), 5000);
        const res = await fetch('api/health', { method: 'GET', cache: 'no-store', signal: ac.signal });
        clearTimeout(tid);
        return res.ok;
    } catch {
        return false;
    }
}

function _clearOfflinePoll() {
    if (_offlinePoll) {
        clearInterval(_offlinePoll);
        _offlinePoll = null;
    }
}

function _ensureOfflinePoll() {
    if (_offlinePoll) return;
    _offlinePoll = setInterval(() => void _recoverIfReachable(), 12000);
}

async function _recoverIfReachable() {
    if (_online) return;
    const ok = await _probeReachability();
    if (ok) _setOnline(true);
}

async function _syncReachability() {
    if (navigator.onLine) {
        _setOnline(true);
        return;
    }
    const ok = await _probeReachability();
    if (ok) _setOnline(true);
    else {
        if (!_online) _ensureOfflinePoll();
        else _setOnline(false);
    }
}

function _scheduleReachabilitySync() {
    clearTimeout(_reachDebounce);
    _reachDebounce = setTimeout(() => {
        _reachDebounce = null;
        void _syncReachability();
    }, 300);
}

/* ---- Public API ---- */

export function isOnline() { return _online; }

/**
 * Register a callback for online/offline transitions.
 * @param {(online: boolean) => void} fn
 */
export function onStatusChange(fn) { _listeners.push(fn); }

/**
 * Queue a write operation for later replay.
 * @param {{ type: string, url: string, options: RequestInit, sessionId: string }} entry
 */
export async function enqueue(entry) {
    const db = await _getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const count = await _promisify(store.count());
    if (count >= MAX_QUEUE_SIZE) {
        console.warn('[offlineQueue] Queue full, dropping oldest entry');
        const cursor = await _promisify(store.openCursor());
        if (cursor) cursor.delete();
    }

    await _promisify(store.add({
        ...entry,
        queued_at: Date.now(),
        session_id: entry.sessionId || state.sessionId,
    }));
    _updateBadge();
}

/**
 * Number of pending writes in the queue.
 */
export async function pendingCount() {
    try {
        const db = await _getDb();
        const tx = db.transaction(STORE_NAME, 'readonly');
        return await _promisify(tx.objectStore(STORE_NAME).count());
    } catch { return 0; }
}

/**
 * Initialize offline detection + auto-flush on reconnect.
 */
export function initOfflineQueue() {
    if (_queueInited) return;
    _queueInited = true;

    window.addEventListener('online', () => _setOnline(true));
    window.addEventListener('offline', () => {
        _setOnline(false);
        setTimeout(() => void _recoverIfReachable(), 500);
    });
    window.addEventListener('pageshow', () => _scheduleReachabilitySync());
    window.addEventListener('focus', () => _scheduleReachabilitySync());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _scheduleReachabilitySync();
    });

    _online = navigator.onLine;
    // UI banner/badge is now a Lit component — see
    // [components/mh-connection-banner.js](./components/mh-connection-banner.js).
    // It subscribes to onStatusChange + polls pendingCount on its own, so
    // we no longer create the banner DOM here. Badge updates happen via
    // the component's internal poll.
    void (async () => {
        await _syncReachability();
        if (_online) _flush();
    })();
}

/* ---- Internals ---- */

function _setOnline(val) {
    if (_online === val) {
        if (!val) _ensureOfflinePoll();
        return;
    }
    _online = val;
    _listeners.forEach(fn => { try { fn(val); } catch (_) {} });
    _updateBanner();
    if (val) {
        _clearOfflinePoll();
        _flush();
    } else {
        _ensureOfflinePoll();
    }
}

async function _flush() {
    if (_flushing || !_online) return;
    _flushing = true;

    try {
        const db = await _getDb();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const entries = await _promisify(tx.objectStore(STORE_NAME).getAll());
        if (!entries || entries.length === 0) { _flushing = false; _updateBadge(); return; }

        for (const entry of entries) {
            if (!_online) break;

            const verdict = await _canReplay(entry);
            if (verdict === 'discard') {
                await _remove(entry.id);
                continue;
            }
            if (verdict === 'defer') {
                // Network/server check failed; treat as transient and stop flushing for now.
                break;
            }

            try {
                const res = await fetch(entry.url, entry.options);
                if (res.ok || res.status === 409) {
                    await _remove(entry.id);
                } else if (res.status === 400 || res.status === 422) {
                    // Permanent client error — drop so it doesn't retry forever.
                    await _remove(entry.id);
                } else {
                    // 401/403/408/5xx/etc → keep and retry later.
                    break;
                }
            } catch {
                // Network error → keep for next flush.
                break;
            }
        }
    } catch (err) {
        console.warn('[offlineQueue] Flush error:', err);
    } finally {
        _flushing = false;
        _updateBadge();
    }
}

/**
 * Check if a queued write should still be replayed.
 * Returns 'replay' (safe to send), 'discard' (status changed, drop), or
 * 'defer' (couldn't verify — keep for later).
 */
async function _canReplay(entry) {
    if (!entry.session_id) return 'replay';
    const actionTypes = new Set(['submit-for-review', 'resubmit']);
    if (!actionTypes.has(entry.type)) return 'replay';

    try {
        const res = await fetch(`api/session/${entry.session_id}`, { cache: 'no-store' });
        if (!res.ok) {
            // 404 → session gone, drop; anything else → try again later.
            return res.status === 404 ? 'discard' : 'defer';
        }
        const data = await res.json();
        const status = data.review_status || 'draft';
        if (entry.type === 'submit-for-review' && status !== 'draft') return 'discard';
        if (entry.type === 'resubmit' && status !== 'returned') return 'discard';
        return 'replay';
    } catch {
        return 'defer';
    }
}

async function _remove(id) {
    const db = await _getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await _promisify(tx.objectStore(STORE_NAME).delete(id));
}

/* ---- IndexedDB helpers ---- */

function _getDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => { _db = req.result; resolve(_db); };
        req.onerror = () => reject(req.error);
    });
}

function _promisify(idbReq) {
    return new Promise((resolve, reject) => {
        idbReq.onsuccess = () => resolve(idbReq.result);
        idbReq.onerror = () => reject(idbReq.error);
    });
}

/* ---- UI: offline banner + pending badge ----
 *
 * Rendering lives in [components/mh-connection-banner.js](./components/mh-connection-banner.js).
 * This module only owns data (online state, queue count) and the pubsub
 * hooks. _updateBanner and _updateBadge are kept as no-ops so existing
 * call-sites in this file compile without conditionals.
 */

function _updateBanner() { /* handled by <mh-connection-banner> */ }

async function _updateBadge() {
    // Let the banner component refresh immediately instead of waiting for
    // its 5s interval. Fire-and-forget — failures are non-fatal.
    try {
        window.dispatchEvent(new CustomEvent('mh:queue-pending-changed'));
    } catch { /* no-op */ }
}
