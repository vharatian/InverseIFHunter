/**
 * API client: auth header and fetch wrapper.
 */
const EMAIL_KEY = "reviewer_email";
const API_BASE = "";

export function getEmail() {
  return sessionStorage.getItem(EMAIL_KEY) || "";
}

export function setEmail(email) {
  sessionStorage.setItem(EMAIL_KEY, email);
}

export function headers() {
  const email = getEmail();
  const h = { "Content-Type": "application/json" };
  if (email) h["X-Reviewer-Email"] = email;
  return h;
}

/**
 * @param {string} path
 * @param {{ method?: string; body?: string; headers?: Record<string,string> }} [options]
 * @returns {Promise<any>}
 */
export async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}
