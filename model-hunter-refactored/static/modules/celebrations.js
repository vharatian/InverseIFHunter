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
import { renderInsightTip, getUserFriendlyError, escapeHtml, debugLog } from './utils.js';

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

export function _celebResize() {
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

export function _celebAnimate() {
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

export function _celebStart() {
    if (!_celeb.running) { _celeb.running = true; _celebAnimate(); }
}

export function _celebFlash(color, opacity, duration) {
    const f = _celeb.flash;
    if (!f) return;
    f.style.background = color;
    f.style.opacity = opacity;
    setTimeout(() => { f.style.opacity = 0; }, duration);
}

// ── Effect 1: Classic Confetti (side cannons) ──
export function _celebConfettiClassic() {
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
export function _celebFireworkRockets() {
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
    debugLog(`🎉 Celebration effect: ${pick.name}`);
    pick();
}


export function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `alert alert-${type === 'info' ? 'warning' : type} fade-in`;
    toast.style.marginBottom = '0.5rem';
    toast.innerHTML = `
        <span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
        <span>${message}</span>
    `;
    
    elements.toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

/**
 * Show a toast with a Retry button for transient errors.
 * @param {string} message - Main message
 * @param {string} [hint] - Optional hint (shown smaller)
 * @param {() => void|Promise<void>} onRetry - Callback when Retry is clicked
 */
export function showToastWithRetry(message, hint, onRetry) {
    const toast = document.createElement('div');
    toast.className = 'alert alert-error fade-in toast-with-retry';
    toast.style.marginBottom = '0.5rem';
    toast.innerHTML = `
        <span>❌</span>
        <div class="toast-retry-content">
            <span>${escapeHtml(message)}</span>
            ${hint ? `<span class="toast-hint">${escapeHtml(hint)}</span>` : ''}
            <button type="button" class="btn btn-sm btn-outline toast-retry-btn">Retry</button>
        </div>
    `;
    elements.toastContainer.appendChild(toast);

    const retryBtn = toast.querySelector('.toast-retry-btn');
    retryBtn.addEventListener('click', () => {
        toast.remove();
        if (typeof onRetry === 'function') onRetry();
    });

    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => toast.remove(), 300);
        }
    }, 8000);
}

/**
 * P7: Show user-friendly error toast. Maps technical errors to readable messages.
 * @param {Error|string} error - Caught error
 * @param {{ operation?: string, status?: number, retry?: () => void }} [options] - Context and optional retry callback
 */
export function showError(error, options = {}) {
    const { message, hint, canRetry } = getUserFriendlyError(error, {
        operation: options.operation || 'Operation',
        status: options.status
    });
    if (canRetry && options.retry) {
        showToastWithRetry(message, hint, options.retry);
    } else {
        const fullMessage = hint ? `${message} ${hint}` : message;
        showToast(fullMessage, 'error');
    }
    if (error && error.message && typeof console !== 'undefined') {
        console.error('[Model Hunter]', error);
    }
}


// ============== Blind Judging ==============

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
    
    // Show modal
    elements.blindJudgeModal.classList.remove('hidden');
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
    
    elements.humanJudgeResult.textContent = humanScore === 0 ? '❌ FAIL (0)' : '✅ PASS (1)';
    elements.humanJudgeResult.style.color = humanScore === 0 ? 'var(--success)' : 'var(--danger)';
    
    elements.llmJudgeResult.textContent = llmScore === 0 ? '❌ FAIL (0)' : llmScore === 1 ? '✅ PASS (1)' : '? Unknown';
    elements.llmJudgeResult.style.color = llmScore === 0 ? 'var(--success)' : 'var(--danger)';
    
    elements.judgeMatch.textContent = isMatch ? '✅ Match!' : '❌ Disagree';
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
    
    // Update score (keep score emojis per user request)
    if (score !== null && score !== undefined) {
        row.querySelector('.score-cell').innerHTML = `
            <span class="score-badge score-${score}">
                ${score === 0 ? '✅ 0' : '❌ 1'}
            </span>
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
    
    // Show summary tip
    renderInsightTip('summaryTipContainer', 'summary', { type: breaksFound >= 3 ? 'success' : undefined });
    
    const successRate = totalHunts > 0 ? Math.round((breaksFound / totalHunts) * 100) : 0;
    document.getElementById('summarySuccess').textContent = `${successRate}% (${breaksFound}/${totalHunts} breaks)`;
    document.getElementById('summaryMet').textContent = breaksFound >= 3 ? 'Yes' : 'No';
    
    // Populate breaking results
    displayBreakingResults();
    
    showToast(
        breaksFound >= 3
            ? `Found ${breaksFound} model breaking responses.` 
            : `Review complete. Found ${breaksFound} breaks.`,
        breaksFound >= 3 ? 'success' : 'info'
    );
}


