/** Top-right stat tiles + per-tab counts, bucketed into: in_queue / in_progress / completed. */
import { homeState } from "./state.js";

/**
 * Map raw review_status -> UI bucket.
 *   - submitted              -> in_queue
 *   - in_progress            -> in_progress
 *   - completed, approved    -> completed
 *   - anything else          -> null (hidden)
 */
export function bucketFor(status) {
  const s = (status || "").toLowerCase();
  if (s === "submitted") return "in_queue";
  if (s === "in_progress") return "in_progress";
  if (s === "completed" || s === "approved") return "completed";
  return null;
}

export function bucketCounts() {
  const c = homeState.counts || {};
  const in_queue = c.submitted || 0;
  const in_progress = c.in_progress || 0;
  const completed = (c.completed || 0) + (c.approved || 0);
  return { in_queue, in_progress, completed };
}

export function renderCounts() {
  const b = bucketCounts();

  _setText("stat-in-queue", b.in_queue);
  _setText("stat-in-progress", b.in_progress);
  _setText("stat-completed", b.completed);

  document.querySelectorAll("[data-count-for]").forEach((el) => {
    const key = el.getAttribute("data-count-for");
    el.textContent = String(b[key] || 0);
  });
}

function _setText(id, n) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(n || 0);
}
