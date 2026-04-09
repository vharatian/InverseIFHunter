/**
 * Council model metadata: names, initials, colors, avatars.
 * Fetched dynamically from /api/council-models on init.
 */
import { api } from "../api.js";
import { escapeHtml } from "../task.js";

let MODEL_SHORT = {};
let MODEL_INITIALS = {};
let MODEL_COLORS = {};

const _PROVIDER_COLORS = {
  openai: "#10a37f", anthropic: "#d97706", google: "#4285f4", "x-ai": "#ef4444",
};
const _PROVIDER_SPECIAL = { opus: "#7c3aed" };

export function deriveModelMeta(modelId) {
  const parts = modelId.split("/");
  const provider = parts[0] || "";
  const name = parts.slice(1).join("/") || modelId;
  const short = name.replace(/-preview$/, "").replace(/\./g, ".").split("-").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ").replace(/\s+/g, " ").trim();
  const initial = short.replace(/[^A-Z0-9]/gi, "").slice(0, 2) || "?";
  let color = _PROVIDER_COLORS[provider] || "#6366f1";
  for (const [k, c] of Object.entries(_PROVIDER_SPECIAL)) {
    if (name.includes(k)) { color = c; break; }
  }
  return { short, initial, color };
}

export async function loadCouncilModels() {
  try {
    const data = await api("/api/council-models");
    const all = [...(data.models || [])];
    if (data.chairman) all.push(data.chairman);
    for (const mid of all) {
      if (!mid || MODEL_SHORT[mid]) continue;
      const m = deriveModelMeta(mid);
      MODEL_SHORT[mid] = m.short;
      MODEL_INITIALS[mid] = m.initial;
      MODEL_COLORS[mid] = m.color;
    }
  } catch { /* fallback to derive on-the-fly */ }
}

function _ensure(mid) {
  if (!MODEL_INITIALS[mid]) {
    const m = deriveModelMeta(mid);
    MODEL_SHORT[mid] = m.short;
    MODEL_INITIALS[mid] = m.initial;
    MODEL_COLORS[mid] = m.color;
  }
}

export function shortModel(id) {
  _ensure(id);
  return MODEL_SHORT[id];
}

export function modelAvatar(mid) {
  _ensure(mid);
  return `<span class="chat-avatar" style="background:${MODEL_COLORS[mid]}">${escapeHtml(MODEL_INITIALS[mid])}</span>`;
}
