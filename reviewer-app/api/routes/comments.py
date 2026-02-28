"""Reviewer feedback: overall + per-section comments. Requires allowlist."""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from api.deps import require_reviewer
from schemas import ReviewerFeedback
from services import get_session_dict
from services.audit_store import append_audit
from services.feedback_store import get_feedback, set_feedback

router = APIRouter(prefix="/api", tags=["comments"])


@router.get("/tasks/{session_id}/feedback")
async def get_task_feedback(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """Get reviewer feedback (overall + per-section) for a task."""
    session = await get_session_dict(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    feedback = await get_feedback(session_id)
    return feedback.model_dump()


@router.put("/tasks/{session_id}/feedback")
async def put_task_feedback(
    session_id: str,
    body: ReviewerFeedback,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """Save reviewer feedback (overall + per-section) for a task."""
    session = await get_session_dict(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await set_feedback(session_id, body)
    await append_audit(session_id, "feedback_saved", _reviewer, {"sections": len(body.section_comments)})
    return {"ok": True}
