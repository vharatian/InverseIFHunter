/**
 * Shared version polling + update UX for trainer, reviewer, dashboard, admin.
 */

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

/**
 * Simple modal for dashboard/admin (no dependency on trainer showAppModal).
 * @returns {Promise<boolean>}
 */
export function showSimpleUpdateModal(options) {
  const {
    title = "New update available",
    message = "",
    confirmLabel = "Update now",
    cancelLabel = "Not now",
  } = options || {};
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "app-modal-overlay version-check-simple-modal";
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 10001;
      background: rgba(0,0,0,0.5); backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
    `;
    const dialog = document.createElement("div");
    dialog.style.cssText = `
      background: var(--bg-secondary, #1e1e2e); border-radius: 12px; padding: 24px 28px;
      max-width: 440px; width: 90%; border: 1px solid var(--border, #333);
      box-shadow: 0 10px 40px rgba(0,0,0,0.4);
    `;
    const msgHtml = (message || "")
      .split("\n")
      .map((line) => escapeHtml(line))
      .join("<br>");
    dialog.innerHTML = `
      <h3 style="margin:0 0 12px 0;color:var(--text-primary,#fff);font-size:17px;">${escapeHtml(title)}</h3>
      <p style="margin:0 0 20px 0;color:var(--text-secondary,#ccc);font-size:14px;line-height:1.5;">${msgHtml}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;"></div>`;
    const row = dialog.querySelector("div:last-child");
    const cancel = document.createElement("button");
    cancel.textContent = cancelLabel;
    cancel.type = "button";
    cancel.style.cssText =
      "background:transparent;color:var(--text-secondary,#aaa);border:1px solid var(--border,#555);padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;";
    const ok = document.createElement("button");
    ok.textContent = confirmLabel;
    ok.type = "button";
    ok.style.cssText =
      "background:var(--primary,#2563eb);color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;";
    const done = (v) => {
      overlay.remove();
      resolve(v);
    };
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    row.appendChild(cancel);
    row.appendChild(ok);
    overlay.appendChild(dialog);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(false);
    });
    document.body.appendChild(overlay);
  });
}

function hardRefresh() {
  window.location.replace(window.location.pathname);
}

/**
 * Mode A: show indicator; user clicks → modal → reload.
 * @param {{ versionUrl: string, intervalMs: number, indicatorId: string, showModal: () => Promise<boolean> }} options
 */
export function createIndicatorClickVersionCheck(options) {
  const { versionUrl, intervalMs, indicatorId, showModal } = options;
  let currentVersion = null;
  let pendingUpdateVersion = null;
  let indicatorWired = false;

  async function checkVersion() {
    try {
      const response = await fetch(versionUrl, { cache: "no-store" });
      const data = await response.json();
      if (currentVersion === null) {
        currentVersion = data.version;
      } else if (data.version !== currentVersion) {
        pendingUpdateVersion = data.version;
        const btn = document.getElementById(indicatorId);
        if (!btn) return;
        btn.classList.remove("hidden");
        if (indicatorWired) return;
        indicatorWired = true;
        btn.addEventListener("click", async () => {
          const confirmed = await showModal();
          if (confirmed) hardRefresh();
        });
      }
    } catch {
      /* server may be updating */
    }
  }

  function hasPendingUpdate() {
    return pendingUpdateVersion !== null;
  }

  function initVersionCheck() {
    checkVersion();
    setInterval(checkVersion, intervalMs);
  }

  return { checkVersion, initVersionCheck, hasPendingUpdate };
}

/**
 * Mode B (reviewer): auto modal or queue when council runs.
 * @param {{ versionUrl: string, intervalMs: number, shouldDefer: () => boolean, onQueued: () => void, showOverlay: () => void }} options
 */
export function createReviewerAutoModalVersionCheck(options) {
  const { versionUrl, intervalMs, shouldDefer, onQueued, showOverlay } = options;
  let currentVersion = null;
  let updatePending = false;

  function tryShowUpdateModal() {
    if (!updatePending) return;
    if (shouldDefer()) {
      onQueued();
      return;
    }
    showOverlay();
  }

  async function checkVersion() {
    try {
      const res = await fetch(versionUrl, { cache: "no-store" });
      const data = await res.json();
      if (currentVersion === null) {
        currentVersion = data.version;
      } else if (data.version !== currentVersion && !updatePending) {
        updatePending = true;
        tryShowUpdateModal();
      }
    } catch {
      /* server may be restarting */
    }
  }

  function onCouncilComplete() {
    if (updatePending) showOverlay();
  }

  function initVersionCheck() {
    checkVersion();
    setInterval(checkVersion, intervalMs);
  }

  return { checkVersion, initVersionCheck, onCouncilComplete };
}
