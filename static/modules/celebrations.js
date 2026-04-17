/**
 * celebrations.js — Celebration Effects Engine, Toast Notifications
 * 
 * Lightweight canvas particle engine for firework, confetti, spark effects.
 * Also handles toast notification display.
 * 
 */

import { elements } from './dom.js';
import { state, getCumulativeStats } from './state.js';
import { displayBreakingResults } from './results.js';
import { renderInsightTip, getUserFriendlyError, escapeHtml } from './utils.js';
import { getHuntModeById } from './config.js';
import { createFocusTrap } from './focusTrap.js';

// ============== Celebration Effects Engine ==============
// Lightweight canvas particle engine for spark/firework effects
(function initCelebrationCanvas() {
    if (document.getElementById('celebrationCanvas')) return;
    const canvas = document.createElement('canvas');
    canvas.id = 'celebrationCanvas';
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999;';
    document.body.appendChild(canvas);

    const flashEl = document.createElement('div');
    flashEl.id = 'celebrationFlash';
    flashEl.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99998;opacity:0;transition:opacity 0.05s;';
    document.body.appendChild(flashEl);
})();

const _celeb = {
    particles: [],
    running: false,
    get canvas() { return document.getElementById('celebrationCanvas'); },
    get ctx() { return this.canvas?.getContext('2d'); },
    get flash() { return document.getElementById('celebrationFlash'); }
};

function _celebResize() {
    const c = _celeb.canvas;
    if (c) { c.width = window.innerWidth; c.height = window.innerHeight; }
}
window.addEventListener('resize', _celebResize);

class _CelebParticle {
    constructor(x, y, opts = {}) {
        this.x = x; this.y = y;
        this.vx = opts.vx || 0; this.vy = opts.vy || 0;
        this.gravity = opts.gravity ?? 0.12;
        this.friction = opts.friction ?? 0.98;
        this.alpha = 1;
        this.decay = opts.decay || (0.01 + Math.random() * 0.02);
        this.size = opts.size || (1 + Math.random() * 3);
        this.color = opts.color || '#ffd700';
        this.trail = opts.trail ?? true;
        this.glow = opts.glow ?? true;
        this.prevX = x; this.prevY = y;
    }
    update() {
        this.prevX = this.x; this.prevY = this.y;
        this.vx *= this.friction; this.vy *= this.friction;
        this.vy += this.gravity;
        this.x += this.vx; this.y += this.vy;
        this.alpha -= this.decay;
    }
    draw(ctx) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, this.alpha);
        if (this.trail) {
            ctx.beginPath();
            ctx.moveTo(this.prevX, this.prevY);
            ctx.lineTo(this.x, this.y);
            ctx.strokeStyle = this.color;
            ctx.lineWidth = this.size * 0.8;
            ctx.stroke();
        }
        if (this.glow) { ctx.shadowBlur = this.size * 6; ctx.shadowColor = this.color; }
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
        ctx.restore();
    }
}

function _celebAnimate() {
    const ctx = _celeb.ctx;
    if (!ctx || _celeb.particles.length === 0) {
        _celeb.running = false;
        if (ctx) ctx.clearRect(0, 0, _celeb.canvas.width, _celeb.canvas.height);
        return;
    }
    ctx.clearRect(0, 0, _celeb.canvas.width, _celeb.canvas.height);
    _celeb.particles = _celeb.particles.filter(p => p.alpha > 0);
    _celeb.particles.forEach(p => { p.update(); p.draw(ctx); });
    requestAnimationFrame(_celebAnimate);
}

function _celebStart() {
    if (!_celeb.running) { _celeb.running = true; _celebAnimate(); }
}

function _celebFlash(color, opacity, duration) {
    const f = _celeb.flash;
    if (!f) return;
    f.style.background = color;
    f.style.opacity = opacity;
    setTimeout(() => { f.style.opacity = 0; }, duration);
}

// ── Effect 1: Classic Confetti (side cannons) ──
function _celebConfettiClassic() {
    if (typeof confetti !== 'function') return;
    const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
    function burst() {
        confetti({ particleCount: 40, spread: 80, angle: 55, origin: { x: 0, y: 0.6 }, startVelocity: 50, scalar: 1.1, colors });
        confetti({ particleCount: 40, spread: 80, angle: 125, origin: { x: 1, y: 0.6 }, startVelocity: 50, scalar: 1.1, colors });
        confetti({ particleCount: 40, spread: 100, angle: 90, origin: { x: 0.5, y: 0.9 }, startVelocity: 45, scalar: 1.1, colors });
    }
    burst();
    setTimeout(burst, 300);
    setTimeout(burst, 600);
}

