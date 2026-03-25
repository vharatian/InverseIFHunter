"""
Reviewer-side agent: runs the full rule engine (same as trainer) AND a rich LLM review.
Returns both alongside each other so the UI can show them together.
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from config import get_reviewer_agent_config

logger = logging.getLogger(__name__)


def _ensure_path():
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def build_review_prompt(snapshot: Dict[str, Any]) -> str:
    """
    Build a rich, multi-section prompt for the reviewer agent.
    Asks for deep, targeted suggestions across all dimensions of the task.
    """
    prompt_text = (snapshot.get("prompt") or "").strip() or "(no prompt)"
    ideal_response = (snapshot.get("ideal_response") or "").strip()
    criteria = snapshot.get("criteria") or []
    criteria_text = "\n".join(
        f"- {c.get('id', '')}: {c.get('description', '')}" for c in criteria
    ) or "(no criteria)"
    selected = snapshot.get("selected_hunts") or []
    human_reviews = snapshot.get("human_reviews") or []
    metadata = (snapshot.get("metadata") or {}).get("task_metadata") or {}

    meta_lines = []
    for k in ("domain", "use_case", "l1_taxonomy", "model", "Turn", "Task ID"):
        v = metadata.get(k) or metadata.get(k.lower()) or metadata.get(k.replace(" ", "_").lower())
        if v:
            meta_lines.append(f"  {k}: {v}")
    meta_block = "\n".join(meta_lines) or "  (none)"

    ideal_block = f"\nIDEAL / EXPECTED RESPONSE (written by trainer):\n{ideal_response}\n" if ideal_response else ""

    slots_text = []
    for i, hunt in enumerate(selected[:4]):
        slot = i + 1
        model = hunt.get("model", "")
        response = (hunt.get("response") or "").strip()
        judge_score = hunt.get("judge_score")
        judge_criteria = hunt.get("judge_criteria") or {}
        judge_explanation = (hunt.get("judge_explanation") or "").strip()
        grade = ""
        explanation = ""
        for hr in human_reviews:
            if str(hr.get("hunt_id")) == str(hunt.get("hunt_id", "")):
                grade = str(hr.get("grades", ""))
                explanation = (hr.get("explanation") or "").strip()
                break
        judge_grades_line = (
            ", ".join(f"{k}: {v}" for k, v in judge_criteria.items())
            if judge_criteria else "(no LLM grades)"
        )
        slots_text.append(
            f"Slot {slot} (model: {model}):\n"
            f"  Response: {response or '(empty)'}\n"
            f"  Human grade: {grade or '(none)'}\n"
            f"  Human explanation: {explanation or '(none)'}\n"
            f"  LLM judge score: {judge_score if judge_score is not None else '(none)'}\n"
            f"  LLM judge grades: {judge_grades_line}\n"
            f"  LLM judge explanation: {judge_explanation or '(none)'}"
        )
    slots_block = "\n\n".join(slots_text) or "(no slots)"

    return f"""You are a senior QC reviewer evaluating a trainer-submitted task for an AI training dataset. \
Your job is to give the reviewer deep, specific, and actionable feedback across every dimension of the task. \
Be critical but fair. Be specific — cite the actual text from the prompt, criteria, or responses when making suggestions.

TASK METADATA:
{meta_block}

TASK PROMPT:
{prompt_text}
{ideal_block}
CRITERIA:
{criteria_text}

SELECTED RESPONSES AND TRAINER GRADES:
{slots_block}

---

Provide your review in the following structure. Use exactly these section headers.

## Summary
(3–5 sentences covering: overall task quality, whether the prompt is clear and well-scoped, whether the criteria \
are specific and measurable, whether the trainer grading is consistent and well-explained, and whether the selected \
responses are appropriately diverse or all from the same quality tier.)

## Prompt Quality
(Bullet list. For each point, quote or reference the specific part of the prompt. Cover:
- Clarity and specificity: Is the task unambiguous? Would two different models interpret it the same way?
- Scope: Is it too broad, too narrow, or well-scoped for the declared domain/use-case?
- Constraints: Are all constraints real and necessary, or are some imaginary/unnecessary?
- Length appropriateness: Is the prompt length appropriate for the complexity of the task?
- Missing context: What information is missing that would help a model answer correctly?
- Alignment: Does the prompt actually match the declared domain, use case, and L1 taxonomy?
Write "No issues." only if the prompt is genuinely excellent.)

## Criteria Quality
(Bullet list. For each criterion, evaluate:
- Is it specific and measurable, or vague and subjective?
- Is it actually testable against the responses?
- Does it cover the most important aspects of a good answer?
- Are there important aspects NOT covered by any criterion?
- Are any criteria redundant or overlapping?
- If an ideal/expected response is provided, do the criteria align with it?
Write "No issues." only if all criteria are genuinely strong.)

