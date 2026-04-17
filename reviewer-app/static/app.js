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
import { showToast } from "./js/dom.js";
import { initCouncil, setNotebookUrl, getCouncilState } from "./js/council.js";

import {
  initHome,
  hydrateTaskIdentity,
  setOpenSessionHandler,
} from "./js/home/index.js";
import { initGate, bootstrapAuthState } from "./js/auth/gate.js";
import { hydrateGateCouncilFooter } from "./js/auth/councilFooter.js";
import { initFetchCard } from "./js/notebook/fetchCard.js";
import {
  loadNotebookOnly,
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
  const url = item?.colab_url || "";
  if (!url) {
    showToast(
      "This session has no notebook URL attached yet. Ask the trainer to resubmit with a Colab/Drive link.",
      "error",
    );
    return;
  }
  const input = document.getElementById("task-fetch-input");
  if (input) input.value = url;
  await loadNotebookOnly(url, { sessionId: item.session_id });
});
hydrateTaskIdentity();

initGate({ onSignOut: () => resetLoader() });
bootstrapAuthState();
