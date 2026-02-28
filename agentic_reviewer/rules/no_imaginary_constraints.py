"""
No imaginary constraints rule.

Checks that the prompt does not introduce invented or arbitrary constraints
that have no grounding in the real-world domain or task type
(e.g. "respond in exactly 47 words", "must use the word 'azure' three times").

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
    use_case = task_meta.get("use_case", "")
    prompt = snapshot.prompt or ""
    criteria_lines = [f"  - {c.get('id','?')}: {c.get('description','')}" for c in snapshot.criteria]
    criteria_block = "\n".join(criteria_lines) if criteria_lines else "  (none)"

    lines = [
        "You are a QA reviewer. Check whether the TASK PROMPT contains imaginary or invented constraints.",
        "",
        "CONTEXT:",
        f"  Domain: {domain or '(empty)'}",
        f"  Use Case: {use_case or '(empty)'}",
        "",
        "TASK PROMPT:",
        prompt if prompt else "(none)",
        "",
        "CRITERIA:",
        criteria_block,
        "",
        "DEFINITION — Imaginary constraints are:",
        "- Arbitrary rules with no grounding in domain reality",
        "  (e.g. 'answer in exactly 50 words', 'include the word blue three times')",
        "- Made-up restrictions that a real user would never impose",
        "  (e.g. 'do not mention any continent starting with A')",
        "- Constraints invented to make the task harder with no pedagogical reason",
        "",
        "NOT imaginary constraints:",
        "- Domain-appropriate rules (e.g. 'respond in plain language' for healthcare)",
        "- Format requirements that a real user might specify (e.g. 'use bullet points')",
        "- Criteria that check for accurate or safe responses",
        "",
        "- PASS if the prompt has no imaginary constraints.",
        "- FAIL if the prompt contains constraints that appear invented or arbitrary.",
        "",
        "First briefly explain your reasoning, then conclude with exactly one word on a new line: PASS or FAIL.",
        "Your final line must be only PASS or FAIL—no other format.",
    ]
    return "\n".join(lines)


@register_rule("no_imaginary_constraints")
def check_no_imaginary_constraints(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: prompt contains no invented/imaginary constraints.
    Only runs at final checkpoint.
    """
    if snapshot.checkpoint != "final":
        return None

    try:
        prompt = _build_prompt(snapshot)
        passed, votes = run_council(prompt, "no_imaginary_constraints")
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
        rule_id="no_imaginary_constraints",
        severity=IssueSeverity.WARNING,
        message=f"Council detected potential imaginary/invented constraints in the prompt. Votes: {vote_summary}",
        hint="Review the prompt for arbitrary constraints that don't reflect real-world use cases. Remove or replace them with domain-appropriate requirements.",
        details={
            "council_votes": [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes],
            "prompt": snapshot.prompt or "",
        },
    )
