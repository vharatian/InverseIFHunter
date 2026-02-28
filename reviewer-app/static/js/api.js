/**
 * API client: auth header and fetch wrapper with automatic retry on network errors.
 */
const EMAIL_KEY = "reviewer_email";
// When served under /reviewer (e.g. behind single-link proxy), API calls must use that prefix.
const API_BASE = (() => {
  const p = typeof location !== "undefined" ? location.pathname : "";
  return p.startsWith("/reviewer") ? "/reviewer" : "";
})();

export function getEmail() {
  return sessionStorage.getItem(EMAIL_KEY) || "";
}

export function setEmail(email) {
  sessionStorage.setItem(EMAIL_KEY, email);
}

export function headers() {
  const email = getEmail();
  const h = { "Content-Type": "application/json" };
  if (email) h["X-Reviewer-Email"] = email;
  return h;
}

/**
 * @param {string} path
 * @param {{ method?: string; body?: string; headers?: Record<string,string> }} [options]
 * @param {{ retries?: number; retryDelay?: number; retryOn?: (res: Response) => boolean }} [retryOptions]
 * @returns {Promise<any>}
 */
export async function api(path, options = {}, retryOptions = {}) {
  const maxRetries = retryOptions.retries ?? 3;
  const baseDelay = retryOptions.retryDelay ?? 1000;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
    }
    try {
      const res = await fetch(API_BASE + path, {
        ...options,
        headers: { ...headers(), ...(options.headers || {}) },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        // Don't retry HTTP errors (4xx/5xx) — only network-level failures
        throw new Error(err.detail || res.statusText);
      }
      if (res.status === 204) return null;
      return await res.json();
    } catch (e) {
      lastErr = e;
      // Only retry on network/fetch errors (TypeError), not on HTTP errors (Error)
      const isNetworkError = e instanceof TypeError;
      if (!isNetworkError || attempt === maxRetries) {
        throw e;
      }
    }
  }
  throw lastErr;
}
