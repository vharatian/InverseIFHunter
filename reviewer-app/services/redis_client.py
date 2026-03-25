"""
Redis access for reviewer app.

Uses the repo-wide async client in redis_client.py (single pool). Key layout matches
the trainer app (mh:sess:{id}:*) so we read session data without importing model-hunter.
Returns plain dicts for agentic_reviewer snapshot builder.
"""
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

_REVIEWER_APP_ROOT = Path(__file__).resolve().parents[1]
_REPO_ROOT = Path(__file__).resolve().parents[2]
# Reviewer package must precede repo root so `config` is reviewer-app/config, not config.py at repo root.
for _p in (_REPO_ROOT, _REVIEWER_APP_ROOT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from config import get_redis_url, get_session_ttl
from config.settings import ensure_agentic_path

ensure_agentic_path()

# Resolve URL from reviewer YAML/env before shared module snapshots REDIS_URL.
os.environ["REDIS_URL"] = get_redis_url()

from redis_client import close_redis, get_redis  # noqa: E402
from agentic_reviewer.team_config import get_role, get_allowed_trainer_emails_for_role  # noqa: E402

KEY_PREFIX = "mh:sess"
SESSION_TTL = get_session_ttl()

__all__ = [
    "get_redis",
    "close_redis",
    "list_sessions",
    "get_review_status",
    "set_review_status",
    "cas_review_status",
    "get_review_status_and_trainer_batch",
    "list_sessions_for_review",
    "get_session_dict",
    "clear_qc_done",
    "set_human_reviews",
]


def _key(session_id: str, field: str) -> str:
    return f"{KEY_PREFIX}:{session_id}:{field}"


REVIEW_STATUS_VALUES = ("draft", "submitted", "returned", "approved", "rejected", "escalated")


async def list_sessions() -> List[str]:
    """List all session IDs that have a status key (active sessions).
    Uses a set to deduplicate because Redis SCAN may return duplicates."""
    r = await get_redis()
    seen: set[str] = set()
    session_ids: List[str] = []
    async for key in r.scan_iter(match=f"{KEY_PREFIX}:*:status"):
        parts = key.split(":")
        if len(parts) == 4:
            sid = parts[2]
            if sid not in seen:
                seen.add(sid)
                session_ids.append(sid)
    return session_ids


async def get_review_status(session_id: str) -> str:
    """Return review_status: draft | submitted | returned | approved. Default draft."""
    r = await get_redis()
    val = await r.get(_key(session_id, "review_status"))
    if val in REVIEW_STATUS_VALUES:
        return val
    return "draft"


async def set_review_status(session_id: str, status: str) -> None:
    """Set review_status. Session must exist."""
    if status not in REVIEW_STATUS_VALUES:
        raise ValueError(f"Invalid review_status: {status}")
    r = await get_redis()
    if await r.get(_key(session_id, "status")) is None:
        raise ValueError(f"Session {session_id} not found")
    await r.set(_key(session_id, "review_status"), status)
    await r.expire(_key(session_id, "review_status"), SESSION_TTL)


_CAS_LUA = """
local exists = redis.call('GET', KEYS[2])
if not exists then return -1 end
local current = redis.call('GET', KEYS[1])
if current == false then current = 'draft' end
if current ~= ARGV[1] then return current end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('HINCRBY', KEYS[3], 'version', 1)
return 1
"""


async def cas_review_status(session_id: str, expected: str, new_status: str) -> tuple[bool, str]:
    """
    Atomic compare-and-swap for review_status.
    Returns (True, new_status) on success, (False, actual_status) on mismatch.
    Raises ValueError if session not found.
    """
    if new_status not in REVIEW_STATUS_VALUES:
        raise ValueError(f"Invalid review_status: {new_status}")
    r = await get_redis()
    result = await r.eval(
        _CAS_LUA, 3,
        _key(session_id, "review_status"),
        _key(session_id, "status"),
        _key(session_id, "meta"),
        expected, new_status, str(SESSION_TTL),
    )
    if result == -1:
        raise ValueError(f"Session {session_id} not found")
    if result == 1:
        return True, new_status
    return False, str(result)


async def get_review_status_and_trainer_batch(session_ids: List[str]) -> List[Tuple[str, str]]:
    """
    For each session_id return (review_status, trainer_email) both lowercased.
    Used to scope tab counts by reviewer pod.
    """
    if not session_ids:
        return []
    r = await get_redis()
    out: List[Tuple[str, str]] = []
    chunk = 200
    for i in range(0, len(session_ids), chunk):
        batch = session_ids[i : i + chunk]
        pipe = r.pipeline()
        for sid in batch:
            pipe.get(_key(sid, "review_status"))
            pipe.hget(_key(sid, "meta"), "trainer_email")
        vals = await pipe.execute()
        for j in range(0, len(vals), 2):
            status_val = vals[j]
            trainer_val = vals[j + 1] if j + 1 < len(vals) else None
            status = (str(status_val).strip() if status_val else "draft").lower()
            if status not in REVIEW_STATUS_VALUES:
                status = "draft"
            trainer = (str(trainer_val).strip() if trainer_val else "").lower()
            out.append((status, trainer))
    return out


async def list_sessions_for_review(reviewer_email: str = "") -> List[str]:
    """List session IDs where review_status is submitted (or escalated for admins),
    scoped to the reviewer's pod. Super admins see all."""
    all_ids = await list_sessions()
    if not all_ids:
        return []

    email = (reviewer_email or "").strip().lower()
    role = get_role(email) if email else None
    allowed_trainers: Optional[Set[str]] = None
    if role == "super_admin":
        allowed_trainers = None
    elif email:
        trainer_list = get_allowed_trainer_emails_for_role(email)
        allowed_trainers = set(trainer_list) if trainer_list is not None else None

    reviewable_statuses = {"submitted"}
    if role in ("super_admin", "admin"):
        reviewable_statuses.add("escalated")

    r = await get_redis()
    pipe = r.pipeline()
    for sid in all_ids:
        pipe.get(_key(sid, "review_status"))
        pipe.hget(_key(sid, "meta"), "trainer_email")
    values = await pipe.execute()

    out = []
    for i, sid in enumerate(all_ids):
        status_val = values[i * 2]
        trainer_email_val = (values[i * 2 + 1] or "").strip().lower()
        status = status_val if status_val in REVIEW_STATUS_VALUES else "draft"
        if status not in reviewable_statuses:
            continue
        if allowed_trainers is not None and trainer_email_val not in allowed_trainers:
            continue
        out.append(sid)
    return out


async def get_session_dict(session_id: str) -> Optional[Dict[str, Any]]:
    """
    Load session from Redis and return a dict suitable for agentic_reviewer.build_snapshot.
    Keys: session_id, notebook, config, all_results, current_turn, human_reviews.
    Returns None if session does not exist.
    """
    r = await get_redis()
    status_val = await r.get(_key(session_id, "status"))
    if status_val is None:
        return None

    pipe = r.pipeline()
    pipe.get(_key(session_id, "config"))
    pipe.get(_key(session_id, "notebook"))
    pipe.hgetall(_key(session_id, "meta"))
    pipe.lrange(_key(session_id, "all_results"), 0, -1)
    pipe.get(_key(session_id, "reviews"))

    config_json, notebook_json, meta, all_results_jsons, reviews_json = await pipe.execute()

    config: Dict[str, Any] = {}
    if config_json:
        try:
            config = json.loads(config_json)
        except json.JSONDecodeError:
            pass
    if not isinstance(config, dict):
        config = {}

    notebook: Dict[str, Any] = {}
    if notebook_json:
        try:
            notebook = json.loads(notebook_json)
        except json.JSONDecodeError:
            pass
    if not isinstance(notebook, dict):
        notebook = {}

    meta = meta or {}
    current_turn = int(meta.get("current_turn", 1))

    all_results: List[Dict[str, Any]] = []
    if all_results_jsons:
        for item in all_results_jsons:
            try:
                all_results.append(json.loads(item))
            except (json.JSONDecodeError, TypeError):
                pass

    human_reviews: Dict[str, Any] = {}
    if reviews_json:
        try:
            human_reviews = json.loads(reviews_json)
        except json.JSONDecodeError:
            pass
    if not isinstance(human_reviews, dict):
        human_reviews = {}

    # Refresh TTL on all session keys so long review cycles don't lose data
    ttl_pipe = r.pipeline()
    for field in ("config", "notebook", "status", "meta", "results",
                  "all_results", "turns", "history", "reviews",
                  "review_status", "qc_done", "resubmitted_at"):
        ttl_pipe.expire(_key(session_id, field), SESSION_TTL)
    await ttl_pipe.execute()

    return {
        "session_id": session_id,
        "notebook": notebook,
        "config": config,
        "all_results": all_results,
        "current_turn": current_turn,
        "human_reviews": human_reviews,
    }


async def clear_qc_done(session_id: str) -> None:
    """Reset QC flag so trainer must re-run Quality Check after reviewer return."""
    r = await get_redis()
    await r.delete(_key(session_id, "qc_done"))


async def set_human_reviews(session_id: str, human_reviews: Dict[str, Any]) -> None:
    """
    Write human_reviews back to Redis (mh:sess:{id}:reviews).
    Used by reviewer app when reviewer edits task. Session must exist.
    """
    r = await get_redis()
    if await r.get(_key(session_id, "status")) is None:
        raise ValueError(f"Session {session_id} not found")
    await r.set(_key(session_id, "reviews"), json.dumps(human_reviews, default=str))
    await r.expire(_key(session_id, "reviews"), SESSION_TTL)
