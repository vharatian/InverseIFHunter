"""Reviewer actions: Approve, Return, and Escalate. Requires allowlist."""
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
from modules.review.telemetry import log_reviewer_event

router = APIRouter(prefix="/api", tags=["review_actions"])


async def _notify_trainer(session_id: str, notif_type: str, message: str) -> None:
    """Push a notification to the trainer who owns this session."""
    r = await get_redis()
    trainer_email = await get_trainer_email_for_session(r, session_id)
    if not trainer_email:
        return
    task_id = await extract_task_display_id(r, session_id)
    await notify_user(r, trainer_email, notif_type, session_id, message, task_id)


async def _set_status_with_feedback(
    session_id: str,
    current: str,
    target: str,
    reviewer_email: str,
    body: Optional[ReviewerFeedback],
    audit_action: str,
    notif_type: str,
    notif_message: str,
    clear_qc: bool = False,
) -> dict:
    """Save optional feedback, CAS status, audit, notify. Returns {ok, review_status} or raises."""
    if body is not None:
        await set_feedback(session_id, body)
        log_reviewer_event("feedback_submitted", reviewer_email, {
            "session_id": session_id,
            "action": audit_action,
        })
    if clear_qc:
        await clear_qc_done(session_id)
    ok, actual = await cas_review_status(session_id, current, target)
    if not ok:
        raise HTTPException(
            status_code=409,
            detail=f"Conflict: task status changed to '{actual}' before your action completed. Refresh and try again.",
        )
    await append_audit(session_id, audit_action, reviewer_email, {})
    log_reviewer_event("reviewer_decision", reviewer_email, {
        "session_id": session_id,
        "decision": target,
        "from_status": current,
        "audit_action": audit_action,
    })
    await safe_notify(
        _notify_trainer(session_id, notif_type, notif_message),
        context=f"{audit_action} notification for {session_id}",
    )
    return {"ok": True, "review_status": target}


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


@router.post("/tasks/{session_id}/mark-in-progress")
async def mark_in_progress(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    Idempotent: transition a submitted task into 'in_progress' when a reviewer opens it.
    - submitted -> in_progress (and audit).
    - in_progress / completed / approved -> no-op (returns current status).
    - any other state -> 409.
    """
    current = await get_review_status(session_id)
    if current in ("in_progress", "completed", "approved"):
        return {"ok": True, "review_status": current, "changed": False}
    if current != "submitted":
        raise HTTPException(
            status_code=409,
            detail=f"Task is '{current}'. Only submitted tasks can be opened for review.",
        )
    ok, actual = await cas_review_status(session_id, "submitted", "in_progress")
    if not ok:
        return {"ok": True, "review_status": actual, "changed": False}
    await append_audit(session_id, "opened_for_review", _reviewer, {})
    log_reviewer_event("task_claimed", _reviewer, {"session_id": session_id})
    return {"ok": True, "review_status": "in_progress", "changed": True}


@router.post("/tasks/{session_id}/mark-completed")
async def mark_completed(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    Idempotent: transition a submitted/in-progress task into 'completed' once the QC run has finished.
    - submitted / in_progress -> completed (and audit + trainer notification).
    - completed / approved -> no-op.
    - any other state -> 409.
    """
    current = await get_review_status(session_id)
    if current in ("completed", "approved"):
        return {"ok": True, "review_status": current, "changed": False}
    if current not in ("submitted", "in_progress"):
        raise HTTPException(
            status_code=409,
            detail=f"Task is '{current}'. Only submitted or in-progress tasks can be completed.",
        )
    ok, actual = await cas_review_status(session_id, current, "completed")
    if not ok:
        return {"ok": True, "review_status": actual, "changed": False}
    await append_audit(session_id, "completed", _reviewer, {})
    log_reviewer_event("reviewer_decision", _reviewer, {
        "session_id": session_id,
        "decision": "completed",
        "from_status": current,
        "audit_action": "completed",
    })
    await safe_notify(
        _notify_trainer(session_id, "task_completed", "Your task has been reviewed and marked completed."),
        context=f"complete notification for {session_id}",
    )
    return {"ok": True, "review_status": "completed", "changed": True}


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
        log_reviewer_event("feedback_submitted", _reviewer, {
            "session_id": session_id,
            "action": "approved",
        })
    await append_audit(session_id, "approved", _reviewer, {})
    log_reviewer_event("reviewer_decision", _reviewer, {
        "session_id": session_id,
        "decision": "approved",
        "from_status": current,
        "audit_action": "approved",
    })
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
    Task must be submitted or escalated. Clears QC so trainer must re-run before resubmit.
    """
    current = await _validated_reviewable_session(session_id, _reviewer)
    return await _set_status_with_feedback(
        session_id,
        current,
        "returned",
        _reviewer,
        body,
        audit_action="returned",
        notif_type="task_returned",
        notif_message="Your task has been returned with comments. Please review and fix.",
        clear_qc=True,
    )


@router.post("/tasks/{session_id}/escalate")
async def escalate_task(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
    body: Optional[ReviewerFeedback] = Body(None),
):
    """
    Escalate a task for admin review. Sets review_status to escalated.
    Task must be submitted. Optional feedback is saved for context.
    """
    current = await _validated_reviewable_session(session_id, _reviewer)
    return await _set_status_with_feedback(
        session_id,
        current,
        "escalated",
        _reviewer,
        body,
        audit_action="escalated",
        notif_type="task_escalated",
        notif_message="Your task has been escalated for admin review.",
        clear_qc=False,
    )
