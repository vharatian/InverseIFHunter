/**
 * Slim reviewer: auth, fetch notebook by Colab/Drive URL only (no session DB lookup).
 */
import { getEmail, setEmail, api, initVersionCheck } from "./js/api.js";
import { showGate, showToast } from "./js/dom.js";
import { escapeHtml } from "./js/task.js";
import { initCouncil, resetCouncil } from "./js/council.js";

let currentSessionId = null;
let currentTask = null;
let _isLoadingTask = false;

function _normalizeNotebookUrl(s) {
  let t = (s || "").trim();
  if (!t) return "";
  if (!/^https?:\/\//i.test(t)) {
    if (
      t.includes("colab.") ||
      t.includes("drive.google") ||
      t.includes("github.com") ||
      t.includes("githubusercontent.com") ||
      /^[\w.-]+\.[a-z]{2,}\//i.test(t)
    ) {
      t = "https://" + t.replace(/^\/+/, "");
    }
  }
  return t;
}

function _isLikelyNotebookUrl(s) {
  const t = (s || "").trim().toLowerCase();
  if (!t) return false;
  return (
    t.includes("colab.research.google.com") ||
    t.includes("colab.google.com") ||
    t.includes("drive.google.com") ||
    t.includes("raw.githubusercontent.com") ||
    t.includes("githubusercontent.com") ||
    (t.includes("github.com") && t.includes(".ipynb"))
  );
}

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

async function resolveAndLoad(query) {
  const raw = (query || "").trim();
  if (!raw) {
    _setFetchStatus("Paste a Colab or Drive link to the notebook.", true);
    return;
  }
  const url = _normalizeNotebookUrl(raw);
  if (!_isLikelyNotebookUrl(url)) {
    _setFetchStatus(
      "Use a Google Colab or Google Drive link to the .ipynb, or a raw GitHub notebook URL.",
      true,
    );
    return;
  }
  _hideLookupMatches();
  _setFetchStatus("Fetching notebook\u2026", false);
  await loadNotebookOnly(url);
}

async function loadNotebookOnly(url) {
  const raw = (url || "").trim();
  if (!raw) {
    _setFetchStatus("Enter a notebook URL.", true);
    return;
  }
  _isLoadingTask = true;
  _hideLookupMatches();
  currentSessionId = null;
  currentTask = null;

  const panel = document.getElementById("task-panel");
  const banner = document.getElementById("notebook-only-banner");
  const taskSessionIdEl = document.getElementById("task-session-id");
  const taskDisplayIdEl = document.getElementById("task-display-id");
  const taskDisplayIdLabelEl = document.getElementById("task-display-id-label");
  const taskErrorEl = document.getElementById("task-error");
  const taskContentEl = document.getElementById("task-content");

  if (panel) {
    panel.hidden = false;
    panel.dataset.notebookOnly = "true";
  }
  if (banner) {
    banner.hidden = true;
    banner.textContent = "";
  }
  if (taskDisplayIdLabelEl) taskDisplayIdLabelEl.textContent = "Notebook URL";
  if (taskDisplayIdEl) taskDisplayIdEl.textContent = raw.length > 72 ? raw.slice(0, 72) + "\u2026" : raw;
  if (taskSessionIdEl) taskSessionIdEl.textContent = "";
  if (taskErrorEl) taskErrorEl.hidden = true;
  if (taskContentEl) {
    taskContentEl.textContent = "Loading notebook\u2026";
    taskContentEl.classList.add("loading-placeholder");
    taskContentEl.setAttribute("aria-busy", "true");
  }

  const fetchInput = document.getElementById("notebook-fetch-url");
  if (fetchInput) fetchInput.value = raw;

  resetCouncil();
  const summaryEl = document.getElementById("council-summary");
  if (summaryEl) summaryEl.textContent = "";

  try {
    const data = await api("/api/notebook-preview", {
      method: "POST",
      body: JSON.stringify({ url: raw }),
    });
    if (taskContentEl) {
      taskContentEl.classList.remove("loading-placeholder");
      taskContentEl.setAttribute("aria-busy", "false");
      taskContentEl.innerHTML = _renderNotebookPreviewBody(data);
    }
    if (banner && data.warnings && data.warnings.length) {
      banner.hidden = false;
      banner.className = "notebook-only-banner notebook-only-banner--warn";
      banner.innerHTML =
        "<strong>Content check.</strong> " +
        escapeHtml(data.warnings.join(" ")) +
        ' <span class="notebook-only-sub">Cells scanned: ' +
        (data.cells_scanned ?? 0) +
        ".</span>";
    }
    _setFetchStatus(
      data.has_structured_content ? "Notebook loaded." : "Notebook opened; some expected sections may be missing.",
      !data.has_structured_content,
    );
  } catch (e) {
    if (taskContentEl) {
      taskContentEl.classList.remove("loading-placeholder");
      taskContentEl.textContent = "";
      taskContentEl.setAttribute("aria-busy", "false");
    }
    if (banner) {
      banner.hidden = false;
      banner.className = "notebook-only-banner notebook-only-banner--error";
      banner.innerHTML = "<strong>Could not load notebook.</strong> " + escapeHtml(e.message || "Unknown error");
    }
    _setFetchStatus(e.message || "Notebook fetch failed.", true);
    showToast(e.message || "Notebook fetch failed.", "error");
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
  const url = _normalizeNotebookUrl(urlInput?.value || "");
  if (!url || !_isLikelyNotebookUrl(url)) {
    statusEl.textContent = "Enter a valid Colab or Drive notebook URL.";
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
    resultEl.innerHTML = _renderNotebookPreviewBody(data);
  } catch (e) {
    statusEl.textContent = "Error: " + (e.message || "Could not fetch notebook.");
    statusEl.className = "notebook-fetch-status error";
    statusEl.hidden = false;
    resultEl.hidden = true;
  } finally {
    btn.disabled = false;
  }
});

function _renderNotebookPreviewBody(data) {
  const warnings = data.warnings || [];
  const warnBlock =
    warnings.length > 0
      ? `<div class="nbp-warnings" role="alert"><strong>Notice:</strong> ${warnings.map((w) => escapeHtml(w)).join(" ")}</div>`
      : "";
  const meta =
    data.cells_scanned != null
      ? `<p class="nbp-meta">Cells scanned in notebook: ${Number(data.cells_scanned)}</p>`
      : "";
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
  return (
    warnBlock +
    meta +
    `<div class="nbp-section"><div class="nbp-section-label">Prompt</div><div class="nbp-text">${prompt}</div></div>
    ${idealHtml}
    <div class="nbp-section"><div class="nbp-section-label">Criteria / Rubric (${criteria.length})</div>${criteriaHtml}</div>`
  );
}

initCouncil(() => currentSessionId, null);
initVersionCheck();

if (getEmail()) {
  document.getElementById("reviewer-email").textContent = getEmail();
  showGate(false);
} else {
  showGate(true);
}
