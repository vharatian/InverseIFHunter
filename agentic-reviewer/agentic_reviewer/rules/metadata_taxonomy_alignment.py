"""
Metadata taxonomy alignment rule: council checks that L1 Taxonomy is consistent with Domain/Use Case.

Context-aware: evaluates semantic consistency, not just keyword match.
Uses LLM Council for subjective judgment.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.council import run_council
from agentic_reviewer.rules.registry import register_rule


def get_council_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council. Public for streaming route."""
    return _build_prompt(snapshot)


def _build_prompt(snapshot: TaskSnapshot) -> str:
    """Build prompt for council: is L1 Taxonomy consistent with Domain and Use Case?"""
    task_meta = snapshot.metadata.get("task_metadata") or {}
    domain = task_meta.get("domain", "")
    use_case = task_meta.get("use_case", "")
    l1_taxonomy = task_meta.get("l1_taxonomy", "")
    prompt = snapshot.prompt or ""

    lines = [
        "You are a QA reviewer. Check if the L1 Taxonomy is consistent with the Domain and Use Case.",
        "",
        "CLAIMED METADATA:",
        f"  Domain: {domain or '(empty)'}",
        f"  Use Case: {use_case or '(empty)'}",
        f"  L1 Taxonomy: {l1_taxonomy or '(empty)'}",
        "",
        "TASK PROMPT (for context):",
        prompt[:1000] if prompt else "(none)",
        "",
        "Evaluate in CONTEXT:",
        "- L1 Taxonomy should semantically align with the Domain and Use Case.",
        "- E.g. Healthcare + Patient Care + QC (Question Correction) can be consistent.",
        "- E.g. Finance + Fraud Detection + CFA (Counterfactual Answering) can be consistent.",
        "- PASS if the taxonomy reasonably fits the domain/use case.",
        "- FAIL if the taxonomy clearly contradicts or is unrelated to the domain/use case.",
        "",
        "First briefly explain your reasoning, then conclude with exactly one word on a new line: PASS or FAIL.",
        "Your final line must be only PASS or FAIL—no other format.",
    ]
    return "\n".join(lines)


@register_rule("metadata_taxonomy_alignment")
def check_metadata_taxonomy_alignment(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: L1 Taxonomy consistent with Domain/Use Case.
    Context-aware. Only runs at final checkpoint.
    """
    if snapshot.checkpoint != "final":
        return None

    task_meta = snapshot.metadata.get("task_metadata") or {}
    domain = task_meta.get("domain", "")
    use_case = task_meta.get("use_case", "")
    l1_taxonomy = task_meta.get("l1_taxonomy", "")

    if not l1_taxonomy:
        return None

    try:
        prompt = _build_prompt(snapshot)
        passed, votes = run_council(prompt, "metadata_taxonomy_alignment")
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
        rule_id="metadata_taxonomy_alignment",
        severity=IssueSeverity.ERROR,
        message=f"Council detected inconsistency between L1 Taxonomy and Domain/Use Case. Votes: {vote_summary}",
        hint="Ensure the L1 Taxonomy aligns with the Domain and Use Case in notebook metadata.",
        details={
            "council_votes": [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes],
            "domain": domain,
            "use_case": use_case,
            "l1_taxonomy": l1_taxonomy,
        },
    )
