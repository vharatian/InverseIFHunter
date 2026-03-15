/**
 * sounds.js — Apple-style synthesized sound effects
 *
 * All sounds are generated in real-time using the Web Audio API.
 * No external files, no downloads, no CDN — pure synthesis.
 *
 * Design principles:
 *  - Sine wave fundamentals with subtle inharmonic partials (bell character)
 *  - Fast attack (~6ms), exponential decay (smooth, never clicks)
 *  - Musical intervals from C major (C E G — resolution, warmth)
 *  - Success: ascending arpeggios, bright upper registers
 *  - Error: descending, lower registers, rounded (never jarring)
 *  - Master compressor for consistent, clean output
 */

let _audioCtx = null;
let _masterGain = null;
let _compressor = null;
let _soundsEnabled = true;

// ─────────────────────────────────────────────────────────────────────────────
// Engine bootstrap
// ─────────────────────────────────────────────────────────────────────────────

function _getCtx() {
    if (!_audioCtx) {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // Dynamics compressor — prevents clipping, glues all sounds together cleanly
        _compressor = _audioCtx.createDynamicsCompressor();
        _compressor.threshold.value = -8;
        _compressor.knee.value      = 4;
        _compressor.ratio.value     = 5;
        _compressor.attack.value    = 0.001;
        _compressor.release.value   = 0.12;

        // Master volume (0.72 — present but not aggressive)
        _masterGain = _audioCtx.createGain();
        _masterGain.gain.value = 0.72;

        _masterGain.connect(_compressor);
        _compressor.connect(_audioCtx.destination);
    }

    // Browser autoplay policy: resume on user gesture
    if (_audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }

    return _audioCtx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive oscillators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bell tone: sine fundamental + inharmonic partial for glass/metal character.
 * Matches the "Ping" / "Glass" quality of macOS system sounds.
 */
function _bell(freq, startTime, decay, gain = 0.45) {
    const ctx = _getCtx();

    // Fundamental
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(gain, startTime + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + decay);
    osc.connect(g);
    g.connect(_masterGain);
    osc.start(startTime);
    osc.stop(startTime + decay + 0.02);

    // Inharmonic partial — adds shimmer (tuned like a bell overtone, not an octave)
    const osc2 = ctx.createOscillator();
    const g2   = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2.756, startTime);
    g2.gain.setValueAtTime(0, startTime);
    g2.gain.linearRampToValueAtTime(gain * 0.14, startTime + 0.006);
    g2.gain.exponentialRampToValueAtTime(0.0001, startTime + decay * 0.45);
    osc2.connect(g2);
    g2.connect(_masterGain);
    osc2.start(startTime);
    osc2.stop(startTime + decay * 0.45 + 0.02);
}

/**
 * Soft rounded tone: no shimmer, slower attack.
 * Used for errors and neutral sounds — present but not alarming.
 */
function _soft(freq, startTime, decay, gain = 0.38) {
    const ctx = _getCtx();
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(gain, startTime + 0.020); // softer attack
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + decay);
    osc.connect(g);
    g.connect(_masterGain);
    osc.start(startTime);
    osc.stop(startTime + decay + 0.02);
}

// ─────────────────────────────────────────────────────────────────────────────
// Note frequency table  (equal-temperament, A4 = 440 Hz)
// ─────────────────────────────────────────────────────────────────────────────

const N = {
    C4: 261.63,  D4: 293.66,  E4: 329.63,  F4: 349.23,
    G4: 392.00,  A4: 440.00,  B4: 493.88,
    C5: 523.25,  D5: 587.33,  E5: 659.25,  F5: 698.46,
    G5: 783.99,  A5: 880.00,  B5: 987.77,
    C6: 1046.50, D6: 1174.66, E6: 1318.51, G6: 1567.98,
};

// ─────────────────────────────────────────────────────────────────────────────
// Enable / disable toggle (for future settings panel)
// ─────────────────────────────────────────────────────────────────────────────

export function setSoundsEnabled(val) { _soundsEnabled = !!val; }
export function getSoundsEnabled()    { return _soundsEnabled; }

// ─────────────────────────────────────────────────────────────────────────────
// 1. FETCH NOTEBOOK
// ─────────────────────────────────────────────────────────────────────────────

