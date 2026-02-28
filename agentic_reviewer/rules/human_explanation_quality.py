"""
Human explanation quality rule.

Council evaluates whether the human explanation is:
1. Meaningful — says something substantive, not just "pass" or "fail"
2. Related to the response — references the actual content of the response
3. Justifies the grades — explains WHY each criterion was passed or failed

This is a stricter and more response-focused version of human_explanation_justifies_grade.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.council import run_council
from agentic_reviewer.rules.registry import register_rule


def get_council_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council. Public for streaming route."""
    return _build_prompt(snapshot)


def _build_prompt(snapshot: TaskSnapshot) -> str:
    prompt = snapshot.prompt or ""
    criteria_lines = [f"  {c.get('id','?')}: {c.get('description','')}" for c in snapshot.criteria]
    criteria_block = "\n".join(criteria_lines) if criteria_lines else "  (none)"

    human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}
    lines = [
        "You are a QA reviewer. Evaluate whether the human grader explanations are:",
        "  (a) Meaningful — say something substantive beyond just 'pass' or 'fail'",
        "  (b) Related to the response — reference actual content from the model response",
        "  (c) Justified — explain WHY each grade was given",
        "",
        "TASK PROMPT:",
        prompt if prompt else "(none)",
        "",
        "CRITERIA:",
        criteria_block,
        "",
    ]
    for i, hunt in enumerate(snapshot.selected_hunts[:4], 1):
        human = human_by_id.get(hunt.hunt_id)
        lines.append(f"=== Slot {i} (model: {hunt.model}) ===")
        lines.append(f"RESPONSE:\n{hunt.response or '(none)'}")
        lines.append("")
        if human:
            lines.append(f"Human grades: {human.grades}")
            lines.append(f"Human explanation: {human.explanation or '(empty)'}")
        else:
            lines.append("Human: (no review)")
        lines.append("")

    lines.extend([
        "EVALUATION:",
        "- PASS if explanations are meaningful, reference the response, and justify the grades.",
        "- FAIL if explanations are generic ('looks good', 'failed'), empty, or don't relate to the response.",
        "- A single poor explanation should FAIL the whole review.",
        "",
        "First briefly explain your reasoning for each slot, then conclude with exactly one word on a new line: PASS or FAIL.",
        "Your final line must be only PASS or FAIL—no other format.",
    ])
    return "\n".join(lines)


@register_rule("human_explanation_quality")
def check_human_explanation_quality(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: human explanations are meaningful, response-related, and justified.
    Only runs at final checkpoint.
    """
    if snapshot.checkpoint != "final":
        return None
    if len(snapshot.human_reviews) < 1 or len(snapshot.selected_hunts) < 1:
        return None

    try:
        prompt = _build_prompt(snapshot)
        passed, votes = run_council(prompt, "human_explanation_quality")
    except ValueError as e:
        if "OPENROUTER" in str(e) or "API" in str(e):
            return None
        raise

    if passed:
        return None

    vote_summary = ", ".join(
        f"{m}: {'PASS' if v else 'FAIL' if v is False else '?'}" for m, v in votes
    )
    human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}
    slots = []
    for i, hunt in enumerate(snapshot.selected_hunts[:4], 1):
        human = human_by_id.get(hunt.hunt_id)
        slots.append({
            "slot": i,
            "hunt_id": hunt.hunt_id,
            "model": hunt.model,
            "grades": human.grades if human else {},
            "explanation": (human.explanation or "") if human else "",
            "response": hunt.response or "",
        })

    return ReviewIssue(
        rule_id="human_explanation_quality",
        severity=IssueSeverity.ERROR,
        message=f"Council found human explanations are not meaningfully related to the responses. Votes: {vote_summary}",
        hint="Rewrite explanations to reference specific parts of each response and explain clearly why each criterion passed or failed.",
        details={
            "council_votes": [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes],
            "slots": slots,
        },
    )
