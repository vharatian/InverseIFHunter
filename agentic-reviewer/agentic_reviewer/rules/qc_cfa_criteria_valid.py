"""
QC/CFA criteria validity rule: for QC and CFA taxonomies, criteria can reference what's not in prompt.

QC (Question Correction): criteria may reject prompt premise, describe correct answer not in prompt.
CFA (Counterfactual Answering): similar "imaginary constraints".
Do not penalize criteria that reference what's not there — but flag invented golden answers.
Uses LLM Council.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.council import run_council
from agentic_reviewer.rules.registry import register_rule

DEFAULT_TAXONOMIES = ["QC", "CFA"]


def get_council_prompt(snapshot: TaskSnapshot, params: dict | None = None) -> str:
    """Build prompt for council. Public for streaming route."""
    params = params or {}
    taxonomies = params.get("taxonomies") or DEFAULT_TAXONOMIES
    return _build_prompt(snapshot, taxonomies)


def _build_prompt(snapshot: TaskSnapshot, taxonomies: list) -> str:
    """Build prompt for council: are QC/CFA criteria valid?"""
    task_meta = snapshot.metadata.get("task_metadata") or {}
    l1_taxonomy = task_meta.get("l1_taxonomy", "")
    prompt = snapshot.prompt or ""
    reference = snapshot.reference or ""

    lines = [
        "You are a QA reviewer. For QC (Question Correction) and CFA (Counterfactual Answering) taxonomies:",
        "",
        "SPECIAL RULES:",
        "- QC: Criteria may REJECT the prompt's premise and describe the CORRECT answer that is NOT in the prompt.",
        "- CFA: Criteria may reference counterfactual/imaginary elements not explicitly in the prompt.",
        "- This is EXPECTED — do NOT fail just because criteria reference what's not in the prompt.",
        "- FAIL only if criteria invent subjective 'golden answers' or are inconsistent with the taxonomy.",
        "",
        f"L1 Taxonomy: {l1_taxonomy or '(not set)'}",
        "",
        "TASK PROMPT:",
        prompt[:1500] if prompt else "(none)",
        "",
        "REFERENCE / CRITERIA:",
        reference[:1500] if reference else "(none)",
        "",
        "CRITERIA (extracted):",
    ]
    for c in snapshot.criteria:
        lines.append(f"  - {c.get('id', '?')}: {c.get('description', '')[:300]}")
    lines.append("")

    if l1_taxonomy.upper() in [t.upper() for t in taxonomies]:
        lines.extend([
            f"Since taxonomy is {l1_taxonomy}, criteria may legitimately reference what's not in the prompt.",
            "- PASS if criteria are valid for QC/CFA (reference correct answer, counterfactuals, etc.) and don't invent subjective golden answers.",
            "- FAIL if criteria are inconsistent, invent arbitrary standards, or don't fit the taxonomy.",
            "",
            "First briefly explain your reasoning, then conclude with exactly one word on a new line: PASS or FAIL.",
            "Your final line must be only PASS or FAIL—no other format.",
        ])
    else:
        lines.extend([
            "Taxonomy is not QC or CFA. Apply standard criteria validity.",
            "- PASS if criteria are clear and consistent with the prompt.",
            "- FAIL if criteria are vague, inconsistent, or invent golden answers.",
            "",
            "First briefly explain your reasoning, then conclude with exactly one word on a new line: PASS or FAIL.",
            "Your final line must be only PASS or FAIL—no other format.",
        ])
    return "\n".join(lines)


@register_rule("qc_cfa_criteria_valid")
def check_qc_cfa_criteria_valid(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: for QC/CFA, criteria can reference what's not in prompt; no invented golden answers.
    Skips if no L1 taxonomy or criteria.
    """
    if snapshot.checkpoint != "final":
        return None

    task_meta = snapshot.metadata.get("task_metadata") or {}
    l1_taxonomy = (task_meta.get("l1_taxonomy") or "").strip()
    taxonomies = params.get("taxonomies") or DEFAULT_TAXONOMIES
    taxonomies = [str(t).upper() for t in taxonomies]

    if not l1_taxonomy or not snapshot.criteria:
        return None

    try:
        prompt = _build_prompt(snapshot, taxonomies)
        passed, votes = run_council(prompt, "qc_cfa_criteria_valid")
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
        rule_id="qc_cfa_criteria_valid",
        severity=IssueSeverity.ERROR,
        message=f"Council detected invalid or inconsistent criteria for {l1_taxonomy}. Votes: {vote_summary}",
        hint="Ensure criteria are valid for QC/CFA: they may reference what's not in the prompt, but should not invent subjective golden answers.",
        details={
            "council_votes": [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes],
            "l1_taxonomy": l1_taxonomy,
            "criteria": [{"id": c.get("id"), "description": (c.get("description") or "")[:200]} for c in snapshot.criteria],
        },
    )
