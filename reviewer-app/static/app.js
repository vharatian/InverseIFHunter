/**
 * Slim reviewer: auth, fetch notebook by Colab/Drive URL only (no session DB lookup).
 */
import { getEmail, setEmail, api, initVersionCheck, setCouncilRunningCheck } from "./js/api.js";
import { showGate, showToast } from "./js/dom.js";
import { escapeHtml } from "./js/task.js";
import { initCouncil, resetCouncil, setNotebookUrl, getCouncilState } from "./js/council.js";

let currentSessionId = null;
let currentTask = null;
let _isLoadingTask = false;
let _currentNotebookUrl = null;

function _normalizeNotebookUrl(s) {
  let t = (s || "").trim();
  if (!t) return "";
  if (!/^https?:\/\//i.test(t)) {
    if (
      t.includes("colab.") ||
      t.includes("drive.google") ||
      t.includes("github.com") ||
      t.includes("githubusercontent.com") ||
      /^[\w.-]+\.[a-z]{2,}\//i.test(t)
    ) {
      t = "https://" + t.replace(/^\/+/, "");
    }
  }
  return t;
}

function _isLikelyNotebookUrl(s) {
  const t = (s || "").trim().toLowerCase();
  if (!t) return false;
  return (
    t.includes("colab.research.google.com") ||
    t.includes("colab.google.com") ||
    t.includes("drive.google.com") ||
    t.includes("raw.githubusercontent.com") ||
    t.includes("githubusercontent.com") ||
    (t.includes("github.com") && t.includes(".ipynb"))
  );
}

function _setFetchStatus(msg, isError) {
  const el = document.getElementById("fetch-status");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.className = "fetch-status" + (isError ? " error" : "");
}

function _hideLookupMatches() {
  const box = document.getElementById("lookup-matches");
  if (box) box.hidden = true;
}

async function resolveAndLoad(query) {
  const raw = (query || "").trim();
  if (!raw) {
    _setFetchStatus("Paste a Colab or Drive link to the notebook.", true);
    return;
  }
  const url = _normalizeNotebookUrl(raw);
  if (!_isLikelyNotebookUrl(url)) {
    _setFetchStatus(
      "Use a Google Colab or Google Drive link to the .ipynb, or a raw GitHub notebook URL.",
      true,
    );
    return;
  }
  _hideLookupMatches();
  _setFetchStatus("Fetching notebook\u2026", false);
  await loadNotebookOnly(url);
}

async function loadNotebookOnly(url) {
  const raw = (url || "").trim();
  if (!raw) {
    _setFetchStatus("Enter a notebook URL.", true);
    return;
  }
  _isLoadingTask = true;
  _hideLookupMatches();
  currentSessionId = null;
  currentTask = null;

  const panel = document.getElementById("task-panel");
  const banner = document.getElementById("notebook-only-banner");
  const taskSessionIdEl = document.getElementById("task-session-id");
  const taskDisplayIdEl = document.getElementById("task-display-id");
  const taskDisplayIdLabelEl = document.getElementById("task-display-id-label");
  const taskErrorEl = document.getElementById("task-error");
  const taskContentEl = document.getElementById("task-content");

  if (panel) {
    panel.hidden = false;
    panel.dataset.notebookOnly = "true";
  }
  if (banner) {
    banner.hidden = true;
    banner.textContent = "";
  }
  const taskHeader = document.querySelector(".task-view-header--slim");
  if (taskHeader) taskHeader.hidden = true;
  if (taskErrorEl) taskErrorEl.hidden = true;
  if (taskContentEl) {
    taskContentEl.textContent = "Loading notebook\u2026";
    taskContentEl.classList.add("loading-placeholder");
    taskContentEl.setAttribute("aria-busy", "true");
  }

  const fetchInput = document.getElementById("notebook-fetch-url");
  if (fetchInput) fetchInput.value = raw;

  _currentNotebookUrl = raw;
  resetCouncil();
  const summaryEl = document.getElementById("council-summary");
  if (summaryEl) summaryEl.textContent = "";

  try {
    const data = await api("/api/notebook-preview", {
      method: "POST",
      body: JSON.stringify({ url: raw }),
    });
    if (taskContentEl) {
      taskContentEl.classList.remove("loading-placeholder");
      taskContentEl.setAttribute("aria-busy", "false");
      taskContentEl.innerHTML = _renderNotebookPreviewBody(data);
      _wireSlotTabs(taskContentEl);
    }
    if (banner && data.warnings && data.warnings.length) {
      banner.hidden = false;
      banner.className = "notebook-only-banner notebook-only-banner--warn";
      banner.innerHTML =
        "<strong>Content check.</strong> " +
        escapeHtml(data.warnings.join(" ")) +
        ' <span class="notebook-only-sub">Cells scanned: ' +
        (data.cells_scanned ?? 0) +
        ".</span>";
    }
    _setFetchStatus(
      data.has_structured_content ? "Notebook loaded." : "Notebook opened; some expected sections may be missing.",
      !data.has_structured_content,
    );
  } catch (e) {
    if (taskContentEl) {
      taskContentEl.classList.remove("loading-placeholder");
      taskContentEl.textContent = "";
      taskContentEl.setAttribute("aria-busy", "false");
    }
    if (banner) {
      banner.hidden = false;
      banner.className = "notebook-only-banner notebook-only-banner--error";
      banner.innerHTML = "<strong>Could not load notebook.</strong> " + escapeHtml(e.message || "Unknown error");
    }
    _setFetchStatus(e.message || "Notebook fetch failed.", true);
    showToast(e.message || "Notebook fetch failed.", "error");
  } finally {
    _isLoadingTask = false;
  }
}

