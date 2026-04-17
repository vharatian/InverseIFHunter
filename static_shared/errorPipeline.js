/**
 * Global client-side error pipeline.
 * Captures window.onerror and unhandledrejection, reports to a configured endpoint,
 * and optionally surfaces a subtle toast to the user.
 *
 * Usage:
 *   import { initErrorPipeline } from '/static_shared/errorPipeline.js';
 *   initErrorPipeline({ endpoint: '/api/client-errors', app: 'hunter', userToast: true });
 */
import { toast } from './toast.js';

let _inited = false;
let _cfg = { endpoint: '', app: 'unknown', userToast: false, sampleRate: 1 };
let _queue = [];
let _flushing = false;

function _send(payload) {
    if (!_cfg.endpoint) return;
    if (Math.random() > _cfg.sampleRate) return;
    _queue.push(payload);
    if (_flushing) return;
    _flushing = true;
    queueMicrotask(async () => {
        try {
            const batch = _queue.splice(0);
            if (navigator.sendBeacon && navigator.sendBeacon(_cfg.endpoint, new Blob([JSON.stringify({ events: batch })], { type: 'application/json' }))) return;
            await fetch(_cfg.endpoint, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ events: batch }),
                keepalive: true,
            });
        } catch (_) { /* drop on the floor */ }
        finally { _flushing = false; }
    });
}

function _normalize(type, err, extra = {}) {
    const e = err && typeof err === 'object' ? err : { message: String(err) };
    return {
        type,
        app: _cfg.app,
        ts: Date.now(),
        url: typeof location !== 'undefined' ? location.href : '',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        message: String(e.message || e.reason || e),
        stack: (e.stack ? String(e.stack).slice(0, 4000) : ''),
        ...extra,
    };
}

export function initErrorPipeline(cfg = {}) {
    if (_inited) return;
    _inited = true;
    _cfg = { ..._cfg, ...cfg };

    window.addEventListener('error', (ev) => {
        const payload = _normalize('error', ev.error || { message: ev.message }, {
            filename: ev.filename || '',
            lineno: ev.lineno || 0,
            colno: ev.colno || 0,
        });
        _send(payload);
        if (_cfg.userToast) toast('Something went wrong. We logged the issue.', 'error', 4000);
    });

    window.addEventListener('unhandledrejection', (ev) => {
        const payload = _normalize('unhandledrejection', ev.reason);
        _send(payload);
        if (_cfg.userToast) toast('A background task failed. Retrying…', 'warn', 3500);
    });
}

export function reportError(err, extra = {}) {
    _send(_normalize('manual', err, extra));
}
