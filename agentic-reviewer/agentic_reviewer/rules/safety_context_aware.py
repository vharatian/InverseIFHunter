"""
Context-aware safety rule: block prohibited content only when requesting/encouraging it.

PASS when prompt discusses or avoids prohibited topics (e.g. "how to avoid sexual content").
FAIL when prompt requests or encourages prohibited content.
Uses LLM Council. Based on Divyansh's safety rubrics.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.council import run_council
from agentic_reviewer.rules.registry import register_rule

# Prohibited categories from Divyansh's safety rubrics
DEFAULT_PROHIBITED = """
1) Sexual Content: sex, eroticism, pornography, rape, sexual violence, sexual content involving minors, incest, exploitation
2) Violence: killing, murder, assault, war, torture, physical harm, weapons used against people
3) Self-Harm: suicide, cutting, overdose, any self-injury
4) Crime: scams, fraud, hacking, theft, illegal activity
5) Terrorism & Extremism: extremist groups, attacks, propaganda
6) Abuse & Exploitation: child abuse, trafficking, coercion
7) Weapons & Drugs: guns, bombs, explosives, illegal drugs, manufacturing or use
8) Privacy & Surveillance Abuse: doxxing, stalking, tracking or exposing individuals
""".strip()


def get_council_prompt(snapshot: TaskSnapshot, params: dict | None = None) -> str:
    """Build prompt for council. Public for streaming route."""
    params = params or {}
    prohibited = params.get("prohibited_text") or DEFAULT_PROHIBITED
    return _build_prompt(snapshot, prohibited)


def _build_prompt(snapshot: TaskSnapshot, prohibited_text: str) -> str:
    """Build prompt for council: context-aware safety check."""
    prompt = snapshot.prompt or ""
    lines = [
        "You are a safety reviewer. Check if the TASK PROMPT contains prohibited content.",
        "",
        "CRITICAL: Check CONTEXT and INTENT, not just word presence.",
        "",
        "PROHIBITED CONTENT (fail only if prompt REQUESTS or ENCOURAGES these):",
        prohibited_text,
        "",
        "TASK PROMPT:",
        prompt[:2500] if prompt else "(none)",
        "",
        "CONTEXT RULES:",
        "- FAIL if the prompt REQUESTS or ENCOURAGES generating prohibited content (e.g. 'Write erotic fiction', 'How to hack a bank').",
        "- PASS if the prompt DISCUSSES or AVOIDS prohibited content (e.g. 'How to avoid sexual content in children's media', 'Discuss suicide prevention strategies').",
        "- PASS for academic, hypothetical, or safety/guidance framing that does not encourage harmful use.",
        "- When in doubt, prefer PASS to reduce false failures.",
        "",
        "First briefly explain your reasoning, then conclude with exactly one word on a new line: PASS or FAIL.",
        "Your final line must be only PASS or FAIL—no other format.",
    ]
    return "\n".join(lines)


@register_rule("safety_context_aware")
def check_safety_context_aware(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Council checks: prompt does not request/encourage prohibited content.
    Context-aware: PASS when discussing/avoiding; FAIL when requesting/encouraging.
    """
    if snapshot.checkpoint != "final":
        return None

    prohibited = params.get("prohibited_text") or DEFAULT_PROHIBITED

    try:
        prompt = _build_prompt(snapshot, prohibited)
        passed, votes = run_council(prompt, "safety_context_aware")
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
        rule_id="safety_context_aware",
        severity=IssueSeverity.ERROR,
        message=f"Council detected prohibited content in prompt (requesting/encouraging). Votes: {vote_summary}",
        hint="The prompt appears to request or encourage prohibited content. Revise to discuss or avoid such topics without encouraging harmful use.",
        details={
            "council_votes": [{"model": m, "vote": "PASS" if v else "FAIL" if v is False else "unclear"} for m, v in votes],
            "prompt_preview": (snapshot.prompt or "")[:500],
        },
    )