// ── Effect: Firework Rockets (canvas sparks) ──
function _celebFireworkRockets() {
    _celebResize();
    const ctx = _celeb.ctx;
    if (!ctx) { _celebConfettiClassic(); return; } // fallback
    ctx.clearRect(0, 0, _celeb.canvas.width, _celeb.canvas.height);
    const w = _celeb.canvas.width, h = _celeb.canvas.height;
    const burstColors = [
        ['#ff6b6b', '#ff4500', '#ffd700'],
        ['#4ecdc4', '#00ff88', '#87ceeb'],
        ['#a78bfa', '#ff6b9d', '#ff1493'],
        ['#ffd700', '#ffa500', '#ffff00']
    ];

    function launchRocket(delay) {
        setTimeout(() => {
            const x = w * (0.2 + Math.random() * 0.6);
            const targetY = h * (0.15 + Math.random() * 0.3);
            const colors = burstColors[Math.floor(Math.random() * burstColors.length)];
            let y = h;
            const trailInterval = setInterval(() => {
                y -= 12;
                _celeb.particles.push(new _CelebParticle(x + (Math.random() - 0.5) * 3, y, {
                    vx: (Math.random() - 0.5) * 0.5, vy: -0.5,
                    gravity: 0.02, decay: 0.03, size: 2,
                    color: '#ffd700', trail: false, glow: true
                }));
                _celebStart();
                if (y <= targetY) {
                    clearInterval(trailInterval);
                    _celebFlash(colors[0], 0.15, 150);
                    for (let i = 0; i < 60; i++) {
                        const angle = Math.random() * Math.PI * 2;
                        const speed = 2 + Math.random() * 7;
                        _celeb.particles.push(new _CelebParticle(x, targetY, {
                            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                            gravity: 0.06, decay: 0.006 + Math.random() * 0.012,
                            size: 1 + Math.random() * 2.5,
                            color: colors[Math.floor(Math.random() * colors.length)],
                            trail: true, glow: true
                        }));
                    }
                    _celebStart();
                }
            }, 25);
        }, delay);
    }
    launchRocket(0);
    launchRocket(600);
    launchRocket(1200);
    launchRocket(2000);
}

// ── Main trigger — randomly picks confetti or fireworks ──
export function triggerColabConfetti() {
    const effects = [_celebConfettiClassic, _celebFireworkRockets];
    const pick = effects[Math.floor(Math.random() * effects.length)];
    pick();
}


const _TOAST_KIND = new Set(['success', 'error', 'warning', 'info']);

let _simpleToastTimer = null;
let _retryToastTimer = null;
let _errorToastTimer = null;

function _hideRetryToastImmediate() {
    clearTimeout(_retryToastTimer);
    _retryToastTimer = null;
    const toast = document.getElementById('mh-toast-retry-singleton');
    if (!toast) return;
    toast.hidden = true;
    toast.style.opacity = '';
    toast.style.transform = '';
}

function _hideSimpleToastImmediate() {
    clearTimeout(_simpleToastTimer);
    _simpleToastTimer = null;
    const toast = document.getElementById('mh-toast-singleton');
    if (!toast) return;
    toast.hidden = true;
    toast.style.opacity = '';
    toast.style.transform = '';
}

function _hideErrorTraceToastImmediate() {
    clearTimeout(_errorToastTimer);
    _errorToastTimer = null;
    const toast = document.getElementById('mh-toast-error-trace-singleton');
    if (!toast) return;
    toast.hidden = true;
    toast.style.opacity = '';
    toast.style.transform = '';
}

function _ensureSimpleToast(dock) {
    let toast = document.getElementById('mh-toast-singleton');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mh-toast-singleton';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.innerHTML = '<span class="mh-toast__bar" aria-hidden="true"></span><span class="mh-toast__msg"></span>';
        dock.appendChild(toast);
    }
    return toast;
}

export function showToast(message, type = 'info') {
    const dock = elements.toastContainer;
    if (!dock) return;

    _hideRetryToastImmediate();

    const kind = _TOAST_KIND.has(type) ? type : 'info';
    const toast = _ensureSimpleToast(dock);
    toast.className = `mh-toast mh-toast--${kind} fade-in`;
    toast.hidden = false;
    toast.style.opacity = '';
    toast.style.transform = '';
    const msg = toast.querySelector('.mh-toast__msg');
    if (msg) msg.textContent = message;

    clearTimeout(_simpleToastTimer);
    _simpleToastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-6px)';
        setTimeout(() => {
            _hideSimpleToastImmediate();
        }, 300);
    }, 4000);
}

