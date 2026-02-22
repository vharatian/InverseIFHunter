"""
Criteria rules: check that criteria are present and valid.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.rules.registry import register_rule


@register_rule("criteria_present")
def check_criteria_present(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """Require at least one criterion in the reference."""
    if snapshot.criteria and len(snapshot.criteria) >= 1:
        return None
    return ReviewIssue(
        rule_id="criteria_present",
        severity=IssueSeverity.ERROR,
        message="No criteria defined in the reference.",
        hint="Add criteria in JSON format [{\"id\":\"C1\",\"criteria1\":\"...\"}] or plain C1: desc.",
    )
