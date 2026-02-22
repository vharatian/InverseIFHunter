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
    window.addEventListener('online', () => _setOnline(true));
    window.addEventListener('offline', () => _setOnline(false));
    _online = navigator.onLine;
    _ensureBanner();
    if (_online) _flush();
}

/* ---- Internals ---- */

function _setOnline(val) {
    if (_online === val) return;
    _online = val;
    _listeners.forEach(fn => { try { fn(val); } catch (_) {} });
    _updateBanner();
    if (val) _flush();
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

            const shouldReplay = await _canReplay(entry);
            if (!shouldReplay) {
                await _remove(entry.id);
                continue;
            }

            try {
                const res = await fetch(entry.url, entry.options);
                if (res.ok || res.status === 409) {
                    await _remove(entry.id);
                } else if (res.status >= 500) {
                    break;
                } else {
                    await _remove(entry.id);
                }
            } catch {
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
 * Discard submits/resubmits if review_status has changed server-side.
 */
async function _canReplay(entry) {
    if (!entry.session_id) return true;
    const actionTypes = new Set(['submit-for-review', 'resubmit']);
    if (!actionTypes.has(entry.type)) return true;

    try {
        const res = await fetch(`/api/session/${entry.session_id}`, { cache: 'no-store' });
        if (!res.ok) return false;
        const data = await res.json();
        const status = data.review_status || 'draft';
        if (entry.type === 'submit-for-review' && status !== 'draft') return false;
        if (entry.type === 'resubmit' && status !== 'returned') return false;
        return true;
    } catch {
        return false;
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

/* ---- UI: offline banner + pending badge ---- */

function _ensureBanner() {
    if (document.getElementById('offlineBanner')) return;
    const banner = document.createElement('div');
    banner.id = 'offlineBanner';
    banner.className = 'offline-banner offline-banner--hidden';
    banner.innerHTML = `
        <span class="offline-banner__icon">⚡</span>
        <span class="offline-banner__text">You're offline — changes will sync when you reconnect</span>
        <span class="offline-banner__badge" id="offlinePendingBadge"></span>
    `;
    const header = document.querySelector('header.header');
    if (header) header.insertAdjacentElement('afterend', banner);
    else document.body.prepend(banner);
    _updateBanner();
}

function _updateBanner() {
    const el = document.getElementById('offlineBanner');
    if (!el) return;
    if (_online) {
        el.classList.add('offline-banner--hidden');
    } else {
        el.classList.remove('offline-banner--hidden');
    }
}

async function _updateBadge() {
    const badge = document.getElementById('offlinePendingBadge');
    if (!badge) return;
    const n = await pendingCount();
    badge.textContent = n > 0 ? `${n} pending` : '';
}
