/** Notebook-only loader: fetch /api/notebook-preview and paint the task panel. */
import { api } from "../api.js";
import { showToast } from "../dom.js";
import { escapeHtml } from "../task.js";
import { resetCouncil } from "../council.js";
import { hideHome } from "../home/index.js";
import { renderNotebookPreviewBody, wireSlotTabs } from "./preview.js";

const loaderState = {
  isLoading: false,
  seq: 0,
  currentSessionId: null,
  currentUrl: null,
};

export function getCurrentSessionId() {
  return loaderState.currentSessionId;
}

export function getCurrentNotebookUrl() {
  return loaderState.currentUrl;
}

export function resetLoader() {
  loaderState.currentSessionId = null;
  loaderState.currentUrl = null;
}

/**
 * Shared setup for any flow that opens the reviewer task view for a session.
 * Hides home, bumps the sequence counter (for race-safe loads), resets the
 * task panel + council, and returns the elements handle plus the load id.
 */
function _beginSession({ sessionId = null, rawUrl = "" } = {}) {
  hideHome();
  const seq = ++loaderState.seq;
  loaderState.currentSessionId = sessionId || null;
  _hideLookupMatches();

  const els = _collectElements();
  _prepareTaskPanel(els, rawUrl);
  resetCouncil();
  const summaryEl = document.getElementById("council-summary");
  if (summaryEl) summaryEl.textContent = "";

  return { els, seq };
}

/**
 * Open the reviewer task view for a session that has NO Colab/Drive link
 * attached. We still bind the sessionId (so council + review actions work)
 * and paint a soft inline notice where the notebook preview would appear.
 */
export function openSessionWithoutNotebook(opts = {}) {
  const { els } = _beginSession({ sessionId: opts.sessionId, rawUrl: "" });
  loaderState.currentUrl = null;

  if (els.taskContent) {
    els.taskContent.classList.remove("loading-placeholder");
    els.taskContent.setAttribute("aria-busy", "false");
    els.taskContent.textContent = "";
  }
  if (els.banner) {
    els.banner.hidden = false;
    els.banner.className = "notebook-only-banner notebook-only-banner--warn";
    els.banner.textContent = "No Colab link attached to this task.";
  }
  setFetchStatus("No Colab link attached — opened without a notebook preview.", false);
  if (els.fetchBtn) {
    els.fetchBtn.disabled = false;
    els.fetchBtn.setAttribute("aria-busy", "false");
  }
}

export async function loadNotebookOnly(url, opts = {}) {
  const raw = (url || "").trim();
  if (!raw) {
    setFetchStatus("Enter a notebook URL.", true);
    return;
  }
  if (loaderState.isLoading) {
    setFetchStatus("A notebook is already loading\u2026", false);
    return;
  }

  loaderState.isLoading = true;
  const { els, seq: loadId } = _beginSession({ sessionId: opts.sessionId, rawUrl: raw });
  loaderState.currentUrl = raw;

  try {
    const data = await api("/api/notebook-preview", {
      method: "POST",
      body: JSON.stringify({ url: raw }),
    });
    if (loadId !== loaderState.seq) return;
    _paintPreview(els, data);
    setFetchStatus(
      data.has_structured_content
        ? "Notebook loaded."
        : "Notebook opened; some expected sections may be missing.",
      !data.has_structured_content,
    );
  } catch (e) {
    if (loadId !== loaderState.seq) return;
    _paintError(els, e);
    setFetchStatus(e.message || "Notebook fetch failed.", true);
    showToast(e.message || "Notebook fetch failed.", "error");
  } finally {
    if (loadId === loaderState.seq) loaderState.isLoading = false;
    if (els.fetchBtn) {
      els.fetchBtn.disabled = false;
      els.fetchBtn.setAttribute("aria-busy", "false");
    }
  }
}

export function setFetchStatus(msg, isError) {
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

function _collectElements() {
  return {
    panel: document.getElementById("task-panel"),
    banner: document.getElementById("notebook-only-banner"),
    taskError: document.getElementById("task-error"),
    taskContent: document.getElementById("task-content"),
    fetchBtn: document.getElementById("btn-fetch-task"),
    taskHeader: document.querySelector(".task-view-header--slim"),
    notebookUrlInput: document.getElementById("notebook-fetch-url"),
  };
}

function _prepareTaskPanel(els, rawUrl) {
  if (els.fetchBtn) {
    els.fetchBtn.disabled = true;
    els.fetchBtn.setAttribute("aria-busy", "true");
  }
  if (els.panel) {
    els.panel.hidden = false;
    els.panel.dataset.notebookOnly = "true";
  }
  if (els.banner) {
    els.banner.hidden = true;
    els.banner.textContent = "";
  }
  if (els.taskHeader) els.taskHeader.hidden = true;
  if (els.taskError) els.taskError.hidden = true;
  if (els.taskContent) {
    els.taskContent.textContent = "Loading notebook\u2026";
    els.taskContent.classList.add("loading-placeholder");
    els.taskContent.setAttribute("aria-busy", "true");
  }
  if (els.notebookUrlInput) els.notebookUrlInput.value = rawUrl;
}

function _paintPreview(els, data) {
  if (els.taskContent) {
    els.taskContent.classList.remove("loading-placeholder");
    els.taskContent.setAttribute("aria-busy", "false");
    els.taskContent.innerHTML = renderNotebookPreviewBody(data);
    wireSlotTabs(els.taskContent);
  }
  if (els.banner && data.warnings && data.warnings.length) {
    els.banner.hidden = false;
    els.banner.className = "notebook-only-banner notebook-only-banner--warn";
    els.banner.innerHTML =
      "<strong>Content check.</strong> " +
      escapeHtml(data.warnings.join(" ")) +
      ' <span class="notebook-only-sub">Cells scanned: ' +
      escapeHtml(String(data.cells_scanned ?? 0)) +
      ".</span>";
  }
}

function _paintError(els, err) {
  if (els.taskContent) {
    els.taskContent.classList.remove("loading-placeholder");
    els.taskContent.textContent = "";
    els.taskContent.setAttribute("aria-busy", "false");
  }
  if (els.banner) {
    els.banner.hidden = false;
    els.banner.className = "notebook-only-banner notebook-only-banner--error";
    els.banner.innerHTML =
      "<strong>Could not load notebook.</strong> " + escapeHtml(err.message || "Unknown error");
  }
}
