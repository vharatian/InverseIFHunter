/**
 * Task module — thin orchestrator that re-exports from submodules.
 * All logic lives in js/task/ submodules.
 */
import { api } from "./api.js";

export const FEEDBACK_ENABLED = false;

export async function loadTask(sessionId) {
  const task = await api("/api/tasks/" + sessionId);
  return { sessionId, task };
}

export { renderTaskContent } from "./task/taskContent.js";
export { renderAgentResult, renderAgentSummaryAtTop } from "./task/taskAgent.js";
export { escapeHtml } from "./task/taskUtils.js";
