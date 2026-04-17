/** Render the notebook-preview body from the /api/notebook-preview response. */
import { escapeHtml } from "../task.js";
import { formatJudgment } from "./judgment.js";

export function renderNotebookPreviewBody(data) {
  const warnings = data.warnings || [];
  const prompt = escapeHtml(data.prompt || "(no prompt)");
  const idealResponse = (data.ideal_response || "").trim();
  const criteria = data.criteria || [];
  const slots = data.slots || [];
  const meta = data.metadata || {};
  const extraCells = data.extra_cells || [];

  return (
    _warningsBlock(warnings) +
    _metaChipsBlock(meta) +
    _taskContextBlock(prompt, idealResponse, criteria) +
    _slotsBlock(slots) +
    _extraCellsBlock(extraCells)
  );
}

function _warningsBlock(warnings) {
  if (!warnings.length) return "";
  return `<div class="nbp-warnings" role="alert"><strong>Notice:</strong> ${warnings
    .map((w) => escapeHtml(w))
    .join(" ")}</div>`;
}

function _metaChipsBlock(meta) {
  const keys = Object.keys(meta || {});
  if (!keys.length) return "";
  const chips = keys
    .map((k) => {
      const label = k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return `<span class="meta-chip"><span class="meta-chip-key">${escapeHtml(label)}</span><span class="meta-chip-val">${escapeHtml(meta[k])}</span></span>`;
    })
    .join("");
  return `<div class="meta-chips-bar">${chips}</div>`;
}

function _taskContextBlock(prompt, idealResponse, criteria) {
  const criteriaHtml = criteria.length
    ? `<ul class="nbp-criteria-list">${criteria
        .map(
          (c) =>
            `<li><span class="criteria-id">${escapeHtml(c.id || "")}</span> ${escapeHtml(c.description || "")}</li>`,
        )
        .join("")}</ul>`
    : `<span class="nbp-empty">No criteria found</span>`;
  const idealBlock = idealResponse
    ? `<div class="ctx-block ctx-block--ideal"><div class="ctx-label">Ideal Response</div><div class="ctx-body">${escapeHtml(idealResponse)}</div></div>`
    : "";
  return `<details class="task-context" open>
    <summary class="task-context-summary">Task Context</summary>
    <div class="task-context-body">
      <div class="ctx-block ctx-block--prompt"><div class="ctx-label">Prompt</div><div class="ctx-body">${prompt}</div></div>
      ${idealBlock}
      <div class="ctx-block ctx-block--criteria"><div class="ctx-label">Criteria (${criteria.length})</div>${criteriaHtml}</div>
    </div>
  </details>`;
}

function _slotsBlock(slots) {
  if (!slots.length) return "";
  const tabs = slots.map(_renderSlotTab).join("");
  const panels = slots.map(_renderSlotPanel).join("");
  return `<div class="slot-viewer">
    <div class="slot-tabs-bar" id="slot-tabs-bar" role="tablist" aria-label="Review slots">${tabs}</div>
    <div class="slot-panels">${panels}</div>
  </div>`;
}

function _renderSlotTab(s, i) {
  const name = escapeHtml(s.model_name || "Unknown");
  const lj = s.llm_judge || "";
  const hj = s.human_judge || "";
  const hasFail = lj.toLowerCase().includes("fail") || hj.toLowerCase().includes("fail");
  const hasPass = lj.toLowerCase().includes("pass") || hj.toLowerCase().includes("pass");
  const dot = hasFail ? "dot-fail" : hasPass ? "dot-pass" : "";
  const selected = i === 0 ? "true" : "false";
  const tabindex = i === 0 ? "0" : "-1";
  const slotSafe = escapeHtml(String(s.slot));
  return `<button type="button" role="tab" id="slot-tab-${slotSafe}" aria-controls="slot-panel-${slotSafe}" aria-selected="${selected}" tabindex="${tabindex}" class="slot-tab${i === 0 ? " active" : ""}" data-slot="${slotSafe}"><span class="slot-tab-num">${slotSafe}</span><span class="slot-tab-model">${name}</span>${dot ? `<span class="slot-tab-dot ${dot}"></span>` : ""}</button>`;
}

function _renderSlotPanel(s, i) {
  const resp = escapeHtml(s.model_response || "(no response)");
  const ljText = s.llm_judge || "";
  const hjText = s.human_judge || "";
  const rtText = s.reasoning_trace || "";
  const slotSafe = escapeHtml(String(s.slot));

  let rightHtml = "";
  if (hjText) rightHtml += formatJudgment("Human Judge", hjText, "slot-judgment-human");
  if (ljText) rightHtml += formatJudgment("LLM Judge", ljText, "slot-judgment-llm");
  if (rtText) {
    rightHtml += `<details class="slot-trace-details"><summary class="slot-trace-summary">Reasoning Trace</summary><div class="slot-judgment-body">${escapeHtml(rtText)}</div></details>`;
  }
  if (!rightHtml) rightHtml = `<span class="nbp-empty">No judgments</span>`;

  return `<div class="slot-tab-content" id="slot-panel-${slotSafe}" role="tabpanel" aria-labelledby="slot-tab-${slotSafe}" data-slot="${slotSafe}"${i > 0 ? " hidden" : ""}>
    <div class="task-slot-body">
      <div class="slot-left"><div class="slot-section"><div class="slot-section-label">Model Response</div><div class="task-slot-response">${resp}</div></div></div>
      <div class="slot-right">${rightHtml}</div>
    </div>
  </div>`;
}

function _extraCellsBlock(extraCells) {
  if (!extraCells.length) return "";
  const items = extraCells
    .map(
      (c) =>
        `<details class="nbp-extra-cell"><summary>${escapeHtml(c.heading || "Cell")}</summary><div class="nbp-extra-body">${escapeHtml(c.content || "")}</div></details>`,
    )
    .join("");
  return `<div class="nbp-section"><div class="nbp-section-label">Other Sections (${extraCells.length})</div>${items}</div>`;
}

export function wireSlotTabs(container) {
  const bar = container.querySelector("#slot-tabs-bar");
  if (!bar) return;
  const activate = (tab) => {
    if (!tab) return;
    const tabs = Array.from(bar.querySelectorAll(".slot-tab"));
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
    });
    container.querySelectorAll(".slot-tab-content").forEach((p) => (p.hidden = true));
    const target = container.querySelector(`.slot-tab-content[data-slot="${tab.dataset.slot}"]`);
    if (target) target.hidden = false;
  };
  bar.addEventListener("click", (e) => activate(e.target.closest(".slot-tab")));
  bar.addEventListener("keydown", (e) => _handleTabKeydown(e, bar, activate));
}

function _handleTabKeydown(e, bar, activate) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const tabs = Array.from(bar.querySelectorAll(".slot-tab"));
  if (!tabs.length) return;
  const idx = tabs.findIndex((t) => t.classList.contains("active"));
  let next = idx;
  if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
  else if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = tabs.length - 1;
  e.preventDefault();
  activate(tabs[next]);
  tabs[next].focus();
}
