"""
Notification routes for the trainer app.

GET  /api/notifications         — list notifications for current trainer
POST /api/notifications/{id}/read   — mark one notification as read
POST /api/notifications/read-all    — mark all as read
GET  /api/notifications/unread-count — just the count (lightweight poll)
"""
import logging
from typing import Annotated

from fastapi import APIRouter, Header

import services.redis_session as redis_store
from agentic_reviewer.notifications import (
    get_notifications,
    get_unread_count,
    mark_read,
    mark_all_read,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["notifications"])


@router.get("/notifications")
async def list_notifications(
    x_trainer_email: Annotated[str | None, Header(alias="X-Trainer-Email")] = None,
    unread_only: bool = False,
):
    email = (x_trainer_email or "").strip().lower()
    if not email:
        return {"notifications": [], "unread_count": 0}
    r = await redis_store.get_redis()
    items = await get_notifications(r, email, unread_only=unread_only)
    unread = await get_unread_count(r, email)
    return {"notifications": items, "unread_count": unread}


@router.get("/notifications/unread-count")
async def unread_count(
    x_trainer_email: Annotated[str | None, Header(alias="X-Trainer-Email")] = None,
):
    email = (x_trainer_email or "").strip().lower()
    if not email:
        return {"unread_count": 0}
    r = await redis_store.get_redis()
    count = await get_unread_count(r, email)
    return {"unread_count": count}


@router.post("/notifications/{notif_id}/read")
async def mark_notification_read(
    notif_id: str,
    x_trainer_email: Annotated[str | None, Header(alias="X-Trainer-Email")] = None,
):
    email = (x_trainer_email or "").strip().lower()
    if not email:
        return {"ok": False}
    r = await redis_store.get_redis()
    found = await mark_read(r, email, notif_id)
    return {"ok": found}


@router.post("/notifications/read-all")
async def mark_all_notifications_read(
    x_trainer_email: Annotated[str | None, Header(alias="X-Trainer-Email")] = None,
):
    email = (x_trainer_email or "").strip().lower()
    if not email:
        return {"ok": False, "count": 0}
    r = await redis_store.get_redis()
    count = await mark_all_read(r, email)
    return {"ok": True, "count": count}
