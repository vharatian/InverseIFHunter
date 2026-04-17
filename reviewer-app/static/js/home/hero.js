/** Hero banner: role eyebrow, greeting, role-aware subtitle, and queue subtitle. */
import { homeState, ROLE_LABELS } from "./state.js";
import { greetingForNow } from "./format.js";

export function renderHero() {
  const eyebrow = document.getElementById("home-role-eyebrow");
  const title = document.getElementById("home-hero-title");
  const sub = document.getElementById("home-hero-sub");
  const queueSub = document.getElementById("home-queue-sub");
  if (!eyebrow) return;

  const roleLabel = ROLE_LABELS[homeState.role] || "Reviewer";
  eyebrow.textContent = homeState.podId ? `${roleLabel} · ${homeState.podId}` : roleLabel;

  if (title) title.textContent = `${greetingForNow()} 👋`;
  if (sub) sub.textContent = _subtitle();
  if (queueSub) queueSub.textContent = _queueSubtitle();
}

function _subtitle() {
  const n = homeState.assignedTrainers.length;
  switch (homeState.role) {
    case "super_admin":
    case "admin":
      return "You have access to all sessions across every pod.";
    case "pod_lead":
      return `You see every task submitted inside pod ${homeState.podId || ""} (${n} trainer${n === 1 ? "" : "s"}).`;
    default:
      if (n > 0) {
        return `${n} trainer${n === 1 ? " is" : "s are"} mapped to you. Their submissions land here automatically.`;
      }
      return "No trainers assigned yet. Ask your lead or admin to map you to a trainer to start reviewing.";
  }
}

function _queueSubtitle() {
  switch (homeState.role) {
    case "super_admin":
    case "admin":
      return "All sessions across all pods";
    case "pod_lead":
      return `All tasks submitted by pod ${homeState.podId || ""}`;
    default:
      return "Submitted by trainers mapped to you";
  }
}
