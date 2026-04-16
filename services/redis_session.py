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
import json
import logging
import os
from typing import Any, Dict, Optional, List

from redis_client import get_redis, get_redis_blocking, close_redis
from helpers.notebook_helpers import prompt_preview_from_notebook_json
from services.turn_dedupe import dedupe_turns_to_models
from models.schemas import (
    HuntSession, HuntConfig, HuntResult, HuntStatus,
    ParsedNotebook, TurnData, HuntEvent
)

logger = logging.getLogger(__name__)

# SESSION_TTL: safety-net TTL for active sessions (30 days default). Prevents abandoned sessions
# from living forever in Redis. Refreshed on every access, so active sessions never expire.
# POST_SUBMIT_TTL: shorter TTL applied after session reaches submitted/approved (7 days).
SESSION_TTL = int(os.getenv("SESSION_TTL", str(30 * 86400)))
POST_SUBMIT_TTL = int(os.getenv("POST_SUBMIT_TTL", str(7 * 86400)))
KEY_PREFIX = "mh:sess"
# Reviewer feedback (keep aligned with reviewer-app/services/feedback_store.py)
_FB_PREFIX = "mh:rev_fb"
_FB_HISTORY_PREFIX = "mh:rev_fb_history"


def _key(session_id: str, field: str) -> str:
    """Build a Redis key: mh:sess:{session_id}:{field}"""
    return f"{KEY_PREFIX}:{session_id}:{field}"


REVIEW_STATUS_VALUES = ("draft", "submitted", "returned", "approved", "rejected", "escalated")

def _session_keys(session_id: str) -> List[str]:
    """All Redis keys belonging to a session (for TTL refresh / deletion)."""
    fields = ["config", "notebook", "status", "meta", "results",
              "all_results", "turns", "history", "reviews", "review_status",
              "qc_done", "resubmitted_at", "trainer_ui"]
    return [_key(session_id, f) for f in fields]


def _feedback_keys(session_id: str) -> List[str]:
    """Reviewer feedback keys — same TTL family as session but different key pattern."""
    return [f"{_FB_PREFIX}:{session_id}", f"{_FB_HISTORY_PREFIX}:{session_id}"]


async def _refresh_ttl(r: Any, session_id: str):
    """Refresh TTL on all session keys. Uses SESSION_TTL (30d) for active, POST_SUBMIT_TTL (7d) for submitted."""
    review_status = await r.get(_key(session_id, "review_status"))
    ttl = POST_SUBMIT_TTL if review_status in ("submitted", "approved") else SESSION_TTL
    pipe = r.pipeline()
    for key in _session_keys(session_id):
        pipe.expire(key, ttl)
    for key in _feedback_keys(session_id):
        pipe.expire(key, ttl)
    await pipe.execute()


async def _apply_post_submit_ttl(session_id: str):
    """Set TTL on all session keys after submission/approval."""
    r = await get_redis()
    pipe = r.pipeline()
    for key in _session_keys(session_id):
        pipe.expire(key, POST_SUBMIT_TTL)
    for key in _feedback_keys(session_id):
        pipe.expire(key, POST_SUBMIT_TTL)
    await pipe.execute()


# ============================================================
# Session Lifecycle
# ============================================================

async def create_session(
    session_id: str,
    notebook: ParsedNotebook,
    config: HuntConfig,
    *,
    review_status: str = "draft",
    current_turn: int = 1,
) -> None:
    """Create a new session with all initial keys."""
    from datetime import datetime, timezone
    r = await get_redis()
    pipe = r.pipeline()

    try:
        ct0 = max(1, int(current_turn or 1))
    except (TypeError, ValueError):
        ct0 = 1

    rs = review_status if review_status in REVIEW_STATUS_VALUES else "draft"
    pipe.set(_key(session_id, "config"), config.model_dump_json())
    pipe.set(_key(session_id, "notebook"), notebook.model_dump_json())
    pipe.set(_key(session_id, "status"), HuntStatus.PENDING.value)
    pipe.hset(_key(session_id, "meta"), mapping={
        "total_hunts": 0,
        "completed_hunts": 0,
        "breaks_found": 0,
        "passes_found": 0,
        "accumulated_hunt_count": 0,
        "current_turn": ct0,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    })
    pipe.set(_key(session_id, "history"), "[]")
    pipe.set(_key(session_id, "reviews"), "{}")
    pipe.set(_key(session_id, "review_status"), rs)
    # results, all_results, turns — start as empty lists (created on first RPUSH)

    await pipe.execute()
    await _refresh_ttl(r, session_id)
    logger.info(f"Session {session_id} created in Redis")



