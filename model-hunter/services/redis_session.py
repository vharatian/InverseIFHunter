"""
Redis Session Store — Granular Keys, Atomic Operations

Replaces the old session_store.py (single blob per session).
Each session field is a separate Redis key for efficient reads/writes:

    mh:sess:{id}:config       → JSON of HuntConfig
    mh:sess:{id}:notebook     → JSON of ParsedNotebook  
    mh:sess:{id}:status       → string (pending|running|completed|failed)
    mh:sess:{id}:meta         → Redis Hash (completed_hunts, breaks_found, total_hunts, etc.)
    mh:sess:{id}:results      → Redis List of current-run HuntResult JSONs
    mh:sess:{id}:all_results  → Redis List of all accumulated HuntResult JSONs
    mh:sess:{id}:turns        → Redis List of TurnData JSONs
    mh:sess:{id}:history      → JSON of conversation history
    mh:sess:{id}:reviews      → JSON of human_reviews dict

Benefits:
- Appending a hunt result is RPUSH (atomic, no read-modify-write race)
- Incrementing breaks_found is HINCRBY (atomic, no lock needed)
- Reading status is GET on a small key, not deserializing 500KB
- Each key has its own TTL (auto-cleanup)
- Any app instance can read/write (stateless)
"""
import os
import json
import logging
from typing import Dict, Any, Optional, List

import redis.asyncio as aioredis

from models.schemas import (
    HuntSession, HuntConfig, HuntResult, HuntStatus,
    ParsedNotebook, TurnData, HuntEvent
)

logger = logging.getLogger(__name__)

# Configuration
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
SESSION_TTL = 4 * 60 * 60  # 4 hours
KEY_PREFIX = "mh:sess"

# Singleton Redis connections
_redis_client: Optional[aioredis.Redis] = None
_redis_blocking_client: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    """Get or create the Redis connection for normal operations (short timeout)."""
    global _redis_client
    if _redis_client is None:
        _redis_client = aioredis.from_url(
            REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5,
        )
        await _redis_client.ping()
        logger.info(f"Redis connected: {REDIS_URL}")
    return _redis_client


async def get_redis_blocking() -> aioredis.Redis:
    """Get or create a Redis connection for blocking operations (XREAD BLOCK).
    Uses a longer socket timeout so XREAD BLOCK doesn't get killed."""
    global _redis_blocking_client
    if _redis_blocking_client is None:
        _redis_blocking_client = aioredis.from_url(
            REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=60,  # Long timeout for XREAD BLOCK
        )
        await _redis_blocking_client.ping()
        logger.info(f"Redis blocking client connected: {REDIS_URL}")
    return _redis_blocking_client


def _key(session_id: str, field: str) -> str:
    """Build a Redis key: mh:sess:{session_id}:{field}"""
    return f"{KEY_PREFIX}:{session_id}:{field}"


def _session_keys(session_id: str) -> List[str]:
    """All Redis keys belonging to a session (for TTL refresh / deletion)."""
    fields = ["config", "notebook", "status", "meta", "results",
              "all_results", "turns", "history", "reviews", "hunt_lock"]
    return [_key(session_id, f) for f in fields]


async def _refresh_ttl(r: aioredis.Redis, session_id: str):
    """Refresh TTL on all keys for a session."""
    pipe = r.pipeline()
    for key in _session_keys(session_id):
        pipe.expire(key, SESSION_TTL)
    await pipe.execute()


# ============================================================
# Session Lifecycle
# ============================================================

async def create_session(session_id: str, notebook: ParsedNotebook, config: HuntConfig) -> None:
    """Create a new session with all initial keys."""
    r = await get_redis()
    pipe = r.pipeline()

    pipe.set(_key(session_id, "config"), config.model_dump_json())
    pipe.set(_key(session_id, "notebook"), notebook.model_dump_json())
    pipe.set(_key(session_id, "status"), HuntStatus.PENDING.value)
    pipe.hset(_key(session_id, "meta"), mapping={
        "total_hunts": 0,
        "completed_hunts": 0,
        "breaks_found": 0,
        "accumulated_hunt_count": 0,
        "current_turn": 1,
    })
    pipe.set(_key(session_id, "history"), "[]")
    pipe.set(_key(session_id, "reviews"), "{}")
    # results, all_results, turns — start as empty lists (created on first RPUSH)

    # Set TTL on all keys
    for key in _session_keys(session_id):
        pipe.expire(key, SESSION_TTL)

    await pipe.execute()
    logger.info(f"Session {session_id} created in Redis")


async def delete_session(session_id: str) -> None:
    """Delete all keys for a session."""
    r = await get_redis()
    keys = _session_keys(session_id)
    if keys:
        await r.delete(*keys)
    logger.info(f"Session {session_id} deleted from Redis")


async def session_exists(session_id: str) -> bool:
    """Check if a session exists (checks status key)."""
    r = await get_redis()
    return await r.exists(_key(session_id, "status")) > 0


# ============================================================
# Full Session Reconstruction
# ============================================================

