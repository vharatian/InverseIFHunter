/**
 * SSE stream runners: session-based and notebook-based council execution.
 */
import { getEmail, API_BASE } from "../api.js";
import { getState } from "./councilState.js";
import { handleEvent } from "./councilEvents.js";
import { showRunBtn, showStopBtn } from "./councilUI.js";

function _renderSlot() {}

async function _runSSE(url, fetchOptions, slotsEl, summaryEl, detailEl, bar) {
  const _state = getState();
  const abortCtrl = new AbortController();
  _state.abortCtrl = abortCtrl;

  // Overall wall-clock cap (10 min) + idle-timeout (no bytes for 90s) so a
  // stuck stream doesn't hang the UI forever.
  const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
  const IDLE_TIMEOUT_MS = 90_000;
  let idleTimer = null;
  const overallTimer = setTimeout(() => {
    try { abortCtrl.abort(new DOMException("Timed out", "AbortError")); } catch (_) {}
  }, OVERALL_TIMEOUT_MS);
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (summaryEl) summaryEl.textContent = "No updates from council for 90s. Stopping.";
      try { abortCtrl.abort(new DOMException("Idle timeout", "AbortError")); } catch (_) {}
    }, IDLE_TIMEOUT_MS);
  };

  try {
    const response = await fetch(url, { ...fetchOptions, signal: abortCtrl.signal });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    resetIdleTimer();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          handleEvent(JSON.parse(jsonStr), slotsEl, summaryEl, detailEl);
        } catch { /* skip malformed */ }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      if (summaryEl) summaryEl.textContent = "Council stopped.";
      if (bar) bar.className = "council-bar council-bar--idle";
    } else {
      if (summaryEl) summaryEl.textContent = `Error: ${e.message}`;
      if (bar) bar.className = "council-bar council-bar--error";
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    _state.running = false;
    showRunBtn();
    const barEl = document.getElementById("council-bar");
    const isComplete = barEl?.classList.contains("council-bar--complete") || barEl?.classList.contains("council-bar--all-pass") || barEl?.classList.contains("council-bar--has-fail");
    if (!isComplete && !abortCtrl.signal.aborted) {
      if (barEl?.classList.contains("council-bar--running")) {
        barEl.className = "council-bar council-bar--error";
        if (summaryEl) summaryEl.textContent = "Council stream ended unexpectedly. Try re-running.";
      }
      for (const ruleId of _state.ruleOrder) {
        if (_state.rules[ruleId]?.status === "running") {
          _state.rules[ruleId].status = "stopped";
        }
      }
    }
    const runBtn = document.getElementById("btn-run-council");
    if (runBtn) runBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Re-run';
  }
}

function _initRun() {
  const _state = getState();
  _state.running = true;
  _state.rules = {};
  _state.ruleOrder = [];
  _state.chairman = {};
  _state.totalRules = 0;
  _state.rulesDone = 0;

  const bar = document.getElementById("council-bar");
  const slotsEl = document.getElementById("council-slots");
  const summaryEl = document.getElementById("council-summary");
  const detailEl = document.getElementById("council-detail");
  const banner = document.getElementById("triage-banner");

  if (bar) bar.className = "council-bar council-bar--running";
  if (slotsEl) { slotsEl.innerHTML = ""; slotsEl.hidden = false; slotsEl.classList.remove("council-slots--grid"); }
  if (detailEl) { detailEl.innerHTML = ""; detailEl.hidden = true; }
  if (banner) { banner.innerHTML = ""; banner.hidden = true; }

  showStopBtn();
  document.querySelectorAll(".council-badge").forEach((b) => b.remove());
  document.querySelectorAll("[data-council-border]").forEach((el) => el.removeAttribute("data-council-border"));

  return { bar, slotsEl, summaryEl, detailEl };
}

export async function runCouncil(sessionId) {
  const _state = getState();
  if (_state.running) return;
  const { bar, slotsEl, summaryEl, detailEl } = _initRun();
  if (summaryEl) summaryEl.textContent = "Starting council...";

  const taskContent = document.getElementById("task-content");
  if (taskContent) taskContent.classList.remove("task-content--collapsed");

  await _runSSE(
    `${API_BASE}/api/tasks/${sessionId}/council-stream`,
    { method: "POST", headers: { "X-Reviewer-Email": getEmail() } },
    slotsEl, summaryEl, detailEl, bar,
  );
}

export async function runNotebookCouncil(notebookUrl) {
  const _state = getState();
  if (_state.running) return;
  const { bar, slotsEl, summaryEl, detailEl } = _initRun();
  if (summaryEl) summaryEl.textContent = "Starting council (notebook mode)...";

  await _runSSE(
    `${API_BASE}/api/notebook-council-stream`,
    { method: "POST", headers: { "Content-Type": "application/json", "X-Reviewer-Email": getEmail() }, body: JSON.stringify({ url: notebookUrl }) },
    slotsEl, summaryEl, detailEl, bar,
  );
}