async def save_full_session(
    session: HuntSession,
    *,
    sqlite_workflow: Optional[Dict[str, Any]] = None,
    workflow_metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Save a full session object to Redis.
    Used when restoring from disk storage or initializing complex state.

    sqlite_workflow: optional workflow row dict (legacy SQLite-shaped) so review_status, qc_done,
    and reviewer feedback are not lost after create_session resets them.

    workflow_metadata: JSON from PostgreSQL `sessions.metadata` (review_status, active_phase, etc.)
    """
    notebook = session.notebook
    if notebook is None:
        notebook = ParsedNotebook(filename="restored.ipynb")

    rs = "draft"
    if workflow_metadata and isinstance(workflow_metadata.get("review_status"), str):
        rs = workflow_metadata["review_status"]
    if sqlite_workflow and isinstance(sqlite_workflow.get("review_status"), str):
        rs = str(sqlite_workflow["review_status"]).strip().lower() or rs

    await create_session(
        session.session_id,
        notebook,
        session.config,
        review_status=rs,
        current_turn=session.current_turn or 1,
    )

    # Update status
    await set_status(session.session_id, session.status)

    # Update meta counters
    await set_hunt_counters(
        session.session_id,
        total_hunts=session.total_hunts,
        completed_hunts=session.completed_hunts,
        breaks_found=session.breaks_found,
        passes_found=getattr(session, "passes_found", 0),
    )
    await set_accumulated_hunt_count(session.session_id, session.accumulated_hunt_count or 0)

    # Update complex structures
    if session.conversation_history:
        await set_conversation_history(session.session_id, session.conversation_history)

    if session.human_reviews:
        await set_human_reviews(session.session_id, session.human_reviews)

    # Bulk set lists
    await set_results(session.session_id, session.results or [])
    await set_all_results(session.session_id, session.all_results or [])
    await set_turns(session.session_id, dedupe_turns_to_models(session.turns or []))

    if workflow_metadata:
        await apply_workflow_metadata_to_redis(session.session_id, workflow_metadata)
    if sqlite_workflow:
        await apply_sqlite_workflow_snapshot(session.session_id, sqlite_workflow)

    logger.info(f"Full session {session.session_id} restored to Redis")


async def snapshot_workflow_for_pg(session_id: str) -> Dict[str, Any]:
    """Snapshot Redis-only reviewer/trainer workflow keys for merging into PostgreSQL `sessions.metadata`."""
    r = await get_redis()
    if await r.get(_key(session_id, "status")) is None:
        return {}

    out: Dict[str, Any] = {}
    rs = await get_review_status(session_id)
    if rs:
        out["review_status"] = rs

    meta = await get_meta(session_id)
    ap = meta.get("active_phase")
    if isinstance(ap, str) and ap.strip():
        out["active_phase"] = ap.strip()
    try:
        rr = int(meta.get("review_round", 0) or 0)
        out["review_round"] = rr
    except (TypeError, ValueError):
        pass

    if await get_qc_done(session_id):
        out["qc_done"] = True
    else:
        out["qc_done"] = False

    raw_rs = await r.get(_key(session_id, "resubmitted_at"))
    if raw_rs:
        out["resubmitted_at"] = raw_rs.decode("utf-8", errors="replace") if isinstance(raw_rs, (bytes, bytearray)) else str(raw_rs)

    try:
        from agentic_reviewer.versioning import get_acknowledged_at
        rconn = await get_redis()
        ack = await get_acknowledged_at(rconn, session_id)
        if isinstance(ack, str) and ack.strip():
            out["acknowledged_at"] = ack.strip()
    except Exception:
        pass

    fb = await get_review_feedback(session_id)
    if fb:
        out["review_feedback"] = fb

    tu = await get_trainer_ui(session_id)
    if tu:
        out["trainer_ui"] = tu
        if tu.get("selected_row_numbers") is not None:
            out["selected_row_numbers"] = tu["selected_row_numbers"]
        if tu.get("selection_confirmed") is not None:
            out["selection_confirmed"] = tu["selection_confirmed"]

    return out


async def apply_workflow_metadata_to_redis(session_id: str, meta: Dict[str, Any]) -> None:
    """Restore Redis workflow keys from PostgreSQL `sessions.metadata` (or equivalent dict)."""
    if not meta:
        return
    r = await get_redis()
    if await r.get(_key(session_id, "status")) is None:
        return

    rs = meta.get("review_status")
    if isinstance(rs, str) and rs.strip() and rs.strip().lower() in REVIEW_STATUS_VALUES:
        k = _key(session_id, "review_status")
        await r.set(k, rs.strip().lower())
        await r.expire(k, SESSION_TTL)

    ap = meta.get("active_phase")
    if isinstance(ap, str) and ap.strip():
        await set_meta_field(session_id, "active_phase", ap.strip())

    if meta.get("qc_done") is True:
        try:
            await set_qc_done(session_id)
        except ValueError:
            pass
    elif meta.get("qc_done") is False:
        await clear_qc_done(session_id)

    rr = meta.get("review_round")
    if rr is not None:
        try:
            await set_meta_field(session_id, "review_round", int(rr))
        except (TypeError, ValueError):
            pass

    rsa = meta.get("resubmitted_at")
    if isinstance(rsa, str) and rsa.strip():
        k = _key(session_id, "resubmitted_at")
        await r.set(k, rsa.strip())
        await r.expire(k, SESSION_TTL)

    ack = meta.get("acknowledged_at")
    if isinstance(ack, str) and ack.strip():
        await set_meta_field(session_id, "acknowledged_at", ack.strip())

    fb = meta.get("review_feedback")
    if fb and isinstance(fb, (dict, list)):
        fb_key = f"{_FB_PREFIX}:{session_id}"
        await r.set(fb_key, json.dumps(fb, default=str))
        await r.expire(fb_key, SESSION_TTL)

    tu = meta.get("trainer_ui")
    if isinstance(tu, dict) and tu:
        merged = dict(tu)
    else:
        merged = await get_trainer_ui(session_id)

    if meta.get("selected_row_numbers") is not None:
        merged["selected_row_numbers"] = meta["selected_row_numbers"]
    if meta.get("selection_confirmed") is not None:
        merged["selection_confirmed"] = meta["selection_confirmed"]

    if merged:
        await set_trainer_ui(session_id, merged)

    final_rs = await get_review_status(session_id)
    if final_rs in ("submitted", "approved"):
        await _apply_post_submit_ttl(session_id)
    else:
        await _refresh_ttl(r, session_id)


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
    turns = dedupe_turns_to_models(
        [TurnData.model_validate_json(tj) for tj in (turns_jsons or [])]
    )
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
        passes_found=int(meta.get("passes_found", 0)),
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


async def set_trainer_email(session_id: str, email: str) -> None:
    """Store the trainer's email in the session meta hash."""
    if not email:
        return
    r = await get_redis()
    await r.hset(_key(session_id, "meta"), "trainer_email", email.strip().lower())


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
    return dedupe_turns_to_models(
        [TurnData.model_validate_json(item) for item in items]
    )


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
    await _refresh_ttl(r, session_id)


async def set_conversation_history(session_id: str, history: List[Dict[str, str]]) -> None:
    r = await get_redis()
    await r.set(_key(session_id, "history"), json.dumps(history))
    await r.expire(_key(session_id, "history"), SESSION_TTL)


async def set_human_reviews(session_id: str, reviews: Dict[str, Any]) -> None:
    r = await get_redis()
    await r.set(_key(session_id, "reviews"), json.dumps(reviews, default=str))
    await r.expire(_key(session_id, "reviews"), SESSION_TTL)


async def set_trainer_ui(session_id: str, data: Dict[str, Any]) -> None:
    """Persist trainer-only UI state (LLM reveal flag, alignment gate). Not sent to reviewers as reviews."""
    r = await get_redis()
    await r.set(_key(session_id, "trainer_ui"), json.dumps(data, default=str))
    await r.expire(_key(session_id, "trainer_ui"), SESSION_TTL)


async def get_trainer_ui(session_id: str) -> Dict[str, Any]:
    r = await get_redis()
    raw = await r.get(_key(session_id, "trainer_ui"))
    if not raw:
        return {}
    try:
        out = json.loads(raw)
        return out if isinstance(out, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


# ============================================================
# Review status (trainer/reviewer sync)
# ============================================================

async def get_review_status(session_id: str) -> str:
    """Return review_status: draft | submitted | returned | approved. Default draft."""
    r = await get_redis()
    val = await r.get(_key(session_id, "review_status"))
    if val in REVIEW_STATUS_VALUES:
        return val
    return "draft"


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
        if new_status in ("submitted", "approved"):
            await _apply_post_submit_ttl(session_id)
        return True, new_status
    return False, str(result)


async def get_qc_done(session_id: str) -> bool:
    """Return True if trainer has completed Quality Check for this session."""
    r = await get_redis()
    val = await r.get(_key(session_id, "qc_done"))
    return val == "1"


async def set_qc_done(session_id: str) -> None:
    """Mark Quality Check as completed. Session must exist."""
    r = await get_redis()
    if await r.get(_key(session_id, "status")) is None:
        raise ValueError(f"Session {session_id} not found")
    await r.set(_key(session_id, "qc_done"), "1")
    await r.expire(_key(session_id, "qc_done"), SESSION_TTL)


async def clear_qc_done(session_id: str) -> None:
    """Reset QC flag so trainer must re-run Quality Check (e.g. after review edits or reviewer return)."""
    r = await get_redis()
    await r.delete(_key(session_id, "qc_done"))


async def apply_sqlite_workflow_snapshot(session_id: str, db_row: Dict[str, Any]) -> None:
    """Restore trainer/reviewer workflow Redis keys from a SQLite session row after save_full_session."""
    r = await get_redis()
    sid = session_id

    rs_raw = db_row.get("review_status")
    rs = str(rs_raw).strip().lower() if rs_raw is not None and rs_raw != "" else ""
    if rs in REVIEW_STATUS_VALUES:
        k = _key(sid, "review_status")
        await r.set(k, rs)
        await r.expire(k, SESSION_TTL)

    if db_row.get("qc_done"):
        kq = _key(sid, "qc_done")
        await r.set(kq, "1")
        await r.expire(kq, SESSION_TTL)
    else:
        await clear_qc_done(sid)

    rr = db_row.get("review_round")
    if rr is not None:
        try:
            await set_meta_field(sid, "review_round", int(rr))
        except (TypeError, ValueError):
            pass

    fb = db_row.get("review_feedback")
    if fb:
        payload: Any = fb
        if isinstance(fb, str):
            try:
                payload = json.loads(fb)
            except (json.JSONDecodeError, TypeError):
                payload = None
        if payload:
            fb_key = f"{_FB_PREFIX}:{sid}"
            await r.set(fb_key, json.dumps(payload, default=str))
            await r.expire(fb_key, SESSION_TTL)

    email = db_row.get("trainer_email")
    if email and isinstance(email, str) and email.strip():
        await set_trainer_email(sid, email.strip())

    await r.expire(_key(sid, "meta"), SESSION_TTL)


async def get_review_feedback(session_id: str) -> Optional[Dict[str, Any]]:
    """Read reviewer feedback from mh:rev_fb:{session_id}. Returns None if missing or invalid."""
    r = await get_redis()
    raw = await r.get(f"{_FB_PREFIX}:{session_id}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def archive_and_clear_feedback(session_id: str) -> None:
    """Move current feedback to history list and clear active feedback (called on resubmit)."""
    r = await get_redis()
    fb_key = f"{_FB_PREFIX}:{session_id}"
    history_key = f"{_FB_HISTORY_PREFIX}:{session_id}"
    current_raw = await r.get(fb_key)
    if current_raw:
        await r.lpush(history_key, current_raw)
        await r.ltrim(history_key, 0, 9)
        await r.expire(history_key, SESSION_TTL)
        await r.delete(fb_key)


async def set_resubmitted_at(session_id: str) -> None:
    """Store resubmit timestamp so reviewer sees 'Revised since last review'."""
    from datetime import datetime, timezone
    r = await get_redis()
    ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    await r.set(_key(session_id, "resubmitted_at"), ts)
    await r.expire(_key(session_id, "resubmitted_at"), SESSION_TTL)


async def incr_review_round(session_id: str) -> int:
    """Atomically increment review_round and return new value. Starts at 1."""
    r = await get_redis()
    return await r.hincrby(_key(session_id, "meta"), "review_round", 1)


async def get_review_round(session_id: str) -> int:
    """Return current review round (0 if not yet submitted)."""
    r = await get_redis()
    val = await r.hget(_key(session_id, "meta"), "review_round")
    return int(val) if val and str(val).isdigit() else 0


def get_max_review_rounds() -> int:
    """Return max review rounds from env or default 5."""
    import os
    return int(os.getenv("MAX_REVIEW_ROUNDS", "5"))


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


async def clear_all_results(session_id: str) -> None:
    """Clear the accumulated all_results list."""
    r = await get_redis()
    await r.delete(_key(session_id, "all_results"))


async def set_results(session_id: str, results: List[HuntResult]) -> None:
    """Replace the current run's results list (e.g. when restoring session from storage)."""
    r = await get_redis()
    key = _key(session_id, "results")
    await r.delete(key)
    if results:
        await r.rpush(key, *[res.model_dump_json() for res in results])
    await r.expire(key, SESSION_TTL)


async def set_all_results(session_id: str, results: List[HuntResult]) -> None:
    """Replace the accumulated all_results list (e.g. when restoring session from storage)."""
    r = await get_redis()
    key = _key(session_id, "all_results")
    await r.delete(key)
    if results:
        await r.rpush(key, *[res.model_dump_json() for res in results])
    await r.expire(key, SESSION_TTL)


async def incr_completed_hunts(session_id: str) -> int:
    """Atomically increment completed_hunts and return new value."""
    r = await get_redis()
    return await r.hincrby(_key(session_id, "meta"), "completed_hunts", 1)


async def incr_breaks_found(session_id: str) -> int:
    """Atomically increment breaks_found and return new value."""
    r = await get_redis()
    return await r.hincrby(_key(session_id, "meta"), "breaks_found", 1)


async def incr_passes_found(session_id: str) -> int:
    """Atomically increment passes_found and return new value."""
    r = await get_redis()
    return await r.hincrby(_key(session_id, "meta"), "passes_found", 1)


async def set_hunt_counters(session_id: str, total_hunts: int,
                            completed_hunts: int = 0, breaks_found: int = 0,
                            passes_found: int = 0) -> None:
    """Reset hunt counters for a new run."""
    r = await get_redis()
    await r.hset(_key(session_id, "meta"), mapping={
        "total_hunts": total_hunts,
        "completed_hunts": completed_hunts,
        "breaks_found": breaks_found,
        "passes_found": passes_found,
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


async def set_turns(session_id: str, turns: List[TurnData]) -> None:
    """Replace the turns list (e.g. when restoring session from storage)."""
    r = await get_redis()
    key = _key(session_id, "turns")
    await r.delete(key)
    if turns:
        await r.rpush(key, *[t.model_dump_json() for t in turns])
    await r.expire(key, SESSION_TTL)


async def set_current_turn(session_id: str, turn_number: int) -> None:
    r = await get_redis()
    await r.hset(_key(session_id, "meta"), "current_turn", turn_number)


# ============================================================
# Admin / Stats
# ============================================================

async def delete_all_session_keys(session_id: str) -> int:
    """Delete all Redis keys for a session (session data, feedback, events, locks)."""
    r = await get_redis()
    keys_to_delete = _session_keys(session_id) + _feedback_keys(session_id)
    keys_to_delete.append(f"mh:events:{session_id}")
    keys_to_delete.append(f"mh:lock:advance:{session_id}")
    keys_to_delete.append(f"mh:rev_audit:{session_id}")
    keys_to_delete.append(f"mh:hunt_active:{session_id}")
    deleted = 0
    for key in keys_to_delete:
        deleted += await r.delete(key)
    return deleted


async def list_sessions() -> List[str]:
    """List all active session IDs.
    Uses a set to deduplicate because Redis SCAN may return duplicates."""
    r = await get_redis()
    seen: set[str] = set()
    session_ids = []
    async for key in r.scan_iter(match=f"{KEY_PREFIX}:*:status"):
        parts = key.split(":")
        if len(parts) == 4:
            sid = parts[2]
            if sid not in seen:
                seen.add(sid)
                session_ids.append(sid)
    return session_ids


async def find_sessions_by_task_id(task_id: str) -> List[Dict[str, Any]]:
    """Find active sessions whose notebook metadata contains the given task_id.
    Returns list of {session_id, review_status, hunt_status} for matches."""
    if not task_id or not task_id.strip():
        return []
    target = task_id.strip()
    all_ids = await list_sessions()
    if not all_ids:
        return []
    r = await get_redis()
    pipe = r.pipeline()
    for sid in all_ids:
        pipe.get(_key(sid, "notebook"))
        pipe.get(_key(sid, "review_status"))
        pipe.get(_key(sid, "status"))
    raw = await pipe.execute()
    matches = []
    for i, sid in enumerate(all_ids):
        nb_json = raw[i * 3]
        existing_tid = _extract_task_display_id(nb_json)
        if existing_tid == target:
            nb_json = nb_json.decode("utf-8", errors="replace") if isinstance(nb_json, (bytes, bytearray)) else nb_json
            matches.append({
                "session_id": sid,
                "review_status": raw[i * 3 + 1] or "draft",
                "hunt_status": raw[i * 3 + 2] or "pending",
                "prompt_preview": prompt_preview_from_notebook_json(nb_json),
            })
    return matches


def _get_task_id_fields() -> list:
    """Return task identity field names (env-configurable)."""
    import os
    primary = os.getenv("TASK_ID_FIELD", "Task ID")
    return [primary, "TaskID", "task_id"]


def _extract_task_display_id(notebook_json: str | None) -> str:
    """Extract the human-readable task ID from notebook metadata JSON using configured fields."""
    if not notebook_json:
        return ""
    try:
        notebook = json.loads(notebook_json)
    except (json.JSONDecodeError, TypeError):
        return ""
    meta = notebook.get("metadata") if isinstance(notebook, dict) else None
    if not isinstance(meta, dict):
        return ""
    for key in _get_task_id_fields():
        val = meta.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def count_submitted_reviews(human_reviews: dict) -> int:
    """
    Count completed reviews from a parsed human_reviews dict.
    Prefers row_N keys (canonical submitted reviews with grading_basis).
    Falls back to counting any key with judgment/submitted to handle legacy data.
    """
    if not isinstance(human_reviews, dict):
        return 0
    row_count = 0
    other_count = 0
    row_hunt_ids: set[str] = set()
    for key, val in human_reviews.items():
        if not isinstance(val, dict):
            continue
        has_review = (
            val.get("judgment") is not None
            or bool(val.get("grading_basis"))
            or val.get("submitted")
        )
        if str(key).startswith("row_") and has_review:
            row_count += 1
            if val.get("hunt_id"):
                row_hunt_ids.add(str(val["hunt_id"]))
        elif has_review and str(key) not in row_hunt_ids:
            other_count += 1
    return row_count if row_count > 0 else other_count


def _count_reviews_from_json(reviews_json: str | None) -> int:
    """Count completed human reviews from raw JSON string."""
    if not reviews_json:
        return 0
    try:
        reviews = json.loads(reviews_json)
    except (json.JSONDecodeError, TypeError):
        return 0
    return count_submitted_reviews(reviews)


def _extract_prompt_preview(notebook_json: str | None, max_len: int = 120) -> str:
    """Extract a short prompt preview from notebook JSON."""
    if not notebook_json:
        return ""
    try:
        nb = json.loads(notebook_json)
    except (json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(nb, dict):
        return ""
    prompt = nb.get("prompt", "")
    if isinstance(prompt, str) and prompt.strip():
        text = prompt.strip().replace("\n", " ")
        return text[:max_len] + ("…" if len(text) > max_len else "")
    return ""


def _get_production_start() -> Optional[str]:
    """Return queue production start timestamp from env or None."""
    import os
    return os.getenv("QUEUE_PRODUCTION_START") or None


async def list_all_sessions_summary() -> List[Dict[str, Any]]:
    """List all sessions with summary data for the trainer queue. Single pipeline, no N+1.
    Respects queue.production_start — old/test sessions without created_at are hidden."""
    all_ids = await list_sessions()
    if not all_ids:
        return []

    production_start = _get_production_start()

    r = await get_redis()
    pipe = r.pipeline()
    for sid in all_ids:
        pipe.get(_key(sid, "review_status"))
        pipe.get(_key(sid, "status"))
        pipe.hgetall(_key(sid, "meta"))
        pipe.get(_key(sid, "notebook"))
        pipe.get(_key(sid, "reviews"))
        pipe.get(_key(sid, "qc_done"))
        pipe.get(f"{_FB_PREFIX}:{sid}")
    raw = await pipe.execute()

    FIELDS_PER_SESSION = 7
    sessions = []
    for i, sid in enumerate(all_ids):
        base = i * FIELDS_PER_SESSION
        review_status_val = raw[base]
        status_val = raw[base + 1]
        meta = raw[base + 2] or {}
        notebook_raw = raw[base + 3]
        reviews_raw = raw[base + 4]
        qc_done_val = raw[base + 5]
        feedback_raw = raw[base + 6]

        # Filter old/test sessions when production_start is configured
        if production_start:
            created_at = meta.get("created_at", "")
            if not created_at or created_at < production_start:
                continue

        review_status = review_status_val if review_status_val in REVIEW_STATUS_VALUES else "draft"
        feedback = None
        if feedback_raw:
            try:
                feedback = json.loads(feedback_raw)
            except (json.JSONDecodeError, TypeError):
                pass

        sessions.append({
            "session_id": sid,
            "task_display_id": _extract_task_display_id(notebook_raw),
            "review_status": review_status,
            "hunt_status": status_val or "pending",
            "total_hunts": int(meta.get("total_hunts", 0)),
            "completed_hunts": int(meta.get("completed_hunts", 0)),
            "breaks_found": int(meta.get("breaks_found", 0)),
            "current_turn": int(meta.get("current_turn", 1)),
            "review_count": _count_reviews_from_json(reviews_raw),
            "qc_done": qc_done_val == "1",
            "prompt_preview": _extract_prompt_preview(notebook_raw),
            "review_feedback": feedback,
            "trainer_email": meta.get("trainer_email", ""),
        })
    return sessions


async def list_sessions_by_review_status(target_status: str) -> List[Dict[str, Any]]:
    """List sessions with a specific review_status. Returns list of {session_id, task_display_id, review_status, review_feedback}."""
    all_ids = await list_sessions()
    if not all_ids:
        return []
    r = await get_redis()
    pipe = r.pipeline()
    for sid in all_ids:
        pipe.get(_key(sid, "review_status"))
    statuses = await pipe.execute()

    matched = []
    for sid, val in zip(all_ids, statuses):
        status = val if val in REVIEW_STATUS_VALUES else "draft"
        if status == target_status:
            matched.append(sid)

    results = []
    for sid in matched:
        pipe2 = r.pipeline()
        pipe2.get(f"{_FB_PREFIX}:{sid}")
        pipe2.get(_key(sid, "notebook"))
        feedback_raw, notebook_raw = await pipe2.execute()
        feedback = None
        if feedback_raw:
            try:
                feedback = json.loads(feedback_raw)
            except json.JSONDecodeError:
                pass
        task_display_id = _extract_task_display_id(notebook_raw)
        results.append({
            "session_id": sid,
            "task_display_id": task_display_id,
            "review_status": target_status,
            "review_feedback": feedback,
        })
    return results


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


_AUDIT_KEY = "mh:rev_audit"
_AUDIT_MAX = 500
_AUDIT_TTL = 30 * 86400


async def append_audit(session_id: str, action: str, actor: str = "trainer", details: dict | None = None) -> None:
    """Append audit entry for trainer-side actions (submit, resubmit, qc_mark)."""
    from datetime import datetime, timezone
    entry = json.dumps({
        "session_id": session_id,
        "action": action,
        "reviewer_id": actor,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        **({"details": details} if details else {}),
    }, default=str)
    r = await get_redis()
    pipe = r.pipeline()
    pipe.lpush(_AUDIT_KEY, entry)
    pipe.ltrim(_AUDIT_KEY, 0, _AUDIT_MAX - 1)
    pipe.expire(_AUDIT_KEY, _AUDIT_TTL)
    sess_key = f"mh:rev_audit:{session_id}"
    pipe.lpush(sess_key, entry)
    pipe.ltrim(sess_key, 0, 49)
    pipe.expire(sess_key, SESSION_TTL)
    await pipe.execute()


async def get_full_session_state(session_id: str) -> Optional[Dict[str, Any]]:
    """Return all session data needed for full UI hydration in a single pipeline.
    Returns None if session doesn't exist."""
    r = await get_redis()
    status_val = await r.get(_key(session_id, "status"))
    if status_val is None:
        return None

    pipe = r.pipeline()
    pipe.get(_key(session_id, "config"))
    pipe.get(_key(session_id, "notebook"))
    pipe.hgetall(_key(session_id, "meta"))
    pipe.lrange(_key(session_id, "results"), 0, -1)
    pipe.lrange(_key(session_id, "all_results"), 0, -1)
    pipe.lrange(_key(session_id, "turns"), 0, -1)
    pipe.get(_key(session_id, "history"))
    pipe.get(_key(session_id, "reviews"))
    pipe.get(_key(session_id, "review_status"))
    pipe.get(_key(session_id, "qc_done"))
    pipe.get(_key(session_id, "resubmitted_at"))
    pipe.get(_key(session_id, "trainer_ui"))
    pipe.get(f"{_FB_PREFIX}:{session_id}")
    pipe.lrange(f"{_FB_HISTORY_PREFIX}:{session_id}", 0, -1)

    (config_json, notebook_json, meta, results_jsons, all_results_jsons,
     turns_jsons, history_json, reviews_json, review_status_val,
     qc_done_val, resubmitted_at_val, trainer_ui_json, feedback_json,
     feedback_history_jsons) = await pipe.execute()

    config = {}
    if config_json:
        try:
            config = json.loads(config_json)
        except (json.JSONDecodeError, TypeError):
            pass

    notebook = {}
    if notebook_json:
        try:
            notebook = json.loads(notebook_json)
        except (json.JSONDecodeError, TypeError):
            pass

    meta = meta or {}

    all_results = []
    for item in (all_results_jsons or []):
        try:
            all_results.append(json.loads(item))
        except (json.JSONDecodeError, TypeError):
            pass

    results = []
    for item in (results_jsons or []):
        try:
            results.append(json.loads(item))
        except (json.JSONDecodeError, TypeError):
            pass

    turns_raw: list[dict] = []
    for item in (turns_jsons or []):
        try:
            turns_raw.append(json.loads(item))
        except (json.JSONDecodeError, TypeError):
            pass
    turns = [t.model_dump() for t in dedupe_turns_to_models(turns_raw)]

    conversation_history = []
    if history_json:
        try:
            conversation_history = json.loads(history_json)
        except (json.JSONDecodeError, TypeError):
            pass

    reviews = {}
    if reviews_json:
        try:
            reviews = json.loads(reviews_json)
        except (json.JSONDecodeError, TypeError):
            pass

    trainer_ui = {}
    if trainer_ui_json:
        try:
            trainer_ui = json.loads(trainer_ui_json)
            if not isinstance(trainer_ui, dict):
                trainer_ui = {}
        except (json.JSONDecodeError, TypeError):
            trainer_ui = {}

    feedback = None
    if feedback_json:
        try:
            feedback = json.loads(feedback_json)
        except (json.JSONDecodeError, TypeError):
            pass

    feedback_history = []
    for item in (feedback_history_jsons or []):
        try:
            feedback_history.append(json.loads(item))
        except (json.JSONDecodeError, TypeError):
            pass

    review_status = review_status_val if review_status_val in REVIEW_STATUS_VALUES else "draft"
    review_round = int(meta.get("review_round", 0))

    await _refresh_ttl(r, session_id)

    return {
        "session_id": session_id,
        "hunt_status": status_val,
        "config": config,
        "notebook": notebook,
        "meta": {
            "total_hunts": int(meta.get("total_hunts", 0)),
            "completed_hunts": int(meta.get("completed_hunts", 0)),
            "breaks_found": int(meta.get("breaks_found", 0)),
            "passes_found": int(meta.get("passes_found", 0)),
            "accumulated_hunt_count": int(meta.get("accumulated_hunt_count", 0)),
            "current_turn": int(meta.get("current_turn", 1)),
            "trainer_email": meta.get("trainer_email", ""),
            "created_at": meta.get("created_at", ""),
            "version": int(meta.get("version", 0)),
            "acknowledged_at": meta.get("acknowledged_at", ""),
            "active_phase": meta.get("active_phase", ""),
        },
        "results": results,
        "all_results": all_results,
        "turns": turns,
        "conversation_history": conversation_history,
        "human_reviews": reviews,
        "trainer_ui": trainer_ui,
        "review_status": review_status,
        "qc_done": qc_done_val == "1",
        "resubmitted_at": resubmitted_at_val,
        "review_round": review_round,
        "max_rounds": get_max_review_rounds(),
        "feedback": feedback,
        "feedback_history": feedback_history,
    }


async def close():
    """Close all Redis connections (delegates to shared redis_client module)."""
    await close_redis()
