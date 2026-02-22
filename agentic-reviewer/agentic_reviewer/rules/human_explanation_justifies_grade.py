"""
Human explanation justifies grade rule: council checks that explanations are substantive.

Flags generic/vague explanations that don't justify the grade given.
Uses LLM Council for subjective judgment.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.council import run_council
from agentic_reviewer.rules.registry import register_rule


def get_council_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council. Public for streaming route."""
    return _build_prompt(snapshot)


def _build_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council: are human explanations substantive?"""
    lines = [
        "You are a QA reviewer. Check if the human grader explanations are substantive and justify the grades given.",
        "",
        "TASK PROMPT:",
        (snapshot.prompt or "")[:1000],
        "",
        "CRITERIA (from reference):",
    ]
    for c in snapshot.criteria:
        lines.append(f"  - {c.get('id', '?')}: {c.get('description', '')[:200]}")
    lines.append("")
    lines.append("For each of 4 slots, the human gave grades and an explanation:")
    lines.append("")

    human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}
    for i, hunt in enumerate(snapshot.selected_hunts[:4], 1):
        human = human_by_id.get(hunt.hunt_id)
        lines.append(f"--- Slot {i} (hunt_id={hunt.hunt_id}) ---")
        lines.append(f"Response preview: {(hunt.response or '')[:200]}...")
        if human:
            lines.append(f"Human grades: {human.grades}")
            lines.append(f"Human explanation: {human.explanation or '(empty)'}")
        else:
            lines.append("Human: (no review)")
        lines.append("")

    lines.extend([
        "Are the human explanations substantive?",
        "- PASS if explanations give concrete reasons that justify the grades (e.g. cite criteria, point to specific issues).",
        "- FAIL if explanations are generic, vague, or don't justify the grade (e.g. 'Bad.', 'It failed.', 'Good.' without reasoning).",
        "- Empty or very short explanations (< 10 words) for fail grades should typically FAIL.",
        "",
        "First briefly explain your reasoning, then conclude with exactly one word on a new line: PASS or FAIL.",
        "Your final line must be only PASS or FAIL—no other format.",
    ])
    return "\n".join(lines)


@register_rule("human_explanation_justifies_grade")
def check_human_explanation_justifies_grade(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: human explanations are substantive and justify grades.
    Only runs at final checkpoint.
    """
    if snapshot.checkpoint != "final":
        return None
    if len(snapshot.human_reviews) < 4 or len(snapshot.selected_hunts) < 4:
        return None

    try:
        prompt = _build_prompt(snapshot)
        passed, votes = run_council(prompt, "human_explanation_justifies_grade")
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
            "grades": human.grades if human else {},
            "explanation": (human.explanation or "")[:300] if human else "",
        })
    return ReviewIssue(
        rule_id="human_explanation_justifies_grade",
        severity=IssueSeverity.ERROR,
        message=f"Council detected generic or non-substantive explanations. Votes: {vote_summary}",
        hint="Provide concrete explanations that justify your grades. Reference criteria and specific issues in the response.",
        details={
            "council_votes": [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes],
            "slots": slots,
        },
    )
