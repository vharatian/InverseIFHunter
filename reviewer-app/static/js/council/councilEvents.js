/**
 * SSE event dispatcher: handles all council streaming event types.
 */
import { escapeHtml } from "../task.js";
import { showToast } from "../dom.js";
import { onCouncilComplete as _notifyUpdateSystem } from "../api.js";
import { shortModel, modelAvatar } from "./councilModels.js";
import { getState } from "./councilState.js";
import { updateProgress, upsertRuleCard } from "./councilUI.js";

export function handleEvent(evt, slotsEl, summaryEl, detailEl) {
  const type = evt.type;
  const _state = getState();

  if (type === "council_init") {
    _state.totalRules = evt.total_rules || 0;
    updateProgress(0, _state.totalRules, false);
  }
  else if (type === "rule_start") {
    _state.ruleOrder.push(evt.rule_id);
    _state.rules[evt.rule_id] = {
      id: evt.rule_id, description: evt.description, status: "running",
      models: {}, passed: null, councilVotes: [], chairman: null, issue: null,
      content_checked: evt.content_checked || "",
    };
    updateProgress(_state.rulesDone || 0, _state.totalRules || 0, false);
    upsertRuleCard(slotsEl, evt.rule_id);
    if (summaryEl) summaryEl.textContent = `Checking: ${evt.description}`;
  }
  else if (type === "council_model_start") {
    const card = slotsEl?.querySelector(`[data-rule="${evt.rule_id}"]`);
    if (!card) return;
    let thread = card.querySelector(".chat-thread");
    if (!thread) {
      thread = document.createElement("div");
      thread.className = "chat-thread";
      card.appendChild(thread);
    }
    const mid = evt.model_id || "";
    const msg = document.createElement("div");
    msg.className = "chat-msg";
    msg.setAttribute("data-model-id", mid);
    msg.innerHTML = `${modelAvatar(mid)}<div class="chat-bubble chat-bubble--streaming"><div class="chat-sender">${escapeHtml(shortModel(mid))}<span class="chat-verdict qc-vote qc-vote-pending">thinking...</span></div><div class="chat-body"></div></div>`;
    thread.appendChild(msg);
    msg.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const rule = _state.rules[evt.rule_id];
    if (rule) rule.models[mid] = { vote: null, status: "running", chunks: [] };
  }
  else if (type === "council_model_chunk") {
    const card = slotsEl?.querySelector(`[data-rule="${evt.rule_id}"]`);
    if (!card) return;
    const msg = card.querySelector(`.chat-msg[data-model-id="${evt.model_id || ""}"]`);
    if (msg) {
      const body = msg.querySelector(".chat-body");
      if (body) body.textContent += evt.chunk || "";
    }
    const rule = _state.rules[evt.rule_id];
    if (rule?.models[evt.model_id]) rule.models[evt.model_id].chunks.push(evt.chunk || "");
  }
  else if (type === "council_model_verdict") {
    const card = slotsEl?.querySelector(`[data-rule="${evt.rule_id}"]`);
    if (card) {
      const msg = card.querySelector(`.chat-msg[data-model-id="${evt.model_id || ""}"]`);
      if (msg) {
        const badge = msg.querySelector(".chat-verdict");
        const vote = evt.vote || "?";
        if (badge) { badge.textContent = vote; badge.className = `chat-verdict qc-vote qc-vote-${vote.toLowerCase()}`; }
        const bubble = msg.querySelector(".chat-bubble");
        if (bubble) bubble.classList.remove("chat-bubble--streaming");
        if (evt.response) {
          const body = msg.querySelector(".chat-body");
          if (body) body.textContent = evt.response;
        }
      }
    }
    const rule = _state.rules[evt.rule_id];
    if (rule) rule.models[evt.model_id] = { vote: evt.vote, status: "done", chunks: rule.models[evt.model_id]?.chunks || [] };
  }
  else if (type === "council_chairman_start") {
    const card = slotsEl?.querySelector(`[data-rule="${evt.rule_id}"]`);
    if (!card) return;
    let thread = card.querySelector(".chat-thread");
    if (!thread) { thread = document.createElement("div"); thread.className = "chat-thread"; card.appendChild(thread); }
    const mid = evt.model_id || "";
    const msg = document.createElement("div");
    msg.className = "chat-msg chat-msg--chairman";
    msg.setAttribute("data-model-id", "chairman");
    msg.innerHTML = `${modelAvatar(mid)}<div class="chat-bubble chat-bubble--chairman chat-bubble--streaming"><div class="chat-sender">Chairman: ${escapeHtml(shortModel(mid))}<span class="chat-verdict qc-vote qc-vote-pending">deciding...</span></div><div class="chat-body"></div></div>`;
    thread.appendChild(msg);
    msg.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  else if (type === "council_chairman_chunk") {
    const card = slotsEl?.querySelector(`[data-rule="${evt.rule_id}"]`);
    if (!card) return;
    const msg = card.querySelector('.chat-msg[data-model-id="chairman"]');
    if (msg) {
      const body = msg.querySelector(".chat-body");
      if (body) body.textContent += evt.chunk || "";
    }
  }
  else if (type === "council_chairman_verdict") {
    const card = slotsEl?.querySelector(`[data-rule="${evt.rule_id}"]`);
    if (!card) return;
    const msg = card.querySelector('.chat-msg[data-model-id="chairman"]');
    if (msg) {
      const badge = msg.querySelector(".chat-verdict");
      const v = evt.passed ? "PASS" : "FAIL";
      if (badge) { badge.textContent = v; badge.className = `chat-verdict qc-vote qc-vote-${v.toLowerCase()}`; }
      const bubble = msg.querySelector(".chat-bubble");
      if (bubble) bubble.classList.remove("chat-bubble--streaming");
      if (evt.rationale) {
        const body = msg.querySelector(".chat-body");
        if (body) body.textContent = evt.rationale;
      }
    }
  }
  else if (type === "rule_done") {
    const rule = _state.rules[evt.rule_id];
    if (rule) {
      rule.status = "done"; rule.passed = evt.passed;
      rule.councilVotes = evt.council_votes || [];
      rule.councilResponses = evt.council_responses || {};
      rule.issue = evt.issue; rule.rationale = evt.rationale;
    }
    _state.rulesDone = (_state.rulesDone || 0) + 1;
    updateProgress(_state.rulesDone, _state.totalRules || _state.ruleOrder.length, false);
    upsertRuleCard(slotsEl, evt.rule_id);
  }
  else if (type === "complete") {
    const bar = document.getElementById("council-bar");
    const passed = evt.passed;
    const issues = evt.issues || [];
    const total = _state.ruleOrder.length;
    const passCount = _state.ruleOrder.filter((r) => _state.rules[r]?.passed).length;
    updateProgress(total, total, true);
    if (bar) bar.className = `council-bar council-bar--complete ${passed ? "council-bar--all-pass" : "council-bar--has-fail"}`;
    if (summaryEl) {
      summaryEl.innerHTML = passed
        ? `<span class="council-summary-pass">${passCount}/${total} passed</span> — All checks clear`
        : `<span class="council-summary-fail">${passCount}/${total} passed</span> — ${issues.length} issue${issues.length > 1 ? "s" : ""} found`;
    }
    _notifyUpdateSystem();
    try {
      window.dispatchEvent(new CustomEvent("reviewer:council-complete", { detail: { passed, issues } }));
    } catch { /* ignore */ }
  }
  else if (type === "overall_start") {
    const container = slotsEl || document.getElementById("council-slots");
    if (container) {
      let card = container.querySelector(".overall-card");
      if (!card) {
        card = document.createElement("div");
        card.className = "overall-card";
        card.innerHTML = `<div class="overall-card-header">${modelAvatar(evt.model || "")}<span class="overall-card-title">Overall Assessment</span><span class="overall-card-badge">analyzing...</span></div><div class="overall-card-body overall-streaming"></div>`;
        container.appendChild(card);
      }
    }
  }
  else if (type === "overall_chunk") {
    const body = (slotsEl || document.getElementById("council-slots"))?.querySelector(".overall-card-body");
    if (body) body.textContent += evt.chunk || "";
  }
  else if (type === "overall_done") {
    const card = (slotsEl || document.getElementById("council-slots"))?.querySelector(".overall-card");
    if (card) {
      const body = card.querySelector(".overall-card-body");
      if (body) { body.classList.remove("overall-streaming"); if (evt.summary) body.textContent = evt.summary; }
      const badge = card.querySelector(".overall-card-badge");
      const text = (evt.summary || "").toUpperCase();
      const rating = text.startsWith("EXCELLENT") ? "excellent" : text.startsWith("GOOD") ? "good" : text.startsWith("NEEDS") ? "needs-work" : text.startsWith("POOR") ? "poor" : "neutral";
      if (badge) { badge.textContent = rating.replace("-", " ").toUpperCase(); badge.className = `overall-card-badge overall-badge--${rating}`; }
    }
  }
  else if (type === "error") {
    if (summaryEl) summaryEl.textContent = `Error: ${evt.message}`;
    const bar = document.getElementById("council-bar");
    if (bar) bar.className = "council-bar council-bar--error";
  }
  else if (type === "persist_warning") {
    showToast(evt.message || "Could not save council results.", "error");
  }
  else if (type === "status") {
    if (summaryEl) summaryEl.textContent = evt.message || "";
  }
}
