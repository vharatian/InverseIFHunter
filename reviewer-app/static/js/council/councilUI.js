/**
 * Council DOM rendering: rule cards, progress bar, buttons, badges, triage.
 */
import { escapeHtml } from "../task.js";
import { shortModel, modelAvatar } from "./councilModels.js";
import { RULE_SHORT_LABELS, RULE_BADGE_TARGETS } from "./councilRules.js";
import { getState } from "./councilState.js";

export function showRunBtn() {
  const runBtn = document.getElementById("btn-run-council");
  const stopBtn = document.getElementById("btn-stop-council");
  if (runBtn) { runBtn.hidden = false; runBtn.disabled = false; runBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Council'; }
  if (stopBtn) stopBtn.hidden = true;
}

export function showStopBtn() {
  const runBtn = document.getElementById("btn-run-council");
  const stopBtn = document.getElementById("btn-stop-council");
  if (runBtn) runBtn.hidden = true;
  if (stopBtn) stopBtn.hidden = false;
}

export function updateProgress(done, total, complete) {
  const bar = document.getElementById("council-bar");
  if (!bar) return;
  let progressWrap = bar.querySelector(".council-progress-wrap");
  if (!progressWrap) {
    progressWrap = document.createElement("div");
    progressWrap.className = "council-progress-wrap";
    progressWrap.innerHTML = '<div class="council-progress-bar"><div class="council-progress-fill"></div></div><span class="council-progress-text"></span>';
    const header = bar.querySelector(".council-bar-header");
    if (header) header.after(progressWrap);
  }
  const fill = progressWrap.querySelector(".council-progress-fill");
  const text = progressWrap.querySelector(".council-progress-text");
  if (complete) {
    if (fill) fill.style.width = "100%";
    if (text) text.textContent = `${total} of ${total} rules checked`;
  } else if (total > 0) {
    const pct = Math.round((done / total) * 100);
    if (fill) fill.style.width = `${pct}%`;
    if (text) text.textContent = `${done} of ${total} completed — checking rule ${done + 1}…`;
  } else {
    if (text) text.textContent = "Starting council…";
  }
}

export function upsertRuleCard(container, ruleId) {
  if (!container) return;
  const _state = getState();
  const rule = _state.rules[ruleId];
  if (!rule) return;
  let card = container.querySelector(`[data-rule="${ruleId}"]`);
  if (!card) {
    card = document.createElement("div");
    card.className = "qc-rule-card";
    card.setAttribute("data-rule", ruleId);
    container.appendChild(card);
  }

  const label = RULE_SHORT_LABELS[ruleId] || ruleId;
  const desc = rule.description || "";
  const status = rule.passed === true ? "pass" : rule.passed === false ? "fail" : "running";
  const icon = status === "pass" ? "\u2713" : status === "fail" ? "\u2717" : "\u23F3";
  const statusText = status === "running" ? "Checking..." : status === "pass" ? "Passed" : "Failed";

  let header = card.querySelector(".qc-rule-header");
  if (!header) {
    header = document.createElement("div");
    header.className = "qc-rule-header";
    card.prepend(header);
  }
  header.innerHTML = `<span class="qc-rule-title">${escapeHtml(label)}</span><span class="qc-rule-status qc-status-${status}">${icon} ${statusText}</span>`;

  let descEl = card.querySelector(".qc-rule-desc");
  if (desc && !descEl) {
    descEl = document.createElement("div");
    descEl.className = "qc-rule-desc";
    header.after(descEl);
  }
  if (descEl) descEl.textContent = desc;

  if (status !== "running") {
    if (rule.councilVotes?.length && !card.querySelector(".chat-thread")) {
      const responses = rule.councilResponses || {};
      const thread = document.createElement("div");
      thread.className = "chat-thread";
      for (const v of rule.councilVotes) {
        const mid = v.model_id || v.model || "";
        const vote = v.vote || "?";
        const reasoning = responses[mid] || rule.models?.[mid]?.chunks?.join("") || "";
        const msg = document.createElement("div");
        msg.className = "chat-msg";
        msg.innerHTML = `${modelAvatar(mid)}<div class="chat-bubble"><div class="chat-sender">${escapeHtml(shortModel(mid))}<span class="chat-verdict qc-vote qc-vote-${vote.toLowerCase()}">${vote}</span></div>${reasoning ? `<div class="chat-body">${escapeHtml(reasoning)}</div>` : ""}</div>`;
        thread.appendChild(msg);
      }
      card.appendChild(thread);
    }

    let issueBlock = card.querySelector(".qc-rule-issue-block");
    const hasIssue = rule.issue?.message;
    const hasHint = rule.issue?.hint;
    if (!issueBlock && (hasIssue || hasHint)) {
      issueBlock = document.createElement("div");
      issueBlock.className = "qc-rule-issue-block";
      card.appendChild(issueBlock);
    }
    if (issueBlock) {
      let html = "";
      if (hasIssue) html += `<div class="qc-issue-message">${escapeHtml(rule.issue.message)}</div>`;
      if (hasHint) html += `<div class="qc-issue-hint">${escapeHtml(rule.issue.hint)}</div>`;
      issueBlock.innerHTML = html;
    }
  }
}

export function injectBadges(ruleId, passed) {
  const targets = RULE_BADGE_TARGETS[ruleId] || [];
  const label = RULE_SHORT_LABELS[ruleId] || ruleId;
  for (const target of targets) {
    const el = document.querySelector(`[data-council-target="${target}"]`);
    if (!el) continue;
    const badge = document.createElement("span");
    badge.className = `council-badge council-badge--${passed ? "pass" : "fail"}`;
    badge.textContent = passed ? "PASS" : "FAIL";
    badge.title = label;
    const header = el.querySelector(".section-card-header, .task-slot-header, .slot-judgment-title");
    (header || el).appendChild(badge);
    if (!passed) el.setAttribute("data-council-border", "fail");
    else if (!el.hasAttribute("data-council-border")) el.setAttribute("data-council-border", "pass");
  }
}

export function applyTriageMode(issues) {
  const _state = getState();
  const failCount = _state.ruleOrder.filter((r) => !_state.rules[r]?.passed).length;
  const hasSafety = !_state.rules["safety_context_aware"]?.passed;
  const triage = failCount === 0 ? "green" : (hasSafety || failCount >= 3) ? "red" : "amber";

  const banner = document.getElementById("triage-banner");
  if (!banner) return;
  banner.hidden = false;

  const failedRules = _state.ruleOrder.filter((r) => !_state.rules[r]?.passed);
  const total = _state.ruleOrder.length;

  if (triage === "green") {
    banner.className = "triage-banner triage-banner--green";
    banner.innerHTML = `<div class="triage-banner-content"><div class="triage-icon-row"><span class="triage-check-icon">&#10003;</span><span class="triage-title">All ${total} checks passed</span></div><p class="triage-subtitle">Council found no issues.</p></div>`;
  } else {
    const cls = triage === "amber" ? "triage-banner--amber" : "triage-banner--red";
    const iconEl = triage === "amber" ? '<span class="triage-warn-icon">!</span>' : '<span class="triage-danger-icon">&#10007;</span>';
    const briefings = failedRules.map((r) => {
      const rule = _state.rules[r];
      return `<div class="triage-briefing-item"><span class="triage-briefing-rule">${escapeHtml(RULE_SHORT_LABELS[r] || r)}</span><span class="triage-briefing-msg">${escapeHtml(rule?.issue?.message || rule?.description || "Failed")}</span></div>`;
    }).join("");
    banner.className = `triage-banner ${cls}`;
    banner.innerHTML = `<div class="triage-banner-content"><div class="triage-icon-row">${iconEl}<span class="triage-title">${failedRules.length} issue${failedRules.length > 1 ? "s" : ""} found</span></div><div class="triage-briefings">${briefings}</div></div>`;
  }
}
