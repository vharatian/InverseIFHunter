"""
Presence, SSE, version history, and bulk action routes for the reviewer app.

POST /api/presence/{id}       — heartbeat
GET  /api/presence/{id}       — who is viewing
GET  /api/session/{id}/events — SSE stream
GET  /api/tasks/{id}/versions — version history
GET  /api/tasks/{id}/diff     — diff between versions
POST /api/tasks/bulk-approve  — approve multiple tasks
"""
import asyncio
import json
import logging
from typing import Annotated, List

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from api.deps import require_reviewer
from services.redis_client import get_redis, get_review_status, cas_review_status
from services.audit_store import append_audit
from services.feedback_store import get_feedback, set_feedback
from agentic_reviewer.versioning import (
    set_presence, get_presence, clear_presence,
    get_version, get_version_history, compute_diff,
)
from agentic_reviewer.resilience import safe_notify
from agentic_reviewer.notifications import (
    extract_task_display_id,
    get_trainer_email_for_session,
    notify_user,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["presence"])


@router.post("/presence/{session_id}")
async def heartbeat(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    r = await get_redis()
    from agentic_reviewer.team_config import get_role
    role = get_role(_reviewer) or "reviewer"
    await set_presence(r, session_id, _reviewer, role, "reviewing")
    return {"ok": True}


@router.get("/presence/{session_id}")
async def who_is_viewing(session_id: str):
    r = await get_redis()
    viewers = await get_presence(r, session_id)
    return {"session_id": session_id, "viewers": viewers}


@router.delete("/presence/{session_id}")
async def leave(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    r = await get_redis()
    await clear_presence(r, session_id, _reviewer)
    return {"ok": True}


@router.get("/session/{session_id}/events")
async def sse_events(session_id: str, request: Request):
    """SSE stream — pushes when version or status changes."""
    r = await get_redis()

    async def event_generator():
        last_version = 0
        last_status = ""
        while True:
            if await request.is_disconnected():
                break
            try:
                version = await get_version(r, session_id)
                status = await get_review_status(session_id)
                if version != last_version or status != last_status:
                    last_version = version
                    last_status = status
                    data = json.dumps({"version": version, "review_status": status})
                    yield f"data: {data}\n\n"
            except Exception:
                pass
            await asyncio.sleep(2)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/tasks/{session_id}/versions")
async def task_versions(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    r = await get_redis()
    versions = await get_version_history(r, session_id)
    return {"session_id": session_id, "versions": versions}


@router.get("/tasks/{session_id}/diff")
async def task_diff(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
    v1: int = Query(...),
    v2: int = Query(...),
):
    r = await get_redis()
    versions = await get_version_history(r, session_id)
    if v1 < 1 or v1 > len(versions) or v2 < 1 or v2 > len(versions):
        raise HTTPException(status_code=400, detail=f"Version out of range. Available: 1-{len(versions)}")
    r1 = versions[v1 - 1].get("reviews", {})
    r2 = versions[v2 - 1].get("reviews", {})
    changes = compute_diff(r1, r2)
    return {"v1": v1, "v2": v2, "changes": changes, "changed_count": len(changes)}


def _get_bulk_max() -> int:
    try:
        from agentic_reviewer.config_loader import get_config_value
        return int(get_config_value("bulk_actions.max_batch_size", 4))
    except Exception:
        return 4


@router.post("/tasks/bulk-approve")
async def bulk_approve(
    _reviewer: Annotated[str, Depends(require_reviewer)],
    body: dict = Body(...),
):
    """Approve multiple submitted tasks. body: { session_ids: [...], comment?: str }"""
    session_ids: List[str] = body.get("session_ids", [])
    comment = (body.get("comment") or "").strip()
    max_batch = _get_bulk_max()

    if not session_ids:
        raise HTTPException(status_code=400, detail="No session_ids provided")
    if len(session_ids) > max_batch:
        raise HTTPException(status_code=400, detail=f"Max {max_batch} tasks per batch. Got {len(session_ids)}.")

    succeeded = []
    failed = []

    for sid in session_ids:
        try:
            status = await get_review_status(sid)
            if status != "submitted":
                failed.append({"session_id": sid, "reason": f"Status is '{status}', not submitted"})
                continue
            ok, actual = await cas_review_status(sid, "submitted", "approved")
            if not ok:
                failed.append({"session_id": sid, "reason": f"CAS conflict: status is '{actual}'"})
                continue
            if comment:
                fb = await get_feedback(sid)
                fb.approval_comment = comment
                await set_feedback(sid, fb)
            await append_audit(sid, "approved", _reviewer, {"bulk": True})

            async def _notify(s=sid):
                r = await get_redis()
                trainer_email = await get_trainer_email_for_session(r, s)
                if trainer_email:
                    task_id = await extract_task_display_id(r, s)
                    await notify_user(r, trainer_email, "task_approved", s, "Your task has been approved.", task_id)

            await safe_notify(_notify(), context=f"bulk approve notification {sid}")
            succeeded.append(sid)
        except Exception as e:
            failed.append({"session_id": sid, "reason": str(e)})

    return {"ok": True, "succeeded": succeeded, "failed": failed}
