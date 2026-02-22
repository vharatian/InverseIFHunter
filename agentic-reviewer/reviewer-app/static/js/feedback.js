/**
 * Feedback form: overall/section comments, appreciations, likes, quick-reply,
 * revision-flag toggles (selection + QC here; slot-level in task.js), and
 * a live "Allowed Edits" summary.
 */
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

/** Quick-reply snippets for overall or section comments. */
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
 * @param {object} feedback - task.feedback
 * @param {boolean} [slotsInline] - If true, don't render section blocks (in task content)
 */
export function renderFeedbackForm(feedback, slotsInline) {
  const overall = feedback?.overall_comment ?? "";
  const overallAppreciation = feedback?.overall_appreciation ?? "";
  const taskRating = feedback?.task_rating ?? "neutral";
  const summaryLine = feedback?.summary_line ?? "";
  const sectionFeedback = feedback?.section_feedback || [];
  const bySection = new Map(sectionFeedback.map((s) => [s.section_id, s]));

  const overallEl = document.getElementById("feedback-overall");
  if (overallEl) overallEl.value = overall;

  const appreciationEl = document.getElementById("feedback-appreciation");
  if (appreciationEl) appreciationEl.value = overallAppreciation;

  const summaryEl = document.getElementById("feedback-summary-line");
  if (summaryEl) summaryEl.value = summaryLine;

  const ratingEl = document.getElementById("feedback-task-rating");
  if (ratingEl) {
    ["like", "neutral", "dislike"].forEach((r) => {
      const btn = ratingEl.querySelector(`[data-rating="${r}"]`);
      if (btn) btn.classList.toggle("active", r === taskRating);
    });
  }

  const sectionsContainer = document.getElementById("feedback-sections");
  if (sectionsContainer && !slotsInline) {
    sectionsContainer.innerHTML = "";
    SLOT_IDS.forEach((sectionId) => {
      const sf = bySection.get(sectionId) || { section_id: sectionId, comment: "", appreciation: "", liked: false };
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

  // Pre-check any previously saved flags
  const existingFlags = feedback?.revision_flags || [];
  if (existingFlags.length > 0) {
    restoreRevisionFlags(existingFlags);
  }
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

/**
 * Pre-check toggles that match the given flag IDs (used on task load).
 * Works for toggles in both slot cards and the feedback container.
 */
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

/**
 * Collect current form values into ReviewerFeedback-shaped object.
 * Reads revision-flag toggles from the entire document (slot cards + feedback card).
 */
export function collectFeedback() {
  const overall = (document.getElementById("feedback-overall")?.value || "").trim();
  const overallAppreciation = (document.getElementById("feedback-appreciation")?.value || "").trim();
  const summaryLine = (document.getElementById("feedback-summary-line")?.value || "").trim();
  let taskRating = "neutral";
  const activeBtn = document.querySelector("#feedback-task-rating [data-rating].active");
  if (activeBtn) taskRating = activeBtn.getAttribute("data-rating") || "neutral";

  const section_comments = [];
  const section_feedback = [];
  SLOT_IDS.forEach((sectionId) => {
    const comment = (document.getElementById(`section-comment-${sectionId}`)?.value || "").trim();
    const appreciation = (document.getElementById(`section-appreciation-${sectionId}`)?.value || "").trim();
    section_comments.push({ section_id: sectionId, section_label: sectionId, comment });
    section_feedback.push({
      section_id: sectionId,
      section_label: sectionId,
      comment,
      appreciation,
      liked: false,
    });
  });

  const revision_flags = [];
  document.querySelectorAll(".revision-flag-toggle:checked").forEach((cb) => {
    const flag = cb.getAttribute("data-flag");
    if (flag) revision_flags.push(flag);
  });

  return {
    overall_comment: overall,
    overall_appreciation: overallAppreciation,
    task_rating: taskRating,
    summary_line: summaryLine,
    section_comments,
    section_feedback,
    revision_flags,
  };
}

/**
 * Update the #allowed-edits-summary with currently toggled flags.
 */
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

/**
 * Show return nudge if reviewer clicks Return with no overall comment.
 * @returns {boolean} true if we should allow return (or nudge was dismissed)
 */
export function showReturnNudgeIfNeeded() {
  const overall = (document.getElementById("feedback-overall")?.value || "").trim();
  const nudgeEl = document.getElementById("feedback-return-nudge");
  if (!nudgeEl) return true;
  if (overall) {
    nudgeEl.hidden = true;
    return true;
  }
  nudgeEl.hidden = false;
  nudgeEl.textContent = "No overall comment yet — add one? (optional)";
  return true;
}

// Global delegation: sync toggle active state + update summary on any toggle change
document.addEventListener("change", (e) => {
  if (!e.target.classList.contains("revision-flag-toggle")) return;
  const row = e.target.closest("[data-flag-item]");
  if (row) row.classList.toggle("active", e.target.checked);
  updateAllowedEditsSummary();
});

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
