/**
 * Task view: render prompt (expandable), criteria (own section), slot cards (split layout),
 * pass/fail coloring, staggered entrance animations, agent result.
 */
import { api } from "./api.js";

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
 * Render task content: expandable prompt, criteria card, full-width slot cards with split layout.
 */
export function renderTaskContent(container, snapshot, feedback) {
  if (!container || !snapshot) return;
  container.innerHTML = "";

  const prompt = (snapshot.prompt || "").trim() || "(no prompt)";
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
  if (criteria.length > 0) {
    container.appendChild(_buildCriteriaSection(criteria));
  }
  container.appendChild(_buildSlotsSection(selectedHunts, reviewsByHuntId, bySection, criteria));
}

function _buildMetadataBar(taskMeta) {
  const bar = document.createElement("div");
  bar.className = "task-metadata-bar";
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
  const card = _createSectionCard("Prompt", "prompt-icon");
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

function _buildCriteriaSection(criteria) {
  const card = _createSectionCard(`Criteria (${criteria.length})`);
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

function _buildSlotsSection(selectedHunts, reviewsByHuntId, bySection, criteria) {
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
    const grades = hr?.grades || {};
    const humanExplanation = (hr?.explanation || "").trim();
    const llmExplanation = (hunt.judge_explanation || "").trim();
    const response = (hunt.response || "").trim();
    const model = hunt.model || "\u2014";
    const sf = bySection.get(slotId) || {};

    const gradeValues = Object.values(grades).map((v) => String(v).toLowerCase());
    const allPass = gradeValues.length > 0 && gradeValues.every((v) => v === "pass");
    const anyFail = gradeValues.some((v) => v === "fail");

    const card = document.createElement("div");
    card.className = "task-slot-card";
    if (allPass) card.classList.add("slot-pass");
    else if (anyFail) card.classList.add("slot-fail");
    card.dataset.slotId = slotId;

    card.style.animationDelay = `${index * 0.08}s`;
    card.classList.add("slot-enter");

    // Header
    const header = document.createElement("div");
    header.className = "task-slot-header";
    const statusDot = allPass ? '<span class="slot-status-dot dot-pass" title="All pass"></span>'
                    : anyFail ? '<span class="slot-status-dot dot-fail" title="Has failures"></span>'
                    : '';
    header.innerHTML = `<span class="slot-number">Slot ${index + 1}</span><span class="slot-model">${escapeHtml(model)}</span>${statusDot}`;
    card.appendChild(header);

    // Two-column body
    const body = document.createElement("div");
    body.className = "task-slot-body";

    // Left: response, grades, explanations
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

    if (Object.keys(grades).length > 0) {
      const gradesSection = document.createElement("div");
      gradesSection.className = "slot-section";
      gradesSection.innerHTML = `<div class="slot-section-label">Grades</div><div class="task-slot-grades">${Object.entries(grades).map(([k, v]) =>
        `<span class="grade grade-${String(v).toLowerCase()}" title="${escapeHtml(k)}">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`
      ).join("")}</div>`;
      left.appendChild(gradesSection);
    }

    if (humanExplanation) {
      const humanSection = document.createElement("div");
      humanSection.className = "slot-section";
      humanSection.innerHTML = `<div class="slot-section-label">Human Explanation</div>`;
      const humanText = document.createElement("div");
      humanText.className = "task-slot-explanation";
      humanText.textContent = humanExplanation;
      humanSection.appendChild(humanText);
      left.appendChild(humanSection);
    }

    if (llmExplanation) {
      const llmSection = document.createElement("div");
      llmSection.className = "slot-section";
      llmSection.innerHTML = `<div class="slot-section-label">LLM Explanation</div>`;
      const llmText = document.createElement("div");
      llmText.className = "task-slot-explanation";
      llmText.textContent = llmExplanation;
      llmSection.appendChild(llmText);
      left.appendChild(llmSection);
    }

    body.appendChild(left);

    const right = document.createElement("div");
    right.className = "slot-right";

    const commentSection = document.createElement("div");
    commentSection.className = "slot-section";
    commentSection.innerHTML = `<div class="slot-section-label">Your Comment</div><textarea id="section-comment-${slotId}" rows="4" placeholder="Comment on this slot...">${escapeHtml(sf.comment || "")}</textarea>`;
    right.appendChild(commentSection);

    const appreciationSection = document.createElement("div");
    appreciationSection.className = "slot-section";
    appreciationSection.innerHTML = `<div class="slot-section-label">What Was Good</div><textarea id="section-appreciation-${slotId}" rows="2" placeholder="Optional...">${escapeHtml(sf.appreciation || "")}</textarea>`;
    right.appendChild(appreciationSection);

    body.appendChild(right);
    card.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "slot-revision-footer";
    footer.innerHTML = `<span class="footer-title">Flag for Revision</span>` +
      _buildToggle(`slot_${index + 1}_grade`, "Grade") +
      _buildToggle(`slot_${index + 1}_explanation`, "Explanation");
    card.appendChild(footer);

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
    out.textContent = "No agent run yet. Click \"Run agent\" to get an AI review.";
    out.className = "agent-output empty";
    return;
  }
  if (agentResult.error) {
    out.textContent = "Error: " + agentResult.error + (agentResult.review_text ? "\n\n" + agentResult.review_text : "");
    out.className = "agent-output error";
    return;
  }
  out.textContent = (agentResult.review_text || "(empty)") + "\n\n---\nModel: " + (agentResult.model_used || "") + " \u00b7 " + (agentResult.timestamp || "");
  out.className = "agent-output";
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

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
