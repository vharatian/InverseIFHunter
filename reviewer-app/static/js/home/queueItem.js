/** Single queue-item card markup. */
import { escapeHtml } from "../task.js";
import { homeState } from "./state.js";
import { formatRelative } from "./format.js";
import { bucketFor } from "./stats.js";

const BUCKET_LABELS = {
  in_queue: "In queue",
  in_progress: "In progress",
  completed: "Completed",
};

export function renderQueueItem(it) {
  const sid = escapeHtml(it.session_id || "");
  const taskId = escapeHtml(it.task_display_id || it.task_id || "—");
  const rawColabUrl = (it.colab_url || "").trim();
  const colabUrl = escapeHtml(rawColabUrl);
  // Prefer explicit trainer_name from the trainer-app registration form.
  // Fall back to the full trainer email (not just the local-part — trainers
  // whose emails start with e.g. "abc@…" were all appearing as "abc").
  // Only as a last resort show "unknown trainer".
  const trainerName = (it.trainer_name || "").trim();
  const trainerEmail = (it.trainer_email || "").trim();
  const trainerDisplay = escapeHtml(trainerName || trainerEmail || "unknown trainer");
  const trainerTooltip = escapeHtml(
    trainerName && trainerEmail ? `${trainerName} <${trainerEmail}>` : (trainerEmail || trainerName || "unknown trainer")
  );
  const domain = escapeHtml(it.domain || "");
  const rawStatus = String(it.review_status || "submitted").toLowerCase();
  const bucket = bucketFor(rawStatus) || "in_queue";
  const statusLabel = BUCKET_LABELS[bucket] || "In queue";
  const status = bucket;
  const when = escapeHtml(formatRelative(it.submitted_at));
  const preview = escapeHtml((it.prompt_preview || "").slice(0, 180));
  // Badge: first 3 chars of the taskId as before (a stable visual anchor that
  // doesn't change when the title switches to a URL).
  const badge = (taskId.slice(0, 3) || "T").toUpperCase();
  const ariaLabel = rawColabUrl
    ? `Open task ${rawColabUrl}`
    : `Open task ${taskId}`;

  // Title line: prefer the Colab URL (full, as requested) so reviewers can
  // see exactly which notebook they're about to open. Sessions without a
  // Colab link fall back to the previous Task ID label.
  const titleMain = rawColabUrl
    ? `<span class="queue-item-colab-url" title="${colabUrl}">${colabUrl}</span>`
    : `<span class="queue-item-taskid">${escapeHtml(homeState.displayIdLabel)}: ${taskId}</span>`;

  return `
    <button type="button" class="queue-item" data-session-id="${sid}" aria-label="${escapeHtml(ariaLabel)}">
      <span class="queue-item-badge" data-status="${escapeHtml(status)}">${badge}</span>
      <span class="queue-item-body">
        <span class="queue-item-title">
          ${titleMain}
          <span class="queue-item-sid">${sid}</span>
        </span>
        <span class="queue-item-meta">
          <span class="queue-meta-trainer" title="${trainerTooltip}">
            ${_iconUser()} ${trainerDisplay}
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
