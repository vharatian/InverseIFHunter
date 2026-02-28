"""
Human/LLM judgment disagreement rule.

More targeted than human_llm_grade_alignment: computes a numeric disagreement
rate and fails if it exceeds a configurable threshold.

Default: fail if > 30% of criteria have conflicting human vs LLM grades across
all 4 slots. Configurable via global.yaml params.disagreement_threshold (0.0–1.0).
"""
from agentic_reviewer.schemas import IssueSeverity, ReviewIssue, TaskSnapshot
from agentic_reviewer.rules.registry import register_rule

DEFAULT_THRESHOLD = 0.30  # 30% disagreement rate triggers failure


@register_rule("human_llm_judgment_disagreement")
def check_human_llm_judgment_disagreement(snapshot: TaskSnapshot, params: dict) -> ReviewIssue | None:
    """
    Deterministic: measure the rate of human vs LLM grade disagreements.
    Fails if the disagreement rate exceeds the configured threshold.
    """
    if snapshot.checkpoint != "final":
        return None

    threshold = float(params.get("disagreement_threshold", DEFAULT_THRESHOLD))

    human_by_id = {r.hunt_id: r for r in snapshot.human_reviews}

    total_comparisons = 0
    disagreements = []

    for i, hunt in enumerate(snapshot.selected_hunts[:4], 1):
        human = human_by_id.get(hunt.hunt_id)
        if not human:
            continue
        llm_criteria = hunt.judge_criteria or {}
        human_grades = human.grades or {}
        shared_criteria = set(llm_criteria.keys()) & set(human_grades.keys())
        for cid in shared_criteria:
            total_comparisons += 1
            h_val = str(human_grades[cid]).lower().strip()
            l_val = str(llm_criteria[cid]).lower().strip()
            if h_val != l_val:
                disagreements.append({
                    "slot": i,
                    "hunt_id": hunt.hunt_id,
                    "criterion": cid,
                    "human": h_val,
                    "llm": l_val,
                })

    if total_comparisons == 0:
        return None

    rate = len(disagreements) / total_comparisons
    if rate <= threshold:
        return None

    pct = round(rate * 100)
    return ReviewIssue(
        rule_id="human_llm_judgment_disagreement",
        severity=IssueSeverity.WARNING,
        message=(
            f"Human and LLM grades disagree on {len(disagreements)} of {total_comparisons} "
            f"criteria ({pct}%), exceeding the {round(threshold * 100)}% threshold."
        ),
        hint=(
            "Review the slots with conflicting grades. Either update human grades to align with "
            "the LLM judge, or provide a clear explanation for why human judgment differs."
        ),
        details={
            "disagreement_rate": rate,
            "threshold": threshold,
            "total_comparisons": total_comparisons,
            "disagreement_count": len(disagreements),
            "disagreements": disagreements,
        },
    )