## Grading Quality
(Bullet list, per slot where relevant. Cover:
- Are the human grades consistent with the criteria?
- Are explanations substantive, or generic/one-line?
- Do the human and LLM judge grades agree? If not, flag the disagreement and suggest which is more defensible.
- Are any responses graded too harshly or too leniently?
- Is the selected response set appropriately diverse (models, quality tiers)?
Write "No issues." only if all grading is genuinely strong.)

## Suggestions
(Concrete, prioritized action items for the trainer. Number them. Start each with the area: \
[PROMPT], [CRITERIA], [GRADING], [RESPONSE], or [METADATA]. Example:
1. [PROMPT] Rewrite the opening sentence to specify that the answer must be in Python 3.10+.
2. [CRITERIA] C2 is too vague — change "is correct" to "produces output matching the expected result for at least 3 test cases".
Be exhaustive. If you see 8 things to fix, list all 8. Do not summarize.)

## Safety & Factuality Checks
(Bullet list of any concerns:
- Does the prompt or any response contain harmful, unsafe, or prohibited content?
- Are any factual claims in the responses verifiably wrong?
- Does the ideal response (if provided) contain errors that could teach the model incorrect information?
- Are there any policy or guideline violations?
Write "No concerns." if none.)

Do not add other sections. Be direct and specific — vague feedback is unhelpful."""


def _run_rule_engine(snapshot_dict: Dict[str, Any]):
    """
    Run all final-checkpoint rules from global.yaml against the snapshot.
    Returns a list of rule result dicts: {rule_id, description, passed, severity, message, hint}.
    """
    _ensure_path()
    from agentic_reviewer.rule_engine import get_rules_for_checkpoint, run_review
    from agentic_reviewer.schemas import TaskSnapshot

    # Build a proper TaskSnapshot for the "final" checkpoint
    try:
        snapshot = TaskSnapshot(**{**snapshot_dict, "checkpoint": "final"})
    except Exception as e:
        logger.warning("Could not build TaskSnapshot for rule engine: %s", e)
        return []

    # Get all final rules (for labels/descriptions)
    all_rules = get_rules_for_checkpoint("final")
    rule_meta = {r["id"]: r for r in all_rules}

    # Run
    try:
        result = run_review(snapshot)
    except Exception as e:
        logger.exception("Rule engine failed: %s", e)
        return [{"rule_id": "rule_engine", "description": "Rule engine", "passed": False,
                 "severity": "error", "message": f"Rule engine error: {e}", "hint": "Check logs."}]

    failed_ids = {issue.rule_id for issue in result.issues}
    issue_by_id = {issue.rule_id: issue for issue in result.issues}

    rule_results = []
    for rule_def in all_rules:
        rid = rule_def.get("id")
        if not rid:
            continue
        passed = rid not in failed_ids
        issue = issue_by_id.get(rid)
        rule_results.append({
            "rule_id": rid,
            "description": rule_def.get("description", rid),
            "passed": passed,
            "severity": issue.severity.value if issue else None,
            "message": issue.message if issue else None,
            "hint": issue.hint if issue else None,
            "weight": rule_def.get("weight"),
        })

    return rule_results, result.weighted_score


def run_agent_sync(session_dict: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run both the rule engine AND the LLM reviewer for a session.
    Returns: { review_text, rule_results, weighted_score, model_used, timestamp, error? }
    """
    _ensure_path()
    from agentic_reviewer.snapshot_builder import build_snapshot

    if not session_dict:
        return {"error": "Session not found", "review_text": "", "rule_results": [],
                "weighted_score": None, "model_used": "", "timestamp": _now_iso()}

    try:
        snapshot = build_snapshot(session_dict, "final")
        snapshot_dict = snapshot.model_dump()
    except Exception as e:
        return {"error": f"Snapshot build failed: {e}", "review_text": "", "rule_results": [],
                "weighted_score": None, "model_used": "", "timestamp": _now_iso()}

    # ── 1. Run rule engine ──────────────────────────────────────────────────
    rule_results = []
    weighted_score = None
    try:
        rule_results, weighted_score = _run_rule_engine(snapshot_dict)
    except Exception as e:
        logger.exception("Rule engine step failed")
        rule_results = [{"rule_id": "rule_engine", "description": "Rule engine", "passed": False,
                         "severity": "error", "message": str(e), "hint": ""}]

    # ── 2. Run LLM review ───────────────────────────────────────────────────
    prompt = build_review_prompt(snapshot_dict)
    cfg = get_reviewer_agent_config()
    model = cfg.get("model", "anthropic/claude-sonnet-4")
    max_tokens = cfg.get("max_tokens", 4096)
    timeout = cfg.get("timeout", 180.0)

    review_text = ""
    llm_error = None
    try:
        from providers.openrouter import call_model_sync
        review_text, err = call_model_sync(prompt, model, max_tokens=max_tokens, timeout=timeout)
        if err:
            llm_error = err
    except Exception as e:
        logger.exception("Agent LLM call failed")
        llm_error = str(e)

    return {
        "review_text": review_text or "",
        "rule_results": rule_results,
        "weighted_score": weighted_score,
        "model_used": model,
        "timestamp": _now_iso(),
        "error": llm_error,
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
