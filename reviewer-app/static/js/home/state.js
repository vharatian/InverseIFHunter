/** Shared state for the reviewer home page. */

export const homeState = {
  role: "reviewer",
  podId: null,
  assignedTrainers: [],
  activeBucket: "in_queue",
  filter: "",
  items: [],
  counts: {},
  loading: false,
  pollTimer: null,
  displayIdLabel: "Task",
  onOpenSession: null,
};

export function setOpenSessionHandler(fn) {
  homeState.onOpenSession = typeof fn === "function" ? fn : null;
}

export function setDisplayIdLabel(label) {
  homeState.displayIdLabel = label || "Task";
}

export const ROLE_LABELS = {
  super_admin: "Super Admin",
  admin: "Admin",
  pod_lead: "Pod Lead",
  reviewer: "Reviewer",
};
