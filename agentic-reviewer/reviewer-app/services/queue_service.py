"""
Queue with at-a-glance summaries for reviewer UI.

Returns session ids plus optional per-session: task_display_id, prompt_preview,
slots_graded, all_pass, review_status.
"""
from typing import Any, Dict, List, Optional

from config import get_task_identity_config
from .redis_client import get_session_dict, get_review_status, list_sessions, list_sessions_for_review
from .snapshot import build_snapshot_safe

_task_id_config = get_task_identity_config()


def _extract_task_display_id(session_dict: Dict[str, Any]) -> str:
    """Extract the human-readable task ID from notebook metadata using the configured field."""
    notebook = session_dict.get("notebook") or {}
    if not isinstance(notebook, dict):
        return ""
    nb_meta = notebook.get("metadata") or {}
    if not isinstance(nb_meta, dict):
        return ""
    fields_to_try = [_task_id_config["display_id_field"]] + _task_id_config["fallback_fields"]
    for field in fields_to_try:
        val = nb_meta.get(field)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def _all_pass_from_snapshot(snapshot: Dict[str, Any]) -> bool:
    """True if every human review has all grades as pass."""
    human_reviews = snapshot.get("human_reviews") or []
    for hr in human_reviews:
        grades = hr.get("grades") or {}
        if not grades:
            continue
        if any(str(v).lower() != "pass" for v in grades.values()):
            return False
    return True


async def get_queue_with_summaries(
    for_review_only: bool = True,
    status_filter: Optional[str] = None,
    search_query: Optional[str] = None,
    reviewer_email: str = "",
) -> List[Dict[str, Any]]:
    """
    List sessions with at-a-glance summary per session.
    Keys per item: session_id, task_display_id, prompt_preview, slots_graded, all_pass, review_status.
    reviewer_email is used to scope to the reviewer's pod.
    """
    if status_filter:
        all_ids = await list_sessions()
        session_ids = []
        for sid in all_ids:
            s = await get_review_status(sid)
            if s == status_filter:
                session_ids.append(sid)
    elif for_review_only:
        session_ids = await list_sessions_for_review(reviewer_email=reviewer_email)
    else:
        session_ids = await list_sessions()

    # Belt-and-suspenders dedup — list_sessions already deduplicates,
    # but guard here too in case upstream changes
    session_ids = list(dict.fromkeys(session_ids))

    out: List[Dict[str, Any]] = []
    search_lower = search_query.strip().lower() if search_query else ""

    for sid in session_ids:
        review_status = await get_review_status(sid)
        session_dict = await get_session_dict(sid)
        task_display_id = ""
        if session_dict is not None:
            task_display_id = _extract_task_display_id(session_dict)

        if search_lower:
            matches = (
                search_lower in sid.lower()
                or search_lower in task_display_id.lower()
            )
            if not matches:
                continue

        if session_dict is None:
            out.append({
                "session_id": sid,
                "task_display_id": task_display_id,
                "prompt_preview": "",
                "slots_graded": 0,
                "all_pass": False,
                "review_status": review_status,
            })
            continue

        snapshot = build_snapshot_safe(session_dict, fallback_to_display=False)
        if not snapshot:
            prompt_preview = ""
            slots_graded = len((session_dict.get("human_reviews") or {}))
            all_pass = False
        else:
            prompt = (snapshot.get("prompt") or "").strip()
            prompt_preview = prompt[:120] + ("\u2026" if len(prompt) > 120 else "")
            human_reviews = snapshot.get("human_reviews") or []
            slots_graded = len(human_reviews)
            all_pass = _all_pass_from_snapshot(snapshot) if human_reviews else False
        out.append({
            "session_id": sid,
            "task_display_id": task_display_id,
            "prompt_preview": prompt_preview,
            "slots_graded": slots_graded,
            "all_pass": all_pass,
            "review_status": review_status,
        })
    return out
