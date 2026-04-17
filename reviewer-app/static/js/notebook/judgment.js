/** Parse a single judge/human-judge block into grade pills + score + explanation. */
import { escapeHtml } from "../task.js";

export function formatJudgment(title, rawText, cssClass) {
  const grades = _parseGrades(rawText);
  const score = _parseScore(rawText);
  const explanation = _parseExplanation(rawText);

  const gradePills = grades.length
    ? `<div class="judge-grades">${grades
        .map((g) => `<span class="judge-grade judge-grade--${g.val.toLowerCase()}">${escapeHtml(g.id)}: ${g.val}</span>`)
        .join("")}</div>`
    : "";
  const scoreHtml = score ? `<span class="judge-score-pill">Score: ${escapeHtml(score)}</span>` : "";
  const expHtml = explanation ? `<div class="judge-explanation">${escapeHtml(explanation)}</div>` : "";

  return `<div class="slot-judgment-block ${cssClass}"><div class="slot-judgment-title">${escapeHtml(title)} ${scoreHtml}</div>${gradePills}${expHtml}</div>`;
}

function _parseGrades(rawText) {
  const grades = [];
  const gradeRe = /\b(C\d+)\s*[:：]\s*(PASS|FAIL|MISSING)\b/gi;
  let m;
  while ((m = gradeRe.exec(rawText)) !== null) {
    grades.push({ id: m[1].toUpperCase(), val: m[2].toUpperCase() });
  }
  if (grades.length) return grades;

  const jsonMatch = rawText.match(/\{[^}]*"C\d+"[^}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      for (const [k, v] of Object.entries(parsed)) {
        if (/^C\d+$/i.test(k)) grades.push({ id: k.toUpperCase(), val: String(v).toUpperCase() });
      }
    } catch {
      /* ignore bad JSON */
    }
  }
  return grades;
}

function _parseScore(rawText) {
  const m = rawText.match(/\*?\*?Score\*?\*?:?\s*(\d+)/i);
  return m ? m[1] : "";
}

function _parseExplanation(rawText) {
  const m = rawText.match(/\*?\*?Explanation\*?\*?:?\s*\n?([\s\S]*)/i);
  if (m) return m[1].replace(/```json[\s\S]*?```/g, "").trim();
  return rawText
    .replace(/```json[\s\S]*?```/g, "")
    .replace(/\*\*[^*]+\*\*:?/g, "")
    .replace(/\b(C\d+)\s*[:：]\s*(PASS|FAIL|MISSING)\b/gi, "")
    .replace(/\{[^}]*"C\d+"[^}]*\}/g, "")
    .trim();
}
