/**
 * safeHtml.js — tagged-template HTML builder + DOMPurify wrapper.
 *
 * Motivation:
 *   Existing modules build markup with raw string concatenation and innerHTML.
 *   New code should use these helpers instead. Both auto-escape interpolated
 *   values; sanitize() is the escape hatch for content that must keep HTML
 *   (e.g. rendered markdown).
 *
 * Adoption policy:
 *   - NEW code MUST prefer html`...` or sanitize() over raw string concat.
 *   - Existing escapeHtml call-sites may stay; migrate opportunistically.
 *
 * Usage:
 *   import { html, sanitize, raw } from './safeHtml.js';
 *   el.innerHTML = html`<p class="x">${userName}</p>`;
 *   el.innerHTML = sanitize(markdownHtml);
 *   el.innerHTML = html`<div>${raw(trustedHtmlFragment)}</div>`;
 */

import { escapeHtml } from './utils.js';

/**
 * Marker class for values that should bypass escaping inside html`...`.
 * Use only for strings you have already sanitised/generated.
 */
class RawHtml {
    constructor(value) {
        this.value = value == null ? '' : String(value);
    }
}

/** Mark a string as pre-escaped HTML. */
export function raw(value) {
    return new RawHtml(value);
}

/**
 * Tagged template literal that HTML-escapes every interpolation.
 * Arrays are joined (each element escaped). RawHtml instances pass through.
 * Nullish values render as empty string.
 */
export function html(strings, ...values) {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
        out += strings[i];
        if (i < values.length) {
            out += _renderValue(values[i]);
        }
    }
    return out;
}

function _renderValue(v) {
    if (v == null || v === false) return '';
    if (v instanceof RawHtml) return v.value;
    if (Array.isArray(v)) return v.map(_renderValue).join('');
    return escapeHtml(v);
}

/**
 * Sanitise a raw HTML string using DOMPurify (loaded from CDN in index.html).
 * Falls back to escaping when DOMPurify isn't available (e.g. early boot).
 * Returns a string; use with innerHTML.
 */
export function sanitize(dirty, options = {}) {
    const input = dirty == null ? '' : String(dirty);
    const dp = typeof globalThis !== 'undefined' ? globalThis.DOMPurify : undefined;
    if (!dp || typeof dp.sanitize !== 'function') {
        return escapeHtml(input);
    }
    return dp.sanitize(input, {
        USE_PROFILES: { html: true },
        ...options,
    });
}
