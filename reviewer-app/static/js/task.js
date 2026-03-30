/**
 * Task view: render prompt, criteria, slot cards with split human/LLM judgment,
 * pass/fail coloring, staggered entrance animations, agent result.
 */
import { api } from "./api.js";

export const FEEDBACK_ENABLED = false; // PAUSED: re-enable when feedback UI is ready

const SLOT_IDS = ["slot_1", "slot_2", "slot_3", "slot_4"];

/**
 * @param {string} sessionId
 * @returns {Promise<{ sessionId: string, task: any }>}
 */
export async function loadTask(sessionId) {
  const task = await api("/api/tasks/" + sessionId);
  return { sessionId, task };
}

/**
 * Render task content: expandable prompt, criteria card, full-width slot cards.
 */
export function renderTaskContent(container, snapshot, feedback) {
  if (!container || !snapshot) return;
  container.innerHTML = "";

  const prompt = (snapshot.prompt || "").trim() || "(no prompt)";
  const idealResponse = (snapshot.ideal_response || "").trim();
  const criteria = snapshot.criteria || [];
  const selectedHunts = snapshot.selected_hunts || [];
  const humanReviews = snapshot.human_reviews || [];
  const reviewsByHuntId = new Map(humanReviews.map((hr) => [hr.hunt_id, hr]));
  const sectionFeedback = (feedback?.section_feedback || feedback?.section_comments || []);
  const bySection = new Map(sectionFeedback.map((s) => [s.section_id, s]));

  const taskMeta = snapshot.metadata?.task_metadata || {};
  if (Object.keys(taskMeta).length > 0) {
    container.appendChild(_buildMetadataBar(taskMeta));
  }
  container.appendChild(_buildPromptSection(prompt));
  if (idealResponse) {
    container.appendChild(_buildIdealResponseSection(idealResponse));
  }
  if (criteria.length > 0) {
    container.appendChild(_buildCriteriaSection(criteria));
  }
  container.appendChild(_buildSlotsSection(selectedHunts, reviewsByHuntId, bySection));
}

function _buildMetadataBar(taskMeta) {
  const bar = document.createElement("div");
  bar.className = "task-metadata-bar";
  bar.setAttribute("data-council-target", "metadata");
  const labels = {
    domain: "Domain",
    use_case: "Use Case",
    l1_taxonomy: "L1 Taxonomy",
    model: "Model",
  };
  for (const [key, label] of Object.entries(labels)) {
    const val = taskMeta[key];
    if (!val) continue;
    const chip = document.createElement("span");
    chip.className = "metadata-chip";
    chip.innerHTML = `<span class="metadata-chip-label">${escapeHtml(label)}</span><span class="metadata-chip-value">${escapeHtml(val)}</span>`;
    bar.appendChild(chip);
  }
  return bar;
}

function _buildPromptSection(prompt) {
  const card = _createSectionCard("Prompt");
  card.setAttribute("data-council-target", "prompt");
  const body = card.querySelector(".section-card-body");

  const textEl = document.createElement("div");
  textEl.className = "task-prompt-text";
  textEl.textContent = prompt;
  body.appendChild(textEl);

  const needsCollapse = prompt.length > 300 || prompt.split("\n").length > 5;
  if (needsCollapse) {
    textEl.classList.add("prompt-collapsed");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-expand-prompt";
    btn.innerHTML = "\u25BC Show full prompt";
    btn.addEventListener("click", () => {
      const isCollapsed = textEl.classList.contains("prompt-collapsed");
      textEl.classList.toggle("prompt-collapsed", !isCollapsed);
      btn.innerHTML = isCollapsed ? "\u25B2 Collapse prompt" : "\u25BC Show full prompt";
    });
    body.appendChild(btn);
  }

  return card;
}

function _buildIdealResponseSection(idealResponse) {
  const card = _createSectionCard("Ideal Response");
  const body = card.querySelector(".section-card-body");

  const textEl = document.createElement("div");
  textEl.className = "task-ideal-response-text";
  textEl.textContent = idealResponse;
  body.appendChild(textEl);

  const needsCollapse = idealResponse.length > 400 || idealResponse.split("\n").length > 6;
  if (needsCollapse) {
    textEl.classList.add("prompt-collapsed");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-expand-prompt";
    btn.innerHTML = "\u25BC Show full response";
    btn.addEventListener("click", () => {
      const isCollapsed = textEl.classList.contains("prompt-collapsed");
      textEl.classList.toggle("prompt-collapsed", !isCollapsed);
      btn.innerHTML = isCollapsed ? "\u25B2 Collapse" : "\u25BC Show full response";
    });
    body.appendChild(btn);
  }

  return card;
}

