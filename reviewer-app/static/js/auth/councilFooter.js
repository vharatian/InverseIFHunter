/** Populate the gate footer with the live council model list. */
import { api } from "../api.js";
import { escapeHtml } from "../task.js";
import { deriveModelMeta } from "../council/councilModels.js";

export async function hydrateGateCouncilFooter() {
  const wrap = document.getElementById("gate-model-chips");
  const labelEl = document.getElementById("gate-footer-label");
  if (!wrap) return;
  try {
    const data = await api("/api/council-models", {}, { timeoutMs: 15_000, retries: 1 });
    const models = (data.models || [])
      .map((m) => (typeof m === "string" ? m : m && m.id))
      .filter(Boolean);
    const chairmanId = String(data.chairman || "").trim();
    if (!models.length && !chairmanId) return;

    wrap.replaceChildren();
    for (const mid of models) {
      wrap.appendChild(_chip(mid));
    }
    if (chairmanId) wrap.appendChild(_chairmanChip(chairmanId));
    _updateLabel(labelEl, models.length, chairmanId);
  } catch {
    /* keep static HTML fallback */
  }
}

function _chip(modelId) {
  const { short } = deriveModelMeta(modelId);
  const span = document.createElement("span");
  span.className = "gate-model-chip";
  span.textContent = short;
  return span;
}

function _chairmanChip(chairmanId) {
  const { short } = deriveModelMeta(chairmanId);
  const span = document.createElement("span");
  span.className = "gate-model-chip gate-model-chip--chairman";
  span.title = "Chairman — final say when the council disagrees";
  span.innerHTML =
    '<span class="chairman-tag" aria-hidden="true">C</span> ' + escapeHtml(short);
  return span;
}

function _updateLabel(labelEl, n, chairmanId) {
  if (!labelEl) return;
  if (n && chairmanId) labelEl.textContent = `Powered by ${n}-model council + chairman`;
  else if (n) labelEl.textContent = `Powered by ${n}-model LLM council`;
  else labelEl.textContent = "Chairman";
}
