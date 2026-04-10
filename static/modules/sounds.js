/**
 * sounds.js — Bloom UI beeps (Web Audio)
 *
 * Short, soft two-note gestures built from sine tones with gentle attack/decay.
 * Families: yes (up), maybe (neutral), nah (down) — mapped to app events below.
 */

let _audioCtx = null;
let _masterGain = null;
let _compressor = null;
let _soundsEnabled = true;

function _getCtx() {
    if (!_audioCtx) {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        _compressor = _audioCtx.createDynamicsCompressor();
        _compressor.threshold.value = -8;
        _compressor.knee.value = 4;
        _compressor.ratio.value = 5;
        _compressor.attack.value = 0.001;
        _compressor.release.value = 0.12;

        _masterGain = _audioCtx.createGain();
        _masterGain.gain.value = 0.72;

        _masterGain.connect(_compressor);
        _compressor.connect(_audioCtx.destination);
    }

    if (_audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }

    return _audioCtx;
}

/** Single soft bloom partial — slower attack, exponential decay. */
function _soft(freq, startTime, decay, gain = 0.38) {
    const ctx = _getCtx();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(gain, startTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + decay);
    osc.connect(g);
    g.connect(_masterGain);
    osc.start(startTime);
    osc.stop(startTime + decay + 0.02);
}

function _bloomYes(t) {
    _soft(659.25, t, 0.35, 0.2);
    _soft(783.99, t + 0.1, 0.4, 0.16);
}

function _bloomMaybe(t) {
    _soft(523.25, t, 0.4, 0.18);
    _soft(587.33, t + 0.14, 0.45, 0.14);
}

function _bloomNah(t) {
    _soft(392, t, 0.45, 0.2);
    _soft(329.63, t + 0.16, 0.5, 0.14);
}

export function setSoundsEnabled(val) { _soundsEnabled = !!val; }
export function getSoundsEnabled() { return _soundsEnabled; }

export function playFetchSuccess() {
    if (!_soundsEnabled) return;
    _bloomYes(_getCtx().currentTime);
}

export function playFetchError() {
    if (!_soundsEnabled) return;
    _bloomNah(_getCtx().currentTime);
}

export function playJudgeSuccess() {
    if (!_soundsEnabled) return;
    _bloomYes(_getCtx().currentTime);
}

export function playJudgeError() {
    if (!_soundsEnabled) return;
    _bloomNah(_getCtx().currentTime);
}

/** Hunt launched — neutral bloom */
export function playHuntStart() {
    if (!_soundsEnabled) return;
    _bloomMaybe(_getCtx().currentTime);
}

export function playHuntStartError() {
    if (!_soundsEnabled) return;
    _bloomNah(_getCtx().currentTime);
}

export function playHuntComplete() {
    if (!_soundsEnabled) return;
    _bloomYes(_getCtx().currentTime);
}

/** Zero results — gentle neutral */
export function playHuntCompleteEmpty() {
    if (!_soundsEnabled) return;
    _bloomMaybe(_getCtx().currentTime);
}

/** Task ended — soft neutral resolution */
export function playEndTask() {
    if (!_soundsEnabled) return;
    _bloomMaybe(_getCtx().currentTime);
}

export function playEndTaskError() {
    if (!_soundsEnabled) return;
    _bloomNah(_getCtx().currentTime);
}

export function playNextTurn() {
    if (!_soundsEnabled) return;
    _bloomYes(_getCtx().currentTime);
}

export function playNextTurnError() {
    if (!_soundsEnabled) return;
    _bloomNah(_getCtx().currentTime);
}

export function playFinalSubmission() {
    if (!_soundsEnabled) return;
    _bloomYes(_getCtx().currentTime);
}

export function playFinalSubmissionError() {
    if (!_soundsEnabled) return;
    _bloomNah(_getCtx().currentTime);
}
