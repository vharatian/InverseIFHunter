/**
 * Reviewer app entrypoint.
 *
 * Wires up:
 *   - auth gate (sign in / change email / session bootstrap)
 *   - council footer on gate
 *   - home page (stats + incoming queue + paste URL card)
 *   - notebook loader & inline refetch card
 *   - council module (bound to the currently-loaded session/URL)
 *   - version checker
 */
import { initVersionCheck, setCouncilRunningCheck } from "./js/api.js";
import { initCouncil, setNotebookUrl, getCouncilState } from "./js/council.js";

import {
  initHome,
  hydrateTaskIdentity,
  setOpenSessionHandler,
  refreshQueue,
} from "./js/home/index.js";
import { markSessionInProgress, markSessionCompleted } from "./js/home/api.js";
import { initGate, bootstrapAuthState } from "./js/auth/gate.js";
import { hydrateGateCouncilFooter } from "./js/auth/councilFooter.js";
import { initFetchCard } from "./js/notebook/fetchCard.js";
import {
  loadNotebookOnly,
  openSessionWithoutNotebook,
  getCurrentSessionId,
  getCurrentNotebookUrl,
  resetLoader,
} from "./js/notebook/loader.js";

initCouncil(() => getCurrentSessionId(), null);
setNotebookUrl(() => getCurrentNotebookUrl());
setCouncilRunningCheck(() => getCouncilState().running);

initVersionCheck();
hydrateGateCouncilFooter();

initFetchCard();

initHome({ onBackToHome: () => resetLoader() });
setOpenSessionHandler(async (item) => {
  const url = (item?.colab_url || "").trim();
  const input = document.getElementById("task-fetch-input");
  if (input) input.value = url;
  if (url) {
    await loadNotebookOnly(url, { sessionId: item.session_id });
  } else {
    // Trainer submitted without a Colab link — still open the task and show
    // an inline notice (no blocking toast, per product decision).
    openSessionWithoutNotebook({ sessionId: item.session_id });
  }
  const res = await markSessionInProgress(item.session_id);
  if (res?.changed) refreshQueue();
});

window.addEventListener("reviewer:council-complete", () => {
  const sid = getCurrentSessionId();
  if (!sid) return;
  markSessionCompleted(sid).then((res) => {
    if (res?.changed) refreshQueue();
  });
});
hydrateTaskIdentity();

initGate({ onSignOut: () => resetLoader() });
bootstrapAuthState();
