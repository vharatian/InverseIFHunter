/**
 * Agent result rendering: rule results panel, LLM review, summary.
 */
import { escapeHtml } from "./taskUtils.js";

export function renderAgentResult(agentResult) {
  const out = document.getElementById("agent-output");
  if (!out) return;

  if (!agentResult) {
    out.innerHTML = "";
    out.className = "agent-output empty";
    const empty = document.createElement("div");
    empty.className = "agent-empty-state";
    empty.textContent = 'No agent run yet. Click "Run agent" to get an AI review.';
    out.appendChild(empty);
    return;
  }

  out.innerHTML = "";
  out.className = "agent-output";

  const ruleResults = agentResult.rule_results || [];
  if (ruleResults.length > 0) {
    out.appendChild(_buildRuleResultsPanel(ruleResults, agentResult.weighted_score));
  }

  const reviewText = (agentResult.review_text || "").trim();
  const llmPanel = document.createElement("div");
  llmPanel.className = "agent-llm-panel";
  const llmHeader = document.createElement("div");
  llmHeader.className = "agent-panel-header";
  llmHeader.innerHTML = `<span class="agent-panel-title">AI Review</span><span class="agent-panel-meta">Model: ${escapeHtml(agentResult.model_used || "")} \u00b7 ${escapeHtml(agentResult.timestamp || "")}</span>`;
  llmPanel.appendChild(llmHeader);

  if (agentResult.error && !reviewText) {
    const errEl = document.createElement("div");
    errEl.className = "agent-llm-error";
    errEl.textContent = "Error: " + agentResult.error;
    llmPanel.appendChild(errEl);
  } else {
    if (agentResult.error) {
      const errEl = document.createElement("div");
      errEl.className = "agent-llm-error";
      errEl.textContent = "Warning: " + agentResult.error;
      llmPanel.appendChild(errEl);
    }
    const body = document.createElement("div");
    body.className = "agent-llm-body";
    body.appendChild(_renderMarkdownSections(reviewText || "(empty)"));
    llmPanel.appendChild(body);
  }
  out.appendChild(llmPanel);
}

function _buildRuleResultsPanel(ruleResults, weightedScore) {
  const panel = document.createElement("div");
  panel.className = "agent-rules-panel";
  const header = document.createElement("div");
  header.className = "agent-panel-header";
  const passed = ruleResults.filter((r) => r.passed).length;
  const total = ruleResults.length;
  const allPassed = passed === total;
  const scoreHtml = weightedScore !== null && weightedScore !== undefined
    ? `<span class="rules-weighted-score ${weightedScore >= 80 ? "score-good" : weightedScore >= 50 ? "score-warn" : "score-bad"}">${weightedScore}%</span>`
    : "";
  header.innerHTML = `<span class="agent-panel-title">QC Rules <span class="rules-summary ${allPassed ? "rules-all-pass" : "rules-has-fail"}">${passed}/${total} passed</span></span>${scoreHtml}`;
  panel.appendChild(header);

  const list = document.createElement("div");
  list.className = "agent-rules-list";
  ruleResults.forEach((rule) => {
    const row = document.createElement("div");
    row.className = `agent-rule-row ${rule.passed ? "rule-pass" : "rule-fail"}`;
    const icon = rule.passed ? "\u2713" : "\u2717";
    const iconEl = document.createElement("span");
    iconEl.className = `rule-icon ${rule.passed ? "rule-icon-pass" : "rule-icon-fail"}`;
    iconEl.textContent = icon;
    const info = document.createElement("div");
    info.className = "rule-info";
    const nameEl = document.createElement("div");
    nameEl.className = "rule-name";
    nameEl.textContent = rule.description || rule.rule_id;
    info.appendChild(nameEl);
    if (!rule.passed && rule.message) {
      const msgEl = document.createElement("div"); msgEl.className = "rule-message"; msgEl.textContent = rule.message;
      info.appendChild(msgEl);
      if (rule.hint) { const h = document.createElement("div"); h.className = "rule-hint"; h.textContent = rule.hint; info.appendChild(h); }
    }
    const badge = document.createElement("span");
    badge.className = `rule-badge ${rule.passed ? "rule-badge-pass" : `rule-badge-${rule.severity || "error"}`}`;
    badge.textContent = rule.passed ? "PASS" : (rule.severity || "FAIL").toUpperCase();
    row.appendChild(iconEl); row.appendChild(info); row.appendChild(badge);
    list.appendChild(row);
  });
  panel.appendChild(list);
  return panel;
}

function _renderMarkdownSections(text) {
  const container = document.createElement("div");
  container.className = "agent-review-sections";
  const sections = text.split(/^## /m).filter(Boolean);
  if (sections.length <= 1) {
    const pre = document.createElement("pre");
    pre.className = "agent-review-plain";
    pre.textContent = text;
    container.appendChild(pre);
    return container;
  }
  sections.forEach((section) => {
    const nl = section.indexOf("\n");
    const title = nl === -1 ? section.trim() : section.slice(0, nl).trim();
    const body = nl === -1 ? "" : section.slice(nl + 1).trim();
    const sectionEl = document.createElement("div");
    sectionEl.className = "agent-review-section";
    const titleEl = document.createElement("div");
    titleEl.className = "agent-review-section-title";
    titleEl.textContent = title;
    sectionEl.appendChild(titleEl);
    if (body) {
      const bodyEl = document.createElement("div");
      bodyEl.className = "agent-review-section-body";
      body.split("\n").forEach((line) => {
        const t = line.trim();
        if (!t) return;
        if (t.startsWith("- ") || t.startsWith("* ") || /^\d+\./.test(t)) {
          const li = document.createElement("div");
          li.className = "agent-review-bullet";
          const numMatch = t.match(/^(\d+\.)\s+(.*)/);
          if (numMatch) li.innerHTML = `<span class="bullet-num">${escapeHtml(numMatch[1])}</span> ${escapeHtml(numMatch[2])}`;
          else li.innerHTML = `<span class="bullet-dot">\u2022</span> ${escapeHtml(t.replace(/^[-*]\s+/, ""))}`;
          bodyEl.appendChild(li);
        } else {
          const p = document.createElement("p"); p.className = "agent-review-para"; p.textContent = t;
          bodyEl.appendChild(p);
        }
      });
      sectionEl.appendChild(bodyEl);
    }
    container.appendChild(sectionEl);
  });
  return container;
}

export function renderAgentSummaryAtTop(container, agentResult) {
  if (!container) return;
  if (!agentResult || agentResult.error || !agentResult.review_text) { container.hidden = true; return; }
  const text = (agentResult.review_text || "").trim();
  const short = text.split(/\n/)[0] || text.slice(0, 200);
  container.hidden = false;
  container.textContent = short + (text.length > short.length ? "\u2026" : "");
}
