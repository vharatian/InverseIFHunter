"""
Session Routes

GET  /api/session/{session_id}      — get session details
GET  /api/trainer-inbox              — list returned/rejected tasks (trainer inbox)
POST /api/update-config/{session_id} — update hunt configuration
"""
import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query  # noqa: F401 - HTTPException used in handlers
from typing import Annotated

from models.schemas import HuntConfig, HuntSession, HuntStatus
from storage.session_storage import get_session_storage, save_session_storage
from helpers.shared import _get_validated_session
import services.redis_session as redis_store
from agentic_reviewer.team_config import get_role, get_allowed_trainer_emails_for_role
from agentic_reviewer.notifications import (
    extract_task_display_id,
    notify_user,
    resolve_reviewer_email_for_trainer,
)
from agentic_reviewer.resilience import safe_notify
from agentic_reviewer.versioning import (
    incr_version,
    get_version,
    check_idempotency,
    store_idempotency,
    snapshot_for_history,
    set_acknowledged,
    get_acknowledged_at,
    clear_acknowledged,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["session"])


def _count_submitted_reviews(human_reviews: dict) -> int:
    """
    Count completed reviews. Prefers row_N keys (canonical submitted reviews with grading_basis).
    Falls back to counting any key with judgment/submitted to handle legacy data.
    """
    if not isinstance(human_reviews, dict):
        return 0
    row_count = 0
    other_count = 0
    row_hunt_ids = set()
    for key, val in human_reviews.items():
        if not isinstance(val, dict):
            continue
        has_review = (
            val.get("judgment") is not None
            or bool(val.get("grading_basis"))
            or val.get("submitted")
        )
        if str(key).startswith("row_") and has_review:
            row_count += 1
            if val.get("hunt_id"):
                row_hunt_ids.add(str(val["hunt_id"]))
        elif has_review and str(key) not in row_hunt_ids:
            other_count += 1
    return row_count if row_count > 0 else other_count


@router.get("/session/{session_id}")
async def get_session(session_id: str):
    """Get session details including review_status and reviewer feedback (for trainer UI)."""
    session = await _get_validated_session(session_id)
    review_status = await redis_store.get_review_status(session_id)
    review_feedback = await redis_store.get_review_feedback(session_id)
    human_reviews = getattr(session, "human_reviews", None) or {}
    review_count = _count_submitted_reviews(human_reviews)
    qc_done = await redis_store.get_qc_done(session_id)
    can_submit = review_count >= 4 and qc_done and review_status == "draft"
    can_resubmit = review_count >= 4 and qc_done and review_status == "returned"

    review_round = await redis_store.get_review_round(session_id)
    max_rounds = redis_store.get_max_review_rounds()
    r = await redis_store.get_redis()
    version = await get_version(r, session_id)
    acknowledged_at = await get_acknowledged_at(r, session_id)

    return {
        "session_id": session.session_id,
        "status": session.status.value,
        "total_hunts": session.total_hunts,
        "completed_hunts": session.completed_hunts,
        "breaks_found": session.breaks_found,
        "config": session.config.model_dump(),
        "results": [r.model_dump() for r in session.results],
        "human_reviews": human_reviews,
        "review_status": review_status,
        "review_feedback": review_feedback,
        "can_submit_for_review": can_submit,
        "can_resubmit": can_resubmit,
        "qc_done": qc_done,
        "review_round": review_round,
        "max_rounds": max_rounds,
        "version": version,
        "acknowledged_at": acknowledged_at,
    }


