/**
 * Reviewer app entry: gate, queue, task, feedback, agent, edit, keyboard, toasts.
 */
import { getEmail, setEmail, api } from "./js/api.js";
import { show, showGate, showQueue, showTask, showToast, showModal, hideModal } from "./js/dom.js";
import { loadQueue, setOnSelectTask, initQueueTabs, initQueueSearch } from "./js/queue.js";
import { loadTask, renderTaskContent, renderAgentResult, renderAgentSummaryAtTop } from "./js/task.js";
import { renderFeedbackForm, collectFeedback, showReturnNudgeIfNeeded } from "./js/feedback.js";
import { setKeyboardHandlers, initKeyboard } from "./js/keyboard.js";
import { initNotifications } from "./js/notifications.js";

let currentSessionId = null;
let currentTask = null;
let queueSessionIds = [];
let currentTaskDisplayId = "";

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
  const idx = queueSessionIds.indexOf(currentSessionId);
  const newIdx = idx + delta;
  if (newIdx >= 0 && newIdx < queueSessionIds.length) {
    loadTaskAndShow(queueSessionIds[newIdx]);
  }
}

async function loadTaskAndShow(sessionId) {
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
    renderFeedbackForm(currentTask.feedback || {}, true);
    renderAgentResult(currentTask.agent_result);
    const agentSummaryEl = document.getElementById("agent-summary-at-top");
    renderAgentSummaryAtTop(agentSummaryEl, currentTask.agent_result);
    document.getElementById("edit-reviews-json").textContent = JSON.stringify(
      currentTask.session?.human_reviews || {},
      null,
      2
    );
    document.getElementById("feedback-status").textContent = "";
    document.getElementById("edit-status").textContent = "";
    document.getElementById("agent-status").textContent = "";
    wireTaskRatingButtons();
    _updateColabSection(currentTask.review_status || "");
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
    showTask(true);
  }
}

function _resetEditToggle() {
  const btn = document.getElementById("edit-toggle");
  if (btn) {
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove("active");
  }
  show("edit-panel", false);
}

function wireTaskRatingButtons() {
  const container = document.getElementById("feedback-task-rating");
  if (!container) return;
  container.querySelectorAll(".btn-rating").forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  container.querySelectorAll(".btn-rating").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".btn-rating").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
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
    const round = historyCount + 1;
    banner.hidden = false;
    banner.className = "revised-banner";
    banner.innerHTML = `<span class="revised-icon">\u21BB</span><strong>Revised since last review</strong>${ts ? ` (resubmitted ${ts})` : ""} \u00b7 Review round ${round}${historyCount > 0 ? ` \u00b7 <button type="button" id="btn-show-prev-feedback" class="btn-link">View previous feedback</button>` : ""}`;
    const prevBtn = banner.querySelector("#btn-show-prev-feedback");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        const history = task.feedback_history || [];
        if (history.length === 0) {
          showToast("No previous feedback.", "info");
          return;
        }
        const html = history.map((fb, i) => {
          const overall = _escapeHtml(fb.overall_comment || "(no comment)");
          return `<div class="history-round"><div class="history-round-header">Round ${historyCount - i}</div><div class="history-round-body">${overall}</div></div>`;
        }).join("");
        showModal("Previous Feedback", html);
      });
    }
  } else {
    banner.hidden = true;
  }
}

function _escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
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
    loadQueue(true).then(() => {
      const list = document.getElementById("queue-list");
      if (list) queueSessionIds = [...list.querySelectorAll("li")].map((li) => li.dataset.sessionId).filter(Boolean);
    });
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

document.getElementById("btn-queue").addEventListener("click", () => {
  loadQueue(true).then(() => {
    const list = document.getElementById("queue-list");
    if (list) queueSessionIds = [...list.querySelectorAll("li")].map((li) => li.dataset.sessionId).filter(Boolean);
  });
});

// ----- Prev/Next task navigation -----
document.getElementById("btn-prev-task")?.addEventListener("click", () => _navigateTask(-1));
document.getElementById("btn-next-task")?.addEventListener("click", () => _navigateTask(1));

