"""
Overall criteria quality rule.

Council checks that the criteria are:
1. Measurable and specific (not vague like "be good")
2. Relevant to the prompt and domain
3. Appropriately learnable — help the model learn from data/issues, not just penalize

Uses LLM Council.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.council import run_council
from agentic_reviewer.rules.registry import register_rule


def get_council_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council. Public for streaming route."""
    return _build_prompt(snapshot)


def _build_prompt(snapshot: TaskSnapshot) -> str:
    task_meta = snapshot.metadata.get("task_metadata") or {}
    domain = task_meta.get("domain", "")
    l1_taxonomy = task_meta.get("l1_taxonomy", "")
    prompt = snapshot.prompt or ""
    criteria_lines = [f"  {c.get('id','?')}: {c.get('description','')}" for c in snapshot.criteria]
    criteria_block = "\n".join(criteria_lines) if criteria_lines else "  (no criteria)"

    lines = [
        "You are a QA reviewer. Evaluate the OVERALL QUALITY of the evaluation criteria for this task.",
        "",
        "CONTEXT:",
        f"  Domain: {domain or '(empty)'}",
        f"  L1 Taxonomy: {l1_taxonomy or '(empty)'}",
        "",
        "TASK PROMPT:",
        prompt if prompt else "(none)",
        "",
        "CRITERIA:",
        criteria_block,
        "",
        "EVALUATION DIMENSIONS:",
        "1. Measurability — each criterion should be objectively assessable (not 'be good' or 'be helpful' alone).",
        "2. Relevance — criteria should test something meaningful for the domain and prompt.",
        "3. Learning value — criteria should help a model learn and improve from feedback, not just penalize.",
        "   Good: 'C1: Response must cite the specific statute when discussing legal obligations'",
        "   Poor: 'C1: Response must be correct' (too vague to learn from)",
        "4. Coverage — together the criteria should cover the important aspects of the task.",
        "5. No overlap — criteria should not duplicate each other.",
        "",
        "- PASS if the criteria are of good overall quality across these dimensions.",
        "- FAIL if criteria are vague, irrelevant, or would not help a model learn.",
        "",
        "First briefly explain your reasoning, then conclude with exactly one word on a new line: PASS or FAIL.",
        "Your final line must be only PASS or FAIL—no other format.",
    ]
    return "\n".join(lines)


@register_rule("overall_criteria_quality")
def check_overall_criteria_quality(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: criteria are specific, measurable, relevant, and have learning value.
    Only runs at final checkpoint.
    """
    if snapshot.checkpoint != "final":
        return None

    if not snapshot.criteria:
        return ReviewIssue(
            rule_id="overall_criteria_quality",
            severity=IssueSeverity.WARNING,
            message="No criteria found for this task.",
            hint="Every task should have at least one evaluation criterion (C1, C2, ...) in the reference section.",
        )

    try:
        prompt = _build_prompt(snapshot)
        passed, votes = run_council(prompt, "overall_criteria_quality")
    except ValueError as e:
        if "OPENROUTER" in str(e) or "API" in str(e):
            return None
        raise

    if passed:
        return None

    vote_summary = ", ".join(
        f"{m}: {'PASS' if v else 'FAIL' if v is False else '?'}" for m, v in votes
    )
    return ReviewIssue(
        rule_id="overall_criteria_quality",
        severity=IssueSeverity.WARNING,
        message=f"Council identified quality issues with the evaluation criteria. Votes: {vote_summary}",
        hint="Improve criteria to be specific and measurable. Each criterion should help the model learn what makes a good response, not just penalize it.",
        details={
            "council_votes": [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes],
            "criteria": snapshot.criteria,
            "prompt": snapshot.prompt or "",
        },
    )
