"""
Optional audit log of reviewer actions (feedback, edits, agent run).
Redis list mh:rev_audit, LPUSH new entries, LTRIM to keep last N. TTL 30 days.
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List

from .redis_client import get_redis

logger = logging.getLogger(__name__)

AUDIT_KEY = "mh:rev_audit"
AUDIT_MAX_ENTRIES = 500
TTL_DAYS = 30
TTL_SECONDS = TTL_DAYS * 86400


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def append_audit(
    session_id: str,
    action: str,
    reviewer_id: str,
    details: Dict[str, Any] | None = None,
) -> None:
    """
    Append an audit entry to global log AND per-session log.
    Actions: approved, returned, rejected, feedback_saved, task_edited, agent_run.
    """
    entry = {
        "session_id": session_id,
        "action": action,
        "reviewer_id": reviewer_id,
        "timestamp": _now_iso(),
    }
    if details:
        entry["details"] = details
    payload = json.dumps(entry, default=str)
    r = await get_redis()
    pipe = r.pipeline()
    pipe.lpush(AUDIT_KEY, payload)
    pipe.ltrim(AUDIT_KEY, 0, AUDIT_MAX_ENTRIES - 1)
    pipe.expire(AUDIT_KEY, TTL_SECONDS)
    sess_key = f"{AUDIT_KEY}:{session_id}"
    pipe.lpush(sess_key, payload)
    pipe.ltrim(sess_key, 0, 49)
    pipe.expire(sess_key, TTL_SECONDS)
    await pipe.execute()


async def get_audit(limit: int = 50) -> List[Dict[str, Any]]:
    """Return the most recent audit entries (newest first)."""
    r = await get_redis()
    raw = await r.lrange(AUDIT_KEY, 0, limit - 1)
    out = []
    for item in raw or []:
        try:
            out.append(json.loads(item))
        except json.JSONDecodeError:
            pass
    return out


async def get_session_audit(session_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    """Return audit entries for a specific session (newest first)."""
    r = await get_redis()
    raw = await r.lrange(f"{AUDIT_KEY}:{session_id}", 0, limit - 1)
    out = []
    for item in raw or []:
        try:
            out.append(json.loads(item))
        except json.JSONDecodeError:
            pass
    return out
