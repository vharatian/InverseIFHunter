/** Top-right stat tiles + per-tab counts. */
import { homeState } from "./state.js";

export function renderCounts() {
  const c = homeState.counts || {};
  const escalated = c.escalated || c.rejected || 0;

  _setText("stat-submitted", c.submitted || 0);
  _setText("stat-returned", c.returned || 0);
  _setText("stat-approved", c.approved || 0);
  _setText("stat-escalated", escalated);

  document.querySelectorAll("[data-count-for]").forEach((el) => {
    const key = el.getAttribute("data-count-for");
    el.textContent = String(key === "escalated" ? escalated : (c[key] || 0));
  });
}

function _setText(id, n) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(n || 0);
}
