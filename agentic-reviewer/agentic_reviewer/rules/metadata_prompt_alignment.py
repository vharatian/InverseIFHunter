"""
Metadata prompt alignment rule: council checks that prompt content matches claimed Domain/Use Case.

Context-aware: evaluates meaning and intent, not just word presence.
Uses LLM Council for subjective judgment.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.council import run_council
from agentic_reviewer.rules.registry import register_rule


def get_council_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council. Public for streaming route."""
    return _build_prompt(snapshot)


def _build_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council: does prompt align with claimed Domain and Use Case?"""
    task_meta = snapshot.metadata.get("task_metadata") or {}
    domain = task_meta.get("domain", "")
    use_case = task_meta.get("use_case", "")
    prompt = snapshot.prompt or ""

    lines = [
        "You are a QA reviewer. Check if the TASK PROMPT content aligns with the claimed Domain and Use Case.",
        "",
        "CLAIMED METADATA:",
        f"  Domain: {domain or '(empty)'}",
        f"  Use Case: {use_case or '(empty)'}",
        "",
        "TASK PROMPT:",
        prompt[:2000] if prompt else "(none)",
        "",
        "Evaluate in CONTEXT:",
        "- Consider the meaning and intent of the prompt, not just keyword presence.",
        "- A prompt about 'Healthcare' discussing patient care aligns with Healthcare domain.",
        "- A prompt about 'avoiding sensitive topics' aligns with safety/guidance use cases.",
        "- PASS if the prompt content is reasonably consistent with the claimed Domain and Use Case.",
        "- FAIL if the prompt clearly belongs to a different domain/use case, or contradicts the metadata.",
        "",
        "First briefly explain your reasoning, then conclude with exactly one word on a new line: PASS or FAIL.",
        "Your final line must be only PASS or FAIL—no other format.",
    ]
    return "\n".join(lines)


@register_rule("metadata_prompt_alignment")
def check_metadata_prompt_alignment(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: prompt content matches claimed Domain/Use Case.
    Context-aware. Only runs at final checkpoint.
    """
    if snapshot.checkpoint != "final":
        return None

    task_meta = snapshot.metadata.get("task_metadata") or {}
    domain = task_meta.get("domain", "")
    use_case = task_meta.get("use_case", "")

    if not domain and not use_case:
        return None

    try:
        prompt = _build_prompt(snapshot)
        passed, votes = run_council(prompt, "metadata_prompt_alignment")
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
        rule_id="metadata_prompt_alignment",
        severity=IssueSeverity.ERROR,
        message=f"Council detected misalignment between prompt content and claimed metadata. Votes: {vote_summary}",
        hint="Ensure the prompt content matches the Domain and Use Case in notebook metadata, or update the metadata.",
        details={
            "council_votes": [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes],
            "domain": domain,
            "use_case": use_case,
            "prompt_preview": (snapshot.prompt or "")[:500],
        },
    )
