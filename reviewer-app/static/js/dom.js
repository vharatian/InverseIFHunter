/**
 * DOM helpers: show/hide views, toast notifications, modals.
 */

/**
 * @param {string | HTMLElement} el
 * @param {boolean} visible
 */
export function show(el, visible) {
  if (typeof el === "string") el = document.getElementById(el);
  if (!el) return;
  el.hidden = !visible;
}

export function showGate(visible) {
  show("gate", visible);
  show("main", !visible);
}

export function showQueue(visible) {
  const qv = document.getElementById("queue-view");
  const tv = document.getElementById("task-view");
  const arrows = document.getElementById("task-nav-arrows");
  const hint = document.getElementById("keyboard-hint");
  if (qv) {
    qv.hidden = !visible;
    if (visible) qv.classList.add("view-enter");
  }
  if (tv) tv.hidden = visible;
  if (arrows) arrows.hidden = visible;
  if (hint) hint.hidden = visible;
}

export function showTask(visible) {
  const qv = document.getElementById("queue-view");
  const tv = document.getElementById("task-view");
  const arrows = document.getElementById("task-nav-arrows");
  const hint = document.getElementById("keyboard-hint");
  if (qv) qv.hidden = visible;
  if (tv) {
    tv.hidden = !visible;
    if (visible) {
      tv.classList.add("view-enter");
      tv.scrollTop = 0;
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  if (arrows) arrows.hidden = !visible;
  if (hint) hint.hidden = !visible;
}

let _reviewerToastTimer = null;

/**
 * Show a toast notification (single reused element).
 * @param {string} message
 * @param {"success"|"error"|"info"} [type="info"]
 * @param {number} [durationMs=3000]
 */
export function showToast(message, type = "info", durationMs = 3000) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  clearTimeout(_reviewerToastTimer);

  let toast = document.getElementById("reviewer-toast-singleton");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "reviewer-toast-singleton";
    container.appendChild(toast);
  }

  const icons = { success: "\u2713", error: "\u2717", info: "\u2139" };
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg">${_escapeHtml(message)}</span>`;
  toast.hidden = false;
  toast.classList.remove("toast-exit");

  requestAnimationFrame(() => {
    toast.classList.add("toast-visible");
  });

  _reviewerToastTimer = setTimeout(() => {
    toast.classList.remove("toast-visible");
    toast.classList.add("toast-exit");
    const finish = () => {
      toast.removeEventListener("transitionend", finish);
      toast.hidden = true;
      toast.classList.remove("toast-exit");
    };
    toast.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 400);
  }, durationMs);
}

/**
 * Show a modal with custom content.
 * @param {string} title
 * @param {string} htmlContent
 */
export function showModal(title, htmlContent) {
  const overlay = document.getElementById("modal-overlay");
  const titleEl = document.getElementById("modal-title");
  const bodyEl = document.getElementById("modal-body");
  if (!overlay || !titleEl || !bodyEl) return;
  titleEl.textContent = title;
  bodyEl.innerHTML = htmlContent;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("modal-visible"));
}

export function hideModal() {
  const overlay = document.getElementById("modal-overlay");
  if (!overlay) return;
  overlay.classList.remove("modal-visible");
  setTimeout(() => { overlay.hidden = true; }, 200);
}

function _escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

(function _initModal() {
  document.getElementById("modal-close")?.addEventListener("click", hideModal);
  document.getElementById("modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) hideModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const overlay = document.getElementById("modal-overlay");
      if (overlay && !overlay.hidden) { hideModal(); e.stopPropagation(); }
    }
  });
})();
