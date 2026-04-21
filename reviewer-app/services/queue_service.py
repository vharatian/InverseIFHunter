"""
Queue with at-a-glance summaries for reviewer UI.

Returns session ids plus optional per-session: task_display_id, prompt_preview,
slots_graded, all_pass, review_status, trainer_email, submitted_at, domain.
"""
from typing import Any, Dict, List, Optional
import json

from config import get_task_identity_config
from .redis_client import (
    get_review_status,
    get_review_status_and_trainer_batch,
    get_session_dict,
    get_redis,
    _key,
    list_sessions,
    list_sessions_for_review,
    REVIEW_STATUS_VALUES,
)

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
    page: int = 1,
    per_page: int = 50,
) -> List[Dict[str, Any]]:
    """
    List sessions with at-a-glance summary per session.
    Keys per item: session_id, task_display_id, prompt_preview, slots_graded, all_pass, review_status.
    reviewer_email is used to scope to the reviewer's pod.
    page/per_page control pagination (1-indexed). per_page=0 returns all items.
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

    # Batch-fetch meta for trainer_email + submitted_at + domain to avoid N+1 round trips
    if out:
        r = await get_redis()
        pipe = r.pipeline()
        for item in out:
            sid = item["session_id"]
            pipe.hgetall(_key(sid, "meta"))
            pipe.get(_key(sid, "notebook"))
        meta_results = await pipe.execute()
        for i, item in enumerate(out):
            meta = meta_results[i * 2] or {}
            notebook_json = meta_results[i * 2 + 1]
            item["trainer_email"] = (meta.get("trainer_email") or "").strip()
            item["trainer_name"] = (meta.get("trainer_name") or "").strip()
            item["submitted_at"] = (meta.get("submitted_at") or meta.get("submit_time") or "").strip()
            item["colab_url"] = (meta.get("colab_url") or meta.get("notebook_url") or meta.get("url") or "").strip()
            # Extract domain from notebook metadata
            domain = ""
            if notebook_json:
                try:
                    nb = json.loads(notebook_json)
                    nb_meta = nb.get("metadata") or {}
                    task_meta = nb_meta.get("task_metadata") or nb_meta
                    domain = str(task_meta.get("domain") or nb_meta.get("domain") or "").strip()
                except Exception:
                    pass
            item["domain"] = domain

        # Fallback for sessions predating Redis-meta persistence of colab_url /
        # trainer_name: pull from PG `sessions.metadata` (the trainer-app write
        # path has always stored them there). Only sessions missing the fields
        # trigger a lookup — new sessions hit the Redis path above with zero
        # extra round trips.
        missing = [
            item for item in out
            if not item.get("colab_url") or not item.get("trainer_name")
        ]
        if missing:
            try:
                from api.ih_pg import _pg_session
                pg = _pg_session()
                for item in missing:
                    try:
                        pg_meta = await pg.get_session_metadata_pg(item["session_id"]) or {}
                    except Exception:
                        pg_meta = {}
                    if not item.get("colab_url"):
                        item["colab_url"] = str(
                            pg_meta.get("colab_url")
                            or pg_meta.get("url")
                            or pg_meta.get("notebook_url")
                            or ""
                        ).strip()
                    if not item.get("trainer_name"):
                        item["trainer_name"] = str(pg_meta.get("trainer_name") or "").strip()
                    if not item.get("trainer_email"):
                        item["trainer_email"] = str(pg_meta.get("trainer_email") or "").strip()
            except Exception:
                # PG unavailable — leave fields empty; frontend handles missing values.
                pass

    if per_page and per_page > 0:
        start = (max(page, 1) - 1) * per_page
        out = out[start : start + per_page]
    return out


async def get_queue_status_counts(reviewer_email: Optional[str] = None) -> Dict[str, int]:
    """
    Return counts of sessions per review_status for tab badges.
    When reviewer_email is set, counts are scoped to that reviewer's pod so tab counts match the list.
    """
    session_ids = await list_sessions()
    if not session_ids:
        return {s: 0 for s in REVIEW_STATUS_VALUES}

    status_trainer_list = await get_review_status_and_trainer_batch(session_ids)
    counts: Dict[str, int] = {s: 0 for s in REVIEW_STATUS_VALUES}

    allowed_trainers: Optional[set] = None
    if (reviewer_email or "").strip():
        from config.settings import ensure_agentic_path
        ensure_agentic_path()
        from agentic_reviewer.team_config import get_role, get_allowed_trainer_emails_for_role
        email = (reviewer_email or "").strip().lower()
        role = get_role(email)
        if role == "super_admin":
            allowed_trainers = None
        else:
            trainer_list = get_allowed_trainer_emails_for_role(email)
            allowed_trainers = set(trainer_list) if trainer_list is not None else None

    for (status, trainer) in status_trainer_list:
        if allowed_trainers is not None and trainer not in allowed_trainers:
            continue
        if status in counts:
            counts[status] += 1
        else:
            counts["draft"] += 1
    return counts
