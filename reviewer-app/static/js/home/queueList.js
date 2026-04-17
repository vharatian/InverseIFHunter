/** Queue list: filtering, rendering, click-to-open, and refresh/loading state. */
import { escapeHtml } from "../task.js";
import { homeState } from "./state.js";
import { renderQueueItem } from "./queueItem.js";
import { renderCounts, bucketFor } from "./stats.js";
import { fetchQueueSummaries } from "./api.js";

const LIST_ID = "home-queue-list";
const REFRESH_ID = "home-queue-refresh";

export async function refreshQueue() {
  const list = document.getElementById(LIST_ID);
  if (!list) return;
  _setLoading(true);
  try {
    const data = await fetchQueueSummaries();
    homeState.items = Array.isArray(data.summaries) ? data.summaries : [];
    homeState.counts = data.counts_by_status || {};
    renderCounts();
    renderList();
  } catch (e) {
    list.innerHTML = `<div class="home-queue-error">Could not load queue: ${escapeHtml(e.message || "unknown error")}</div>`;
  } finally {
    _setLoading(false);
  }
}

export function renderList() {
  const list = document.getElementById(LIST_ID);
  if (!list) return;
  const items = _filteredItems();

  if (!items.length) {
    list.innerHTML = _emptyStateHtml();
    return;
  }

  list.innerHTML = items.map(renderQueueItem).join("");
  list.querySelectorAll(".queue-item").forEach((node) => {
    node.addEventListener("click", () => _openBySid(node.dataset.sessionId));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        node.click();
      }
    });
  });
}

function _filteredItems() {
  const q = (homeState.filter || "").trim().toLowerCase();
  const bucket = homeState.activeBucket;
  return homeState.items.filter((it) => _matchesBucket(it, bucket) && _matchesQuery(it, q));
}

function _matchesBucket(it, bucket) {
  if (!bucket) return true;
  return bucketFor(it.review_status) === bucket;
}

function _matchesQuery(it, q) {
  if (!q) return true;
  const hay = [it.task_display_id, it.session_id, it.trainer_email, it.domain, it.prompt_preview]
    .map((x) => String(x || "").toLowerCase())
    .join(" ");
  return hay.includes(q);
}

function _openBySid(sid) {
  if (!sid || typeof homeState.onOpenSession !== "function") return;
  const item = homeState.items.find((x) => x.session_id === sid);
  if (item) homeState.onOpenSession(item);
}

function _emptyStateHtml() {
  const bucket = homeState.activeBucket;
  const isFiltered = !!homeState.filter || bucket !== "in_queue";
  const defaultsByBucket = {
    in_queue: {
      title: "You're all caught up",
      body: "Nothing pending for you right now. Check back soon, or paste a notebook link on the right to review ad-hoc.",
    },
    in_progress: {
      title: "No tasks in progress",
      body: "Open a task from 'In queue' to start reviewing. It'll show up here while you work on it.",
    },
    completed: {
      title: "Nothing completed yet",
      body: "Finish a QC run on an in-progress task and it'll land here.",
    },
  };
  const d = defaultsByBucket[bucket] || defaultsByBucket.in_queue;
  const title = homeState.filter ? "No tasks match these filters" : d.title;
  const body = homeState.filter ? "Try another tab or clear the filter." : d.body;
  // Unused guard retained for parity with previous UX.
  void isFiltered;
  return `
    <div class="home-queue-empty">
      <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      <span class="home-queue-empty-title">${title}</span>
      ${body}
    </div>`;
}

function _setLoading(loading) {
  homeState.loading = loading;
  const list = document.getElementById(LIST_ID);
  if (list) list.setAttribute("aria-busy", loading ? "true" : "false");
  const refresh = document.getElementById(REFRESH_ID);
  if (refresh) refresh.classList.toggle("spinning", loading);
}
