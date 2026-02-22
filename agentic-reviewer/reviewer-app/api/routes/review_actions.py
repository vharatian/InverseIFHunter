"""Reviewer actions: Approve, Return, and Reject. Requires allowlist."""
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Body

from api.deps import require_reviewer
from schemas import ReviewerFeedback
from services import get_session_dict
from services.redis_client import get_redis, get_review_status, cas_review_status, clear_qc_done
from services.feedback_store import get_feedback, set_feedback
from services.audit_store import append_audit
from agentic_reviewer.notifications import (
    extract_task_display_id,
    get_trainer_email_for_session,
    notify_user,
)
from agentic_reviewer.resilience import safe_notify

router = APIRouter(prefix="/api", tags=["review_actions"])


async def _notify_trainer(session_id: str, notif_type: str, message: str) -> None:
    """Push a notification to the trainer who owns this session."""
    r = await get_redis()
    trainer_email = await get_trainer_email_for_session(r, session_id)
    if not trainer_email:
        return
    task_id = await extract_task_display_id(r, session_id)
    await notify_user(r, trainer_email, notif_type, session_id, message, task_id)


async def _validated_reviewable_session(session_id: str, reviewer_email: str = "") -> str:
    """Load session, verify it exists and is in a reviewable state. Returns current status.
    Submitted tasks can be reviewed by any reviewer.
    Escalated tasks can only be reviewed by admin/super_admin."""
    from agentic_reviewer.team_config import get_role
    session = await get_session_dict(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    current = await get_review_status(session_id)
    if current == "submitted":
        return current
    if current == "escalated":
        role = get_role(reviewer_email) if reviewer_email else None
        if role in ("super_admin", "admin"):
            return current
        raise HTTPException(
            status_code=409,
            detail="Task is escalated. Only admins can act on escalated tasks.",
        )
    raise HTTPException(
        status_code=409,
        detail=f"Task is '{current}'. Only submitted or escalated tasks can be reviewed.",
    )


@router.post("/tasks/{session_id}/approve")
async def approve_task(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
    body: Optional[dict] = Body(None),
):
    """
    Atomically set review_status to approved. Task must be submitted or escalated.
    Optional body: { "comment": "optional approval comment" }.
    """
    current = await _validated_reviewable_session(session_id, _reviewer)
    ok, actual = await cas_review_status(session_id, current, "approved")
    if not ok:
        raise HTTPException(
            status_code=409,
            detail=f"Conflict: task status changed to '{actual}' before your action completed. Refresh and try again.",
        )
    if body and body.get("comment"):
        feedback = await get_feedback(session_id)
        feedback.approval_comment = (body["comment"] or "").strip()
        await set_feedback(session_id, feedback)
    await append_audit(session_id, "approved", _reviewer, {})
    await safe_notify(
        _notify_trainer(session_id, "task_approved", "Your task has been approved by the reviewer."),
        context=f"approve notification for {session_id}",
    )
    return {"ok": True, "review_status": "approved"}


@router.post("/tasks/{session_id}/return")
async def return_task(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
    body: Optional[ReviewerFeedback] = Body(None),
):
    """
    Atomically save feedback and set review_status to returned.
    Task must be submitted. Clears QC so trainer must re-run before resubmit.
    """
    current = await _validated_reviewable_session(session_id, _reviewer)
    if body is not None:
        await set_feedback(session_id, body)
    ok, actual = await cas_review_status(session_id, current, "returned")
    if not ok:
        raise HTTPException(
            status_code=409,
            detail=f"Conflict: task status changed to '{actual}' before your action completed. Refresh and try again.",
        )
    await clear_qc_done(session_id)
    await append_audit(session_id, "returned", _reviewer, {})
    await safe_notify(
        _notify_trainer(session_id, "task_returned", "Your task has been returned with comments. Please review and fix."),
        context=f"return notification for {session_id}",
    )
    return {"ok": True, "review_status": "returned"}


@router.post("/tasks/{session_id}/reject")
async def reject_task(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
    body: Optional[ReviewerFeedback] = Body(None),
):
    """
    Atomically reject a task (terminal state). Task must be submitted.
    """
    current = await _validated_reviewable_session(session_id, _reviewer)
    if body is not None:
        await set_feedback(session_id, body)
    ok, actual = await cas_review_status(session_id, current, "rejected")
    if not ok:
        raise HTTPException(
            status_code=409,
            detail=f"Conflict: task status changed to '{actual}' before your action completed. Refresh and try again.",
        )
    await append_audit(session_id, "rejected", _reviewer, {})
    await safe_notify(
        _notify_trainer(session_id, "task_rejected", "Your task has been rejected by the reviewer."),
        context=f"reject notification for {session_id}",
    )
    return {"ok": True, "review_status": "rejected"}