async def get_full_session(session_id: str) -> Optional[HuntSession]:
    """
    Reconstruct a full HuntSession from all Redis keys.
    Used for API responses and operations that need the full object.
    Returns None if session doesn't exist.
    """
    r = await get_redis()

    # Check existence
    status_val = await r.get(_key(session_id, "status"))
    if status_val is None:
        return None

    # Read all fields in a pipeline
    pipe = r.pipeline()
    pipe.get(_key(session_id, "config"))
    pipe.get(_key(session_id, "notebook"))
    pipe.hgetall(_key(session_id, "meta"))
    pipe.lrange(_key(session_id, "results"), 0, -1)
    pipe.lrange(_key(session_id, "all_results"), 0, -1)
    pipe.lrange(_key(session_id, "turns"), 0, -1)
    pipe.get(_key(session_id, "history"))
    pipe.get(_key(session_id, "reviews"))

    config_json, notebook_json, meta, results_jsons, all_results_jsons, \
        turns_jsons, history_json, reviews_json = await pipe.execute()

    # Parse
    config = HuntConfig.model_validate_json(config_json) if config_json else HuntConfig()
    notebook = ParsedNotebook.model_validate_json(notebook_json) if notebook_json else None
    results = [HuntResult.model_validate_json(rj) for rj in (results_jsons or [])]
    all_results = [HuntResult.model_validate_json(rj) for rj in (all_results_jsons or [])]
    turns = [TurnData.model_validate_json(tj) for tj in (turns_jsons or [])]
    history = json.loads(history_json) if history_json else []
    reviews = json.loads(reviews_json) if reviews_json else {}

    meta = meta or {}

    session = HuntSession(
        session_id=session_id,
        notebook=notebook,
        config=config,
        results=results,
        all_results=all_results,
        total_hunts=int(meta.get("total_hunts", 0)),
        completed_hunts=int(meta.get("completed_hunts", 0)),
        breaks_found=int(meta.get("breaks_found", 0)),
        accumulated_hunt_count=int(meta.get("accumulated_hunt_count", 0)),
        status=HuntStatus(status_val),
        human_reviews=reviews,
        current_turn=int(meta.get("current_turn", 1)),
        conversation_history=history,
        turns=turns,
    )

    # Refresh TTL on access
    await _refresh_ttl(r, session_id)

    return session


# ============================================================
# Granular Reads
# ============================================================

async def get_config(session_id: str) -> Optional[HuntConfig]:
    r = await get_redis()
    data = await r.get(_key(session_id, "config"))
    return HuntConfig.model_validate_json(data) if data else None


async def get_notebook(session_id: str) -> Optional[ParsedNotebook]:
    r = await get_redis()
    data = await r.get(_key(session_id, "notebook"))
    return ParsedNotebook.model_validate_json(data) if data else None


async def get_status(session_id: str) -> Optional[HuntStatus]:
    r = await get_redis()
    val = await r.get(_key(session_id, "status"))
    return HuntStatus(val) if val else None


async def get_meta(session_id: str) -> Dict[str, Any]:
    r = await get_redis()
    meta = await r.hgetall(_key(session_id, "meta"))
    return {k: int(v) if v.lstrip("-").isdigit() else v for k, v in meta.items()} if meta else {}


async def get_results(session_id: str) -> List[HuntResult]:
    r = await get_redis()
    items = await r.lrange(_key(session_id, "results"), 0, -1)
    return [HuntResult.model_validate_json(item) for item in items]


async def get_all_results(session_id: str) -> List[HuntResult]:
    r = await get_redis()
    items = await r.lrange(_key(session_id, "all_results"), 0, -1)
    return [HuntResult.model_validate_json(item) for item in items]


async def get_turns(session_id: str) -> List[TurnData]:
    r = await get_redis()
    items = await r.lrange(_key(session_id, "turns"), 0, -1)
    return [TurnData.model_validate_json(item) for item in items]


async def get_conversation_history(session_id: str) -> List[Dict[str, str]]:
    r = await get_redis()
    data = await r.get(_key(session_id, "history"))
    return json.loads(data) if data else []


# ============================================================
# Granular Writes
# ============================================================

async def set_config(session_id: str, config: HuntConfig) -> None:
    r = await get_redis()
    await r.set(_key(session_id, "config"), config.model_dump_json())
    await r.expire(_key(session_id, "config"), SESSION_TTL)


async def set_notebook(session_id: str, notebook: ParsedNotebook) -> None:
    r = await get_redis()
    await r.set(_key(session_id, "notebook"), notebook.model_dump_json())
    await r.expire(_key(session_id, "notebook"), SESSION_TTL)


async def set_status(session_id: str, status: HuntStatus) -> None:
    r = await get_redis()
    await r.set(_key(session_id, "status"), status.value)
    await r.expire(_key(session_id, "status"), SESSION_TTL)


async def set_meta_field(session_id: str, field: str, value: Any) -> None:
    r = await get_redis()
    await r.hset(_key(session_id, "meta"), field, value)


async def set_conversation_history(session_id: str, history: List[Dict[str, str]]) -> None:
    r = await get_redis()
    await r.set(_key(session_id, "history"), json.dumps(history))
    await r.expire(_key(session_id, "history"), SESSION_TTL)


