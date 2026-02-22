"""Task edit: write-back human_reviews to Redis. Requires allowlist."""
from typing import Annotated, Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.deps import require_reviewer
from services import get_session_dict
from services.audit_store import append_audit
from services.redis_client import set_human_reviews

router = APIRouter(prefix="/api", tags=["edit"])


class TaskEditBody(BaseModel):
    """Allowed fields for reviewer edit. Only human_reviews for now."""
    human_reviews: Dict[str, Any] = Field(default_factory=dict)


@router.patch("/tasks/{session_id}")
async def patch_task(
    session_id: str,
    body: TaskEditBody,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    Update task data (e.g. human_reviews). Session must exist.
    Use when reviewer enables "Edit" and saves changes.
    """
    session = await get_session_dict(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        await set_human_reviews(session_id, body.human_reviews)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    await append_audit(session_id, "task_edited", _reviewer, {"keys_updated": len(body.human_reviews)})
    return {"ok": True}
