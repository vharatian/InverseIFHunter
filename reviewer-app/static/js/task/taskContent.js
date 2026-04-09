/**
 * Task content rendering: prompt, ideal response, criteria, metadata bar.
 */
import { escapeHtml } from "./taskUtils.js";
import { buildSlotsSection, createSectionCard } from "./taskSlots.js";

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
  container.appendChild(buildSlotsSection(selectedHunts, reviewsByHuntId, bySection));
}

function _buildMetadataBar(taskMeta) {
  const bar = document.createElement("div");
  bar.className = "task-metadata-bar";
  bar.setAttribute("data-council-target", "metadata");
  const labels = { domain: "Domain", use_case: "Use Case", l1_taxonomy: "L1 Taxonomy", model: "Model" };
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
  const card = createSectionCard("Prompt");
  card.setAttribute("data-council-target", "prompt");
  const body = card.querySelector(".section-card-body");
  const textEl = document.createElement("div");
  textEl.className = "task-prompt-text";
  textEl.textContent = prompt;
  body.appendChild(textEl);
  if (prompt.length > 300 || prompt.split("\n").length > 5) {
    textEl.classList.add("prompt-collapsed");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-expand-prompt";
    btn.innerHTML = "\u25BC Show full prompt";
    btn.addEventListener("click", () => {
      const c = textEl.classList.contains("prompt-collapsed");
      textEl.classList.toggle("prompt-collapsed", !c);
      btn.innerHTML = c ? "\u25B2 Collapse prompt" : "\u25BC Show full prompt";
    });
    body.appendChild(btn);
  }
  return card;
}

function _buildIdealResponseSection(idealResponse) {
  const card = createSectionCard("Ideal Response");
  const body = card.querySelector(".section-card-body");
  const textEl = document.createElement("div");
  textEl.className = "task-ideal-response-text";
  textEl.textContent = idealResponse;
  body.appendChild(textEl);
  if (idealResponse.length > 400 || idealResponse.split("\n").length > 6) {
    textEl.classList.add("prompt-collapsed");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-expand-prompt";
    btn.innerHTML = "\u25BC Show full response";
    btn.addEventListener("click", () => {
      const c = textEl.classList.contains("prompt-collapsed");
      textEl.classList.toggle("prompt-collapsed", !c);
      btn.innerHTML = c ? "\u25B2 Collapse" : "\u25BC Show full response";
    });
    body.appendChild(btn);
  }
  return card;
}

function _buildCriteriaSection(criteria) {
  const card = createSectionCard(`Criteria (${criteria.length})`);
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