/**
 * Show a toast with a Retry button for transient errors.
 * @param {string} message - Main message
 * @param {string} [hint] - Optional hint (shown smaller)
 * @param {() => void|Promise<void>} onRetry - Callback when Retry is clicked
 */
export function showToastWithRetry(message, hint, onRetry) {
    const dock = elements.toastContainer;
    if (!dock) return;

    _hideSimpleToastImmediate();

    let toast = document.getElementById('mh-toast-retry-singleton');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mh-toast-retry-singleton';
        toast.className = 'mh-toast mh-toast--error toast-with-retry fade-in';
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
        toast.innerHTML = `
            <span class="mh-toast__bar" aria-hidden="true"></span>
            <div class="mh-toast__body">
                <div class="toast-retry-content">
                    <span class="toast-retry-msg"></span>
                    <span class="toast-hint"></span>
                    <button type="button" class="btn btn-sm btn-outline toast-retry-btn">Retry</button>
                </div>
            </div>`;
        dock.appendChild(toast);
    }

    toast.hidden = false;
    toast.style.opacity = '';
    toast.style.transform = '';

    const msgSpan = toast.querySelector('.toast-retry-msg');
    const hintSpan = toast.querySelector('.toast-hint');
    const retryBtn = toast.querySelector('.toast-retry-btn');
    if (msgSpan) msgSpan.textContent = message;
    if (hintSpan) {
        if (hint) {
            hintSpan.textContent = hint;
            hintSpan.style.display = '';
        } else {
            hintSpan.textContent = '';
            hintSpan.style.display = 'none';
        }
    }
    if (retryBtn) {
        retryBtn.onclick = () => {
            _hideRetryToastImmediate();
            if (typeof onRetry === 'function') onRetry();
        };
    }

    clearTimeout(_retryToastTimer);
    _retryToastTimer = setTimeout(() => {
        if (!toast.hidden) {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-6px)';
            setTimeout(() => _hideRetryToastImmediate(), 300);
        }
    }, 8000);
}

/**
 * Show an error toast carrying the server-side trace id as a monospace,
 * copy-to-clipboard chip. Used when showError gets a traceId in the error
 * or options. Singleton DOM, aria-live assertive.
 */
function _showErrorTraceToast(message, hint, traceId, onRetry) {
    const dock = elements.toastContainer;
    if (!dock) return;

    _hideSimpleToastImmediate();
    _hideRetryToastImmediate();

    let toast = document.getElementById('mh-toast-error-trace-singleton');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mh-toast-error-trace-singleton';
        toast.className = 'mh-toast mh-toast--error mh-toast--with-trace fade-in';
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
        toast.innerHTML = `
            <span class="mh-toast__bar" aria-hidden="true"></span>
            <div class="mh-toast__body">
                <div class="mh-toast__msg"></div>
                <div class="mh-toast__hint" hidden></div>
                <div class="mh-toast__actions">
                    <button type="button" class="mh-toast__trace-chip"
                            title="Copy trace ID to clipboard"
                            aria-label="Copy trace ID to clipboard"></button>
                    <button type="button" class="btn btn-sm btn-outline mh-toast__retry" hidden>Retry</button>
                </div>
            </div>`;
        dock.appendChild(toast);
    }

    toast.hidden = false;
    toast.style.opacity = '';
    toast.style.transform = '';

    const msgEl = toast.querySelector('.mh-toast__msg');
    const hintEl = toast.querySelector('.mh-toast__hint');
    const chipEl = toast.querySelector('.mh-toast__trace-chip');
    const retryEl = toast.querySelector('.mh-toast__retry');

    if (msgEl) msgEl.textContent = message;
    if (hintEl) {
        if (hint) {
            hintEl.textContent = hint;
            hintEl.hidden = false;
        } else {
            hintEl.textContent = '';
            hintEl.hidden = true;
        }
    }
    if (chipEl) {
        const tid = traceId || '';
        chipEl.textContent = tid ? `trace: ${tid}` : '';
        chipEl.hidden = !tid;
        chipEl.onclick = async () => {
            if (!tid) return;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(tid);
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = tid;
                    ta.setAttribute('readonly', '');
                    ta.style.position = 'absolute';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                const prev = chipEl.textContent;
                chipEl.textContent = 'copied ✓';
                setTimeout(() => { chipEl.textContent = prev; }, 1400);
            } catch (e) {
                console.warn('[Model Hunter] trace-id copy failed', e);
            }
        };
    }
    if (retryEl) {
        if (typeof onRetry === 'function') {
            retryEl.hidden = false;
            retryEl.onclick = () => {
                _hideErrorTraceToastImmediate();
                onRetry();
            };
        } else {
            retryEl.hidden = true;
            retryEl.onclick = null;
        }
    }

    clearTimeout(_errorToastTimer);
    _errorToastTimer = setTimeout(() => {
        if (!toast.hidden) {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-6px)';
            setTimeout(() => _hideErrorTraceToastImmediate(), 300);
        }
    }, 10000);
}

