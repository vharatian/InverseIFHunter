/**
 * Queue view: load and render task list with at-a-glance summaries, progress, status tabs, and search.
 */
import { api } from "./api.js";
import { show, showQueue, showTask } from "./dom.js";

/** @type {(sessionId: string) => void} */
let onSelectTask = () => {};
let currentStatusFilter = "";
let searchDebounceTimer = null;

// Pagination state
let _currentPage = 1;
let _totalCount = 0;
const PER_PAGE = 50;

export function setOnSelectTask(fn) {
  onSelectTask = fn;
}

/**
 * @param {boolean} withSummaries
 * @param {string} [statusFilter]
 * @param {boolean} [append] - If true, append to existing list (load more)
 */
export async function loadQueue(withSummaries = true, statusFilter, append = false) {
  if (statusFilter !== undefined) {
    currentStatusFilter = statusFilter;
    _currentPage = 1;
  }
  if (!append) _currentPage = 1;

  const countEl = document.getElementById("queue-count");
  const listEl = document.getElementById("queue-list");
  const errEl = document.getElementById("queue-error");
  const searchEl = document.getElementById("queue-search");
  if (errEl) errEl.hidden = true;
  if (!append) {
    if (countEl) {
      countEl.textContent = "Loading\u2026";
      countEl.classList.add("loading-placeholder");
    }
    if (listEl) {
      listEl.setAttribute("aria-busy", "true");
      listEl.innerHTML = _renderSkeletons(5);
    }
    _removePaginationControls();
  }

  _updateActiveTab(currentStatusFilter);

  try {
    let path = `/api/queue?summaries=1&page=${_currentPage}&per_page=${PER_PAGE}`;
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
    const countsByStatus = data.counts_by_status || null;
    _totalCount = data.total_count != null ? data.total_count : rawSessions.length;

    const seen = new Set();
    // Collect already-rendered IDs when appending to deduplicate
    if (append && listEl) {
      listEl.querySelectorAll("li[data-session-id]").forEach((li) => seen.add(li.dataset.sessionId));
    }
    const sessions = rawSessions.filter((sid) => {
      if (seen.has(sid)) return false;
      seen.add(sid);
      return true;
    });

      const existingCount = append && listEl ? listEl.querySelectorAll("li").length : 0;
      const total = _totalCount;

      if (!append) {
        if (countEl) {
          countEl.classList.remove("loading-placeholder");
          countEl.textContent = total === 0 ? "" : `${total} task${total !== 1 ? "s" : ""}`;
        }
        // Clear skeleton
        if (listEl) listEl.innerHTML = "";
        if (total === 0) {
          _renderEmptyState(listEl, currentStatusFilter);
        }
      } else if (countEl) {
        countEl.classList.remove("loading-placeholder");
        countEl.textContent = total === 0 ? "" : `${total} task${total !== 1 ? "s" : ""}`;
      }

    if (countsByStatus) {
      document.querySelectorAll(".queue-tab").forEach((tab) => {
        const status = tab.dataset.status || "";
        const key = status === "" ? "submitted" : status;
        const n = countsByStatus[key] != null ? countsByStatus[key] : 0;
        const countSpan = tab.querySelector(".tab-count");
        if (countSpan) countSpan.textContent = String(n);
      });
      // Update "reviewed today" progress
      const approved = countsByStatus["approved"] || 0;
      const returned = countsByStatus["returned"] || 0;
      const escalated = countsByStatus["escalated"] || 0;
      const reviewed = approved + returned + escalated;
      const totalAll = reviewed + (countsByStatus["submitted"] || 0);
      const reviewedTodayEl = document.getElementById("queue-reviewed-today");
      const progressBarEl = document.getElementById("queue-progress-bar");
      const progressFillEl = document.getElementById("queue-progress-fill");
      if (reviewedTodayEl && reviewed > 0) {
        reviewedTodayEl.textContent = `${reviewed} reviewed`;
        reviewedTodayEl.hidden = false;
      } else if (reviewedTodayEl) {
        reviewedTodayEl.hidden = true;
      }
      if (progressBarEl && progressFillEl && totalAll > 0) {
        const pct = Math.round((reviewed / totalAll) * 100);
        progressFillEl.style.width = `${pct}%`;
        progressBarEl.hidden = false;
        progressBarEl.title = `${reviewed} of ${totalAll} reviewed (${pct}%)`;
      } else if (progressBarEl) {
        progressBarEl.hidden = true;
      }
    }

    sessions.forEach((sid, index) => {
      const summary = summaries.find((s) => s.session_id === sid) || {};
      const li = document.createElement("li");
      li.className = "queue-item";
      li.dataset.sessionId = sid;
      li.setAttribute("role", "button");
      li.tabIndex = 0;
      li.style.animationDelay = `${(existingCount + index) * 0.03}s`;

        const taskDisplayId = summary.task_display_id || "";
        const preview = (summary.prompt_preview || "").slice(0, 80);
        const slots = summary.slots_graded != null ? `${summary.slots_graded}/4` : "";
        const allPass = summary.all_pass === true;
        const allFail = summary.all_pass === false && slots === "4/4";
        const reviewStatus = summary.review_status || "";
        const statusBadge = reviewStatus
          ? `<span class="queue-item-status status-${reviewStatus}">${reviewStatus}</span>`
          : "";
        const trainerEmail = summary.trainer_email || "";
        const trainerDisplay = trainerEmail ? trainerEmail.split("@")[0] : "";
        const domain = summary.domain || "";
        const submittedAt = summary.submitted_at || "";
        const timeDisplay = submittedAt ? _formatRelativeTime(submittedAt) : "";

        const passIcon = allPass ? '<span class="queue-pass-icon" title="All pass">\u2713</span>'
                       : allFail ? '<span class="queue-fail-icon" title="Has failures">\u2717</span>'
                       : "";

        const idDisplay = taskDisplayId
          ? `<span class="queue-item-task-id" title="Task ID">${escapeHtml(taskDisplayId)}</span><span class="queue-item-sess-id">${escapeHtml(sid)}</span>`
          : `<span class="queue-item-id">${escapeHtml(sid)}</span>`;

        const metaChips = [
          trainerDisplay ? `<span class="queue-item-chip chip-trainer" title="${escapeHtml(trainerEmail)}">\u{1F464} ${escapeHtml(trainerDisplay)}</span>` : "",
          domain ? `<span class="queue-item-chip chip-domain">${escapeHtml(domain)}</span>` : "",
          timeDisplay ? `<span class="queue-item-chip chip-time" title="${escapeHtml(submittedAt)}">${escapeHtml(timeDisplay)}</span>` : "",
        ].filter(Boolean).join("");

        const itemIndex = existingCount + index;
        li.innerHTML = [
          `<div class="queue-item-top">`,
          `  ${idDisplay}`,
          `  <span class="queue-item-meta">${statusBadge}${passIcon}</span>`,
          `</div>`,
          preview ? `<div class="queue-item-preview">${escapeHtml(preview)}${preview.length >= 80 ? "\u2026" : ""}</div>` : "",
          `<div class="queue-item-bottom">`,
          metaChips ? `<span class="queue-item-chips">${metaChips}</span>` : "",
          slots ? `<span class="queue-item-slots">${slots} graded</span>` : "",
          `<span class="queue-item-index">${itemIndex + 1} of ${total}</span>`,
          `</div>`,
        ].filter(Boolean).join("");

      li.addEventListener("click", () => onSelectTask(sid));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectTask(sid); }
      });
      if (listEl) listEl.appendChild(li);
    });

    if (listEl) listEl.setAttribute("aria-busy", "false");

    // Show "Load more" if there are more pages
    const renderedCount = (append ? existingCount : 0) + sessions.length;
    if (renderedCount < total) {
      _renderLoadMoreButton();
    } else {
      _removePaginationControls();
    }

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

