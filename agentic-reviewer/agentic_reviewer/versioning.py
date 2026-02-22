"""
Versioning, idempotency, and presence — shared module for both apps.

Provides:
    incr_version          — atomically increment session version in meta
    get_version           — read current version
    check_idempotency     — check/store idempotency key
    set_presence          — heartbeat for viewer presence
    get_presence          — who is currently viewing a session
    snapshot_for_history  — capture reviews + selections for version history
    get_version_history   — retrieve version list
    compute_diff          — field-level diff between two versions
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

SESS_PREFIX = "mh:sess"
IDEMP_PREFIX = "mh:idemp"
PRESENCE_PREFIX = "mh:presence"
VERSIONS_PREFIX = "mh:versions"

_DEFAULT_IDEMP_TTL = 86400  # 24 hours
_DEFAULT_PRESENCE_TTL = 30  # seconds
_MAX_VERSIONS = 20


def _idemp_ttl() -> int:
    try:
        from agentic_reviewer.config_loader import get_config_value
        return get_config_value("idempotency.ttl_hours", 24) * 3600
    except Exception:
        return _DEFAULT_IDEMP_TTL


def _presence_ttl() -> int:
    try:
        from agentic_reviewer.config_loader import get_config_value
        return get_config_value("presence.ttl_seconds", 30)
    except Exception:
        return _DEFAULT_PRESENCE_TTL


# ---- Version (optimistic locking) ----

async def incr_version(redis_conn, session_id: str) -> int:
    """Atomically increment and return the session version. Starts at 1."""
    return await redis_conn.hincrby(f"{SESS_PREFIX}:{session_id}:meta", "version", 1)


async def get_version(redis_conn, session_id: str) -> int:
    val = await redis_conn.hget(f"{SESS_PREFIX}:{session_id}:meta", "version")
    return int(val) if val and str(val).isdigit() else 0


async def check_version_match(redis_conn, session_id: str, expected: int) -> Tuple[bool, int]:
    """Compare expected version with current. Returns (match, current_version)."""
    current = await get_version(redis_conn, session_id)
    return (current == expected or expected == 0), current


# ---- Idempotency ----

async def check_idempotency(redis_conn, key: str) -> Optional[Dict[str, Any]]:
    """If key exists, return stored response. Otherwise return None."""
    if not key:
        return None
    raw = await redis_conn.get(f"{IDEMP_PREFIX}:{key}")
    if raw:
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            pass
    return None


async def store_idempotency(redis_conn, key: str, response: Dict[str, Any]) -> None:
    """Store response for an idempotency key."""
    if not key:
        return
    await redis_conn.set(
        f"{IDEMP_PREFIX}:{key}",
        json.dumps(response, default=str),
        ex=_idemp_ttl(),
    )


# ---- Presence ----

async def set_presence(redis_conn, session_id: str, email: str, role: str, action: str = "viewing") -> None:
    """Record that a user is viewing/editing a session. Auto-expires."""
    key = f"{PRESENCE_PREFIX}:{session_id}"
    field = email.strip().lower()
    val = json.dumps({"role": role, "action": action, "ts": _now_iso()})
    await redis_conn.hset(key, field, val)
    await redis_conn.expire(key, _presence_ttl())


async def get_presence(redis_conn, session_id: str) -> List[Dict[str, Any]]:
    """Return list of users currently viewing a session."""
    key = f"{PRESENCE_PREFIX}:{session_id}"
    data = await redis_conn.hgetall(key)
    out = []
    for email, raw in (data or {}).items():
        try:
            info = json.loads(raw)
            out.append({"email": email, **info})
        except (json.JSONDecodeError, TypeError):
            out.append({"email": email, "action": "viewing"})
    return out


async def clear_presence(redis_conn, session_id: str, email: str) -> None:
    key = f"{PRESENCE_PREFIX}:{session_id}"
    await redis_conn.hdel(key, email.strip().lower())


# ---- Version History (snapshots) ----

async def snapshot_for_history(redis_conn, session_id: str, round_num: int) -> None:
    """Capture current reviews + selections as a versioned snapshot."""
    reviews_raw = await redis_conn.get(f"{SESS_PREFIX}:{session_id}:reviews")
    reviews = {}
    if reviews_raw:
        try:
            reviews = json.loads(reviews_raw)
        except (json.JSONDecodeError, TypeError):
            pass

    snapshot = {
        "round": round_num,
        "timestamp": _now_iso(),
        "reviews": reviews,
    }

    key = f"{VERSIONS_PREFIX}:{session_id}"
    pipe = redis_conn.pipeline()
    pipe.rpush(key, json.dumps(snapshot, default=str))
    pipe.ltrim(key, -_MAX_VERSIONS, -1)
    pipe.expire(key, 14400)
    await pipe.execute()


async def get_version_history(redis_conn, session_id: str) -> List[Dict[str, Any]]:
    """Return all version snapshots for a session."""
    key = f"{VERSIONS_PREFIX}:{session_id}"
    raw_list = await redis_conn.lrange(key, 0, -1)
    out = []
    for i, raw in enumerate(raw_list or []):
        try:
            item = json.loads(raw)
            item["version"] = i + 1
            out.append(item)
        except (json.JSONDecodeError, TypeError):
            pass
    return out


def compute_diff(v1_reviews: Dict, v2_reviews: Dict) -> List[Dict[str, Any]]:
    """Compute field-level diff between two review snapshots."""
    changes = []
    all_keys = set(list(v1_reviews.keys()) + list(v2_reviews.keys()))
    for key in sorted(all_keys):
        old = v1_reviews.get(key, {})
        new = v2_reviews.get(key, {})
        if not isinstance(old, dict):
            old = {}
        if not isinstance(new, dict):
            new = {}

        if key not in v1_reviews:
            changes.append({"slot": key, "field": "added", "old": None, "new": "new review"})
            continue
        if key not in v2_reviews:
            changes.append({"slot": key, "field": "removed", "old": "had review", "new": None})
            continue

        for field in ("judgment", "grading_basis", "explanation"):
            ov = old.get(field)
            nv = new.get(field)
            if ov != nv:
                changes.append({"slot": key, "field": field, "old": ov, "new": nv})

    return changes


# ---- Acknowledgment ----

async def set_acknowledged(redis_conn, session_id: str) -> str:
    """Record that the trainer acknowledged reviewer feedback. Returns timestamp."""
    ts = _now_iso()
    await redis_conn.hset(f"{SESS_PREFIX}:{session_id}:meta", "acknowledged_at", ts)
    return ts


async def get_acknowledged_at(redis_conn, session_id: str) -> Optional[str]:
    return await redis_conn.hget(f"{SESS_PREFIX}:{session_id}:meta", "acknowledged_at")


async def clear_acknowledged(redis_conn, session_id: str) -> None:
    await redis_conn.hdel(f"{SESS_PREFIX}:{session_id}:meta", "acknowledged_at")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