document.getElementById("btn-continue")?.addEventListener("click", async () => {
  const input = document.getElementById("email-input");
  const errEl = document.getElementById("gate-error");
  const btn = document.getElementById("btn-continue");
  const email = (input?.value || "").trim();
  if (!email) {
    errEl.textContent = "Enter your email.";
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  setEmail(email);
  try {
    await api("/api/queue");
    document.getElementById("reviewer-email").textContent = email;
    showGate(false);
    showToast("Signed in as " + email, "success");
  } catch (e) {
    setEmail("");
    errEl.textContent =
      e.message && e.message.includes("timed out")
        ? "The server took too long to respond. Try again, or contact your lead if this keeps happening."
        : e.message &&
            (e.message.includes("allowlist") ||
              e.message.includes("Missing") ||
              e.message.includes("403") ||
              e.message.includes("Not an allowed"))
          ? "This email isn't on the list. Ask your lead for help."
          : e.message || "Something went wrong. Try again.";
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.setAttribute("aria-busy", "false");
  }
});

document.getElementById("email-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-continue")?.click();
});

document.getElementById("btn-change-email")?.addEventListener("click", () => {
  const prevEmail = getEmail();
  setEmail("");
  document.getElementById("reviewer-email").textContent = "";
  currentSessionId = null;
  currentTask = null;
  showGate(true);
  const input = document.getElementById("email-input");
  if (input) {
    input.value = prevEmail;
    input.focus();
  }
});

document.getElementById("btn-fetch-task")?.addEventListener("click", () => {
  const q = document.getElementById("task-fetch-input")?.value || "";
  resolveAndLoad(q);
});

document.getElementById("task-fetch-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-fetch-task")?.click();
});

