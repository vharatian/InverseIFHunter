"""
Colab save routes for the reviewer app.

GET  /api/tasks/{id}/colab-preview     — preview what will be saved
POST /api/tasks/{id}/submit-to-colab   — submit approved task to Colab
"""
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from api.deps import require_reviewer
from services.colab_save import build_colab_preview, submit_to_colab
from services.redis_client import get_redis, get_review_status
from services.audit_store import append_audit
from agentic_reviewer.notifications import (
    extract_task_display_id,
    get_trainer_email_for_session,
    notify_user,
)
from agentic_reviewer.resilience import safe_notify

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["colab"])


@router.get("/tasks/{session_id}/colab-preview")
async def colab_preview(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """Preview what will be saved to Colab for this approved task."""
    try:
        preview = await build_colab_preview(session_id)
        return preview
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/tasks/{session_id}/submit-to-colab")
async def submit_to_colab_route(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """Submit an approved task to Colab. Only reviewer/admin can do this."""
    review_status = await get_review_status(session_id)
    if review_status != "approved":
        raise HTTPException(
            status_code=400,
            detail=f"Task must be approved before saving to Colab. Current status: '{review_status}'",
        )

    try:
        result = await submit_to_colab(session_id, reviewer_email=_reviewer)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Colab save failed for session %s: %s", session_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Colab save failed: {str(e)}")

    await append_audit(session_id, "colab_saved", _reviewer, {"method": "reviewer_submit"})

    async def _notify_colab_saved():
        r = await get_redis()
        trainer_email = await get_trainer_email_for_session(r, session_id)
        if trainer_email:
            task_display_id = await extract_task_display_id(r, session_id)
            await notify_user(
                r, trainer_email, "task_colab_saved", session_id,
                "Your task has been submitted to Colab by the reviewer.",
                task_display_id,
            )

    await safe_notify(_notify_colab_saved(), context=f"colab_save notification for {session_id}")

    return {
        "ok": True,
        "message": "Task submitted to Colab successfully",
        "details": result,
    }