/**
 * Show an undo toast for destructive, optimistic actions.
 *
 *   const handle = showUndoToast({
 *       message: 'Session deleted',
 *       delayMs: 5000,
 *       onUndo: () => { ... restore UI ... },
 *       onCommit: async () => { ... perform the real API call ... },
 *       onCommitError: (err) => { ... restore UI + surface error ... },
 *   });
 *   handle.dismiss(); // optional — commit immediately
 *
 * Behaviour:
 *   - Renders a singleton toast with a live countdown + Undo button.
 *   - If Undo is clicked within delayMs: cancels the timer, calls onUndo.
 *   - If the timer fires: calls onCommit (awaited). Any throw is forwarded
 *     to onCommitError (if provided) so the caller can revert the UI.
 *   - Only one undo toast may be visible at a time; creating a new one
 *     commits the previous one immediately (safest default for queue ops).
 *
 * @param {{
 *   message: string,
 *   delayMs?: number,
 *   undoLabel?: string,
 *   onUndo?: () => void,
 *   onCommit?: () => (void | Promise<void>),
 *   onCommitError?: (err: unknown) => void,
 * }} options
 * @returns {{ dismiss: () => void, undo: () => void }}
 */
let _undoToastState = null;

function _hideUndoToastImmediate() {
    if (_undoToastState?.interval) clearInterval(_undoToastState.interval);
    if (_undoToastState?.timer) clearTimeout(_undoToastState.timer);
    _undoToastState = null;
    const toast = document.getElementById('mh-toast-undo-singleton');
    if (!toast) return;
    toast.hidden = true;
    toast.style.opacity = '';
    toast.style.transform = '';
}

export function showUndoToast(options) {
    const {
        message,
        delayMs = 5000,
        undoLabel = 'Undo',
        onUndo,
        onCommit,
        onCommitError,
    } = options || {};
    const dock = elements.toastContainer;
    if (!dock) {
        // No toast dock — commit synchronously as a safe default.
        Promise.resolve()
            .then(() => (typeof onCommit === 'function' ? onCommit() : undefined))
            .catch((err) => { if (typeof onCommitError === 'function') onCommitError(err); });
        return { dismiss() {}, undo() {} };
    }

    // Any in-flight undo commits now (flush previous before showing a new one).
    if (_undoToastState) {
        const prev = _undoToastState;
        _undoToastState = null;
        clearInterval(prev.interval);
        clearTimeout(prev.timer);
        try {
            const res = typeof prev.onCommit === 'function' ? prev.onCommit() : undefined;
            if (res && typeof res.then === 'function') {
                res.catch((err) => {
                    if (typeof prev.onCommitError === 'function') prev.onCommitError(err);
                });
            }
        } catch (err) {
            if (typeof prev.onCommitError === 'function') prev.onCommitError(err);
        }
    }

    _hideSimpleToastImmediate();
    _hideRetryToastImmediate();

    let toast = document.getElementById('mh-toast-undo-singleton');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mh-toast-undo-singleton';
        toast.className = 'mh-toast mh-toast--info mh-toast--with-undo fade-in';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.innerHTML = `
            <span class="mh-toast__bar" aria-hidden="true"></span>
            <div class="mh-toast__body">
                <div class="mh-toast__msg"></div>
                <div class="mh-toast__actions">
                    <span class="mh-toast__countdown" aria-hidden="true"></span>
                    <button type="button" class="btn btn-sm btn-outline mh-toast__undo"></button>
                </div>
            </div>`;
        dock.appendChild(toast);
    }
    toast.hidden = false;
    toast.style.opacity = '';
    toast.style.transform = '';

    const msgEl = toast.querySelector('.mh-toast__msg');
    const cdEl = toast.querySelector('.mh-toast__countdown');
    const undoEl = toast.querySelector('.mh-toast__undo');
    if (msgEl) msgEl.textContent = message || 'Action pending…';
    if (undoEl) undoEl.textContent = undoLabel;

    const startedAt = Date.now();
    const state = { interval: null, timer: null, onCommit, onCommitError };
    _undoToastState = state;

    function _tick() {
        const remaining = Math.max(0, delayMs - (Date.now() - startedAt));
        if (cdEl) cdEl.textContent = `${Math.ceil(remaining / 1000)}s`;
    }
    _tick();
    state.interval = setInterval(_tick, 250);

    async function _commit() {
        if (_undoToastState !== state) return; // superseded
        _hideUndoToastImmediate();
        try {
            if (typeof onCommit === 'function') await onCommit();
        } catch (err) {
            if (typeof onCommitError === 'function') onCommitError(err);
            else console.error('[Model Hunter] undo commit failed', err);
        }
    }
    function _undo() {
        if (_undoToastState !== state) return;
        _hideUndoToastImmediate();
        try {
            if (typeof onUndo === 'function') onUndo();
        } catch (err) {
            console.error('[Model Hunter] undo handler threw', err);
        }
    }

    if (undoEl) undoEl.onclick = _undo;
    state.timer = setTimeout(_commit, delayMs);

    return { dismiss: _commit, undo: _undo };
}