@router.get("/session/{session_id}/full-state")
async def get_session_full_state(session_id: str):
    """Return all session data for full UI hydration (clicked from trainer queue)."""
    data = await redis_store.get_full_session_state(session_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return data


@router.get("/trainer-queue")
async def trainer_queue(
    x_trainer_email: Annotated[str | None, Header(alias="X-Trainer-Email")] = None,
):
    """Sessions scoped by role: super_admin/admin see all (or pod-scoped), trainers see only their own."""
    all_sessions = await redis_store.list_all_sessions_summary()
    email = (x_trainer_email or "").strip().lower()
    role = get_role(email) if email else None

    if role == "super_admin":
        sessions = all_sessions
    elif role in ("admin", "reviewer"):
        allowed = get_allowed_trainer_emails_for_role(email)
        sessions = [s for s in all_sessions if s.get("trainer_email") in allowed] if allowed is not None else all_sessions
    else:
        sessions = [s for s in all_sessions if s.get("trainer_email") == email] if email else all_sessions

    by_status = {}
    for s in sessions:
        by_status.setdefault(s["review_status"], []).append(s)
    return {
        "sessions": sessions,
        "by_status": by_status,
        "total": len(sessions),
    }


@router.get("/trainer-inbox")
async def trainer_inbox(
    status: Optional[str] = Query(None, description="Filter by review_status (returned, rejected, approved, submitted)"),
):
    """
    List tasks that need trainer attention.
    Default: returned + rejected. Pass ?status=returned or ?status=rejected to filter.
    """
    if status:
        items = await redis_store.list_sessions_by_review_status(status)
    else:
        returned = await redis_store.list_sessions_by_review_status("returned")
        rejected = await redis_store.list_sessions_by_review_status("rejected")
        items = returned + rejected
    return {"tasks": items, "count": len(items)}


@router.post("/update-config/{session_id}")
async def update_config(session_id: str, config: HuntConfig):
    """Update hunt configuration for a session. Restores from storage if needed."""
    # Use shared helper to get session (handles Redis cache + Disk fallback)
    session = await _get_validated_session(session_id)
    
    # CRITICAL: Preserve multi-turn fields that the frontend doesn't send
    existing_conversation_history = session.config.conversation_history if session.config else []
    existing_judge_prompt = session.config.custom_judge_system_prompt if session.config else None
    
    session.config = config
    
    # Restore multi-turn fields if the incoming config didn't include them
    if not config.conversation_history and existing_conversation_history:
        session.config.conversation_history = existing_conversation_history
        logger.info(f"Session {session_id}: Preserved conversation_history ({len(existing_conversation_history)} messages) during config update")
    if not config.custom_judge_system_prompt and existing_judge_prompt:
        session.config.custom_judge_system_prompt = existing_judge_prompt
        logger.info(f"Session {session_id}: Preserved custom_judge_system_prompt during config update")
    
    session.total_hunts = config.parallel_workers

    # Persist config to Redis
    await redis_store.set_config(session_id, session.config)
    await redis_store.set_meta_field(session_id, "total_hunts", session.total_hunts)

    # Update storage
    storage = get_session_storage(session_id) or {}
    storage["session_data"] = session.model_dump()
    save_session_storage(session_id, storage)

    return {"success": True, "config": config.model_dump()}


async def _notify_reviewer_for_session(session_id: str, notif_type: str, message: str) -> None:
    """Push a notification to the reviewer responsible for the trainer who owns this session."""
    r = await redis_store.get_redis()
    meta = await redis_store.get_meta(session_id)
    trainer_email = (meta.get("trainer_email") or "").strip().lower()
    if not trainer_email:
        return
    reviewer_email = resolve_reviewer_email_for_trainer(trainer_email)
    if not reviewer_email:
        return
    task_display_id = await extract_task_display_id(r, session_id)
    await notify_user(r, reviewer_email, notif_type, session_id, message, task_display_id)


async def _notify_escalation(session_id: str, round_num: int, max_rounds: int) -> None:
    """Notify all super_admins and admins about an escalated task.
    Swallows exceptions so escalation CAS is never rolled back by notification failures."""
    try:
        from agentic_reviewer.team_config import _load, _norm
        r = await redis_store.get_redis()
        task_display_id = await extract_task_display_id(r, session_id)

        msg = f"Task escalated: exceeded {max_rounds} review rounds (currently round {round_num}). Needs admin decision."
        data = _load()
        admin_emails = set()
        for sa in data.get("super_admins") or []:
            email = _norm(sa.get("email"))
            if email:
                admin_emails.add(email)
        for admin in data.get("admins") or []:
            email = _norm(admin.get("email"))
            if email:
                admin_emails.add(email)

        for email in admin_emails:
            await notify_user(r, email, "task_escalated", session_id, msg, task_display_id)
    except Exception:
        logger.exception("Failed to send escalation notifications for session %s", session_id)


@router.post("/session/{session_id}/submit-for-review")
async def submit_for_review(session_id: str):
    """Set review_status to submitted so the task appears in the reviewer queue. Requires 4 human reviews."""
    session = await _get_validated_session(session_id)
    human_reviews = getattr(session, "human_reviews", None) or {}
    review_count = _count_submitted_reviews(human_reviews)
    if review_count < 4:
        raise HTTPException(
            status_code=400,
            detail="Complete all 4 human reviews before submitting for review.",
        )
    if not await redis_store.get_qc_done(session_id):
        raise HTTPException(
            status_code=400,
            detail="Complete the Quality Check (Proceed to QC) before submitting for review.",
        )
    ok, actual = await redis_store.cas_review_status(session_id, "draft", "submitted")
    if not ok:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot submit: task is currently '{actual}'. Only drafts can be submitted.",
        )
    round_num = await redis_store.incr_review_round(session_id)
    r = await redis_store.get_redis()
    await snapshot_for_history(r, session_id, round_num)
    await redis_store.append_audit(session_id, "submitted", "trainer")
    await safe_notify(
        _notify_reviewer_for_session(session_id, "task_submitted", "A new task has been submitted for your review."),
        context=f"submit notification for {session_id}",
    )
    version = await get_version(r, session_id)
    logger.info(f"Session {session_id} submitted for review (round {round_num})")
    return {"ok": True, "review_status": "submitted", "review_round": round_num, "version": version}


