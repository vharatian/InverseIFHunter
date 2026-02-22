/**
 * Keyboard shortcuts: A = Approve, R = Return, S = Save feedback, j/k = queue nav,
 * Enter = open, Esc = back, Left/Right = prev/next task.
 */
import { showTask } from "./dom.js";

let onApprove = () => {};
let onReturn = () => {};
let onSaveFeedback = () => {};
let onSelectTask = () => {};
let getQueueSessionIds = () => [];
let getFocusedQueueIndex = () => -1;
let onPrevTask = () => {};
let onNextTask = () => {};

export function setKeyboardHandlers(handlers) {
  onApprove = handlers.onApprove || onApprove;
  onReturn = handlers.onReturn || onReturn;
  onSaveFeedback = handlers.onSaveFeedback || onSaveFeedback;
  onSelectTask = handlers.onSelectTask || onSelectTask;
  getQueueSessionIds = handlers.getQueueSessionIds || getQueueSessionIds;
  getFocusedQueueIndex = handlers.getFocusedQueueIndex || getFocusedQueueIndex;
  onPrevTask = handlers.onPrevTask || onPrevTask;
  onNextTask = handlers.onNextTask || onNextTask;
}

function isTypingElement(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return true;
  if (el.isContentEditable) return true;
  return false;
}

export function initKeyboard() {
  document.addEventListener("keydown", (e) => {
    const gate = document.getElementById("gate");
    if (gate && !gate.hidden) return;

    const modal = document.getElementById("modal-overlay");
    if (modal && !modal.hidden) return;

    const active = document.activeElement;
    if (isTypingElement(active) || isTypingElement(e.target)) return;
    const key = e.key.toLowerCase();
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    const taskView = document.getElementById("task-view");
    const inTask = taskView && !taskView.hidden;

    if (key === "a" && inTask) { e.preventDefault(); onApprove(); return; }
    if (key === "r" && inTask) { e.preventDefault(); onReturn(); return; }
    if (key === "s" && inTask) { e.preventDefault(); onSaveFeedback(); return; }

    if (inTask && (key === "arrowleft" || key === "[")) { e.preventDefault(); onPrevTask(); return; }
    if (inTask && (key === "arrowright" || key === "]")) { e.preventDefault(); onNextTask(); return; }

    const queueList = document.getElementById("queue-list");
    if (inTask && queueList) {
      if (key === "escape") { e.preventDefault(); showTask(false); return; }
    }

    if (queueList && (key === "j" || key === "k" || key === "arrowdown" || key === "arrowup")) {
      const ids = getQueueSessionIds();
      if (ids.length === 0) return;
      let idx = getFocusedQueueIndex();
      if (key === "k" || key === "arrowup") {
        idx = idx <= 0 ? ids.length - 1 : idx - 1;
      } else {
        idx = idx < 0 ? 0 : (idx + 1) % ids.length;
      }
      const li = queueList.querySelector(`li[data-session-id="${ids[idx]}"]`);
      if (li) { li.focus(); e.preventDefault(); }
      return;
    }

    if (key === "enter" && document.activeElement?.dataset?.sessionId) {
      e.preventDefault();
      onSelectTask(document.activeElement.dataset.sessionId);
    }
  });
}