function _renderLoadMoreButton() {
  _removePaginationControls();
  const listEl = document.getElementById("queue-list");
  if (!listEl) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "queue-load-more";
  btn.className = "btn-queue-load-more";
  btn.textContent = "Load more\u2026";
  btn.addEventListener("click", () => {
    _currentPage += 1;
    btn.disabled = true;
    btn.textContent = "Loading\u2026";
    loadQueue(true, undefined, true);
  });
  listEl.insertAdjacentElement("afterend", btn);
}

function _removePaginationControls() {
  document.getElementById("queue-load-more")?.remove();
}

function _renderSkeletons(count) {
  return Array.from({ length: count }, () =>
    `<li class="queue-item queue-skeleton" aria-hidden="true">
      <div class="queue-item-top">
        <div class="skel skel-id"></div>
        <div class="skel skel-badge"></div>
      </div>
      <div class="skel skel-preview"></div>
      <div class="queue-item-bottom">
        <div class="skel skel-chips"></div>
        <div class="skel skel-index"></div>
      </div>
    </li>`
  ).join("");
}

const EMPTY_STATE_ICONS = {
  "": `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="8" y="12" width="48" height="40" rx="6" stroke="currentColor" stroke-width="2" fill="none"/><path d="M20 24h24M20 32h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="44" cy="44" r="10" fill="var(--bg-tertiary)" stroke="currentColor" stroke-width="2"/><path d="M41 44h6M44 41v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  "approved": `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="22" stroke="var(--success)" stroke-width="2" fill="none"/><path d="M22 32l8 8 12-14" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  "returned": `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="22" stroke="var(--warning)" stroke-width="2" fill="none"/><path d="M38 22l-12 10 12 10" stroke="var(--warning)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  "escalated": `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path d="M32 12l4 16h16l-13 9.5 5 16L32 43l-12 10.5 5-16L12 28h16z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>`,
};

const EMPTY_STATE_MESSAGES = {
  "": { title: "Queue is clear", sub: "No tasks pending review right now. Check back soon." },
  "approved": { title: "No approved tasks", sub: "Tasks you approve will appear here." },
  "returned": { title: "No returned tasks", sub: "Tasks returned for revision will appear here." },
  "escalated": { title: "No escalated tasks", sub: "Escalated tasks will appear here." },
};

function _renderEmptyState(listEl, statusFilter) {
  if (!listEl) return;
  const icon = EMPTY_STATE_ICONS[statusFilter] || EMPTY_STATE_ICONS[""];
  const msg = EMPTY_STATE_MESSAGES[statusFilter] || EMPTY_STATE_MESSAGES[""];
  listEl.innerHTML = `<li class="queue-empty-state" aria-live="polite">
    <div class="empty-state-icon">${icon}</div>
    <div class="empty-state-title">${escapeHtml(msg.title)}</div>
    <div class="empty-state-sub">${escapeHtml(msg.sub)}</div>
  </li>`;
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

function _formatRelativeTime(isoOrTs) {
  if (!isoOrTs) return "";
  const d = new Date(isoOrTs);
  if (isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}d ago`;
}
