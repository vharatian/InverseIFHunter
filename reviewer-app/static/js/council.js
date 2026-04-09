/**
 * Council orchestrator — thin entry point that wires submodules together.
 * All logic lives in council/ submodules.
 */
import { showToast } from "./dom.js";
import { loadCouncilModels } from "./council/councilModels.js";
import { showRulesModal } from "./council/councilRules.js";
import { getState, resetState, getCouncilState, ruleStateFromStored } from "./council/councilState.js";
import { showRunBtn, upsertRuleCard, injectBadges } from "./council/councilUI.js";
import { handleEvent } from "./council/councilEvents.js";
import { runCouncil, runNotebookCouncil } from "./council/councilStream.js";

let _getSessionId = () => null;
let _getNotebookUrl = () => null;

export function initCouncil(getSessionId, onApprove) {
  _getSessionId = getSessionId;
  loadCouncilModels();

  document.getElementById("btn-run-council")?.addEventListener("click", () => {
    const sid = _getSessionId();
    if (sid) {
      runCouncil(sid);
    } else {
      const nbUrl = _getNotebookUrl?.();
      if (nbUrl) {
        runNotebookCouncil(nbUrl);
      } else {
        showToast("Load a task or fetch a notebook first.", "info");
      }
    }
  });

  document.getElementById("btn-stop-council")?.addEventListener("click", () => {
    const s = getState();
    if (s.abortCtrl) s.abortCtrl.abort();
  });

  document.getElementById("btn-council-rules")?.addEventListener("click", showRulesModal);
}

export function resetCouncil() {
  resetState();

  const bar = document.getElementById("council-bar");
  if (bar) {
    bar.className = "council-bar council-bar--idle";
    const pw = bar.querySelector(".council-progress-wrap");
    if (pw) pw.remove();
  }

  const slots = document.getElementById("council-slots");
  if (slots) { slots.innerHTML = ""; slots.hidden = true; }

  const detail = document.getElementById("council-detail");
  if (detail) { detail.innerHTML = ""; detail.hidden = true; }

  const summary = document.getElementById("council-summary");
  if (summary) summary.textContent = "";

  const banner = document.getElementById("triage-banner");
  if (banner) { banner.innerHTML = ""; banner.hidden = true; }

  showRunBtn();
  document.querySelectorAll(".council-badge").forEach((b) => b.remove());
  document.querySelectorAll("[data-council-border]").forEach((el) => el.removeAttribute("data-council-border"));
}

export function setNotebookUrl(getUrl) {
  _getNotebookUrl = getUrl;
}

export function autoRunCouncil(sessionId) {
  if (!sessionId) return;
  setTimeout(() => runCouncil(sessionId), 300);
}

export { getCouncilState } from "./council/councilState.js";

export function restoreCouncilFromTask(lastCouncil) {
  if (!lastCouncil?.result?.complete) return;
  const { complete, rule_results } = lastCouncil.result;
  if (!complete || !Array.isArray(rule_results)) return;

  resetCouncil();
  const _state = getState();
  const slotsEl = document.getElementById("council-slots");
  const summaryEl = document.getElementById("council-summary");
  const detailEl = document.getElementById("council-detail");
  if (slotsEl) { slotsEl.innerHTML = ""; slotsEl.hidden = false; }

  for (const rd of rule_results) {
    if (!rd.rule_id) continue;
    _state.ruleOrder.push(rd.rule_id);
    _state.rules[rd.rule_id] = ruleStateFromStored(rd);
    upsertRuleCard(slotsEl, rd.rule_id);
    injectBadges(rd.rule_id, rd.passed);
  }
  handleEvent(complete, slotsEl, summaryEl, detailEl);
}
