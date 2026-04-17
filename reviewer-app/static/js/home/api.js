/** API calls made by the home page. */
import { api } from "../api.js";

export async function fetchAuthSession() {
  return await api("/api/auth/session", {}, { timeoutMs: 15_000, retries: 0 });
}

export async function fetchQueueSummaries() {
  return await api(
    "/api/queue?summaries=true&all_sessions=true&per_page=0",
    {},
    { timeoutMs: 20_000, retries: 1 },
  );
}

export async function fetchTaskIdentityConfig() {
  return await api("/api/task-identity-config", {}, { timeoutMs: 10_000, retries: 0 });
}
