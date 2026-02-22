/**
 * Agentic Reviewer — standalone UI logic
 */
(function () {
  const checkpointSelect = document.getElementById("checkpoint");
  const idsRow = document.getElementById("ids-row");
  const idsInput = document.getElementById("ids");
  const sessionTextarea = document.getElementById("session-json");
  const loadSampleBtn = document.getElementById("load-sample");
  const runBtn = document.getElementById("run-btn");
  const resultSection = document.getElementById("result-section");
  const resultBadge = document.getElementById("result-badge");
  const resultIssues = document.getElementById("result-issues");
  const resultMeta = document.getElementById("result-meta");
  const errorSection = document.getElementById("error-section");
  const errorMessage = document.getElementById("error-message");

  const SAMPLE_SESSION = {
    session_id: "demo12345",
    current_turn: 1,
    notebook: {
      prompt: "Write a haiku about coding.",
      response_reference:
        '[{"id":"C1","criteria1":"Must be 3 lines"},{"id":"C2","criteria2":"Must mention code"}]',
    },
    config: { models: ["nvidia/nemotron-3-nano-30b-a3b", "qwen/qwen3-235b"] },
    all_results: [
      {
        hunt_id: 1,
        model: "nvidia/nemotron-3-nano-30b-a3b",
        response:
          "Code flows like rivers\nBugs hide in the shadows\nFix and ship again",
        judge_score: 1,
        judge_criteria: { C1: "PASS", C2: "PASS" },
        judge_explanation: "Meets all criteria.",
        is_breaking: false,
      },
      {
        hunt_id: 2,
        model: "qwen/qwen3-235b",
        response: "Broken output here",
        judge_score: 0,
        judge_criteria: { C1: "FAIL", C2: "FAIL" },
        judge_explanation: "Fails criteria.",
        is_breaking: true,
      },
      {
        hunt_id: 3,
        model: "nvidia/nemotron-3-nano-30b-a3b",
        response: "Another broken one",
        judge_score: 0,
        is_breaking: true,
      },
      {
        hunt_id: 4,
        model: "qwen/qwen3-235b",
        response: "Yet another fail",
        judge_score: 0,
        is_breaking: true,
      },
    ],
    human_reviews: {},
  };

  function toggleIdsRow() {
    idsRow.style.display =
      checkpointSelect.value === "preflight" ? "block" : "none";
  }

  function loadSample() {
    sessionTextarea.value = JSON.stringify(SAMPLE_SESSION, null, 2);
    idsInput.value = "1, 2, 3, 4";
  }

  async function runReview() {
    hideError();
    resultSection.hidden = true;

    let session;
    try {
      session = JSON.parse(sessionTextarea.value.trim());
    } catch (e) {
      showError("Invalid JSON: " + e.message);
      return;
    }

    const checkpoint = checkpointSelect.value;
    let selectedHuntIds = null;
    if (checkpoint === "preflight") {
      const idsStr = idsInput.value.trim();
      if (!idsStr) {
        showError("Preflight requires 4 hunt IDs (e.g. 1, 2, 3, 4)");
        return;
      }
      selectedHuntIds = idsStr.split(/[,\s]+/).map((s) => parseInt(s.trim(), 10));
      if (selectedHuntIds.length !== 4 || selectedHuntIds.some(isNaN)) {
        showError("Preflight requires exactly 4 valid hunt IDs");
        return;
      }
    }

    runBtn.disabled = true;
    runBtn.textContent = "Running...";

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session,
          checkpoint,
          selected_hunt_ids: selectedHuntIds,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        showError(data.detail || res.statusText || "Request failed");
        return;
      }

      showResult(data);
    } catch (e) {
      showError("Network error: " + e.message);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run Review";
    }
  }

  function showResult(data) {
    resultSection.hidden = false;
    resultBadge.textContent = data.passed ? "✓ Passed" : "✗ Failed";
    resultBadge.className = "badge " + (data.passed ? "passed" : "failed");

    resultIssues.innerHTML = "";
    if (data.issues && data.issues.length > 0) {
      const ul = document.createElement("ul");
      ul.className = "issues-list";
      data.issues.forEach((issue) => {
        const li = document.createElement("li");
        li.innerHTML =
          '<span class="rule-id">' +
          escapeHtml(issue.rule_id) +
          "</span>" +
          '<p class="message">' +
          escapeHtml(issue.message) +
          "</p>" +
          (issue.hint
            ? '<p class="hint">Hint: ' + escapeHtml(issue.hint) + "</p>"
            : "");
        ul.appendChild(li);
      });
      resultIssues.appendChild(ul);
    }

    resultMeta.textContent = "Checkpoint: " + data.checkpoint + " • " + data.timestamp;
  }

  function showError(msg) {
    errorSection.hidden = false;
    errorMessage.textContent = msg;
  }

  function hideError() {
    errorSection.hidden = true;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  checkpointSelect.addEventListener("change", toggleIdsRow);
  loadSampleBtn.addEventListener("click", loadSample);
  runBtn.addEventListener("click", runReview);

  toggleIdsRow();
})();