document.getElementById("btn-fetch-notebook")?.addEventListener("click", async () => {
  const urlInput = document.getElementById("notebook-fetch-url");
  const statusEl = document.getElementById("notebook-fetch-status");
  const resultEl = document.getElementById("notebook-fetch-result");
  const btn = document.getElementById("btn-fetch-notebook");
  const url = _normalizeNotebookUrl(urlInput?.value || "");
  if (!url || !_isLikelyNotebookUrl(url)) {
    statusEl.textContent = "Enter a valid Colab or Drive notebook URL.";
    statusEl.hidden = false;
    statusEl.className = "notebook-fetch-status error";
    return;
  }
  btn.disabled = true;
  statusEl.textContent = "Fetching\u2026";
  statusEl.hidden = false;
  statusEl.className = "notebook-fetch-status";
  resultEl.hidden = true;
  try {
    const data = await api("/api/notebook-preview", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    statusEl.hidden = true;
    resultEl.hidden = false;
    resultEl.innerHTML = _renderNotebookPreviewBody(data);
    _wireSlotTabs(resultEl);
  } catch (e) {
    statusEl.textContent = "Error: " + (e.message || "Could not fetch notebook.");
    statusEl.className = "notebook-fetch-status error";
    statusEl.hidden = false;
    resultEl.hidden = true;
  } finally {
    btn.disabled = false;
  }
});

function _formatJudgment(title, rawText, cssClass) {
  const grades = [];
  let explanation = "";
  let score = "";

  // Parse "C1: PASS", "C2: FAIL" patterns
  const gradeRe = /\b(C\d+)\s*[:：]\s*(PASS|FAIL|MISSING)\b/gi;
  let m;
  while ((m = gradeRe.exec(rawText)) !== null) {
    grades.push({ id: m[1].toUpperCase(), val: m[2].toUpperCase() });
  }
  // Also parse JSON grades: {"C1": "PASS", "C2": "FAIL"}
  if (grades.length === 0) {
    const jsonMatch = rawText.match(/\{[^}]*"C\d+"[^}]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const [k, v] of Object.entries(parsed)) {
          if (/^C\d+$/i.test(k)) grades.push({ id: k.toUpperCase(), val: String(v).toUpperCase() });
        }
      } catch {}
    }
  }

  // Extract score
  const scoreMatch = rawText.match(/\*?\*?Score\*?\*?:?\s*(\d+)/i);
  if (scoreMatch) score = scoreMatch[1];

  // Extract explanation (after "Explanation:" or after the grades block)
  const expMatch = rawText.match(/\*?\*?Explanation\*?\*?:?\s*\n?([\s\S]*)/i);
  if (expMatch) {
    explanation = expMatch[1].replace(/```json[\s\S]*?```/g, "").trim();
  } else {
    // Fallback: remove grade lines and JSON blocks, show the rest
    explanation = rawText
      .replace(/```json[\s\S]*?```/g, "")
      .replace(/\*\*[^*]+\*\*:?/g, "")
      .replace(/\b(C\d+)\s*[:：]\s*(PASS|FAIL|MISSING)\b/gi, "")
      .replace(/\{[^}]*"C\d+"[^}]*\}/g, "")
      .trim();
  }

  const gradePills = grades.length > 0
    ? `<div class="judge-grades">${grades.map((g) => `<span class="judge-grade judge-grade--${g.val.toLowerCase()}">${escapeHtml(g.id)}: ${g.val}</span>`).join("")}</div>`
    : "";
  const scoreHtml = score ? `<span class="judge-score-pill">Score: ${escapeHtml(score)}</span>` : "";
  const expHtml = explanation ? `<div class="judge-explanation">${escapeHtml(explanation)}</div>` : "";

  return `<div class="slot-judgment-block ${cssClass}"><div class="slot-judgment-title">${escapeHtml(title)} ${scoreHtml}</div>${gradePills}${expHtml}</div>`;
}

