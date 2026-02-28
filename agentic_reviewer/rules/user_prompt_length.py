"""
User prompt length rule.

Deterministic check: actual prompt word count must be within ±N words of the
reference word count declared in notebook metadata (user_prompt_length field).
Default tolerance: ±10 words (configurable via params.tolerance).

PASS if no reference length is present (rule is inapplicable).
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.rules.registry import register_rule

DEFAULT_TOLERANCE = 10


def _word_count(text: str) -> int:
    return len(text.split()) if text else 0


@register_rule("user_prompt_length")
def check_user_prompt_length(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Deterministic: check that prompt word count is within ±tolerance of the
    declared user_prompt_length metadata field.
    """
    task_meta = snapshot.metadata.get("task_metadata") or {}
    reference_length_str = task_meta.get("user_prompt_length", "")

    if not reference_length_str:
        return None  # No reference length declared — rule does not apply

    try:
        reference_length = int(str(reference_length_str).strip())
    except (ValueError, TypeError):
        return None  # Non-numeric — skip

    tolerance = int(params.get("tolerance", DEFAULT_TOLERANCE))
    actual_length = _word_count(snapshot.prompt)
    delta = abs(actual_length - reference_length)

    if delta <= tolerance:
        return None

    return ReviewIssue(
        rule_id="user_prompt_length",
        severity=IssueSeverity.WARNING,
        message=(
            f"Prompt word count ({actual_length}) differs from declared length "
            f"({reference_length}) by {delta} words (tolerance: ±{tolerance})."
        ),
        hint=f"Adjust the prompt or update the 'User Prompt Length' metadata field. "
             f"Actual: {actual_length} words, declared: {reference_length} words.",
        details={
            "actual_word_count": actual_length,
            "declared_word_count": reference_length,
            "delta": delta,
            "tolerance": tolerance,
        },
    )
