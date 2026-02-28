/**
 * Feedback form: overall/section comments, appreciations, quality score,
 * revision-flag toggles, and a live "Allowed Edits" summary.
 */
import { escapeHtml } from "./task.js";

const SLOT_IDS = ["slot_1", "slot_2", "slot_3", "slot_4"];

const FLAG_LABELS = {
  selection: "Selection (which responses were selected)",
  slot_1_grade: "Slot 1 — Grade",
  slot_1_explanation: "Slot 1 — Explanation",
  slot_2_grade: "Slot 2 — Grade",
  slot_2_explanation: "Slot 2 — Explanation",
  slot_3_grade: "Slot 3 — Grade",
  slot_3_explanation: "Slot 3 — Explanation",
  slot_4_grade: "Slot 4 — Grade",
  slot_4_explanation: "Slot 4 — Explanation",
  qc: "Re-run Quality Check",
};

export const QUICK_REPLIES = [
  "Grades align with criteria.",
  "Explanation could be clearer.",
  "Strong selection.",
  "C2 needs re-grade.",
  "Prompt is clear.",
  "One criterion misapplied.",
];

/**
 * Render feedback form into #feedback-sections and related containers.
 * If slotsInline=true, skip section blocks (they're rendered in task slots).
 */
export function renderFeedbackForm(feedback, slotsInline) {
  const overall = feedback?.overall_comment ?? "";
  const overallAppreciation = feedback?.overall_appreciation ?? "";
  const overallScore = feedback?.overall_score ?? null;
  const summaryLine = feedback?.summary_line ?? "";
  const sectionFeedback = feedback?.section_feedback || [];
  const bySection = new Map(sectionFeedback.map((s) => [s.section_id, s]));

  const overallEl = document.getElementById("feedback-overall");
  if (overallEl) overallEl.value = overall;

  const appreciationEl = document.getElementById("feedback-appreciation");
  if (appreciationEl) appreciationEl.value = overallAppreciation;

  const summaryEl = document.getElementById("feedback-summary-line");
  if (summaryEl) summaryEl.value = summaryLine;

  // Restore overall score
  const scoreRow = document.getElementById("feedback-score-row");
  if (scoreRow) {
    scoreRow.querySelectorAll(".btn-score").forEach((btn) => {
      const s = parseInt(btn.getAttribute("data-score"), 10);
      btn.classList.toggle("active", s === overallScore);
    });
  }

  const sectionsContainer = document.getElementById("feedback-sections");
  if (sectionsContainer && !slotsInline) {
    sectionsContainer.innerHTML = "";
    SLOT_IDS.forEach((sectionId) => {
      const sf = bySection.get(sectionId) || { section_id: sectionId, comment: "", appreciation: "" };
      const sectionDiv = document.createElement("div");
      sectionDiv.className = "feedback-section-block";
      sectionDiv.dataset.sectionId = sectionId;
      sectionDiv.innerHTML = [
        `<label>${sectionId}</label>`,
        `<textarea id="section-comment-${sectionId}" rows="2" placeholder="Comment…">${escapeHtml(sf.comment || "")}</textarea>`,
        `<textarea id="section-appreciation-${sectionId}" rows="1" placeholder="What was good…">${escapeHtml(sf.appreciation || "")}</textarea>`,
      ].join("");
      sectionsContainer.appendChild(sectionDiv);
    });
  } else if (sectionsContainer && slotsInline) {
    sectionsContainer.innerHTML = "";
  }

  // Selection + QC toggles (slot-level toggles live inside task.js slot cards)
  const flagsContainer = document.getElementById("feedback-revision-flags");
  if (flagsContainer) {
    flagsContainer.innerHTML =
      `<label class="feedback-label">Sections that need revision</label>` +
      _toggleRow("selection", "Selection (which responses were selected)") +
      _toggleRow("qc", "Re-run Quality Check");
  }

  const existingFlags = feedback?.revision_flags || [];
  if (existingFlags.length > 0) restoreRevisionFlags(existingFlags);

  const promptFbEl = document.getElementById("feedback-prompt-feedback");
  if (promptFbEl) promptFbEl.value = feedback?.prompt_feedback ?? "";
  const modelRefFbEl = document.getElementById("feedback-model-reference-feedback");
  if (modelRefFbEl) modelRefFbEl.value = feedback?.model_reference_feedback ?? "";
  const judgeFbEl = document.getElementById("feedback-judge-feedback");
  if (judgeFbEl) judgeFbEl.value = feedback?.judge_system_prompt_feedback ?? "";

  updateAllowedEditsSummary();

  const quickReplyContainer = document.getElementById("feedback-quick-replies");
  if (quickReplyContainer && quickReplyContainer.children.length === 0) {
    QUICK_REPLIES.forEach((text) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-quick-reply";
      btn.textContent = text;
      btn.addEventListener("click", () => {
        const ta = document.getElementById("feedback-overall");
        if (ta) ta.value = (ta.value ? ta.value + "\n" : "") + text;
      });
      quickReplyContainer.appendChild(btn);
    });
  }
}