function _renderNotebookPreviewBody(data) {
  const warnings = data.warnings || [];
  const prompt = escapeHtml(data.prompt || "(no prompt)");
  const idealResponse = (data.ideal_response || "").trim();
  const criteria = data.criteria || [];
  const slots = data.slots || [];
  const meta = data.metadata || {};
  const extraCells = data.extra_cells || [];

  // --- Zone 0: Warnings ---
  const warnBlock = warnings.length > 0
    ? `<div class="nbp-warnings" role="alert"><strong>Notice:</strong> ${warnings.map((w) => escapeHtml(w)).join(" ")}</div>`
    : "";

  // --- Zone 1: Task context (distinct colored blocks) ---
  const criteriaHtml = criteria.length > 0
    ? `<ul class="nbp-criteria-list">${criteria.map((c) => `<li><span class="criteria-id">${escapeHtml(c.id || "")}</span> ${escapeHtml(c.description || "")}</li>`).join("")}</ul>`
    : `<span class="nbp-empty">No criteria found</span>`;
  const idealBlock = idealResponse
    ? `<div class="ctx-block ctx-block--ideal"><div class="ctx-label">Ideal Response</div><div class="ctx-body">${escapeHtml(idealResponse)}</div></div>`
    : "";
  const taskContext = `<details class="task-context" open>
    <summary class="task-context-summary">Task Context</summary>
    <div class="task-context-body">
      <div class="ctx-block ctx-block--prompt"><div class="ctx-label">Prompt</div><div class="ctx-body">${prompt}</div></div>
      ${idealBlock}
      <div class="ctx-block ctx-block--criteria"><div class="ctx-label">Criteria (${criteria.length})</div>${criteriaHtml}</div>
    </div>
  </details>`;

  // --- Zone 2: Metadata chips ---
  let metaChips = "";
  const metaKeys = Object.keys(meta);
  if (metaKeys.length > 0) {
    const chips = metaKeys.map((k) => {
      const label = k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return `<span class="meta-chip"><span class="meta-chip-key">${escapeHtml(label)}</span><span class="meta-chip-val">${escapeHtml(meta[k])}</span></span>`;
    }).join("");
    metaChips = `<div class="meta-chips-bar">${chips}</div>`;
  }

  // --- Zone 3: Tabbed slots ---
  let slotsBlock = "";
  if (slots.length > 0) {
    const tabs = slots.map((s, i) => {
      const name = escapeHtml(s.model_name || "Unknown");
      const lj = s.llm_judge || ""; const hj = s.human_judge || "";
      const hasFail = lj.toLowerCase().includes("fail") || hj.toLowerCase().includes("fail");
      const hasPass = lj.toLowerCase().includes("pass") || hj.toLowerCase().includes("pass");
      const dot = hasFail ? "dot-fail" : hasPass ? "dot-pass" : "";
      return `<button type="button" class="slot-tab${i === 0 ? " active" : ""}" data-slot="${s.slot}"><span class="slot-tab-num">${s.slot}</span><span class="slot-tab-model">${name}</span>${dot ? `<span class="slot-tab-dot ${dot}"></span>` : ""}</button>`;
    }).join("");

    const panels = slots.map((s, i) => {
      const resp = escapeHtml(s.model_response || "(no response)");
      const ljText = s.llm_judge || "";
      const hjText = s.human_judge || "";
      const rtText = s.reasoning_trace || "";

      let rightHtml = "";
      if (hjText) rightHtml += _formatJudgment("Human Judge", hjText, "slot-judgment-human");
      if (ljText) rightHtml += _formatJudgment("LLM Judge", ljText, "slot-judgment-llm");
      if (rtText) rightHtml += `<details class="slot-trace-details"><summary class="slot-trace-summary">Reasoning Trace</summary><div class="slot-judgment-body">${escapeHtml(rtText)}</div></details>`;
      if (!rightHtml) rightHtml = `<span class="nbp-empty">No judgments</span>`;

      return `<div class="slot-tab-content" data-slot="${s.slot}"${i > 0 ? " hidden" : ""}>
        <div class="task-slot-body">
          <div class="slot-left"><div class="slot-section"><div class="slot-section-label">Model Response</div><div class="task-slot-response">${resp}</div></div></div>
          <div class="slot-right">${rightHtml}</div>
        </div>
      </div>`;
    }).join("");

    slotsBlock = `<div class="slot-viewer">
      <div class="slot-tabs-bar" id="slot-tabs-bar">${tabs}</div>
      <div class="slot-panels">${panels}</div>
    </div>`;
  }

  // --- Zone 4: Extra cells ---
  let extraHtml = "";
  if (extraCells.length > 0) {
    const items = extraCells.map((c) =>
      `<details class="nbp-extra-cell"><summary>${escapeHtml(c.heading || "Cell")}</summary><div class="nbp-extra-body">${escapeHtml(c.content || "")}</div></details>`
    ).join("");
    extraHtml = `<div class="nbp-section"><div class="nbp-section-label">Other Sections (${extraCells.length})</div>${items}</div>`;
  }

  return warnBlock + metaChips + taskContext + slotsBlock + extraHtml;
}

function _wireSlotTabs(container) {
  const bar = container.querySelector("#slot-tabs-bar");
  if (!bar) return;
  bar.addEventListener("click", (e) => {
    const tab = e.target.closest(".slot-tab");
    if (!tab) return;
    bar.querySelectorAll(".slot-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const panels = container.querySelectorAll(".slot-tab-content");
    panels.forEach((p) => (p.hidden = true));
    const target = container.querySelector(`.slot-tab-content[data-slot="${tab.dataset.slot}"]`);
    if (target) target.hidden = false;
  });
}

initCouncil(() => currentSessionId, null);
setNotebookUrl(() => _currentNotebookUrl);
setCouncilRunningCheck(() => getCouncilState().running);
initVersionCheck();

if (getEmail()) {
  document.getElementById("reviewer-email").textContent = getEmail();
  showGate(false);
} else {
  showGate(true);
}
