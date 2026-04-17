/** Paste-URL fetch cards: main card on home + compact refetch card inside task panel. */
import { api } from "../api.js";
import { loadNotebookOnly, setFetchStatus } from "./loader.js";
import { renderNotebookPreviewBody, wireSlotTabs } from "./preview.js";
import { normalizeNotebookUrl, isLikelyNotebookUrl } from "./urls.js";

export function initFetchCard() {
  _wireMainFetch();
  _wireInlineRefetch();
}

function _wireMainFetch() {
  const btn = document.getElementById("btn-fetch-task");
  const input = document.getElementById("task-fetch-input");
  btn?.addEventListener("click", () => _resolveAndLoad(input?.value || ""));
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btn?.click();
  });
}

async function _resolveAndLoad(query) {
  const raw = (query || "").trim();
  if (!raw) {
    setFetchStatus("Paste a Colab or Drive link to the notebook.", true);
    return;
  }
  const url = normalizeNotebookUrl(raw);
  if (!isLikelyNotebookUrl(url)) {
    setFetchStatus(
      "Use a Google Colab or Google Drive link to the .ipynb, or a raw GitHub notebook URL.",
      true,
    );
    return;
  }
  setFetchStatus("Fetching notebook\u2026", false);
  await loadNotebookOnly(url);
}

function _wireInlineRefetch() {
  const btn = document.getElementById("btn-fetch-notebook");
  btn?.addEventListener("click", () => _runInlineRefetch());
}

async function _runInlineRefetch() {
  const urlInput = document.getElementById("notebook-fetch-url");
  const statusEl = document.getElementById("notebook-fetch-status");
  const resultEl = document.getElementById("notebook-fetch-result");
  const btn = document.getElementById("btn-fetch-notebook");
  if (!urlInput || !statusEl || !resultEl || !btn) return;

  const url = normalizeNotebookUrl(urlInput.value || "");
  if (!url || !isLikelyNotebookUrl(url)) {
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
    resultEl.innerHTML = renderNotebookPreviewBody(data);
    wireSlotTabs(resultEl);
  } catch (e) {
    statusEl.textContent = "Error: " + (e.message || "Could not fetch notebook.");
    statusEl.className = "notebook-fetch-status error";
    statusEl.hidden = false;
    resultEl.hidden = true;
  } finally {
    btn.disabled = false;
  }
}
