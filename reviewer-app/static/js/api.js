/**
 * API client: auth header, fetch wrapper, and version check for soft-reload.
 */
const EMAIL_KEY = "reviewer_email";
const VERSION_CHECK_INTERVAL = 30000;
let _currentVersion = null;
let _pendingVersion = null;
// API routes are mounted under the same path prefix as this page (e.g. /staging/reviewer).
// Pathname wins over <base href> because the server often injects /reviewer/ even when deployed at /staging/reviewer/.
export const API_BASE = (() => {
  if (typeof location === "undefined") return "/reviewer";
  const normalized = ((location.pathname || "/").replace(/\/+$/, "") || "/").split("?")[0];
  if (normalized.endsWith("/reviewer")) {
    return normalized;
  }
  try {
    const baseEl = document.querySelector("base[href]");
    if (baseEl) {
      const href = baseEl.getAttribute("href") || "";
      const abs = new URL(href, location.origin);
      let path = abs.pathname.replace(/\/$/, "");
      if (path) return path;
    }
  } catch (_) {
    /* fall through */
  }
  const idx = normalized.indexOf("/reviewer");
  if (idx >= 0) return normalized.substring(0, idx + "/reviewer".length);
  return "/reviewer";
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
        const d = err.detail;
        let msg = res.statusText;
        if (typeof d === "string") msg = d;
        else if (Array.isArray(d))
          msg = d.map((x) => (typeof x === "object" && x?.msg ? x.msg : String(x))).join("; ");
        else if (d && typeof d === "object") msg = JSON.stringify(d);
        if (res.status === 404 && (msg === "Not Found" || !msg)) {
          msg =
            "API path not found (404). If this page was opened as a file or from a wrong URL, open the reviewer from the server link that ends with /reviewer/ .";
        }
        throw new Error(msg);
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
    const res = await fetch(`${API_BASE}/api/version`, { cache: "no-store" });
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