/** Notebook fetched successfully — bright two-note chime ascending */
export function playFetchSuccess() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _bell(N.C5, t,        0.55, 0.44);
    _bell(N.E5, t + 0.10, 0.55, 0.42);
    _bell(N.G5, t + 0.20, 0.80, 0.40);
}

/** Fetch failed — soft two-note descend */
export function playFetchError() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _soft(N.E4, t,        0.45, 0.36);
    _soft(N.C4, t + 0.16, 0.55, 0.30);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. JUDGE IDEAL RESPONSE (testbed save + judge)
// ─────────────────────────────────────────────────────────────────────────────

/** Ideal response judged — all criteria passing — warm three-note arpeggio */
export function playJudgeSuccess() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _bell(N.E5, t,        0.50, 0.40);
    _bell(N.G5, t + 0.09, 0.50, 0.40);
    _bell(N.C6, t + 0.19, 0.90, 0.46);
}

/** Judge found criteria failures — soft descending two notes */
export function playJudgeError() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _soft(N.G4, t,        0.42, 0.34);
    _soft(N.E4, t + 0.18, 0.52, 0.28);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. FIND BREAKING RESPONSES (hunt start)
// ─────────────────────────────────────────────────────────────────────────────

/** Hunt launched — short punchy ascending activation sound */
export function playHuntStart() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _bell(N.G4, t,        0.22, 0.34);
    _bell(N.D5, t + 0.08, 0.32, 0.42);
}

/** Hunt blocked / failed to start */
export function playHuntStartError() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _soft(N.E4, t, 0.50, 0.34);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. HUNT COMPLETED
// ─────────────────────────────────────────────────────────────────────────────

/** Hunt finished with results — triumphant four-note C major arpeggio */
export function playHuntComplete() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _bell(N.C5, t,        0.65, 0.40);
    _bell(N.E5, t + 0.10, 0.65, 0.40);
    _bell(N.G5, t + 0.20, 0.65, 0.42);
    _bell(N.C6, t + 0.33, 1.10, 0.50);
}

/** Hunt completed with zero results — soft neutral two-note */
export function playHuntCompleteEmpty() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _soft(N.A4, t,        0.40, 0.28);
    _soft(N.G4, t + 0.18, 0.52, 0.24);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. END TASK (mark breaking / end & review)
// ─────────────────────────────────────────────────────────────────────────────

/** Task ended — decisive descending resolution, like closing a chapter */
export function playEndTask() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _bell(N.G5, t,        0.50, 0.38);
    _bell(N.E5, t + 0.10, 0.50, 0.36);
    _bell(N.C5, t + 0.22, 0.85, 0.42);
}

/** End task API call failed */
export function playEndTaskError() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _soft(N.E4, t,        0.45, 0.34);
    _soft(N.C4, t + 0.18, 0.55, 0.28);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. GO TO NEXT TURN
// ─────────────────────────────────────────────────────────────────────────────

/** Advancing to next turn — two ascending notes, forward momentum */
export function playNextTurn() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _bell(N.G4, t,        0.38, 0.36);
    _bell(N.C5, t + 0.12, 0.55, 0.42);
}

/** Next turn navigation failed */
export function playNextTurnError() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _soft(N.E4, t, 0.48, 0.32);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. FINAL SUBMISSION (submit to Colab)
// ─────────────────────────────────────────────────────────────────────────────

/** Submitted to Colab — grand five-note arpeggio with long sustain on top note */
export function playFinalSubmission() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _bell(N.C5, t,        0.70, 0.42);
    _bell(N.E5, t + 0.10, 0.70, 0.42);
    _bell(N.G5, t + 0.20, 0.72, 0.44);
    _bell(N.C6, t + 0.32, 0.90, 0.48);
    _bell(N.E6, t + 0.46, 1.80, 0.52);
}

/** Final submission failed — classic macOS-style three-note descend (Sosumi homage) */
export function playFinalSubmissionError() {
    if (!_soundsEnabled) return;
    const ctx = _getCtx();
    const t = ctx.currentTime;
    _soft(N.B4, t,        0.36, 0.38);
    _soft(N.G4, t + 0.15, 0.36, 0.34);
    _soft(N.E4, t + 0.30, 0.58, 0.30);
}
