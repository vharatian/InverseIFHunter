/**
 * Queue view: load and render task list with at-a-glance summaries, progress, status tabs, and search.
 */
import { api } from "./api.js";
import { show, showQueue, showTask } from "./dom.js";

/** @type {(sessionId: string) => void} */
let onSelectTask = () => {};
let currentStatusFilter = "";
let searchDebounceTimer = null;

export function setOnSelectTask(fn) {
  onSelectTask = fn;
}

/**
 * @param {boolean} withSummaries
 * @param {string} [statusFilter]
 */
export async function loadQueue(withSummaries = true, statusFilter) {
  if (statusFilter !== undefined) currentStatusFilter = statusFilter;
  const countEl = document.getElementById("queue-count");
  const listEl = document.getElementById("queue-list");
  const errEl = document.getElementById("queue-error");
  const searchEl = document.getElementById("queue-search");
  if (errEl) errEl.hidden = true;
  if (countEl) {
    countEl.textContent = "Loading\u2026";
    countEl.classList.add("loading-placeholder");
  }
  if (listEl) {
    listEl.setAttribute("aria-busy", "true");
    listEl.innerHTML = "";
  }

  _updateActiveTab(currentStatusFilter);

  try {
    let path = "/api/queue?summaries=1";
    if (currentStatusFilter) {
      path += `&status=${encodeURIComponent(currentStatusFilter)}`;
    }
    const searchQuery = searchEl ? searchEl.value.trim() : "";
    if (searchQuery) {
      path += `&q=${encodeURIComponent(searchQuery)}`;
    }
    const data = await api(path);
    const rawSessions = data.sessions || [];
    const summaries = data.summaries || [];
    const seen = new Set();
    const sessions = rawSessions.filter((sid) => {
      if (seen.has(sid)) return false;
      seen.add(sid);
      return true;
    });
    const total = sessions.length;
    if (countEl) {
      countEl.classList.remove("loading-placeholder");
      countEl.textContent = total === 0 ? "No tasks." : `${total} task(s)`;
    }
    sessions.forEach((sid, index) => {
      const summary = summaries.find((s) => s.session_id === sid) || {};
      const li = document.createElement("li");
      li.className = "queue-item";
      li.dataset.sessionId = sid;
      li.setAttribute("role", "button");
      li.tabIndex = 0;
      li.style.animationDelay = `${index * 0.03}s`;

      const taskDisplayId = summary.task_display_id || "";
      const preview = (summary.prompt_preview || "").slice(0, 80);
      const slots = summary.slots_graded != null ? `${summary.slots_graded}/4` : "";
      const allPass = summary.all_pass === true;
      const allFail = summary.all_pass === false && slots === "4/4";
      const reviewStatus = summary.review_status || "";
      const statusBadge = reviewStatus
        ? `<span class="queue-item-status status-${reviewStatus}">${reviewStatus}</span>`
        : "";

      const passIcon = allPass ? '<span class="queue-pass-icon" title="All pass">\u2713</span>'
                     : allFail ? '<span class="queue-fail-icon" title="Has failures">\u2717</span>'
                     : "";

      const idDisplay = taskDisplayId
        ? `<span class="queue-item-task-id" title="Task ID">${escapeHtml(taskDisplayId)}</span><span class="queue-item-sess-id">${escapeHtml(sid)}</span>`
        : `<span class="queue-item-id">${escapeHtml(sid)}</span>`;

      li.innerHTML = [
        `<div class="queue-item-top">`,
        `  ${idDisplay}`,
        `  <span class="queue-item-meta">${statusBadge}${passIcon}</span>`,
        `</div>`,
        preview ? `<div class="queue-item-preview">${escapeHtml(preview)}${preview.length >= 80 ? "\u2026" : ""}</div>` : "",
        `<div class="queue-item-bottom">`,
        slots ? `<span class="queue-item-slots">${slots} graded</span>` : "",
        `<span class="queue-item-index">${index + 1} of ${total}</span>`,
        `</div>`,
      ].filter(Boolean).join("");

      li.addEventListener("click", () => onSelectTask(sid));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectTask(sid); }
      });
      if (listEl) listEl.appendChild(li);
    });
    if (listEl) listEl.setAttribute("aria-busy", "false");
    showQueue(true);
    showTask(false);
  } catch (e) {
    if (countEl) {
      countEl.classList.remove("loading-placeholder");
      countEl.textContent = "Could not load queue.";
    }
    if (errEl) {
      errEl.textContent = e.message || "Network error.";
      errEl.hidden = false;
    }
    if (listEl) listEl.setAttribute("aria-busy", "false");
  }
}

export function initQueueTabs() {
  document.querySelectorAll(".queue-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const status = tab.dataset.status || "";
      loadQueue(true, status);
    });
  });
}

export function initQueueSearch() {
  const searchEl = document.getElementById("queue-search");
  if (!searchEl) return;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => loadQueue(true), 300);
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchEl.value = "";
      loadQueue(true);
    }
  });
}

function _updateActiveTab(status) {
  document.querySelectorAll(".queue-tab").forEach((tab) => {
    const tabStatus = tab.dataset.status || "";
    tab.classList.toggle("active", tabStatus === status);
  });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
