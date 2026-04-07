/**
 * Slim reviewer: auth, session/URL fetch, task preview, council.
 */
import { getEmail, setEmail, api, initVersionCheck } from "./js/api.js";
import { show, showGate, showToast, showModal } from "./js/dom.js";
import { loadTask, renderTaskContent, escapeHtml } from "./js/task.js";
import { initCouncil, resetCouncil, restoreCouncilFromTask } from "./js/council.js";

let currentSessionId = null;
let currentTask = null;
let _isLoadingTask = false;

const SESSION_ID_RE = /^[a-f0-9]{8}$/i;

function _setFetchStatus(msg, isError) {
  const el = document.getElementById("fetch-status");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.className = "fetch-status" + (isError ? " error" : "");
}

function _hideLookupMatches() {
  const box = document.getElementById("lookup-matches");
  if (box) box.hidden = true;
}

function _showLookupMatches(matches) {
  const box = document.getElementById("lookup-matches");
  const list = document.getElementById("lookup-matches-list");
  if (!box || !list) return;
  list.innerHTML = "";
  for (const m of matches) {
    const li = document.createElement("li");
    const sid = m.session_id;
    li.innerHTML = `<button type="button" class="lookup-pick-btn" data-session="${escapeHtml(sid)}">${escapeHtml(sid)} <span class="lookup-pick-meta">${escapeHtml(m.hunt_status || "")}</span></button>`;
    list.appendChild(li);
  }
  list.querySelectorAll(".lookup-pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sid = btn.getAttribute("data-session");
      if (sid) loadTaskAndShow(sid);
    });
  });
  box.hidden = false;
}

async function resolveAndLoad(query) {
  const raw = (query || "").trim();
  if (!raw) {
    _setFetchStatus("Enter a session ID or URL.", true);
    return;
  }
  _hideLookupMatches();
  _setFetchStatus("Looking up\u2026", false);

  if (SESSION_ID_RE.test(raw)) {
    _setFetchStatus("", false);
    await loadTaskAndShow(raw.toLowerCase());
    return;
  }

  try {
    const data = await api("/api/session-lookup?q=" + encodeURIComponent(raw));
    const matches = data.matches || [];
    if (matches.length === 0) {
      _setFetchStatus("No session found for that URL. Try the 8-character session ID from the trainer queue.", true);
      return;
    }
    if (matches.length === 1) {
      _setFetchStatus("", false);
      await loadTaskAndShow(matches[0].session_id);
      return;
    }
    _setFetchStatus("Multiple matches — choose one below.", false);
    _showLookupMatches(matches);
  } catch (e) {
    _setFetchStatus(e.message || "Lookup failed.", true);
  }
}

async function loadTaskAndShow(sessionId) {
  if (_isLoadingTask) return;
  _isLoadingTask = true;
  _hideLookupMatches();
  currentSessionId = sessionId;

  const panel = document.getElementById("task-panel");
  const taskSessionIdEl = document.getElementById("task-session-id");
  const taskDisplayIdEl = document.getElementById("task-display-id");
  const taskDisplayIdLabelEl = document.getElementById("task-display-id-label");
  const taskErrorEl = document.getElementById("task-error");
  const taskContentEl = document.getElementById("task-content");

  if (panel) panel.hidden = false;
  if (taskSessionIdEl) taskSessionIdEl.textContent = `Session: ${sessionId}`;
  if (taskDisplayIdEl) taskDisplayIdEl.textContent = "";
  if (taskErrorEl) taskErrorEl.hidden = true;
  if (taskContentEl) {
    taskContentEl.textContent = "Loading task\u2026";
    taskContentEl.classList.add("loading-placeholder");
    taskContentEl.setAttribute("aria-busy", "true");
  }

  try {
    const result = await loadTask(sessionId);
    if (!result) throw new Error("No task");
    currentTask = result.task;
    const taskIdLabel = currentTask.task_id_label || "Task ID";
    const disp = currentTask.task_display_id || sessionId;

    if (taskDisplayIdEl) taskDisplayIdEl.textContent = disp;
    if (taskDisplayIdLabelEl) taskDisplayIdLabelEl.textContent = taskIdLabel;
    if (taskSessionIdEl) {
      taskSessionIdEl.textContent = currentTask.task_display_id ? `Session: ${sessionId}` : "";
    }

    if (taskContentEl) {
      taskContentEl.classList.remove("loading-placeholder");
      taskContentEl.setAttribute("aria-busy", "false");
      renderTaskContent(taskContentEl, currentTask.snapshot || {}, currentTask.feedback || {});
    }

    const nbUrl =
      currentTask.session?.notebook?.url ||
      currentTask.session?.notebook?.metadata?.url ||
      currentTask.session?.notebook?.source_url ||
      "";
    const fetchInput = document.getElementById("notebook-fetch-url");
    if (fetchInput) fetchInput.value = nbUrl;

    resetCouncil();
    restoreCouncilFromTask(currentTask.last_council);

    _setFetchStatus("", false);
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
    showToast(e.message || "Could not load task.", "error");
  } finally {
    _isLoadingTask = false;
  }
}

document.getElementById("btn-continue")?.addEventListener("click", async () => {
  const input = document.getElementById("email-input");
  const errEl = document.getElementById("gate-error");
  const btn = document.getElementById("btn-continue");
  const email = (input?.value || "").trim();
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
  showGate(true);
  const input = document.getElementById("email-input");
  if (input) {
    input.value = prevEmail;
    input.focus();
  }
});

document.getElementById("btn-fetch-task")?.addEventListener("click", () => {
  const q = document.getElementById("task-fetch-input")?.value || "";
  resolveAndLoad(q);
});

document.getElementById("task-fetch-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-fetch-task")?.click();
});

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
  const criteria = data.criteria || [];
  const criteriaHtml =
    criteria.length > 0
      ? `<ul class="nbp-criteria-list">${criteria.map((c) => `<li><span class="criteria-id">${escapeHtml(c.id || "")}</span> ${escapeHtml(c.description || "")}</li>`).join("")}</ul>`
      : `<span class="nbp-empty">No criteria found</span>`;
  const idealHtml = idealResponse
    ? `<div class="nbp-section"><div class="nbp-section-label">Ideal Response</div><div class="nbp-ideal-response">${escapeHtml(idealResponse)}</div></div>`
    : "";
  return `
    <div class="nbp-section"><div class="nbp-section-label">Prompt</div><div class="nbp-text">${prompt}</div></div>
    ${idealHtml}
    <div class="nbp-section"><div class="nbp-section-label">Criteria / Rubric (${criteria.length})</div>${criteriaHtml}</div>`;
}

initCouncil(() => currentSessionId, null);
initVersionCheck();

if (getEmail()) {
  document.getElementById("reviewer-email").textContent = getEmail();
  showGate(false);
} else {
  showGate(true);
}
