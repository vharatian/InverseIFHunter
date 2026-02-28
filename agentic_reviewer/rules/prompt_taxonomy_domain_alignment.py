"""
Prompt taxonomy/domain alignment rule.

Checks that the prompt is aligned first to the L1 Taxonomy, then to the Domain.
Uses LLM Council. FAIL if prompt doesn't fit the taxonomy AND domain.
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
    use_case = task_meta.get("use_case", "")
    prompt = snapshot.prompt or ""

    lines = [
        "You are a QA reviewer. Check that the TASK PROMPT is aligned with the L1 Taxonomy and Domain.",
        "",
        "CLAIMED METADATA:",
        f"  L1 Taxonomy: {l1_taxonomy or '(empty)'}",
        f"  Domain: {domain or '(empty)'}",
        f"  Use Case: {use_case or '(empty)'}",
        "",
        "TASK PROMPT:",
        prompt if prompt else "(none)",
        "",
        "EVALUATION ORDER:",
        "1. First check: does the prompt fit the L1 Taxonomy category? (e.g. QC = question correction/quality, CFA = counterfactual answering)",
        "2. Then check: does the prompt belong to the claimed Domain? (e.g. Healthcare, Finance, Legal)",
        "",
        "- PASS if the prompt aligns with BOTH the L1 Taxonomy and Domain.",
        "- FAIL if the prompt clearly mismatches the L1 Taxonomy OR the Domain.",
        "- Minor style differences are OK; flag substantive mismatches only.",
        "",
        "First briefly explain your reasoning (check taxonomy first, then domain), then conclude with exactly one word on a new line: PASS or FAIL.",
        "Your final line must be only PASS or FAIL—no other format.",
    ]
    return "\n".join(lines)


@register_rule("prompt_taxonomy_domain_alignment")
def check_prompt_taxonomy_domain_alignment(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: prompt aligns with L1 Taxonomy, then Domain.
    Only runs at final checkpoint.
    """
    if snapshot.checkpoint != "final":
        return None

    task_meta = snapshot.metadata.get("task_metadata") or {}
    l1_taxonomy = task_meta.get("l1_taxonomy", "")
    domain = task_meta.get("domain", "")
    if not l1_taxonomy and not domain:
        return None

    try:
        prompt = _build_prompt(snapshot)
        passed, votes = run_council(prompt, "prompt_taxonomy_domain_alignment")
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
        rule_id="prompt_taxonomy_domain_alignment",
        severity=IssueSeverity.ERROR,
        message=f"Prompt does not align with the claimed L1 Taxonomy / Domain. Votes: {vote_summary}",
        hint="Verify that the prompt content matches the L1 Taxonomy (task type) and Domain (subject area) in the notebook metadata.",
        details={
            "council_votes": [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes],
            "l1_taxonomy": l1_taxonomy,
            "domain": domain,
            "prompt": snapshot.prompt or "",
        },
    )
