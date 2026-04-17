/** Public entrypoint for the reviewer home page. */
import { homeState } from "./state.js";
import { renderHero } from "./hero.js";
import { refreshQueue, renderList } from "./queueList.js";
import { fetchAuthSession, fetchTaskIdentityConfig } from "./api.js";

const POLL_MS = 30_000;

export { setOpenSessionHandler, setDisplayIdLabel } from "./state.js";
export { refreshQueue } from "./queueList.js";

export function showHome() {
  const home = document.getElementById("home-panel");
  const task = document.getElementById("task-panel");
  if (home) home.hidden = false;
  if (task) task.hidden = true;
  refreshQueue();
}

export function hideHome() {
  const home = document.getElementById("home-panel");
  if (home) home.hidden = true;
}

export async function hydrateIdentity() {
  const data = await fetchAuthSession();
  homeState.role = data.role || "reviewer";
  homeState.podId = data.pod_id || null;
  homeState.assignedTrainers = Array.isArray(data.assigned_trainers) ? data.assigned_trainers : [];
  renderHero();
  return data;
}

export async function hydrateTaskIdentity() {
  try {
    const cfg = await fetchTaskIdentityConfig();
    if (cfg && cfg.display_id_label) homeState.displayIdLabel = cfg.display_id_label;
  } catch {
    /* ignored — fallback label already in state */
  }
}

export function initHome({ onBackToHome } = {}) {
  _wireRefresh();
  _wireFilter();
  _wireTabs();
  _wireBackButton(onBackToHome);
  _startPolling();
}

function _wireRefresh() {
  document.getElementById("home-queue-refresh")?.addEventListener("click", () => refreshQueue());
}

function _wireFilter() {
  const input = document.getElementById("home-queue-filter");
  input?.addEventListener("input", (e) => {
    homeState.filter = e.target.value || "";
    renderList();
  });
}

function _wireTabs() {
  document.querySelectorAll(".home-queue-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const bucket = tab.getAttribute("data-bucket") || "in_queue";
      homeState.activeBucket = bucket;
      document.querySelectorAll(".home-queue-tab").forEach((t) => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      renderList();
    });
  });
}

function _wireBackButton(onBackToHome) {
  document.getElementById("btn-back-home")?.addEventListener("click", () => {
    if (typeof onBackToHome === "function") onBackToHome();
    showHome();
  });
}

function _startPolling() {
  if (homeState.pollTimer) clearInterval(homeState.pollTimer);
  homeState.pollTimer = setInterval(() => {
    const home = document.getElementById("home-panel");
    if (home && !home.hidden && !homeState.loading) refreshQueue();
  }, POLL_MS);
}
