"""
Human vs LLM grade alignment rule: council checks for large disagreements.

Uses LLM Council (multiple models, consensus) for subjective judgment.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.council import run_council
from agentic_reviewer.rules.registry import register_rule


def get_council_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council. Public for streaming route."""
    return _build_prompt(snapshot)


def _build_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council: human grades vs LLM judge criteria."""
    lines = [
        "You are a QA reviewer. Compare human grader results with LLM judge results for 4 model responses.",
        "",
        "TASK PROMPT:",
        snapshot.prompt[:1500] if snapshot.prompt else "(none)",
        "",
        "CRITERIA (from reference):",
    ]
    for c in snapshot.criteria:
        lines.append(f"  - {c.get('id', '?')}: {c.get('description', '')[:200]}")
    lines.append("")
    lines.append("For each of 4 slots, compare HUMAN grades vs LLM judge:")
    lines.append("")

    human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}
    for i, hunt in enumerate(snapshot.selected_hunts[:4], 1):
        human = human_by_id.get(hunt.hunt_id)
        lines.append(f"--- Slot {i} (hunt_id={hunt.hunt_id}) ---")
        lines.append(f"LLM Judge: score={hunt.judge_score}, criteria={hunt.judge_criteria}")
        lines.append(f"LLM explanation: {hunt.judge_explanation[:300]}..." if len(hunt.judge_explanation or "") > 300 else f"LLM explanation: {hunt.judge_explanation or '(none)'}")
        if human:
            lines.append(f"Human grades: {human.grades}")
            lines.append(f"Human explanation: {human.explanation[:300]}..." if len(human.explanation or "") > 300 else f"Human explanation: {human.explanation or '(none)'}")
        else:
            lines.append("Human: (no review)")
        lines.append("")

    lines.extend([
        "Is there a LARGE disagreement between human and LLM grading?",
        "- PASS if human and LLM are broadly aligned, or differences are minor.",
        "- FAIL if there is a major disagreement (e.g. human says fail, LLM says pass, or vice versa for key criteria).",
        "",
        "First briefly explain your reasoning, then conclude with exactly one word on a new line: PASS or FAIL.",
        "Your final line must be only PASS or FAIL—no other format.",
    ])
    return "\n".join(lines)


@register_rule("human_llm_grade_alignment")
def check_human_llm_grade_alignment(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: human grading vs LLM judge — flag large disagreements.
    Only runs at final checkpoint (requires human_reviews).
    """
    if snapshot.checkpoint != "final":
        return None
    if len(snapshot.human_reviews) < 4 or len(snapshot.selected_hunts) < 4:
        return None

    try:
        prompt = _build_prompt(snapshot)
        passed, votes = run_council(prompt, "human_llm_grade_alignment")
    except ValueError as e:
        if "OPENROUTER" in str(e) or "API" in str(e):
            # API key missing — skip rule (don't block save)
            return None
        raise

    if passed:
        return None

    vote_summary = ", ".join(
        f"{m}: {'PASS' if v else 'FAIL' if v is False else '?'}" for m, v in votes
    )
    # Build slot-by-slot comparison for evaluation UI
    human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}
    slots = []
    for i, hunt in enumerate(snapshot.selected_hunts[:4], 1):
        human = human_by_id.get(hunt.hunt_id)
        llm_criteria = hunt.judge_criteria or {}
        human_grades = human.grades if human else {}
        # Find disagreements: same criterion, different pass/fail
        disagreements = []
        all_criteria = set(llm_criteria.keys()) | set(human_grades.keys())
        for cid in all_criteria:
            h_val = str(human_grades.get(cid, "")).lower() if human_grades.get(cid) else None
            l_val = str(llm_criteria.get(cid, "")).lower() if llm_criteria.get(cid) else None
            if h_val and l_val and h_val != l_val:
                disagreements.append({"criterion": cid, "human": h_val, "llm": l_val})
        slots.append({
            "slot": i,
            "hunt_id": hunt.hunt_id,
            "model": hunt.model,
            "response_preview": (hunt.response or "")[:300],
            "human_grades": human_grades if human else {},
            "human_explanation": (human.explanation or "")[:500] if human else "",
            "llm_judge_score": hunt.judge_score,
            "llm_judge_criteria": llm_criteria,
            "llm_judge_explanation": (hunt.judge_explanation or "")[:500],
            "disagreements": disagreements,
        })
    council_votes = [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes]
    return ReviewIssue(
        rule_id="human_llm_grade_alignment",
        severity=IssueSeverity.ERROR,
        message=f"Council detected a significant disagreement between human and LLM grading. Votes: {vote_summary}",
        hint="Review your grades and explanations. Ensure they align with the LLM judge criteria, or provide a clear justification for the difference.",
        details={
            "council_votes": council_votes,
            "slots": slots,
            "prompt": snapshot.prompt[:1000] if snapshot.prompt else "",
            "criteria": [{"id": c.get("id"), "description": (c.get("description") or "")[:200]} for c in snapshot.criteria],
        },
    )
