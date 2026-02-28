"""
Model consistency rule: all 4 selected responses must be from the same model.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.rules.registry import register_rule


@register_rule("model_consistency")
def check_model_consistency(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Require all 4 selected responses to be from the same model.
    """
    if len(snapshot.selected_hunts) < 4:
        return ReviewIssue(
            rule_id="model_consistency",
            severity=IssueSeverity.ERROR,
            message="Exactly 4 responses must be selected.",
            hint="Select exactly 4 responses for review.",
        )
    models = {h.model for h in snapshot.selected_hunts}
    if len(models) == 1:
        return None
    return ReviewIssue(
        rule_id="model_consistency",
        severity=IssueSeverity.ERROR,
        message=f"All 4 selected responses must be from the same model. Found: {len(models)} models ({', '.join(models)}).",
        hint="Re-select 4 responses from a single model.",
    )