/**
 * P7: Show user-friendly error toast. Maps technical errors to readable messages.
 *
 * When a trace id is available (from `options.traceId` or `error.traceId` —
 * as attached by `apiFetch`), a monospace copy-to-clipboard chip is rendered
 * so trainers can paste the id into a bug report.
 *
 * @param {Error|string} error - Caught error. ApiError instances carry `.traceId` and `.status`.
 * @param {{ operation?: string, status?: number, retry?: () => void, traceId?: string }} [options]
 */
export function showError(error, options = {}) {
    const status = options.status ?? (error && typeof error === 'object' ? error.status : undefined);
    const traceId = options.traceId || (error && typeof error === 'object' ? error.traceId : '') || '';
    const { message, hint, canRetry } = getUserFriendlyError(error, {
        operation: options.operation || 'Operation',
        status,
    });
    const retry = typeof options.retry === 'function' ? options.retry : null;

    if (traceId) {
        _showErrorTraceToast(message, hint, traceId, canRetry ? retry : null);
    } else if (canRetry && retry) {
        showToastWithRetry(message, hint, retry);
    } else {
        const fullMessage = hint ? `${message} ${hint}` : message;
        showToast(fullMessage, 'error');
    }
    if (error && error.message && typeof console !== 'undefined') {
        console.error('[Model Hunter]', error, traceId ? { traceId } : '');
    }
}


// ============== Blind Judging ==============

let _blindJudgeTrap = null;

export function showNextBlindJudge() {
    if (state.blindJudging.queue.length === 0) {
        // All judging complete - show final results
        hideBlindJudgeModal();
        showFinalResults();
        return;
    }
    
    // Get next result from queue
    const result = state.blindJudging.queue.shift();
    state.blindJudging.currentResult = result;
    
    // Reset modal state
    elements.llmJudgeReveal.classList.add('hidden');
    elements.humanJudgePass.disabled = false;
    elements.humanJudgeFail.disabled = false;
    elements.humanJudgeSkip.disabled = false;
    
    // Populate modal
    elements.judgeHuntId.textContent = result.hunt_id;
    elements.judgeResponseText.textContent = result.response || 'No response content available';
    
    // Show modal + trap focus. Modal is role=dialog via index.html; we
    // add aria-modal here defensively in case markup is missed.
    const modal = elements.blindJudgeModal;
    modal.classList.remove('hidden');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    if (_blindJudgeTrap) { try { _blindJudgeTrap.release(); } catch { /* ignore */ } }
    _blindJudgeTrap = createFocusTrap(modal, {
        initialFocus: elements.humanJudgePass,
    });
}

