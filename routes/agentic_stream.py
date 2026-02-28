"""
Streaming helpers for agentic review — build content_checked and rationale per rule.

Keeps agentic.py focused on HTTP; this module builds rich event payloads for live UI.
"""
from typing import Any, Dict, List, Optional

# Avoid circular import — snapshot comes from agentic_reviewer
# We accept snapshot as dict-like for content extraction


def build_content_checked(rule_id: str, snapshot: Any) -> Dict[str, Any]:
    """Build what this rule is checking (for live display)."""
    if rule_id == "model_consistency":
        hunts = getattr(snapshot, "selected_hunts", [])[:4]
        models = [h.model for h in hunts] if hunts else []
        return {
            "check": "All 4 selected responses must be from the same model",
            "models": models,
            "models_count": len(set(models)) if models else 0,
        }
    if rule_id == "human_llm_grade_alignment":
        hunts = getattr(snapshot, "selected_hunts", [])[:4]
        human_reviews = {r.hunt_id: r for r in getattr(snapshot, "human_reviews", [])}
        slots = []
        for i, h in enumerate(hunts, 1):
            hr = human_reviews.get(h.hunt_id)
            slots.append({
                "slot": i,
                "model": h.model,
                "human_grades": hr.grades if hr else {},
                "human_explanation_preview": (hr.explanation or "")[:150] if hr else "",
                "llm_criteria": h.judge_criteria or {},
            })
        criteria = getattr(snapshot, "criteria", []) or []
        return {
            "check": "Human grades vs LLM judge — flag large disagreements",
            "slots": slots,
            "criteria": [{"id": c.get("id"), "desc": (c.get("description") or "")[:100]} for c in criteria],
            "prompt_preview": (getattr(snapshot, "prompt", "") or "")[:300],
        }
    if rule_id in ("metadata_prompt_alignment", "metadata_taxonomy_alignment"):
        task_meta = (getattr(snapshot, "metadata", {}) or {}).get("task_metadata") or {}
        return {
            "check": f"Metadata: Domain={task_meta.get('domain', '—')}, Use Case={task_meta.get('use_case', '—')}, L1={task_meta.get('l1_taxonomy', '—')}",
            "prompt_preview": (getattr(snapshot, "prompt", "") or "")[:300],
        }
    if rule_id == "human_explanation_justifies_grade":
        human_reviews = {r.hunt_id: r for r in getattr(snapshot, "human_reviews", [])}
        hunts = getattr(snapshot, "selected_hunts", [])[:4]
        slots = []
        for i, h in enumerate(hunts, 1):
            hr = human_reviews.get(h.hunt_id)
            exp = (hr.explanation or "")[:300] if hr else ""
            slots.append({"slot": i, "model": getattr(h, "model", ""), "explanation": exp})
        return {"check": "Human explanations must be substantive", "slots": slots}
    if rule_id == "safety_context_aware":
        return {"check": "Prompt must not request prohibited content (context-aware)", "prompt_preview": (getattr(snapshot, "prompt", "") or "")[:300]}
    if rule_id == "qc_cfa_criteria_valid":
        task_meta = (getattr(snapshot, "metadata", {}) or {}).get("task_metadata") or {}
        criteria = getattr(snapshot, "criteria", []) or []
        return {
            "check": f"QC/CFA criteria validity (L1={task_meta.get('l1_taxonomy', '—')})",
            "criteria": [{"id": c.get("id"), "desc": (c.get("description") or "")[:80]} for c in criteria],
        }
    return {"check": rule_id}


def build_rationale(rule_id: str, issue: Optional[Any], content_checked: Dict[str, Any]) -> str:
    """Build human-readable rationale for the check result."""
    if issue and hasattr(issue, "message"):
        return issue.message
    if rule_id == "model_consistency":
        models = content_checked.get("models", [])
        if len(set(models)) == 1 and models:
            return f"All 4 responses from same model: {models[0]}"
        return f"Models found: {', '.join(models) if models else 'none'}"
    if rule_id == "human_llm_grade_alignment":
        votes = []
        if issue and hasattr(issue, "details") and issue.details:
            for v in issue.details.get("council_votes", []):
                votes.append(f"{v.get('model', '?')}: {v.get('vote', '?')}")
        if votes:
            return "Council votes: " + "; ".join(votes)
        return "Council agreed: human and LLM grading are aligned."
    if rule_id in ("metadata_prompt_alignment", "metadata_taxonomy_alignment", "safety_context_aware", "human_explanation_justifies_grade", "qc_cfa_criteria_valid"):
        if issue and hasattr(issue, "details") and issue.details:
            votes = issue.details.get("council_votes", [])
            if votes:
                return "Council votes: " + "; ".join(f"{v.get('model', '?')}: {v.get('vote', '?')}" for v in votes)
        if issue and hasattr(issue, "message"):
            return issue.message
    return "Check completed."
