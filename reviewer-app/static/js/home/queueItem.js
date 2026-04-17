/** Single queue-item card markup. */
import { escapeHtml } from "../task.js";
import { homeState } from "./state.js";
import { formatRelative } from "./format.js";

export function renderQueueItem(it) {
  const sid = escapeHtml(it.session_id || "");
  const taskId = escapeHtml(it.task_display_id || it.task_id || "—");
  const trainer = escapeHtml(it.trainer_email || "unknown trainer");
  const domain = escapeHtml(it.domain || "");
  const status = String(it.review_status || "submitted").toLowerCase();
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  const when = escapeHtml(formatRelative(it.submitted_at));
  const preview = escapeHtml((it.prompt_preview || "").slice(0, 180));
  const trainerShort = trainer.split("@")[0] || trainer;
  const badge = (taskId.slice(0, 3) || "T").toUpperCase();

  return `
    <button type="button" class="queue-item" data-session-id="${sid}" aria-label="Open task ${taskId}">
      <span class="queue-item-badge" data-status="${escapeHtml(status)}">${badge}</span>
      <span class="queue-item-body">
        <span class="queue-item-title">
          <span class="queue-item-taskid">${escapeHtml(homeState.displayIdLabel)}: ${taskId}</span>
          <span class="queue-item-sid">${sid}</span>
        </span>
        <span class="queue-item-meta">
          <span class="queue-meta-trainer" title="${trainer}">
            ${_iconUser()} ${escapeHtml(trainerShort)}
          </span>
          ${domain ? `<span>${_iconTag()} ${domain}</span>` : ""}
          ${when ? `<span>${_iconClock()} ${when}</span>` : ""}
        </span>
        ${preview ? `<span class="queue-item-preview">${preview}</span>` : ""}
      </span>
      <span class="queue-item-right">
        <span class="queue-status-pill" data-status="${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
        ${_iconArrow()}
      </span>
    </button>
  `;
}

const _iconUser = () =>
  `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

const _iconTag = () =>
  `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;

const _iconClock = () =>
  `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

const _iconArrow = () =>
  `<svg class="queue-item-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
