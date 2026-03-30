/**
 * API client: auth header, fetch wrapper, and version check for soft-reload.
 */
const EMAIL_KEY = "reviewer_email";
const VERSION_CHECK_INTERVAL = 30000;
let _currentVersion = null;
let _pendingVersion = null;
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

export async function checkVersion() {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    const data = await res.json();
    if (_currentVersion === null) {
      _currentVersion = data.version;
    } else if (data.version !== _currentVersion) {
      _pendingVersion = data.version;
      _showUpdateBanner();
    }
  } catch { /* server may be restarting */ }
}

let _indicatorWired = false;

function _showUpdateBanner() {
  const btn = document.getElementById("reviewerUpdateIndicator");
  if (!btn) return;
  btn.classList.remove("hidden");
  if (_indicatorWired) return;
  _indicatorWired = true;
  btn.addEventListener("click", () => {
    if (confirm("A new version is available. Refresh now?")) {
      window.location.href = window.location.pathname + "?_v=" + Date.now();
    }
  });
}

export function initVersionCheck() {
  checkVersion();
  setInterval(checkVersion, VERSION_CHECK_INTERVAL);
}