function _toggleRow(flagId, label) {
  return `<div class="revision-flag-row" data-flag-item="${flagId}">
    <span class="flag-label">${escapeHtml(label)}</span>
    <label class="toggle-switch">
      <input type="checkbox" class="revision-flag-toggle" data-flag="${flagId}" />
      <span class="toggle-track"></span>
    </label>
  </div>`;
}

export function restoreRevisionFlags(flags) {
  if (!flags || !flags.length) return;
  const flagSet = new Set(flags);
  document.querySelectorAll(".revision-flag-toggle").forEach((cb) => {
    const id = cb.getAttribute("data-flag");
    if (flagSet.has(id)) {
      cb.checked = true;
      const row = cb.closest("[data-flag-item]");
      if (row) row.classList.add("active");
    }
  });
  updateAllowedEditsSummary();
}

export function collectFeedback() {
  const overall = (document.getElementById("feedback-overall")?.value || "").trim();
  const overallAppreciation = (document.getElementById("feedback-appreciation")?.value || "").trim();
  const summaryLine = (document.getElementById("feedback-summary-line")?.value || "").trim();

  let overallScore = null;
  const activeScoreBtn = document.querySelector("#feedback-score-row .btn-score.active");
  if (activeScoreBtn) {
    const parsed = parseInt(activeScoreBtn.getAttribute("data-score"), 10);
    if (parsed >= 1 && parsed <= 5) overallScore = parsed;
  }

  const section_comments = [];
  const section_feedback = [];
  SLOT_IDS.forEach((sectionId) => {
    const comment = (document.getElementById(`section-comment-${sectionId}`)?.value || "").trim();
    const appreciation = (document.getElementById(`section-appreciation-${sectionId}`)?.value || "").trim();
    section_comments.push({ section_id: sectionId, section_label: sectionId, comment });
    section_feedback.push({ section_id: sectionId, section_label: sectionId, comment, appreciation });
  });

  const revision_flags = [];
  document.querySelectorAll(".revision-flag-toggle:checked").forEach((cb) => {
    const flag = cb.getAttribute("data-flag");
    if (flag) revision_flags.push(flag);
  });

  return {
    overall_comment: overall,
    overall_appreciation: overallAppreciation,
    overall_score: overallScore,
    summary_line: summaryLine,
    section_comments,
    section_feedback,
    revision_flags,
    prompt_feedback: (document.getElementById("feedback-prompt-feedback")?.value || "").trim(),
    model_reference_feedback: (document.getElementById("feedback-model-reference-feedback")?.value || "").trim(),
    judge_system_prompt_feedback: (document.getElementById("feedback-judge-feedback")?.value || "").trim(),
  };
}

export function updateAllowedEditsSummary() {
  const summaryEl = document.getElementById("allowed-edits-summary");
  if (!summaryEl) return;

  const active = [];
  document.querySelectorAll(".revision-flag-toggle:checked").forEach((cb) => {
    const flag = cb.getAttribute("data-flag");
    if (flag && FLAG_LABELS[flag]) active.push(FLAG_LABELS[flag]);
  });

  if (active.length === 0) {
    summaryEl.classList.remove("has-flags");
    summaryEl.innerHTML = "No sections flagged &mdash; trainer cannot edit anything.";
  } else {
    summaryEl.classList.add("has-flags");
    const tags = active.map((l) => `<span class="edit-tag">${escapeHtml(l)}</span>`).join(" ");
    summaryEl.innerHTML = `<strong>Trainer will be able to edit:</strong> ${tags}`;
  }
}

export function showReturnNudgeIfNeeded() {
  const overall = (document.getElementById("feedback-overall")?.value || "").trim();
  const nudgeEl = document.getElementById("feedback-return-nudge");
  const hasFlags = document.querySelectorAll(".revision-flag-toggle:checked").length > 0;

  if (overall || hasFlags) {
    if (nudgeEl) nudgeEl.hidden = true;
    return true;
  }

  if (nudgeEl) {
    nudgeEl.hidden = false;
    nudgeEl.textContent = "Please add an overall comment or flag at least one section before returning.";
    nudgeEl.classList.add("return-nudge--error");
    nudgeEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  return false;
}

// Global delegation: sync toggle active state + update summary on any toggle change
document.addEventListener("change", (e) => {
  if (!e.target.classList.contains("revision-flag-toggle")) return;
  const row = e.target.closest("[data-flag-item]");
  if (row) row.classList.toggle("active", e.target.checked);
  updateAllowedEditsSummary();
  const nudgeEl = document.getElementById("feedback-return-nudge");
  if (nudgeEl) { nudgeEl.hidden = true; nudgeEl.classList.remove("return-nudge--error"); }
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "feedback-overall") return;
  const nudgeEl = document.getElementById("feedback-return-nudge");
  if (nudgeEl && nudgeEl.classList.contains("return-nudge--error")) {
    nudgeEl.hidden = true;
    nudgeEl.classList.remove("return-nudge--error");
  }
});
