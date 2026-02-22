"""
Diversity rule: selected responses should be from at least N different models.
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.rules.registry import register_rule


@register_rule("diversity")
def check_diversity(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Require at least min_models distinct models in selected_hunts.
    Default min_models=2.
    """
    min_models = int(params.get("min_models", 2))
    models = {h.model for h in snapshot.selected_hunts}
    if len(models) >= min_models:
        return None
    return ReviewIssue(
        rule_id="diversity",
        severity=IssueSeverity.ERROR,
        message=f"Only {len(models)} model(s) in selection. Need at least {min_models}.",
        hint="Select responses from different models for better diversity.",
    )
