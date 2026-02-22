"""
Reviewer feedback storage in Redis.

Key: mh:rev_fb:{session_id} → JSON(ReviewerFeedback).
History key: mh:rev_fb_history:{session_id} → JSON list (archival handled by trainer on resubmit).
TTL aligned with session TTL so feedback lives as long as the session.
"""
import json
import logging
from typing import Any, Dict, List

from config import get_session_ttl
from schemas import ReviewerFeedback

from .redis_client import get_redis

logger = logging.getLogger(__name__)

_FB_PREFIX = "mh:rev_fb"
_FB_HISTORY_PREFIX = "mh:rev_fb_history"
_TTL = get_session_ttl()


async def get_feedback(session_id: str) -> ReviewerFeedback:
    """Load reviewer feedback for session. Returns empty feedback if none stored."""
    r = await get_redis()
    raw = await r.get(f"{_FB_PREFIX}:{session_id}")
    if not raw:
        return ReviewerFeedback()
    try:
        data = json.loads(raw)
        return ReviewerFeedback.model_validate(data)
    except (json.JSONDecodeError, Exception) as e:
        logger.warning("Invalid feedback for %s: %s", session_id, e)
        return ReviewerFeedback()


async def set_feedback(session_id: str, feedback: ReviewerFeedback) -> None:
    """Save reviewer feedback for session. Uses to_legacy_dump() so section_comments stays in sync."""
    r = await get_redis()
    key = f"{_FB_PREFIX}:{session_id}"
    payload = feedback.to_legacy_dump()
    await r.set(key, json.dumps(payload, default=str))
    await r.expire(key, _TTL)
    logger.debug("Feedback saved for session %s", session_id)


async def get_feedback_history(session_id: str) -> List[Dict[str, Any]]:
    """Return previous feedback snapshots (newest first). Empty list if none."""
    r = await get_redis()
    raw_list = await r.lrange(f"{_FB_HISTORY_PREFIX}:{session_id}", 0, -1)
    out: List[Dict[str, Any]] = []
    for raw in raw_list or []:
        try:
            out.append(json.loads(raw))
        except json.JSONDecodeError:
            pass
    return out
