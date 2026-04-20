"""
Task view: get one task by session_id (snapshot + optional trainer QC context).
Requires allowlist.
"""
import json
import logging
from typing import Annotated, Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException

from api.deps import require_reviewer
from config import get_task_identity_config
from services import get_session_dict
from services.redis_client import get_redis, get_review_status
from services.snapshot import build_snapshot_safe
from services.queue_service import _extract_task_display_id
from services.feedback_store import get_feedback, get_feedback_history
from services.agent_store import get_agent_result as get_agent_result_store
from api.ih_pg import get_last_reviewer_council
from modules.review.telemetry import log_reviewer_event

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["task"])


@router.get("/tasks/{session_id}")
async def get_task(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    Get task by session_id: raw session dict + snapshot (if 4 human reviews).
    Includes previous round snapshot for diff when task was resubmitted.
    """
    session_dict = await get_session_dict(session_id)
    if session_dict is None:
        raise HTTPException(status_code=404, detail="Session not found")

    snapshot = build_snapshot_safe(session_dict, fallback_to_display=True)
    feedback = await get_feedback(session_id)
    feedback_history = await get_feedback_history(session_id)
    agent_result = await get_agent_result_store(session_id)

    r = await get_redis()
    resubmitted_at = await r.get(f"mh:sess:{session_id}:resubmitted_at")
    review_status = await get_review_status(session_id)
    review_round_val = await r.hget(f"mh:sess:{session_id}:meta", "review_round")
    review_round = int(review_round_val) if review_round_val and str(review_round_val).isdigit() else 0

    previous_round_snapshot = None
    if feedback_history:
        versions_key = f"mh:versions:{session_id}"
        version_count = await r.llen(versions_key)
        if version_count >= 2:
            prev_raw = await r.lindex(versions_key, -2)
            if prev_raw:
                try:
                    previous_round_snapshot = json.loads(prev_raw)
                except Exception:
                    pass

    task_display_id = _extract_task_display_id(session_dict)
    ti_config = get_task_identity_config()

    last_council = None
    try:
        last_council = await get_last_reviewer_council(session_id)
    except Exception:
        logger.warning("Could not load last council run for %s", session_id, exc_info=True)

    log_reviewer_event("task_opened", _reviewer, {
        "session_id": session_id,
        "task_display_id": task_display_id,
        "review_status": review_status,
        "review_round": review_round,
        "has_snapshot": snapshot is not None,
        "has_previous_snapshot": previous_round_snapshot is not None,
    })

    return {
        "session_id": session_id,
        "task_display_id": task_display_id,
        "task_id_label": ti_config["display_id_label"],
        "session": session_dict,
        "snapshot": snapshot,
        "feedback": feedback.model_dump(),
        "feedback_history": feedback_history,
        "resubmitted_at": resubmitted_at,
        "agent_result": agent_result,
        "review_status": review_status,
        "review_round": review_round,
        "previous_round_snapshot": previous_round_snapshot,
        "last_council": last_council,
    }