@router.post("/session/{session_id}/mark-qc-done")
async def mark_qc_done(session_id: str):
    """Mark Quality Check as completed. Call when trainer finishes Proceed to QC."""
    await _get_validated_session(session_id)
    await redis_store.set_qc_done(session_id)
    logger.info(f"Session {session_id}: QC marked done")
    return {"ok": True}


@router.post("/session/{session_id}/resubmit")
async def resubmit_for_review(session_id: str):
    """Set review_status back to submitted after trainer revised (from returned). Requires re-QC.
    If max rounds exceeded, escalates to admin instead."""
    await _get_validated_session(session_id)
    if not await redis_store.get_qc_done(session_id):
        raise HTTPException(
            status_code=400,
            detail="Re-run Quality Check before resubmitting. Reviews may have changed since last QC.",
        )
    r = await redis_store.get_redis()
    ack_at = await get_acknowledged_at(r, session_id)
    if not ack_at:
        raise HTTPException(
            status_code=400,
            detail="Acknowledge reviewer feedback before resubmitting.",
        )
    await redis_store.archive_and_clear_feedback(session_id)
    await redis_store.set_resubmitted_at(session_id)
    await clear_acknowledged(r, session_id)

    current_round = await redis_store.get_review_round(session_id)
    next_round = current_round + 1
    max_rounds = redis_store.get_max_review_rounds()

    if next_round > max_rounds:
        ok, actual = await redis_store.cas_review_status(session_id, "returned", "escalated")
        if not ok:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot resubmit: task is currently '{actual}'.",
            )
        await redis_store.incr_review_round(session_id)
        await redis_store.append_audit(session_id, "escalated", "trainer", {"reason": f"Max rounds ({max_rounds}) exceeded"})
        await _notify_escalation(session_id, next_round, max_rounds)
        logger.info(f"Session {session_id} escalated to admin (round {next_round} > max {max_rounds})")
        return {"ok": True, "review_status": "escalated", "review_round": next_round, "escalated": True}

    ok, actual = await redis_store.cas_review_status(session_id, "returned", "submitted")
    if not ok:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot resubmit: task is currently '{actual}'. Only returned tasks can be resubmitted.",
        )
    await redis_store.incr_review_round(session_id)
    await snapshot_for_history(r, session_id, next_round)
    await redis_store.append_audit(session_id, "resubmitted", "trainer")
    await safe_notify(
        _notify_reviewer_for_session(session_id, "task_resubmitted", "A task has been fixed and resubmitted for your review."),
        context=f"resubmit notification for {session_id}",
    )
    version = await get_version(r, session_id)
    logger.info(f"Session {session_id} resubmitted for review round {next_round} (feedback archived)")
    return {"ok": True, "review_status": "submitted", "review_round": next_round, "version": version}


@router.post("/session/{session_id}/acknowledge")
async def acknowledge_feedback(session_id: str):
    """Trainer acknowledges reviewer feedback. Required before resubmit."""
    await _get_validated_session(session_id)
    status = await redis_store.get_review_status(session_id)
    if status != "returned":
        raise HTTPException(status_code=400, detail=f"Can only acknowledge when status is 'returned'. Current: '{status}'.")
    r = await redis_store.get_redis()
    ts = await set_acknowledged(r, session_id)
    await redis_store.append_audit(session_id, "acknowledged", "trainer")
    return {"ok": True, "acknowledged_at": ts}


@router.get("/session/{session_id}/versions")
async def get_versions(session_id: str):
    """Return version history (snapshots of reviews at each submit/resubmit)."""
    from agentic_reviewer.versioning import get_version_history
    r = await redis_store.get_redis()
    versions = await get_version_history(r, session_id)
    return {"session_id": session_id, "versions": versions}


@router.get("/session/{session_id}/diff")
async def get_diff(session_id: str, v1: int = Query(...), v2: int = Query(...)):
    """Compute diff between two version snapshots."""
    from agentic_reviewer.versioning import get_version_history, compute_diff
    r = await redis_store.get_redis()
    versions = await get_version_history(r, session_id)
    if v1 < 1 or v1 > len(versions) or v2 < 1 or v2 > len(versions):
        raise HTTPException(status_code=400, detail=f"Version out of range. Available: 1-{len(versions)}")
    r1 = versions[v1 - 1].get("reviews", {})
    r2 = versions[v2 - 1].get("reviews", {})
    changes = compute_diff(r1, r2)
    return {"v1": v1, "v2": v2, "changes": changes, "changed_count": len(changes)}


@router.get("/session/{session_id}/preview")
async def preview_submission(session_id: str):
    """Preview what the reviewer will see — read-only snapshot of current state."""
    data = await redis_store.get_full_session_state(session_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "session_id": session_id,
        "review_status": data.get("review_status", "draft"),
        "notebook": data.get("notebook", {}),
        "human_reviews": data.get("human_reviews", {}),
        "all_results": data.get("all_results", []),
        "meta": data.get("meta", {}),
        "qc_done": data.get("qc_done", False),
    }
