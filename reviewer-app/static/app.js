/**
 * Reviewer app entry: gate, queue, task, feedback, agent, edit, keyboard, toasts.
 */
import { getEmail, setEmail, api, initVersionCheck } from "./js/api.js";
import { show, showGate, showQueue, showTask, showToast, showModal, hideModal } from "./js/dom.js";
import { loadQueue, setOnSelectTask, initQueueTabs, initQueueSearch, initBatchApprove, startQueueRefresh, stopQueueRefresh } from "./js/queue.js";
import { loadTask, renderTaskContent, renderAgentResult, renderAgentSummaryAtTop, escapeHtml, FEEDBACK_ENABLED } from "./js/task.js";
import { renderFeedbackForm, collectFeedback, showReturnNudgeIfNeeded } from "./js/feedback.js";
import { setKeyboardHandlers, initKeyboard } from "./js/keyboard.js";
import { initNotifications } from "./js/notifications.js";
import { initCouncil, resetCouncil, autoRunCouncil, getCouncilState } from "./js/council.js";

const DEEP_REVIEW_ENABLED = false; // PAUSED: re-enable when ready

let currentSessionId = null;
let currentTask = null;
let queueSessionIds = [];
let currentTaskDisplayId = "";
let _isLoadingTask = false;
let _taskOpenedAt = 0;

function updateBreadcrumb(sessionId, index, total, taskDisplayId) {
  const breadcrumb = document.getElementById("breadcrumb");
  if (!breadcrumb) return;
  const displayLabel = taskDisplayId || sessionId;
  if (total > 0 && index >= 0) {
    breadcrumb.textContent = ` / ${displayLabel} (${index + 1} of ${total})`;
  } else {
    breadcrumb.textContent = " / " + (displayLabel || "");
  }
  _updateNavArrows(index, total);
}

function _updateNavArrows(index, total) {
  const prev = document.getElementById("btn-prev-task");
  const next = document.getElementById("btn-next-task");
  if (prev) prev.disabled = index <= 0;
  if (next) next.disabled = index < 0 || index >= total - 1;
}

function _navigateTask(delta) {
  if (_isLoadingTask) return;
  const idx = queueSessionIds.indexOf(currentSessionId);
  const newIdx = idx + delta;
  if (newIdx >= 0 && newIdx < queueSessionIds.length) {
    loadTaskAndShow(queueSessionIds[newIdx]);
  }
}

