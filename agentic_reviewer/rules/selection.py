"""
Selection rules: check that the right number of responses are selected.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.rules.registry import register_rule


@register_rule("selection_count")
def check_selection_count(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """Require exactly expected_count selected hunts. Default 4."""
    expected = int(params.get("expected_count", 4))
    actual = len(snapshot.selected_hunts)
    if actual == expected:
        return None
    return ReviewIssue(
        rule_id="selection_count",
        severity=IssueSeverity.ERROR,
        message=f"Expected {expected} selected responses, got {actual}.",
        hint="Select exactly 4 responses for review.",
    )
