/** URL helpers: normalize freeform input into a URL and probe for notebook-ish links. */

export function normalizeNotebookUrl(s) {
  let t = (s || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (
    t.includes("colab.") ||
    t.includes("drive.google") ||
    t.includes("github.com") ||
    t.includes("githubusercontent.com") ||
    /^[\w.-]+\.[a-z]{2,}\//i.test(t)
  ) {
    return "https://" + t.replace(/^\/+/, "");
  }
  return t;
}

export function isLikelyNotebookUrl(s) {
  const t = (s || "").trim().toLowerCase();
  if (!t) return false;
  return (
    t.includes("colab.research.google.com") ||
    t.includes("colab.google.com") ||
    t.includes("drive.google.com") ||
    t.includes("raw.githubusercontent.com") ||
    t.includes("githubusercontent.com") ||
    (t.includes("github.com") && t.includes(".ipynb"))
  );
}