async def set_human_reviews(session_id: str, reviews: Dict[str, Any]) -> None:
    r = await get_redis()
    await r.set(_key(session_id, "reviews"), json.dumps(reviews, default=str))
    await r.expire(_key(session_id, "reviews"), SESSION_TTL)


# ============================================================
# Hunt Lock (prevents duplicate hunts for same session)
# ============================================================

HUNT_LOCK_TTL = 600  # 10 minutes max hunt duration

async def acquire_hunt_lock(session_id: str) -> bool:
    """
    Try to acquire a hunt lock for this session.
    Returns True if acquired (no hunt running), False if already locked.
    Uses SET NX (set-if-not-exists) — atomic, no race conditions.
    Lock auto-expires after 10 minutes (safety net for crashes).
    """
    r = await get_redis()
    result = await r.set(
        _key(session_id, "hunt_lock"),
        "locked",
        nx=True,
        ex=HUNT_LOCK_TTL
    )
    return result is not None  # SET NX returns None if key already exists


async def release_hunt_lock(session_id: str) -> None:
    """Release the hunt lock after hunt completes."""
    r = await get_redis()
    await r.delete(_key(session_id, "hunt_lock"))


async def is_hunt_running(session_id: str) -> bool:
    """Check if a hunt is currently running (lock exists)."""
    r = await get_redis()
    return await r.exists(_key(session_id, "hunt_lock")) > 0


# ============================================================
# Atomic Operations (for concurrent hunts)
# ============================================================

async def append_result(session_id: str, result: HuntResult) -> None:
    """Append a hunt result to the current run's results list. Atomic."""
    r = await get_redis()
    await r.rpush(_key(session_id, "results"), result.model_dump_json())
    await r.expire(_key(session_id, "results"), SESSION_TTL)


async def append_all_result(session_id: str, result: HuntResult) -> None:
    """Append a hunt result to the accumulated all_results list. Atomic."""
    r = await get_redis()
    await r.rpush(_key(session_id, "all_results"), result.model_dump_json())
    await r.expire(_key(session_id, "all_results"), SESSION_TTL)


async def clear_results(session_id: str) -> None:
    """Clear the current run's results list (for new hunt run)."""
    r = await get_redis()
    await r.delete(_key(session_id, "results"))


async def incr_completed_hunts(session_id: str) -> int:
    """Atomically increment completed_hunts and return new value."""
    r = await get_redis()
    return await r.hincrby(_key(session_id, "meta"), "completed_hunts", 1)


async def incr_breaks_found(session_id: str) -> int:
    """Atomically increment breaks_found and return new value."""
    r = await get_redis()
    return await r.hincrby(_key(session_id, "meta"), "breaks_found", 1)


async def set_hunt_counters(session_id: str, total_hunts: int,
                            completed_hunts: int = 0, breaks_found: int = 0) -> None:
    """Reset hunt counters for a new run."""
    r = await get_redis()
    await r.hset(_key(session_id, "meta"), mapping={
        "total_hunts": total_hunts,
        "completed_hunts": completed_hunts,
        "breaks_found": breaks_found,
    })


async def set_accumulated_hunt_count(session_id: str, count: int) -> None:
    r = await get_redis()
    await r.hset(_key(session_id, "meta"), "accumulated_hunt_count", count)


# ============================================================
# Turn Management
# ============================================================

async def append_turn(session_id: str, turn: TurnData) -> None:
    """Append a completed turn to the turns list."""
    r = await get_redis()
    await r.rpush(_key(session_id, "turns"), turn.model_dump_json())
    await r.expire(_key(session_id, "turns"), SESSION_TTL)


async def set_current_turn(session_id: str, turn_number: int) -> None:
    r = await get_redis()
    await r.hset(_key(session_id, "meta"), "current_turn", turn_number)


# ============================================================
# Admin / Stats
# ============================================================

async def list_sessions() -> List[str]:
    """List all active session IDs."""
    r = await get_redis()
    # Scan for status keys (one per session)
    session_ids = []
    async for key in r.scan_iter(match=f"{KEY_PREFIX}:*:status"):
        # Extract session_id from "mh:sess:{id}:status"
        parts = key.split(":")
        if len(parts) == 4:
            session_ids.append(parts[2])
    return session_ids


async def get_stats() -> Dict[str, Any]:
    """Get session store statistics."""
    r = await get_redis()
    try:
        await r.ping()
        sessions = await list_sessions()
        info = await r.info("memory")
        return {
            "backend": "redis",
            "status": "connected",
            "active_sessions": len(sessions),
            "used_memory_mb": round(info.get("used_memory", 0) / 1024 / 1024, 1),
        }
    except Exception as e:
        return {"backend": "redis", "status": f"error: {e}", "active_sessions": 0}


async def close():
    """Close all Redis connections."""
    global _redis_client, _redis_blocking_client
    if _redis_client:
        await _redis_client.close()
        _redis_client = None
    if _redis_blocking_client:
        await _redis_blocking_client.close()
        _redis_blocking_client = None