function _buildCriteriaSection(criteria) {
  const card = _createSectionCard(`Criteria (${criteria.length})`);
  card.setAttribute("data-council-target", "criteria");
  const body = card.querySelector(".section-card-body");

  const ul = document.createElement("ul");
  ul.className = "task-criteria-list";
  criteria.forEach((c) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="criteria-id">${escapeHtml((c.id || "").toString())}</span><span>${escapeHtml((c.description || "").toString())}</span>`;
    ul.appendChild(li);
  });
  body.appendChild(ul);
  return card;
}

/** Normalize a raw grade value to "pass", "fail", or null. */
function _normalizeGrade(raw) {
  const s = String(raw).toLowerCase().trim();
  if (s === "pass" || s === "1" || s === "true" || s === "yes") return "pass";
  if (s === "fail" || s === "0" || s === "false" || s === "no") return "fail";
  return null;
}

/** Build the grades element for a judgment block. */
function _buildGradesEl(grades) {
  const el = document.createElement("div");
  el.className = "task-slot-grades";
  Object.entries(grades).forEach(([k, v]) => {
    const norm = _normalizeGrade(v);
    const span = document.createElement("span");
    span.className = `grade grade-${norm || "unknown"}`;
    span.title = k;
    span.innerHTML = `<span class="grade-key">${escapeHtml(k)}</span><strong class="grade-val">${norm ? norm.toUpperCase() : escapeHtml(String(v))}</strong>`;
    el.appendChild(span);
  });
  return el;
}

function _buildSlotsSection(selectedHunts, reviewsByHuntId, bySection) {
  const wrapper = document.createElement("div");

  const label = document.createElement("label");
  label.className = "section-label";
  label.textContent = "Selected Responses";
  wrapper.appendChild(label);

  const grid = document.createElement("div");
  grid.className = "task-slots-grid";

  selectedHunts.slice(0, 4).forEach((hunt, index) => {
    const slotId = SLOT_IDS[index] || `slot_${index + 1}`;
    const hr = reviewsByHuntId.get(hunt.hunt_id);
    const humanGrades = hr?.grades || {};
    const humanExplanation = (hr?.explanation || "").trim();

    const llmGrades = hunt.judge_criteria || {};
    const llmExplanation = (hunt.judge_explanation || "").trim();
    const llmScore = hunt.judge_score;

    const response = (hunt.response || "").trim();
    const model = hunt.model || "\u2014";
    const sf = bySection.get(slotId) || {};

    const humanGradeNorms = Object.values(humanGrades).map(_normalizeGrade);
    const allPass = humanGradeNorms.length > 0 && humanGradeNorms.every((v) => v === "pass");
    const anyFail = humanGradeNorms.some((v) => v === "fail");

    const card = document.createElement("div");
    card.className = "task-slot-card";
    if (allPass) card.classList.add("slot-pass");
    else if (anyFail) card.classList.add("slot-fail");
    card.dataset.slotId = slotId;
    card.setAttribute("data-council-target", `slot-${index}`);
    card.style.animationDelay = `${index * 0.08}s`;
    card.classList.add("slot-enter");

    // Header
    const header = document.createElement("div");
    header.className = "task-slot-header";
    const statusBadge = allPass
      ? `<span class="slot-verdict slot-verdict--pass">PASS</span>`
      : anyFail
      ? `<span class="slot-verdict slot-verdict--fail">FAIL</span>`
      : `<span class="slot-verdict slot-verdict--pending">PENDING</span>`;
    header.innerHTML = `<span class="slot-number">Slot ${index + 1}</span><span class="slot-model">${escapeHtml(model)}</span>${statusBadge}`;
    card.appendChild(header);

    // Two-column body: response LEFT, judgments RIGHT
    const body = document.createElement("div");
    body.className = "task-slot-body";

    // ── LEFT: response only ──
    const left = document.createElement("div");
    left.className = "slot-left";

    const responseSection = document.createElement("div");
    responseSection.className = "slot-section";
    responseSection.innerHTML = `<div class="slot-section-label">Response</div>`;
    const responseText = document.createElement("div");
    responseText.className = "task-slot-response";
    responseText.textContent = response || "(no response)";
    responseSection.appendChild(responseText);
    left.appendChild(responseSection);

    body.appendChild(left);

    // ── RIGHT: human + LLM judgment ──
    const right = document.createElement("div");
    right.className = "slot-right";

    const humanBlock = document.createElement("div");
    humanBlock.className = "slot-judgment-block slot-judgment-human";
    humanBlock.setAttribute("data-council-target", `explanation-${index}`);

    const humanTitle = document.createElement("div");
    humanTitle.className = "slot-judgment-title";
    humanTitle.textContent = "Human Judgment";
    humanBlock.appendChild(humanTitle);

    if (Object.keys(humanGrades).length > 0) {
      humanBlock.appendChild(_buildGradesEl(humanGrades));
    } else {
      const noGrades = document.createElement("span");
      noGrades.className = "slot-no-data";
      noGrades.textContent = "No grades yet";
      humanBlock.appendChild(noGrades);
    }

    if (humanExplanation) {
      const expEl = document.createElement("div");
      expEl.className = "slot-explanation-block";
      expEl.innerHTML = `<div class="slot-section-sublabel">Explanation</div>`;
      const expText = document.createElement("div");
      expText.className = "task-slot-explanation";
      expText.textContent = humanExplanation;
      expEl.appendChild(expText);
      humanBlock.appendChild(expEl);
    }
    right.appendChild(humanBlock);

    const llmBlock = document.createElement("div");
    llmBlock.className = "slot-judgment-block slot-judgment-llm";

    const llmTitle = document.createElement("div");
    llmTitle.className = "slot-judgment-title";
    llmTitle.innerHTML = `LLM Judgment${llmScore !== null && llmScore !== undefined ? ` <span class="llm-score">score: ${llmScore}</span>` : ""}`;
    llmBlock.appendChild(llmTitle);

    if (Object.keys(llmGrades).length > 0) {
      llmBlock.appendChild(_buildGradesEl(llmGrades));
    } else {
      const noLlm = document.createElement("span");
      noLlm.className = "slot-no-data";
      noLlm.textContent = "No LLM grades";
      llmBlock.appendChild(noLlm);
    }

    if (llmExplanation) {
      const llmExpEl = document.createElement("div");
      llmExpEl.className = "slot-explanation-block";
      llmExpEl.innerHTML = `<div class="slot-section-sublabel">Explanation</div>`;
      const llmExpText = document.createElement("div");
      llmExpText.className = "task-slot-explanation";
      llmExpText.textContent = llmExplanation;
      llmExpEl.appendChild(llmExpText);
      llmBlock.appendChild(llmExpEl);
    }
    right.appendChild(llmBlock);

    if (FEEDBACK_ENABLED) {
      const commentSection = document.createElement("div");
      commentSection.className = "slot-section";
      commentSection.innerHTML = `<div class="slot-section-label">Your Comment</div><textarea id="section-comment-${slotId}" rows="4" placeholder="Comment on this slot...">${escapeHtml(sf.comment || "")}</textarea>`;
      right.appendChild(commentSection);
      const appreciationSection = document.createElement("div");
      appreciationSection.className = "slot-section";
      appreciationSection.innerHTML = `<div class="slot-section-label">What Was Good</div><textarea id="section-appreciation-${slotId}" rows="2" placeholder="Optional...">${escapeHtml(sf.appreciation || "")}</textarea>`;
      right.appendChild(appreciationSection);
    }

    body.appendChild(right);

    card.appendChild(body);

    if (FEEDBACK_ENABLED) {
      const footer = document.createElement("div");
      footer.className = "slot-revision-footer";
      footer.innerHTML =
        `<span class="footer-title">Flag for Revision</span>` +
        _buildToggle(`slot_${index + 1}_grade`, "Grade") +
        _buildToggle(`slot_${index + 1}_explanation`, "Explanation");
      card.appendChild(footer);
    }

    grid.appendChild(card);
  });

  wrapper.appendChild(grid);
  return wrapper;
}

function _buildToggle(flagId, label) {
  return `<label class="slot-revision-item" data-flag-item="${flagId}">
    <span class="toggle-switch">
      <input type="checkbox" class="revision-flag-toggle" data-flag="${flagId}" />
      <span class="toggle-track"></span>
    </span>
    <span>${escapeHtml(label)}</span>
  </label>`;
}

function _createSectionCard(title) {
  const card = document.createElement("div");
  card.className = "section-card";

  const header = document.createElement("div");
  header.className = "section-card-header";
  header.innerHTML = `<h4>${escapeHtml(title)}</h4><span class="chevron">\u25BC</span>`;

  const body = document.createElement("div");
  body.className = "section-card-body";

  header.addEventListener("click", () => {
    const isCollapsed = header.classList.contains("collapsed");
    header.classList.toggle("collapsed", !isCollapsed);
    body.classList.toggle("collapsed", !isCollapsed);
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

export function renderAgentResult(agentResult) {
  const out = document.getElementById("agent-output");
  if (!out) return;

  if (!agentResult) {
    out.innerHTML = "";
    out.className = "agent-output empty";
    const empty = document.createElement("div");
    empty.className = "agent-empty-state";
    empty.textContent = "No agent run yet. Click \"Run agent\" to get an AI review.";
    out.appendChild(empty);
    return;
  }

  out.innerHTML = "";
  out.className = "agent-output";

  // ── Rule Engine Results Panel ──────────────────────────────────────────
  const ruleResults = agentResult.rule_results || [];
  if (ruleResults.length > 0) {
    out.appendChild(_buildRuleResultsPanel(ruleResults, agentResult.weighted_score));
  }

  // ── LLM Review Panel ──────────────────────────────────────────────────
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

/** Build the rule engine results panel with pass/fail per rule + weighted score. */
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

    const icon = rule.passed ? "✓" : "✗";
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
      const msgEl = document.createElement("div");
      msgEl.className = "rule-message";
      msgEl.textContent = rule.message;
      info.appendChild(msgEl);
      if (rule.hint) {
        const hintEl = document.createElement("div");
        hintEl.className = "rule-hint";
        hintEl.textContent = rule.hint;
        info.appendChild(hintEl);
      }
    }

    const badge = document.createElement("span");
    badge.className = `rule-badge ${rule.passed ? "rule-badge-pass" : `rule-badge-${rule.severity || "error"}`}`;
    badge.textContent = rule.passed ? "PASS" : (rule.severity || "FAIL").toUpperCase();

    row.appendChild(iconEl);
    row.appendChild(info);
    row.appendChild(badge);
    list.appendChild(row);
  });

  panel.appendChild(list);
  return panel;
}

/** Render markdown-style sections (## Header + body) as styled HTML blocks. */
function _renderMarkdownSections(text) {
  const container = document.createElement("div");
  container.className = "agent-review-sections";

  const sections = text.split(/^## /m).filter(Boolean);
  if (sections.length <= 1) {
    // No sections found — render as plain pre
    const pre = document.createElement("pre");
    pre.className = "agent-review-plain";
    pre.textContent = text;
    container.appendChild(pre);
    return container;
  }

  sections.forEach((section) => {
    const newlineIdx = section.indexOf("\n");
    const title = newlineIdx === -1 ? section.trim() : section.slice(0, newlineIdx).trim();
    const body = newlineIdx === -1 ? "" : section.slice(newlineIdx + 1).trim();

    const sectionEl = document.createElement("div");
    sectionEl.className = "agent-review-section";

    const titleEl = document.createElement("div");
    titleEl.className = "agent-review-section-title";
    titleEl.textContent = title;
    sectionEl.appendChild(titleEl);

    if (body) {
      const bodyEl = document.createElement("div");
      bodyEl.className = "agent-review-section-body";
      // Render bullet lines
      const lines = body.split("\n");
      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || /^\d+\./.test(trimmed)) {
          const li = document.createElement("div");
          li.className = "agent-review-bullet";
          li.textContent = trimmed.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
          // Re-prepend the numbering or bullet marker
          if (/^\d+\./.test(trimmed)) {
            const match = trimmed.match(/^(\d+\.)\s+(.*)/);
            if (match) {
              li.innerHTML = `<span class="bullet-num">${escapeHtml(match[1])}</span> ${escapeHtml(match[2])}`;
            } else {
              li.textContent = trimmed;
            }
          } else {
            li.innerHTML = `<span class="bullet-dot">\u2022</span> ${escapeHtml(trimmed.replace(/^[-*]\s+/, ""))}`;
          }
          bodyEl.appendChild(li);
        } else {
          const p = document.createElement("p");
          p.className = "agent-review-para";
          p.textContent = trimmed;
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
  if (!agentResult || agentResult.error || !agentResult.review_text) {
    container.hidden = true;
    return;
  }
  const text = (agentResult.review_text || "").trim();
  const short = text.split(/\n/)[0] || text.slice(0, 200);
  container.hidden = false;
  container.textContent = short + (text.length > short.length ? "\u2026" : "");
}

export function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

