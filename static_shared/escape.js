/** Shared HTML escape utility used across Hunter, Dashboard, Reviewer. */
const _ESC_RE = /[&<>"'`]/g;
const _ESC_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
};

export function escapeHtml(value) {
    if (value == null) return '';
    return String(value).replace(_ESC_RE, (c) => _ESC_MAP[c]);
}

/** Escape an attribute value, URL-guarded. Returns '' for dangerous schemes. */
export function safeUrl(value) {
    if (value == null) return '';
    const s = String(value).trim();
    if (/^\s*javascript:/i.test(s) || /^\s*data:/i.test(s) || /^\s*vbscript:/i.test(s)) return '';
    return escapeHtml(s);
}
