"""
Task view: get one task by session_id (snapshot + optional trainer QC context).
Requires allowlist.
"""
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

router = APIRouter(prefix="/api", tags=["task"])


@router.get("/tasks/{session_id}")
async def get_task(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    Get task by session_id: raw session dict + snapshot (if 4 human reviews).
    Trainer-side QC is not stored in Redis by default; can be added later.
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

    task_display_id = _extract_task_display_id(session_dict)
    ti_config = get_task_identity_config()

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
    }