// ----- Save feedback -----
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
    showToast("Task approved!", "success");
    await loadQueue(true);
    const list = document.getElementById("queue-list");
    if (list) queueSessionIds = [...list.querySelectorAll("li")].map((li) => li.dataset.sessionId).filter(Boolean);
    showQueue(true);
    showTask(false);
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-return").addEventListener("click", async () => {
  if (!currentSessionId) {
    showToast("Open a task first.", "info");
    return;
  }
  showReturnNudgeIfNeeded();
  const btn = document.getElementById("btn-return");
  btn.disabled = true;
  try {
    const body = collectFeedback();
    await api("/api/tasks/" + currentSessionId + "/return", {
      method: "POST",
      body: JSON.stringify(body),
    });
    showToast("Returned with comments", "success");
    await loadQueue(true);
    const list = document.getElementById("queue-list");
    if (list) queueSessionIds = [...list.querySelectorAll("li")].map((li) => li.dataset.sessionId).filter(Boolean);
    showQueue(true);
    showTask(false);
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-reject").addEventListener("click", async () => {
  if (!currentSessionId) {
    showToast("Open a task first.", "info");
    return;
  }
  if (!confirm("Reject this task? This is permanent \u2014 the trainer cannot resubmit.")) return;
  const btn = document.getElementById("btn-reject");
  btn.disabled = true;
  try {
    const body = collectFeedback();
    delete body.revision_flags;
    await api("/api/tasks/" + currentSessionId + "/reject", {
      method: "POST",
      body: JSON.stringify(body),
    });
    showToast("Task rejected", "success");
    await loadQueue(true);
    const list = document.getElementById("queue-list");
    if (list) queueSessionIds = [...list.querySelectorAll("li")].map((li) => li.dataset.sessionId).filter(Boolean);
    showQueue(true);
    showTask(false);
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ----- Colab save (reviewer submits approved tasks) -----
function _updateColabSection(reviewStatus) {
  const section = document.getElementById("colab-save-section");
  if (!section) return;
  const colabSaved = currentTask?.session?.meta?.colab_saved === "1";
  if (reviewStatus === "approved" && !colabSaved) {
    section.hidden = false;
  } else if (colabSaved) {
    section.hidden = false;
    section.querySelector(".colab-save-hint").textContent = "This task has already been submitted to Colab.";
    const previewBtn = document.getElementById("btn-colab-preview");
    const submitBtn = document.getElementById("btn-colab-submit");
    if (previewBtn) previewBtn.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
  } else {
    section.hidden = true;
  }
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
      <strong>Slot ${s.slot}</strong> — ${_escapeHtml(s.model || "unknown")}
      <span class="colab-slot-judgment">${_escapeHtml(s.judgment || s.grading_basis || "")}</span>
      <div class="colab-slot-response">${_escapeHtml(s.response_preview || "")}</div>
    </div>`
  ).join("");
  return `<div class="colab-preview-summary">
    <div><strong>Task ID:</strong> ${_escapeHtml(preview.task_display_id || preview.session_id)}</div>
    <div><strong>Domain:</strong> ${_escapeHtml(preview.metadata?.domain || "")}</div>
    <div><strong>Total hunts:</strong> ${preview.total_hunts || 0}</div>
    <div><strong>Reviews:</strong> ${preview.reviews_count || 0}</div>
  </div>
  <div class="colab-slots-preview">${slots}</div>`;
}

// ----- Run agent -----
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

// ----- Keyboard -----
setKeyboardHandlers({
  onApprove: () => document.getElementById("btn-approve")?.click(),
  onReturn: () => document.getElementById("btn-return")?.click(),
  onSaveFeedback: () => document.getElementById("btn-save-feedback")?.click(),
  onSelectTask: loadTaskAndShow,
  getQueueSessionIds: () => queueSessionIds,
  getFocusedQueueIndex,
  onPrevTask: () => _navigateTask(-1),
  onNextTask: () => _navigateTask(1),
});
initKeyboard();

// ----- Init -----
if (getEmail()) {
  document.getElementById("reviewer-email").textContent = getEmail();
  showGate(false);
  loadQueue(true).then(() => {
    const list = document.getElementById("queue-list");
    if (list) queueSessionIds = [...list.querySelectorAll("li")].map((li) => li.dataset.sessionId).filter(Boolean);
  });
  initNotifications({ onNavigateToTask: loadTaskAndShow });
} else {
  showGate(true);
}
