/**
 * lit.js — single import-stable re-export of Lit 3 from the CDN.
 *
 * Components import from this file instead of the CDN URL directly so we
 * can swap Lit versions (or later move to a bundled copy) in one place.
 * No runtime logic — just re-exports.
 */
export {
    LitElement,
    html,
    svg,
    css,
    nothing,
    noChange,
} from 'https://cdn.jsdelivr.net/npm/lit@3.2.1/+esm';

export { repeat } from 'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/repeat.js/+esm';
export { classMap } from 'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/class-map.js/+esm';
export { styleMap } from 'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/style-map.js/+esm';
export { ifDefined } from 'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/if-defined.js/+esm';
