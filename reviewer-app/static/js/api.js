/**
 * API client: auth header, fetch wrapper, and version check for soft-reload.
 */
import { createReviewerAutoModalVersionCheck } from "/static/js/updates/version-check.mjs";

if (typeof location !== "undefined" && location.search.includes("_v=")) {
  history.replaceState(null, "", location.pathname);
}
const EMAIL_KEY = "reviewer_email";
const VERSION_CHECK_INTERVAL = 30000;
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

let _isCouncilRunning = () => false;

export function setCouncilRunningCheck(fn) {
  _isCouncilRunning = fn;
}

function _showUpdateModal() {
  let overlay = document.getElementById("update-modal-overlay");
  if (overlay) { overlay.hidden = false; return; }

  overlay = document.createElement("div");
  overlay.id = "update-modal-overlay";
  overlay.className = "update-modal-overlay";
  overlay.innerHTML = `
    <div class="update-modal">
      <div class="update-modal-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </div>
      <h3 class="update-modal-title">Update Available</h3>
      <p class="update-modal-msg">A new version of the reviewer app is ready.</p>
      <p class="update-modal-warn">Updating will reload the page and reset your current view. Make sure you've finished any active task before updating.</p>
      <div class="update-modal-actions">
        <button type="button" class="update-modal-btn update-modal-btn--later">Later</button>
        <button type="button" class="update-modal-btn update-modal-btn--now">Update Now</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector(".update-modal-btn--now").addEventListener("click", () => location.reload());
  overlay.querySelector(".update-modal-btn--later").addEventListener("click", () => {
    overlay.hidden = true;
  });

  // Replace header button to kill any old event listeners
  const oldBtn = document.getElementById("reviewerUpdateIndicator");
  if (oldBtn) {
    const newBtn = oldBtn.cloneNode(true);
    newBtn.classList.remove("hidden");
    newBtn.textContent = "Update";
    newBtn.addEventListener("click", () => { overlay.hidden = false; });
    oldBtn.replaceWith(newBtn);
  }
}

const _reviewerVc = createReviewerAutoModalVersionCheck({
  versionUrl: `${API_BASE}/api/version`,
  intervalMs: VERSION_CHECK_INTERVAL,
  shouldDefer: () => _isCouncilRunning(),
  onQueued: () => {
    const btn = document.getElementById("reviewerUpdateIndicator");
    if (btn) {
      btn.classList.remove("hidden");
      btn.textContent = "Update queued...";
      btn.onclick = null;
    }
  },
  showOverlay: _showUpdateModal,
});

export async function checkVersion() {
  return _reviewerVc.checkVersion();
}

export function initVersionCheck() {
  return _reviewerVc.initVersionCheck();
}

export function onCouncilComplete() {
  return _reviewerVc.onCouncilComplete();
}