export function handleHumanJudgment(humanScore) {
    const result = state.blindJudging.currentResult;
    if (!result) return;
    
    // Store human judgment
    state.blindJudging.humanJudgments[result.hunt_id] = humanScore;
    
    // Disable buttons
    elements.humanJudgePass.disabled = true;
    elements.humanJudgeFail.disabled = true;
    elements.humanJudgeSkip.disabled = true;
    
    // Reveal LLM judgment
    const llmScore = result.score;
    const isMatch = humanScore === llmScore;
    const passingMode = state.config?.passing_mode === true;
    
    const humanWanted = passingMode ? humanScore === 1 : humanScore === 0;
    elements.humanJudgeResult.textContent = humanScore === 0 ? 'FAIL (0)' : 'PASS (1)';
    elements.humanJudgeResult.style.color = humanWanted ? 'var(--success)' : 'var(--danger)';
    
    const llmWanted = passingMode ? llmScore === 1 : llmScore === 0;
    elements.llmJudgeResult.textContent = llmScore === 0 ? 'FAIL (0)' : llmScore === 1 ? 'PASS (1)' : '? Unknown';
    elements.llmJudgeResult.style.color = llmWanted ? 'var(--success)' : 'var(--danger)';
    
    elements.judgeMatch.textContent = isMatch ? 'Match!' : 'Disagree';
    elements.judgeMatch.className = `comparison-value ${isMatch ? 'match' : 'no-match'}`;
    
    // Update table row with actual score now
    updateRowWithScore(result.hunt_id, result);
    
    // Show reveal section
    elements.llmJudgeReveal.classList.remove('hidden');
}

export function updateRowWithScore(huntId, result) {
    const row = document.getElementById(`hunt-row-${huntId}`);
    if (!row) return;
    
    const score = result.score;
    
    // Update status (no emoji)
    row.querySelector('.status-cell').innerHTML = `
        <span class="score-badge" style="background: var(--success-bg); color: var(--success);">Reviewed</span>
    `;
    
    if (score !== null && score !== undefined) {
        row.querySelector('.score-cell').innerHTML = `
            <span class="score-badge score-${score}">${score}</span>
        `;
    }
    
    // Update result column
    const resultCell = row.querySelector('.result-cell') || row.querySelector('.issues-cell');
    if (resultCell) {
        resultCell.textContent = result.is_breaking ? 'Breaking' : '-';
    }
    
    // Update breaks indicator
    if (result.is_breaking) {
        const dots = elements.breaksIndicator.querySelectorAll('.break-dot:not(.found)');
        if (dots.length > 0) {
            dots[0].classList.add('found');
        }
    }
}

export function hideBlindJudgeModal() {
    elements.blindJudgeModal.classList.add('hidden');
    state.blindJudging.currentResult = null;
    if (_blindJudgeTrap) {
        try { _blindJudgeTrap.release(); } catch { /* ignore */ }
        _blindJudgeTrap = null;
    }
}

export function showFinalResults() {
    // Show upload and config sections again
    document.querySelector('.section')?.classList.remove('hidden');
    elements.configSection?.classList.remove('hidden');
    
    // Update status
    elements.statusText.textContent = 'Review Complete';
    
    // Show results section
    elements.resultsSection.classList.remove('hidden');
    elements.summarySection.classList.remove('hidden');
    
    // Calculate CUMULATIVE breaks and hunts across ALL turns + current turn
    const cumulative = getCumulativeStats();
    const totalHunts = cumulative.totalHunts;
    const breaksFound = cumulative.totalBreaks;
    
    // Populate summary with cumulative data
    document.getElementById('summaryTotal').textContent = totalHunts;
    document.getElementById('summaryBreaks').textContent = breaksFound;
    
    const huntMode = state.config?.hunt_mode || 'break_50';
    const celMode = getHuntModeById(huntMode);
    const celMinBreaking = state.config?.min_breaking_required ?? 0;
    let celMet;
    if (celMode.type === 'passing' || celMinBreaking === 0) {
        celMet = (totalHunts - breaksFound) >= 1;
    } else if (celMode.count_based) {
        celMet = breaksFound >= (celMode.required_breaking ?? 1);
    } else {
        celMet = breaksFound >= celMinBreaking;
    }

    renderInsightTip('summaryTipContainer', 'summary', { type: celMet ? 'success' : undefined });

    const successRate = totalHunts > 0 ? Math.round((breaksFound / totalHunts) * 100) : 0;
    document.getElementById('summarySuccess').textContent = `${successRate}% (${breaksFound}/${totalHunts} breaks)`;
    document.getElementById('summaryMet').textContent = celMet ? 'Yes' : 'No';

    displayBreakingResults();

    showToast(
        celMet
            ? `Found ${breaksFound} breaking responses. Criteria met!`
            : `Review complete. Found ${breaksFound} breaks.`,
        celMet ? 'success' : 'info'
    );
}


