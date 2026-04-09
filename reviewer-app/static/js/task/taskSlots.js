/**
 * Slot card rendering: two-column layout, grades, toggles.
 */
import { escapeHtml } from "./taskUtils.js";

const SLOT_IDS = ["slot_1", "slot_2", "slot_3", "slot_4"];
let FEEDBACK_ENABLED = false;

export function setFeedbackEnabled(val) { FEEDBACK_ENABLED = val; }

function _normalizeGrade(raw) {
  const s = String(raw).toLowerCase().trim();
  if (s === "pass" || s === "1" || s === "true" || s === "yes") return "pass";
  if (s === "fail" || s === "0" || s === "false" || s === "no") return "fail";
  return null;
}

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

function _buildToggle(flagId, label) {
  return `<label class="slot-revision-item" data-flag-item="${flagId}">
    <span class="toggle-switch"><input type="checkbox" class="revision-flag-toggle" data-flag="${flagId}" /><span class="toggle-track"></span></span>
    <span>${escapeHtml(label)}</span>
  </label>`;
}

export function createSectionCard(title) {
  const card = document.createElement("div");
  card.className = "section-card";
  const header = document.createElement("div");
  header.className = "section-card-header";
  header.innerHTML = `<h4>${escapeHtml(title)}</h4><span class="chevron">\u25BC</span>`;
  const body = document.createElement("div");
  body.className = "section-card-body";
  header.addEventListener("click", () => {
    const c = header.classList.contains("collapsed");
    header.classList.toggle("collapsed", !c);
    body.classList.toggle("collapsed", !c);
  });
  card.appendChild(header);
  card.appendChild(body);
  return card;
}

export function buildSlotsSection(selectedHunts, reviewsByHuntId, bySection) {
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

    const header = document.createElement("div");
    header.className = "task-slot-header";
    const statusBadge = allPass
      ? `<span class="slot-verdict slot-verdict--pass">PASS</span>`
      : anyFail
      ? `<span class="slot-verdict slot-verdict--fail">FAIL</span>`
      : `<span class="slot-verdict slot-verdict--pending">PENDING</span>`;
    header.innerHTML = `<span class="slot-number">Slot ${index + 1}</span><span class="slot-model">${escapeHtml(model)}</span>${statusBadge}`;
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "task-slot-body";

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
      const ng = document.createElement("span"); ng.className = "slot-no-data"; ng.textContent = "No grades yet";
      humanBlock.appendChild(ng);
    }
    if (humanExplanation) {
      const expEl = document.createElement("div");
      expEl.className = "slot-explanation-block";
      expEl.innerHTML = `<div class="slot-section-sublabel">Explanation</div>`;
      const expText = document.createElement("div"); expText.className = "task-slot-explanation"; expText.textContent = humanExplanation;
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
      const nl = document.createElement("span"); nl.className = "slot-no-data"; nl.textContent = "No LLM grades";
      llmBlock.appendChild(nl);
    }
    if (llmExplanation) {
      const llmExpEl = document.createElement("div");
      llmExpEl.className = "slot-explanation-block";
      llmExpEl.innerHTML = `<div class="slot-section-sublabel">Explanation</div>`;
      const llmExpText = document.createElement("div"); llmExpText.className = "task-slot-explanation"; llmExpText.textContent = llmExplanation;
      llmExpEl.appendChild(llmExpText);
      llmBlock.appendChild(llmExpEl);
    }
    right.appendChild(llmBlock);

    if (FEEDBACK_ENABLED) {
      right.innerHTML += `<div class="slot-section"><div class="slot-section-label">Your Comment</div><textarea id="section-comment-${slotId}" rows="4" placeholder="Comment...">${escapeHtml(sf.comment || "")}</textarea></div>`;
      right.innerHTML += `<div class="slot-section"><div class="slot-section-label">What Was Good</div><textarea id="section-appreciation-${slotId}" rows="2" placeholder="Optional...">${escapeHtml(sf.appreciation || "")}</textarea></div>`;
    }
    body.appendChild(right);
    card.appendChild(body);

    if (FEEDBACK_ENABLED) {
      const footer = document.createElement("div");
      footer.className = "slot-revision-footer";
      footer.innerHTML = `<span class="footer-title">Flag for Revision</span>` + _buildToggle(`slot_${index + 1}_grade`, "Grade") + _buildToggle(`slot_${index + 1}_explanation`, "Explanation");
      card.appendChild(footer);
    }

    grid.appendChild(card);
  });

  wrapper.appendChild(grid);
  return wrapper;
}