async function loadTaskAndShow(sessionId) {
  if (_isLoadingTask) return;
  _isLoadingTask = true;
  stopQueueRefresh();
  // Disable nav arrows while loading to prevent double-navigation
  const prevBtn = document.getElementById("btn-prev-task");
  const nextBtn = document.getElementById("btn-next-task");
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;

  currentSessionId = sessionId;
  const taskSessionIdEl = document.getElementById("task-session-id");
  const taskDisplayIdEl = document.getElementById("task-display-id");
  const taskDisplayIdLabelEl = document.getElementById("task-display-id-label");
  const taskErrorEl = document.getElementById("task-error");
  const taskContentEl = document.getElementById("task-content");
  const idx = queueSessionIds.indexOf(sessionId);
  const total = queueSessionIds.length;
  updateBreadcrumb(sessionId, idx, total);
  if (taskSessionIdEl) taskSessionIdEl.textContent = `Session: ${sessionId}`;
  if (taskDisplayIdEl) taskDisplayIdEl.textContent = "";
  if (taskErrorEl) taskErrorEl.hidden = true;
  if (taskContentEl) {
    taskContentEl.textContent = "Loading task\u2026";
    taskContentEl.classList.add("loading-placeholder");
    taskContentEl.setAttribute("aria-busy", "true");
  }

  _resetEditToggle();

  try {
    const result = await loadTask(sessionId);
    if (!result) throw new Error("No task");
    currentTask = result.task;
    currentTaskDisplayId = currentTask.task_display_id || "";
    const taskIdLabel = currentTask.task_id_label || "Task ID";

    if (taskDisplayIdEl) taskDisplayIdEl.textContent = currentTaskDisplayId || sessionId;
    if (taskDisplayIdLabelEl) taskDisplayIdLabelEl.textContent = taskIdLabel;
    if (taskSessionIdEl) {
      taskSessionIdEl.textContent = currentTaskDisplayId ? `Session: ${sessionId}` : "";
    }
    updateBreadcrumb(sessionId, idx, total, currentTaskDisplayId);

    if (taskContentEl) {
      taskContentEl.classList.remove("loading-placeholder");
      taskContentEl.setAttribute("aria-busy", "false");
      renderTaskContent(taskContentEl, currentTask.snapshot || {}, currentTask.feedback || {});
    }
    _renderRevisedBanner(currentTask);
    if (FEEDBACK_ENABLED) renderFeedbackForm(currentTask.feedback || {}, true);
    if (DEEP_REVIEW_ENABLED) {
      renderAgentResult(currentTask.agent_result);
      const agentSummaryEl = document.getElementById("agent-summary-at-top");
      renderAgentSummaryAtTop(agentSummaryEl, currentTask.agent_result);
    }
      document.getElementById("edit-reviews-json").textContent = JSON.stringify(
        currentTask.session?.human_reviews || {},
        null,
        2
      );
      _renderEditReviewFields(currentTask.session?.human_reviews || {});
    document.getElementById("feedback-status").textContent = "";
    document.getElementById("edit-status").textContent = "";
    document.getElementById("agent-status").textContent = "";
    if (FEEDBACK_ENABLED) wireScoreButtons();
    resetCouncil();
    _taskOpenedAt = Date.now();
    // Auto-populate notebook fetch URL from session data
    const nbUrl = currentTask.session?.notebook?.url
      || currentTask.session?.notebook?.metadata?.url
      || currentTask.session?.notebook?.source_url
      || "";
    const fetchInput = document.getElementById("notebook-fetch-url");
    if (fetchInput) fetchInput.value = nbUrl;
    _updateColabSection(currentTask.review_status || "");
    _updateActionButtons(currentTask.review_status || "");
    showTask(true);
  } catch (e) {
    if (taskContentEl) {
      taskContentEl.classList.remove("loading-placeholder");
      taskContentEl.textContent = "";
      taskContentEl.setAttribute("aria-busy", "false");
    }
    if (taskErrorEl) {
      taskErrorEl.textContent = e.message || "Could not load task.";
      taskErrorEl.hidden = false;
    }
    _updateActionButtons(null);
    showTask(true);
  } finally {
    _isLoadingTask = false;
    // Restore nav arrows based on current position
    const idx = queueSessionIds.indexOf(sessionId);
    _updateNavArrows(idx, queueSessionIds.length);
  }
}

function _syncQueueSessionIds() {
  const list = document.getElementById("queue-list");
  if (list) queueSessionIds = [...list.querySelectorAll("li")].map((li) => li.dataset.sessionId).filter(Boolean);
}

function _resetEditToggle() {
  const btn = document.getElementById("edit-toggle");
  if (btn) {
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("active");
  }
  show("edit-panel", false);
}

function wireScoreButtons() {
  const scoreRow = document.getElementById("feedback-score-row");
  if (!scoreRow) return;
  scoreRow.querySelectorAll(".btn-score").forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  scoreRow.querySelectorAll(".btn-score").forEach((btn) => {
    btn.addEventListener("click", () => {
      const alreadyActive = btn.classList.contains("active");
      scoreRow.querySelectorAll(".btn-score").forEach((b) => b.classList.remove("active"));
      // Toggle off if clicking the already-active button
      if (!alreadyActive) btn.classList.add("active");
    });
  });
}

function getFocusedQueueIndex() {
  const list = document.getElementById("queue-list");
  if (!list) return -1;
  const focused = list.querySelector("li:focus");
  if (!focused) return -1;
  const id = focused.dataset.sessionId;
  return queueSessionIds.indexOf(id);
}

