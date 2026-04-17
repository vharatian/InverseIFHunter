/** Gate (sign-in): email validation + sign-in button + change-email button. */
import { getEmail, setEmail, api } from "../api.js";
import { showGate, showToast } from "../dom.js";
import { hydrateIdentity, showHome } from "../home/index.js";
import { resetLoader } from "../notebook/loader.js";

/**
 * @param {() => void} [onSignIn] - called after a successful sign-in.
 * @param {() => void} [onSignOut] - called after the user hits "Change email".
 */
export function initGate({ onSignIn, onSignOut } = {}) {
  _wireContinue(onSignIn);
  _wireEmailInput();
  _wireChangeEmail(onSignOut);
}

function _wireContinue(onSignIn) {
  document.getElementById("btn-continue")?.addEventListener("click", async () => {
    const input = document.getElementById("email-input");
    const errEl = document.getElementById("gate-error");
    const btn = document.getElementById("btn-continue");
    const email = (input?.value || "").trim();

    if (!email) {
      _showGateError(errEl, "Enter your email.");
      _updateEmailFeedback();
      return;
    }
    if (!isPlausibleEmail(email)) {
      _showGateError(errEl, "Fix your email, then press Sign in.");
      _updateEmailFeedback();
      input?.focus();
      return;
    }
    if (errEl) errEl.hidden = true;
    _setBtnBusy(btn, true);

    setEmail(email);
    try {
      await hydrateIdentity();
      const emailSpan = document.getElementById("reviewer-email");
      if (emailSpan) emailSpan.textContent = email;
      showGate(false);
      showHome();
      if (typeof onSignIn === "function") onSignIn(email);
      showToast("Signed in as " + email, "success");
    } catch (e) {
      setEmail("");
      _showGateError(errEl, _friendlySignInError(e));
    } finally {
      _setBtnBusy(btn, false);
    }
  });
}

function _wireEmailInput() {
  const input = document.getElementById("email-input");
  input?.addEventListener("input", () => {
    const errEl = document.getElementById("gate-error");
    if (errEl && !errEl.hidden) {
      errEl.hidden = true;
      errEl.textContent = "";
    }
    _updateEmailFeedback();
  });
  input?.addEventListener("blur", _updateEmailFeedback);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-continue")?.click();
  });
}

function _wireChangeEmail(onSignOut) {
  document.getElementById("btn-change-email")?.addEventListener("click", () => {
    const prevEmail = getEmail();
    setEmail("");
    const emailSpan = document.getElementById("reviewer-email");
    if (emailSpan) emailSpan.textContent = "";
    resetLoader();
    if (typeof onSignOut === "function") onSignOut();
    showGate(true);
    const input = document.getElementById("email-input");
    if (input) {
      input.value = prevEmail;
      input.focus();
      _updateEmailFeedback();
    }
  });
}

/**
 * Restore session on page load. If the stored email still validates against
 * the server, transition to the home page. Otherwise, leave the user on the gate.
 */
export async function bootstrapAuthState() {
  const email = getEmail();
  if (!email) {
    showGate(true);
    return;
  }
  const emailSpan = document.getElementById("reviewer-email");
  if (emailSpan) emailSpan.textContent = email;
  showGate(false);
  try {
    await hydrateIdentity();
    showHome();
  } catch (e) {
    const msg = (e && e.message) || "";
    if (/403|unauth|allowlist|not\s*allow|forbidden|Missing/i.test(msg)) {
      setEmail("");
      if (emailSpan) emailSpan.textContent = "";
      resetLoader();
      showGate(true);
      showToast("Your reviewer access is no longer valid. Please sign in again.", "error");
    }
  }
}

export function isPlausibleEmail(s) {
  const t = (s || "").trim();
  if (!t || t.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(t);
}

function _updateEmailFeedback() {
  const input = document.getElementById("email-input");
  const fb = document.getElementById("gate-email-feedback");
  if (!input || !fb) return;
  const t = (input.value || "").trim();
  input.classList.remove("gate-input--invalid", "gate-input--valid");
  if (!t) {
    fb.hidden = true;
    fb.textContent = "";
    fb.className = "gate-email-feedback";
    input.removeAttribute("aria-invalid");
    return;
  }
  fb.hidden = false;
  if (isPlausibleEmail(t)) {
    fb.className = "gate-email-feedback gate-email-feedback--valid";
    fb.textContent = "Looks good. Press Sign in next.";
    input.classList.add("gate-input--valid");
    input.setAttribute("aria-invalid", "false");
  } else {
    fb.className = "gate-email-feedback gate-email-feedback--invalid";
    fb.textContent = "That doesn't look like a full email. Use something like you@company.com.";
    input.classList.add("gate-input--invalid");
    input.setAttribute("aria-invalid", "true");
  }
}

function _showGateError(errEl, msg) {
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.hidden = false;
}

function _setBtnBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.setAttribute("aria-busy", busy ? "true" : "false");
}

function _friendlySignInError(e) {
  const msg = e?.message || "";
  if (msg.includes("timed out")) {
    return "The server took too long to respond. Try again, or contact your lead if this keeps happening.";
  }
  if (/allowlist|Missing|403|Not an allowed/i.test(msg)) {
    return "This email isn't on the list. Ask your lead for help.";
  }
  return msg || "Something went wrong. Try again.";
}
