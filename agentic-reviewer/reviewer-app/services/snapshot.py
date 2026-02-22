"""
Shared snapshot builder for the reviewer app.

Used by both the task detail route and the queue summary service.
Attempts the formal agentic_reviewer.snapshot_builder first, falls back to
a display-only snapshot built from raw session data.
"""
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

_agentic_root = Path(__file__).resolve().parent.parent.parent
if str(_agentic_root) not in sys.path:
    sys.path.insert(0, str(_agentic_root))


def build_snapshot_safe(
    session_dict: Dict[str, Any],
    *,
    fallback_to_display: bool = True,
) -> Optional[Dict[str, Any]]:
    """
    Build a final snapshot dict if we have 4 human reviews.

    Args:
        session_dict: Raw session data from Redis.
        fallback_to_display: If True, return a display-only snapshot on error.
                             If False, return None on error (used by queue summaries).
    """
    try:
        from agentic_reviewer.snapshot_builder import build_snapshot
        snapshot = build_snapshot(session_dict, "final")
        return snapshot.model_dump()
    except Exception:
        return _build_display_snapshot(session_dict) if fallback_to_display else None


def _build_display_snapshot(session_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Fallback: build display snapshot from raw session when formal snapshot fails."""
    notebook = session_dict.get("notebook") or {}
    if not isinstance(notebook, dict):
        notebook = {}
    all_results = session_dict.get("all_results") or session_dict.get("results") or []
    human_reviews = session_dict.get("human_reviews") or {}
    if not isinstance(human_reviews, dict):
        human_reviews = {}
    turns = notebook.get("turns") or []
    current_turn = session_dict.get("current_turn", 1)
    prompt = notebook.get("prompt", "")
    reference = notebook.get("response_reference", "")
    if turns and current_turn >= 1:
        turn_idx = current_turn - 1
        if turn_idx < len(turns) and isinstance(turns[turn_idx], dict):
            t = turns[turn_idx]
            prompt = t.get("prompt", prompt)
            reference = t.get("response_reference", reference)
    criteria: List[Dict[str, str]] = []
    if reference:
        for m in re.finditer(r"^(C\d+)\s*[:：]\s*(.+)$", reference, re.MULTILINE | re.IGNORECASE):
            criteria.append({"id": m.group(1).upper(), "description": m.group(2).strip()})
    by_id = {int(r.get("hunt_id", 0)): r for r in all_results if r.get("hunt_id") is not None}
    slot_hids: List[tuple] = []
    for k, v in human_reviews.items():
        v = v if isinstance(v, dict) else {}
        hid = v.get("hunt_id")
        slot_num = v.get("slotNum", 999)
        if hid is not None:
            try:
                slot_hids.append((int(slot_num), int(hid)))
            except (TypeError, ValueError):
                pass
        elif ":" in str(k):
            part = str(k).split(":")[0]
            if part.isdigit():
                slot_hids.append((999, int(part)))
        elif str(k).isdigit():
            slot_hids.append((999, int(k)))
    slot_hids.sort(key=lambda x: x[0])
    ids_from_reviews = [hid for _, hid in slot_hids]
    seen: set = set()
    ids_from_reviews = [x for x in ids_from_reviews if x not in seen and not seen.add(x)]
    if len(ids_from_reviews) < 4:
        ids_from_reviews = list(by_id.keys())[:4]
    selected_hunts = []
    for hid in ids_from_reviews[:4]:
        if hid in by_id:
            h = by_id[hid]
            selected_hunts.append({
                "hunt_id": hid,
                "model": h.get("model", ""),
                "response": h.get("response", ""),
                "judge_score": h.get("judge_score"),
                "judge_criteria": h.get("judge_criteria") or {},
                "judge_explanation": h.get("judge_explanation", ""),
                "is_breaking": h.get("is_breaking", False),
            })
    human_reviews_list = []
    for sh in selected_hunts:
        hid = sh["hunt_id"]
        r = None
        for k, v in human_reviews.items():
            if str(k) == str(hid) or (":" in str(k) and str(k).split(":")[0] == str(hid)):
                r = v if isinstance(v, dict) else {}
                break
        if r:
            grades = r.get("grades") or r.get("grading_basis") or r.get("criteria") or {}
            if isinstance(grades, dict):
                grades = {str(kk): str(vv) for kk, vv in grades.items()}
            else:
                grades = {}
            human_reviews_list.append({
                "hunt_id": hid,
                "grades": grades,
                "explanation": r.get("explanation", ""),
                "submitted": bool(r.get("submitted") or r.get("judgment")),
            })
        else:
            human_reviews_list.append({"hunt_id": hid, "grades": {}, "explanation": "", "submitted": False})
    nb_meta = notebook.get("metadata") or {}
    task_metadata = {}
    if isinstance(nb_meta, dict):
        for display_key, variants in [
            ("task_id", ["Task ID", "TaskID", "task_id"]),
            ("domain", ["Domain", "Domain:", "domain"]),
            ("use_case", ["Use Case", "UseCase", "use_case"]),
            ("l1_taxonomy", ["L1 Taxonomy", "L1Taxonomy", "l1_taxonomy"]),
        ]:
            for v in variants:
                val = nb_meta.get(v)
                if val is not None and str(val).strip():
                    task_metadata[display_key] = str(val).strip()
                    break

    return {
        "prompt": prompt or "(no prompt)",
        "criteria": criteria,
        "selected_hunts": selected_hunts,
        "human_reviews": human_reviews_list,
        "metadata": {"task_metadata": task_metadata},
    }
