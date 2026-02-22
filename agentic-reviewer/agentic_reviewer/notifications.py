"""
In-app notifications — shared module for trainer and reviewer apps.

Redis storage: mh:notif:{email} — capped list of JSON notification objects.
Each notification: {id, type, session_id, task_display_id, message, created_at, read}

Both apps import this module to push/read/mark-read notifications.
Also provides shared helpers to extract task_display_id and trainer_email from
Redis session data, eliminating duplication across route handlers.
"""
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

NOTIF_PREFIX = "mh:notif"
SESS_PREFIX = "mh:sess"
NOTIF_MAX = 100
NOTIF_TTL = 7 * 86400  # 7 days


def _notif_key(email: str) -> str:
    return f"{NOTIF_PREFIX}:{email.strip().lower()}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _get_task_id_fields() -> list:
    """Config-driven metadata field names for task display ID extraction."""
    try:
        from agentic_reviewer.config_loader import get_config_value
        primary = get_config_value("task_identity.display_id_field") or "Task ID"
        fallbacks = get_config_value("task_identity.fallback_fields") or ["TaskID", "task_id"]
        return [primary] + list(fallbacks)
    except Exception:
        return ["Task ID", "TaskID", "task_id"]


async def extract_task_display_id(redis_conn, session_id: str) -> str:
    """Read notebook metadata from Redis and return the human-readable task ID.
    Falls back to the first 8 chars of the session_id."""
    raw = await redis_conn.get(f"{SESS_PREFIX}:{session_id}:notebook")
    if not raw:
        return session_id[:8]
    try:
        nb = json.loads(raw)
        meta = nb.get("metadata", {}) if isinstance(nb, dict) else {}
        for key in _get_task_id_fields():
            val = meta.get(key)
            if val is not None and str(val).strip():
                return str(val).strip()
    except (json.JSONDecodeError, TypeError):
        pass
    return session_id[:8]


def extract_task_display_id_from_metadata(metadata: dict) -> str:
    """Synchronous extraction from an already-loaded metadata dict."""
    if not isinstance(metadata, dict):
        return ""
    for key in _get_task_id_fields():
        val = metadata.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


async def get_trainer_email_for_session(redis_conn, session_id: str) -> Optional[str]:
    """Read trainer_email from session meta hash."""
    val = await redis_conn.hget(f"{SESS_PREFIX}:{session_id}:meta", "trainer_email")
    email = (val or "").strip().lower()
    return email or None


async def notify_user(
    redis_conn,
    email: str,
    notif_type: str,
    session_id: str,
    message: str,
    task_display_id: str = "",
) -> None:
    """Build + push a notification in one call. Skips silently if email is empty."""
    if not email:
        return
    notif = build_notification(notif_type, session_id, message, task_display_id=task_display_id)
    await push_notification(redis_conn, email, notif)


def build_notification(
    notif_type: str,
    session_id: str,
    message: str,
    task_display_id: str = "",
) -> Dict[str, Any]:
    """Build a notification dict (not yet persisted)."""
    return {
        "id": str(uuid.uuid4()),
        "type": notif_type,
        "session_id": session_id,
        "task_display_id": task_display_id,
        "message": message,
        "created_at": _now_iso(),
        "read": False,
    }


async def push_notification(redis_conn, email: str, notification: Dict[str, Any]) -> None:
    """Push a notification to a user's list. Caps at NOTIF_MAX entries."""
    if not email:
        return
    key = _notif_key(email)
    payload = json.dumps(notification, default=str)
    pipe = redis_conn.pipeline()
    pipe.lpush(key, payload)
    pipe.ltrim(key, 0, NOTIF_MAX - 1)
    pipe.expire(key, NOTIF_TTL)
    await pipe.execute()
    logger.debug("Notification pushed to %s: %s", email, notification.get("type"))


async def get_notifications(
    redis_conn, email: str, unread_only: bool = False, limit: int = 50
) -> List[Dict[str, Any]]:
    """Return notifications for a user (newest first)."""
    if not email:
        return []
    key = _notif_key(email)
    raw_list = await redis_conn.lrange(key, 0, limit - 1)
    out: List[Dict[str, Any]] = []
    for raw in raw_list or []:
        try:
            item = json.loads(raw)
            if unread_only and item.get("read"):
                continue
            out.append(item)
        except (json.JSONDecodeError, TypeError):
            pass
    return out


async def get_unread_count(redis_conn, email: str) -> int:
    """Return count of unread notifications."""
    items = await get_notifications(redis_conn, email, unread_only=True, limit=NOTIF_MAX)
    return len(items)


_LUA_MARK_ONE_READ = """
local key = KEYS[1]
local target_id = ARGV[1]
local len = redis.call('LLEN', key)
for i = 0, len - 1 do
    local raw = redis.call('LINDEX', key, i)
    local ok, item = pcall(cjson.decode, raw)
    if ok and item['id'] == target_id and not item['read'] then
        item['read'] = true
        redis.call('LSET', key, i, cjson.encode(item))
        return 1
    end
end
return 0
"""

_LUA_MARK_ALL_READ = """
local key = KEYS[1]
local len = redis.call('LLEN', key)
local count = 0
for i = 0, len - 1 do
    local raw = redis.call('LINDEX', key, i)
    local ok, item = pcall(cjson.decode, raw)
    if ok and not item['read'] then
        item['read'] = true
        redis.call('LSET', key, i, cjson.encode(item))
        count = count + 1
    end
end
return count
"""


async def mark_read(redis_conn, email: str, notif_id: str) -> bool:
    """Atomically mark a single notification as read using a Lua script."""
    if not email or not notif_id:
        return False
    result = await redis_conn.eval(_LUA_MARK_ONE_READ, 1, _notif_key(email), notif_id)
    return bool(result)


async def mark_all_read(redis_conn, email: str) -> int:
    """Atomically mark all notifications as read using a Lua script."""
    if not email:
        return 0
    result = await redis_conn.eval(_LUA_MARK_ALL_READ, 1, _notif_key(email))
    return int(result)


def resolve_reviewer_email_for_trainer(trainer_email: str) -> Optional[str]:
    """Given a trainer email, find the reviewer for their pod via team_config."""
    try:
        from agentic_reviewer.team_config import get_pod_for_email, get_reviewer_email_for_pod
        pod_id = get_pod_for_email(trainer_email)
        if pod_id:
            return get_reviewer_email_for_pod(pod_id)
    except Exception:
        pass
    return None


def resolve_trainer_email_for_session(session_meta: Dict[str, Any]) -> Optional[str]:
    """Extract trainer_email from session meta hash."""
    return (session_meta.get("trainer_email") or "").strip().lower() or None
