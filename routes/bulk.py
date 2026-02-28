"""
Bulk action routes for the trainer app.

POST /api/session/bulk-resubmit — resubmit multiple returned tasks
"""
import logging
from typing import List

from fastapi import APIRouter, Body, HTTPException

import services.redis_session as redis_store
from agentic_reviewer.versioning import get_acknowledged_at, clear_acknowledged, snapshot_for_history
from agentic_reviewer.resilience import safe_notify
from agentic_reviewer.notifications import (
    extract_task_display_id,
    notify_user,
    resolve_reviewer_email_for_trainer,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["bulk"])


def _get_bulk_max() -> int:
    try:
        from agentic_reviewer.config_loader import get_config_value
        return int(get_config_value("bulk_actions.max_batch_size", 4))
    except Exception:
        return 4


@router.post("/session/bulk-resubmit")
async def bulk_resubmit(body: dict = Body(...)):
    """Resubmit multiple returned tasks. body: { session_ids: [...] }
    Each task must have QC done + acknowledgment."""
    session_ids: List[str] = body.get("session_ids", [])
    max_batch = _get_bulk_max()

    if not session_ids:
        raise HTTPException(status_code=400, detail="No session_ids provided")
    if len(session_ids) > max_batch:
        raise HTTPException(status_code=400, detail=f"Max {max_batch} tasks per batch. Got {len(session_ids)}.")

    succeeded = []
    failed = []

    for sid in session_ids:
        try:
            r = await redis_store.get_redis()
            status = await redis_store.get_review_status(sid)
            if status != "returned":
                failed.append({"session_id": sid, "reason": f"Status is '{status}', not returned"})
                continue
            if not await redis_store.get_qc_done(sid):
                failed.append({"session_id": sid, "reason": "QC not done"})
                continue
            ack_at = await get_acknowledged_at(r, sid)
            if not ack_at:
                failed.append({"session_id": sid, "reason": "Feedback not acknowledged"})
                continue

            await redis_store.archive_and_clear_feedback(sid)
            await redis_store.set_resubmitted_at(sid)
            await clear_acknowledged(r, sid)

            current_round = await redis_store.get_review_round(sid)
            next_round = current_round + 1
            max_rounds = redis_store.get_max_review_rounds()

            if next_round > max_rounds:
                ok, actual = await redis_store.cas_review_status(sid, "returned", "escalated")
                if ok:
                    await redis_store.incr_review_round(sid)
                    await redis_store.append_audit(sid, "escalated", "trainer", {"bulk": True})
                else:
                    failed.append({"session_id": sid, "reason": f"CAS conflict: '{actual}'"})
                continue

            ok, actual = await redis_store.cas_review_status(sid, "returned", "submitted")
            if not ok:
                failed.append({"session_id": sid, "reason": f"CAS conflict: '{actual}'"})
                continue

            await redis_store.incr_review_round(sid)
            await snapshot_for_history(r, sid, next_round)
            await redis_store.append_audit(sid, "resubmitted", "trainer", {"bulk": True})

            async def _notify(s=sid):
                rr = await redis_store.get_redis()
                meta = await redis_store.get_meta(s)
                trainer_email = (meta.get("trainer_email") or "").strip().lower()
                if not trainer_email:
                    return
                reviewer_email = resolve_reviewer_email_for_trainer(trainer_email)
                if not reviewer_email:
                    return
                task_display_id = await extract_task_display_id(rr, s)
                await notify_user(rr, reviewer_email, "task_resubmitted", s, "A task has been resubmitted.", task_display_id)

            await safe_notify(_notify(), context=f"bulk resubmit notification {sid}")
            succeeded.append(sid)
        except Exception as e:
            failed.append({"session_id": sid, "reason": str(e)})

    return {"ok": True, "succeeded": succeeded, "failed": failed}
