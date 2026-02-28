"""
Presence and SSE routes for the trainer app.

POST /api/presence/{session_id}  — heartbeat
GET  /api/presence/{session_id}  — who is viewing
GET  /api/session/{session_id}/events — SSE stream
"""
import asyncio
import json
import logging
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

import services.redis_session as redis_store
from agentic_reviewer.versioning import set_presence, get_presence, clear_presence

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["presence"])


@router.post("/presence/{session_id}")
async def heartbeat(
    session_id: str,
    x_trainer_email: Annotated[str | None, Header(alias="X-Trainer-Email")] = None,
):
    """Record that the trainer is viewing/editing this session."""
    email = (x_trainer_email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="X-Trainer-Email header required")
    r = await redis_store.get_redis()
    await set_presence(r, session_id, email, "trainer", "editing")
    return {"ok": True}


@router.get("/presence/{session_id}")
async def who_is_viewing(session_id: str):
    """Return list of users currently viewing this session."""
    r = await redis_store.get_redis()
    viewers = await get_presence(r, session_id)
    return {"session_id": session_id, "viewers": viewers}


@router.delete("/presence/{session_id}")
async def leave(
    session_id: str,
    x_trainer_email: Annotated[str | None, Header(alias="X-Trainer-Email")] = None,
):
    email = (x_trainer_email or "").strip().lower()
    if email:
        r = await redis_store.get_redis()
        await clear_presence(r, session_id, email)
    return {"ok": True}


@router.get("/session/{session_id}/events")
async def sse_events(session_id: str, request: Request):
    """Server-Sent Events stream for real-time state updates.
    Polls Redis every 2s and pushes when version changes."""
    r = await redis_store.get_redis()

    async def event_generator():
        last_version = 0
        last_status = ""
        while True:
            if await request.is_disconnected():
                break
            try:
                from agentic_reviewer.versioning import get_version
                version = await get_version(r, session_id)
                status = await redis_store.get_review_status(session_id)
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
