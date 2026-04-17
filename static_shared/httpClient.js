/**
 * Thin fetch wrapper for consistent error handling, CSRF, and JSON decoding.
 * Apps can override defaults via `configureHttp({ baseUrl, csrfCookieName, csrfHeaderName })`.
 */
let _config = {
    baseUrl: '',
    csrfCookieName: 'csrf_token',
    csrfHeaderName: 'X-CSRF-Token',
    credentials: 'same-origin',
};

export function configureHttp(opts) {
    _config = { ..._config, ...(opts || {}) };
}

function _readCookie(name) {
    if (typeof document === 'undefined' || !document.cookie) return '';
    const parts = document.cookie.split(';');
    for (const p of parts) {
        const [k, ...rest] = p.trim().split('=');
        if (k === name) return decodeURIComponent(rest.join('='));
    }
    return '';
}

export class HttpError extends Error {
    constructor(status, statusText, body) {
        super(`HTTP ${status} ${statusText}`);
        this.name = 'HttpError';
        this.status = status;
        this.statusText = statusText;
        this.body = body;
    }
}

export async function http(path, options = {}) {
    const { baseUrl, csrfCookieName, csrfHeaderName, credentials } = _config;
    const url = /^https?:/i.test(path) ? path : baseUrl + path;
    const method = (options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type') && typeof options.body === 'string') {
        headers.set('Content-Type', 'application/json');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const token = _readCookie(csrfCookieName);
        if (token && !headers.has(csrfHeaderName)) headers.set(csrfHeaderName, token);
    }
    const res = await fetch(url, { credentials, ...options, method, headers });
    const ct = res.headers.get('content-type') || '';
    const parse = async () => {
        if (ct.includes('application/json')) { try { return await res.json(); } catch { return null; } }
        try { return await res.text(); } catch { return null; }
    };
    if (!res.ok) {
        throw new HttpError(res.status, res.statusText, await parse());
    }
    return { data: await parse(), response: res };
}