function _renderRevisedBanner(task) {
  let banner = document.getElementById("revised-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "revised-banner";
    const taskContent = document.getElementById("task-content");
    if (taskContent) taskContent.parentNode.insertBefore(banner, taskContent);
  }
  const resubmittedAt = task.resubmitted_at;
  const historyCount = (task.feedback_history || []).length;
  if (resubmittedAt || historyCount > 0) {
    const ts = resubmittedAt ? new Date(resubmittedAt).toLocaleString() : "";
    const round = task.review_round || (historyCount + 1);

    const changeSummary = _buildChangeSummary(task);
    const lastReturnReason = _getLastReturnReason(task);

    let extraHtml = "";
    if (lastReturnReason) {
      extraHtml += `<div class="revised-return-reason"><span class="revised-label">Previous return reason:</span> ${escapeHtml(lastReturnReason)}</div>`;
    }
    if (changeSummary) {
      extraHtml += `<div class="revised-changes"><span class="revised-label">What changed:</span> ${escapeHtml(changeSummary)}</div>`;
    }

    banner.hidden = false;
    banner.className = "revised-banner";
    banner.innerHTML = `<div class="revised-banner-top"><span class="revised-icon">\u21BB</span><strong>Revised since last review</strong>${ts ? ` (resubmitted ${ts})` : ""} \u00b7 Review round ${round}${historyCount > 0 ? ` \u00b7 <button type="button" id="btn-show-prev-feedback" class="btn-link">View previous feedback</button>` : ""}</div>${extraHtml}`;
    const prevBtn = banner.querySelector("#btn-show-prev-feedback");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        const history = task.feedback_history || [];
        if (history.length === 0) {
          showToast("No previous feedback.", "info");
          return;
        }
        const html = history.map((fb, i) => {
          const overall = escapeHtml(fb.overall_comment || "(no comment)");
          return `<div class="history-round"><div class="history-round-header">Round ${historyCount - i}</div><div class="history-round-body">${overall}</div></div>`;
        }).join("");
        showModal("Previous Feedback", html);
      });
    }
  } else {
    banner.hidden = true;
  }
}

function _getLastReturnReason(task) {
  const history = task.feedback_history || [];
  if (history.length === 0) return "";
  const last = history[0];
  return (last.overall_comment || "").trim();
}

function _buildChangeSummary(task) {
  const prev = task.previous_round_snapshot;
  if (!prev || !prev.reviews) return "";
  const currentReviews = task.session?.human_reviews || {};
  const prevReviews = prev.reviews || {};
  const changes = [];
  for (const [huntId, current] of Object.entries(currentReviews)) {
    const old = prevReviews[huntId];
    if (!old) { changes.push(`Slot ${huntId}: new review added`); continue; }
    const curGrades = current.grades || current.grading_basis || {};
    const oldGrades = old.grades || old.grading_basis || {};
    for (const [cid, curVal] of Object.entries(curGrades)) {
      const oldVal = oldGrades[cid];
      if (oldVal && String(curVal).toLowerCase() !== String(oldVal).toLowerCase()) {
        changes.push(`${cid}: ${String(oldVal).toUpperCase()} -> ${String(curVal).toUpperCase()}`);
      }
    }
    const curExp = (current.explanation || "").trim();
    const oldExp = (old.explanation || "").trim();
    if (curExp !== oldExp && curExp) {
      changes.push(`Slot ${huntId}: explanation updated`);
    }
  }
  return changes.length > 0 ? changes.join(", ") : "";
}

// ----- Gate -----
document.getElementById("btn-continue").addEventListener("click", async () => {
  const input = document.getElementById("email-input");
  const errEl = document.getElementById("gate-error");
  const btn = document.getElementById("btn-continue");
  const email = (input.value || "").trim();
  if (!email) {
    errEl.textContent = "Enter your email.";
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  setEmail(email);
  try {
    await api("/api/queue");
    document.getElementById("reviewer-email").textContent = email;
    showGate(false);
    showToast("Signed in as " + email, "success");
    queueSessionIds = [];
    loadQueue(true).then(_syncQueueSessionIds);
    startQueueRefresh();
    initNotifications({ onNavigateToTask: loadTaskAndShow });
  } catch (e) {
    setEmail("");
    errEl.textContent =
      e.message && (e.message.includes("allowlist") || e.message.includes("Missing") || e.message.includes("403") || e.message.includes("Not an allowed"))
        ? "This email isn't on the list. Ask your lead for help."
        : (e.message || "Something went wrong. Try again.");
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.setAttribute("aria-busy", "false");
  }
});

document.getElementById("email-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-continue")?.click();
});

document.getElementById("btn-change-email")?.addEventListener("click", () => {
  const prevEmail = getEmail();
  setEmail("");
  document.getElementById("reviewer-email").textContent = "";
  currentSessionId = null;
  currentTask = null;
  queueSessionIds = [];
  showGate(true);
  const input = document.getElementById("email-input");
  if (input) {
    input.value = prevEmail;
    input.focus();
  }
});

// ----- Queue -----
setOnSelectTask(loadTaskAndShow);
initQueueTabs();
initQueueSearch();
initBatchApprove();

document.getElementById("btn-queue").addEventListener("click", () => {
  loadQueue(true).then(_syncQueueSessionIds);
  startQueueRefresh();
});

// ----- Prev/Next task navigation -----
document.getElementById("btn-prev-task")?.addEventListener("click", () => _navigateTask(-1));
document.getElementById("btn-next-task")?.addEventListener("click", () => _navigateTask(1));

// ----- Save feedback (PAUSED when feedback UI is hidden) -----
if (FEEDBACK_ENABLED) {
  document.getElementById("btn-save-feedback").addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-feedback");
    btn.disabled = true;
    try {
      const body = collectFeedback();
      await api("/api/tasks/" + currentSessionId + "/feedback", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      showToast("Feedback saved", "success");
    } catch (e) {
      showToast("Error: " + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ----- Approve / Return / Reject -----
document.getElementById("btn-approve").addEventListener("click", async () => {
  if (!currentSessionId) {
    showToast("Open a task first.", "info");
    return;
  }
  const btn = document.getElementById("btn-approve");
  btn.disabled = true;
  try {
    await api("/api/tasks/" + currentSessionId + "/approve", { method: "POST", body: JSON.stringify({}) });
    _recordReviewStat("approved");
    showToast("Task approved!", "success");
    await loadQueue(true);
    _syncQueueSessionIds();
    showQueue(true);
    showTask(false);
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-return").addEventListener("click", () => {
    if (!currentSessionId) {
      showToast("Open a task first.", "info");
      return;
    }
    if (FEEDBACK_ENABLED) {
      if (!showReturnNudgeIfNeeded()) return;
      _submitReturn(collectFeedback());
      return;
    }
    _showReturnModal();
});

function _showReturnModal() {
  const cs = getCouncilState();
  const failedMsgs = (cs.ruleOrder || [])
    .filter((r) => !cs.rules[r]?.passed)
    .map((r) => {
      const label = r.replace(/_/g, " ");
      const msg = cs.rules[r]?.issue?.message || cs.rules[r]?.description || "";
      return `<div class="return-reason-item"><strong>${escapeHtml(label)}</strong>: ${escapeHtml(msg)}</div>`;
    });

  const suggestedHtml = failedMsgs.length > 0
    ? `<div class="return-suggested"><div class="return-suggested-label">Council findings (auto-filled):</div>${failedMsgs.join("")}</div>`
    : "";

  const html = `<div class="return-modal-content">
    ${suggestedHtml}
    <label class="return-modal-label">Reason for returning this task:</label>
    <textarea id="return-reason-input" class="return-reason-textarea" rows="4" placeholder="Add your comments...">${failedMsgs.length > 0 ? escapeHtml((cs.ruleOrder || []).filter((r) => !cs.rules[r]?.passed).map((r) => cs.rules[r]?.issue?.message || cs.rules[r]?.description || r).join("; ")) : ""}</textarea>
    <div class="return-modal-actions">
      <button type="button" id="btn-return-cancel" class="btn-return-cancel">Cancel</button>
      <button type="button" id="btn-return-confirm" class="btn-return-confirm">Return Task</button>
    </div>
  </div>`;

  showModal("Return Task", html);

  const textarea = document.getElementById("return-reason-input");
  if (textarea) { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); }

  document.getElementById("btn-return-cancel")?.addEventListener("click", hideModal);
  document.getElementById("btn-return-confirm")?.addEventListener("click", () => {
    const reason = (document.getElementById("return-reason-input")?.value || "").trim();
    if (!reason) { showToast("Please enter a reason.", "error"); return; }
    hideModal();
    _submitReturn({ overall_comment: reason });
  });
}

async function _submitReturn(body) {
  const btn = document.getElementById("btn-return");
  if (btn) btn.disabled = true;
  try {
    await api("/api/tasks/" + currentSessionId + "/return", {
      method: "POST",
      body: JSON.stringify(body),
    });
    _recordReviewStat("returned");
    showToast("Returned with comments", "success");
    await loadQueue(true);
    _syncQueueSessionIds();
    showQueue(true);
    showTask(false);
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById("btn-escalate").addEventListener("click", async () => {
  if (!currentSessionId) {
    showToast("Open a task first.", "info");
    return;
  }
  if (!confirm("Escalate this task for admin review? The trainer will be notified.")) return;
  const btn = document.getElementById("btn-escalate");
  btn.disabled = true;
  try {
    const body = FEEDBACK_ENABLED ? collectFeedback() : {};
    await api("/api/tasks/" + currentSessionId + "/escalate", {
      method: "POST",
      body: JSON.stringify(body),
    });
    showToast("Task escalated", "success");
    await loadQueue(true);
    _syncQueueSessionIds();
    showQueue(true);
    showTask(false);
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ----- Colab save (reviewer submits approved tasks) -----
function _updateColabSection(_reviewStatus) {
  // PAUSED: colab save not needed on reviewer side
}

/**
 * Enable/disable Approve, Return, Escalate based on task review status.
 * - Pending (submitted): all enabled.
 * - Returned: all disabled (must resubmit before any action).
 * - Approved: Approve disabled; Return, Escalate enabled.
 * - Escalated: Approve, Return enabled; Escalate disabled (already escalated).
 * - No task (null): all disabled.
 */
function _updateActionButtons(reviewStatus) {
  const approveBtn = document.getElementById("btn-approve");
  const returnBtn = document.getElementById("btn-return");
  const escalateBtn = document.getElementById("btn-escalate");
  if (!approveBtn || !returnBtn || !escalateBtn) return;

  const status = reviewStatus === null || reviewStatus === undefined ? "" : String(reviewStatus).toLowerCase();
  const pending = status === "" || status === "submitted";

  let allowApprove, allowReturn, allowEscalate;
  if (pending) {
    allowApprove = allowReturn = allowEscalate = true;
  } else if (status === "returned") {
    allowApprove = allowReturn = allowEscalate = false;
  } else if (status === "approved") {
    allowApprove = false;
    allowReturn = allowEscalate = true;
  } else if (status === "escalated") {
    allowApprove = allowReturn = true;
    allowEscalate = false;
  } else {
    allowApprove = allowReturn = allowEscalate = false;
  }

  approveBtn.disabled = !allowApprove;
  returnBtn.disabled = !allowReturn;
  escalateBtn.disabled = !allowEscalate;
}

document.getElementById("btn-colab-preview")?.addEventListener("click", async () => {
  if (!currentSessionId) return;
  const btn = document.getElementById("btn-colab-preview");
  const content = document.getElementById("colab-preview-content");
  const statusEl = document.getElementById("colab-save-status");
  btn.disabled = true;
  statusEl.textContent = "Loading preview...";
  try {
    const preview = await api("/api/tasks/" + currentSessionId + "/colab-preview");
    content.innerHTML = _renderColabPreview(preview);
    document.getElementById("btn-colab-submit").disabled = false;
    statusEl.textContent = "";
  } catch (e) {
    statusEl.textContent = "Error: " + e.message;
    statusEl.style.color = "var(--error)";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-colab-submit")?.addEventListener("click", async () => {
  if (!currentSessionId) return;
  if (!confirm("Submit this task to Colab? This will write to the original notebook.")) return;
  const btn = document.getElementById("btn-colab-submit");
  const statusEl = document.getElementById("colab-save-status");
  btn.disabled = true;
  statusEl.textContent = "Saving to Colab...";
  statusEl.style.color = "";
  try {
    await api("/api/tasks/" + currentSessionId + "/submit-to-colab", { method: "POST" });
    showToast("Task submitted to Colab!", "success");
    statusEl.textContent = "Saved successfully!";
    statusEl.style.color = "var(--success, #22c55e)";
    btn.textContent = "Submitted";
  } catch (e) {
    showToast("Error: " + e.message, "error");
    statusEl.textContent = "Error: " + e.message;
    statusEl.style.color = "var(--error)";
    btn.disabled = false;
  }
});

function _renderColabPreview(preview) {
  const slots = (preview.selected_slots || []).map(s =>
    `<div class="colab-slot-preview">
      <strong>Slot ${s.slot}</strong> — ${escapeHtml(s.model || "unknown")}
      <span class="colab-slot-judgment">${escapeHtml(s.judgment || s.grading_basis || "")}</span>
      <div class="colab-slot-response">${escapeHtml(s.response_preview || "")}</div>
    </div>`
  ).join("");
  return `<div class="colab-preview-summary">
    <div><strong>Task ID:</strong> ${escapeHtml(preview.task_display_id || preview.session_id)}</div>
    <div><strong>Domain:</strong> ${escapeHtml(preview.metadata?.domain || "")}</div>
    <div><strong>Total hunts:</strong> ${preview.total_hunts || 0}</div>
    <div><strong>Reviews:</strong> ${preview.reviews_count || 0}</div>
  </div>
  <div class="colab-slots-preview">${slots}</div>`;
}

// ----- Run agent (PAUSED when deep review is hidden) -----
if (DEEP_REVIEW_ENABLED) {
  document.getElementById("btn-run-agent").addEventListener("click", async () => {
    const btn = document.getElementById("btn-run-agent");
    const statusEl = document.getElementById("agent-status");
    btn.disabled = true;
    statusEl.textContent = "Running agent\u2026";
    statusEl.style.color = "";
    try {
      const result = await api("/api/tasks/" + currentSessionId + "/agent-run", { method: "POST" });
      renderAgentResult(result);
      showToast(result.error ? "Agent finished with errors" : "Agent review complete", result.error ? "error" : "success");
      if (result.error) statusEl.textContent = "Done with errors.";
      else statusEl.textContent = "";
      currentTask.agent_result = result;
      const agentSummaryEl = document.getElementById("agent-summary-at-top");
      renderAgentSummaryAtTop(agentSummaryEl, result);
    } catch (e) {
      showToast("Error: " + e.message, "error");
      statusEl.textContent = "";
      renderAgentResult({ error: e.message });
    } finally {
      btn.disabled = false;
    }
  });
}

// ----- Edit toggle (top-right pill button) -----
document.getElementById("edit-toggle").addEventListener("click", () => {
  const btn = document.getElementById("edit-toggle");
  const pressed = btn.getAttribute("aria-pressed") === "true";
  btn.setAttribute("aria-pressed", String(!pressed));
  btn.classList.toggle("active", !pressed);
  show("edit-panel", !pressed);
});
document.getElementById("btn-save-edit").addEventListener("click", async () => {
  const pre = document.getElementById("edit-reviews-json");
  const statusEl = document.getElementById("edit-status");
  const btn = document.getElementById("btn-save-edit");
  let data;
  try {
    data = JSON.parse(pre.textContent);
  } catch (e) {
    showToast("Invalid JSON", "error");
    return;
  }
  // Merge structured fields into data
  const fieldsContainer = document.getElementById("edit-reviews-fields");
  if (fieldsContainer) {
    fieldsContainer.querySelectorAll(".edit-review-row").forEach((row) => {
      const huntId = row.dataset.huntId;
      if (!huntId || !data[huntId]) return;
      const expEl = row.querySelector(".edit-explanation");
      if (expEl) data[huntId].explanation = expEl.value;
      row.querySelectorAll(".edit-grade-select").forEach((sel) => {
        const criteriaId = sel.dataset.criteriaId;
        if (criteriaId) data[huntId].grades[criteriaId] = sel.value;
      });
    });
  }
  btn.disabled = true;
  try {
    await api("/api/tasks/" + currentSessionId, {
      method: "PATCH",
      body: JSON.stringify({ human_reviews: data }),
    });
    showToast("Edits saved", "success");
    statusEl.textContent = "";
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

function _renderEditReviewFields(humanReviews) {
  const container = document.getElementById("edit-reviews-fields");
  if (!container) return;
  container.innerHTML = "";
  const entries = Object.entries(humanReviews || {});
  if (entries.length === 0) {
    container.innerHTML = '<p class="hint">No human reviews yet.</p>';
    return;
  }
  entries.forEach(([huntId, review]) => {
    const row = document.createElement("div");
    row.className = "edit-review-row";
    row.dataset.huntId = huntId;
    const grades = review.grades || {};
      const gradeHtml = Object.entries(grades).map(([cid, val]) => {
        const v = String(val).toLowerCase();
        return `<div class="edit-grade-item">
          <label class="edit-grade-label">${escapeHtml(cid)}</label>
          <select class="edit-grade-select" data-criteria-id="${escapeHtml(cid)}">
            <option value="pass" ${v === "pass" ? "selected" : ""}>Pass</option>
            <option value="fail" ${v === "fail" ? "selected" : ""}>Fail</option>
          </select>
        </div>`;
      }).join("");
      row.innerHTML = `
        <div class="edit-review-header">
          <span class="edit-hunt-id">${escapeHtml(huntId)}</span>
          <span class="edit-model">${escapeHtml(review.model || "")}</span>
        </div>
        ${gradeHtml ? `<div class="edit-grades-row">${gradeHtml}</div>` : ""}
        <div class="edit-explanation-row">
          <label class="edit-field-label">Explanation</label>
          <textarea class="edit-explanation" rows="2">${escapeHtml(review.explanation || "")}</textarea>
        </div>
      `;
    container.appendChild(row);
  });
}

// ----- Notebook fetch (verify source link) -----
document.getElementById("btn-fetch-notebook")?.addEventListener("click", async () => {
  const urlInput = document.getElementById("notebook-fetch-url");
  const statusEl = document.getElementById("notebook-fetch-status");
  const resultEl = document.getElementById("notebook-fetch-result");
  const btn = document.getElementById("btn-fetch-notebook");

  const url = (urlInput?.value || "").trim();
  if (!url) {
    statusEl.textContent = "Please enter a URL.";
    statusEl.hidden = false;
    statusEl.className = "notebook-fetch-status error";
    return;
  }

  btn.disabled = true;
  statusEl.textContent = "Fetching\u2026";
  statusEl.hidden = false;
  statusEl.className = "notebook-fetch-status";
  resultEl.hidden = true;

  try {
    const data = await api("/api/notebook-preview", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    statusEl.hidden = true;
    resultEl.hidden = false;
    resultEl.innerHTML = _renderNotebookPreview(data);
  } catch (e) {
    statusEl.textContent = "Error: " + (e.message || "Could not fetch notebook.");
    statusEl.className = "notebook-fetch-status error";
    statusEl.hidden = false;
    resultEl.hidden = true;
  } finally {
    btn.disabled = false;
  }
});

function _renderNotebookPreview(data) {
  const prompt = escapeHtml(data.prompt || "(no prompt)");
  const idealResponse = (data.ideal_response || "").trim();
  const criteria = (data.criteria || []);
  const criteriaHtml = criteria.length > 0
    ? `<ul class="nbp-criteria-list">${criteria.map(c => `<li><span class="criteria-id">${escapeHtml(c.id || "")}</span> ${escapeHtml(c.description || "")}</li>`).join("")}</ul>`
    : `<span class="nbp-empty">No criteria found</span>`;
  const idealHtml = idealResponse
    ? `<div class="nbp-section">
        <div class="nbp-section-label">Ideal Response</div>
        <div class="nbp-ideal-response">${escapeHtml(idealResponse)}</div>
      </div>`
    : "";
  return `
    <div class="nbp-section">
      <div class="nbp-section-label">Prompt</div>
      <div class="nbp-text">${prompt}</div>
    </div>
    ${idealHtml}
    <div class="nbp-section">
      <div class="nbp-section-label">Criteria / Rubric (${criteria.length})</div>
      ${criteriaHtml}
    </div>`;
}

// ----- Keyboard -----
setKeyboardHandlers({
  onApprove: () => document.getElementById("btn-approve")?.click(),
  onReturn: () => document.getElementById("btn-return")?.click(),
  onEscalate: () => document.getElementById("btn-escalate")?.click(),
  onSaveFeedback: () => document.getElementById("btn-save-feedback")?.click(),
  onRunCouncil: () => document.getElementById("btn-run-council")?.click(),
  onSelectTask: loadTaskAndShow,
  getQueueSessionIds: () => queueSessionIds,
  getFocusedQueueIndex,
  onPrevTask: () => _navigateTask(-1),
  onNextTask: () => _navigateTask(1),
});
initKeyboard();

// ----- Council -----
initCouncil(() => currentSessionId, () => document.getElementById("btn-approve")?.click());

// ----- Review stats -----
function _recordReviewStat(action) {
  const elapsed = _taskOpenedAt ? Math.round((Date.now() - _taskOpenedAt) / 1000) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const key = `review_stats_${today}`;
  let stats;
  try { stats = JSON.parse(localStorage.getItem(key) || "null"); } catch { stats = null; }
  if (!stats) stats = { date: today, count: 0, totalSeconds: 0, approved: 0, returned: 0 };
  stats.count++;
  stats.totalSeconds += elapsed;
  if (action === "approved") stats.approved++;
  if (action === "returned") stats.returned++;
  localStorage.setItem(key, JSON.stringify(stats));
  _renderQueueStats();
}
function _renderQueueStats() {
  const el = document.getElementById("queue-stats");
  if (!el) return;
  const today = new Date().toISOString().slice(0, 10);
  let stats;
  try { stats = JSON.parse(localStorage.getItem(`review_stats_${today}`) || "null"); } catch { stats = null; }
  if (!stats || stats.count === 0) { el.hidden = true; return; }
  const avg = Math.round(stats.totalSeconds / stats.count);
  el.hidden = false;
  el.innerHTML = `Today: <strong>${stats.count}</strong> reviewed &middot; avg <strong>${avg}s</strong> &middot; ${stats.approved} approved &middot; ${stats.returned} returned`;
}

// ----- Feedback section collapsibles (PAUSED when feedback UI hidden) -----
document.querySelectorAll(".fb-section-header").forEach((header) => {
  const section = header.dataset.section;
  const bodyId = `fb-body-${section}`;
  const body = document.getElementById(bodyId);
  const chevron = header.querySelector(".fb-chevron");
  const isOpen = header.classList.contains("fb-section-header--open");
  if (body && !isOpen) body.classList.add("fb-section-body--collapsed");

  header.addEventListener("click", () => {
    const collapsed = body?.classList.contains("fb-section-body--collapsed");
    if (collapsed) {
      body?.classList.remove("fb-section-body--collapsed");
      header.classList.add("fb-section-header--open");
      if (chevron) chevron.style.transform = "";
    } else {
      body?.classList.add("fb-section-body--collapsed");
      header.classList.remove("fb-section-header--open");
      if (chevron) chevron.style.transform = "rotate(-90deg)";
    }
  });
  // Set initial chevron for collapsed sections
  if (!isOpen && chevron) chevron.style.transform = "rotate(-90deg)";
});

// ----- Init -----
initVersionCheck();
if (getEmail()) {
  document.getElementById("reviewer-email").textContent = getEmail();
  showGate(false);
    loadQueue(true).then(() => { _syncQueueSessionIds(); _renderQueueStats(); });
    startQueueRefresh();
    initNotifications({ onNavigateToTask: loadTaskAndShow });
} else {
  showGate(true);
}
