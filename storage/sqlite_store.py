"""
SQLite Persistence Layer — permanent source of truth for session data.

Redis remains the fast cache for active sessions. SQLite is the durable backup
that survives Redis restarts, TTL expiry, and server reboots.

Write-through: every save goes to both Redis and SQLite.
Read fallback: if Redis misses, load from SQLite and restore to Redis.

Schema is intentionally flat — one row per session with JSON columns for
complex data. This avoids ORM complexity while giving full query capability.
"""
import json
import sqlite3
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

_DB_DIR = os.path.join(os.getcwd(), ".storage")
os.makedirs(_DB_DIR, exist_ok=True)
_DB_PATH = os.path.join(_DB_DIR, "sessions.db")

_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    """Get thread-local SQLite connection (SQLite connections aren't thread-safe)."""
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(_DB_PATH, timeout=10)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA busy_timeout=5000")
    return _local.conn


def init_db():
    """Create tables if they don't exist. Safe to call multiple times."""
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id      TEXT PRIMARY KEY,
            colab_url       TEXT,
            notebook_data   TEXT,
            config          TEXT,
            hunt_results    TEXT DEFAULT '[]',
            all_results     TEXT DEFAULT '[]',
            human_reviews   TEXT DEFAULT '{}',
            review_status   TEXT DEFAULT 'draft',
            review_feedback TEXT,
            qc_done         INTEGER DEFAULT 0,
            review_round    INTEGER DEFAULT 0,
            trainer_email   TEXT,
            turns           TEXT DEFAULT '[]',
            conversation_history TEXT DEFAULT '[]',
            total_hunts     INTEGER DEFAULT 0,
            completed_hunts INTEGER DEFAULT 0,
            breaks_found    INTEGER DEFAULT 0,
            current_turn    INTEGER DEFAULT 1,
            accumulated_hunt_count INTEGER DEFAULT 0,
            status          TEXT DEFAULT 'pending',
            created_at      TEXT,
            updated_at      TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_review_status ON sessions(review_status);
        CREATE INDEX IF NOT EXISTS idx_sessions_trainer ON sessions(trainer_email);
        CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

        CREATE TABLE IF NOT EXISTS hunt_events (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      TEXT NOT NULL,
            ts              TEXT NOT NULL,
            event_type      TEXT NOT NULL,
            payload_json    TEXT DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_hunt_events_session ON hunt_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_hunt_events_ts ON hunt_events(session_id, ts);
    """)
    conn.commit()
    logger.info(f"SQLite database initialized at {_DB_PATH}")


init_db()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_dumps(obj: Any) -> str:
    if obj is None:
        return "{}"
    if isinstance(obj, str):
        return obj
    return json.dumps(obj, default=str)


def _json_loads(raw: Optional[str], default=None):
    if not raw:
        return default if default is not None else {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default if default is not None else {}


def save_session(session_id: str, data: Dict[str, Any]) -> None:
    """Upsert a full session to SQLite. Called on every significant state change."""
    conn = _get_conn()
    now = _now_iso()
    try:
        conn.execute("""
            INSERT INTO sessions (
                session_id, colab_url, notebook_data, config,
                hunt_results, all_results, human_reviews,
                review_status, review_feedback, qc_done, review_round,
                trainer_email, turns, conversation_history,
                total_hunts, completed_hunts, breaks_found,
                current_turn, accumulated_hunt_count, status,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?
            )
            ON CONFLICT(session_id) DO UPDATE SET
                colab_url = COALESCE(excluded.colab_url, colab_url),
                notebook_data = COALESCE(excluded.notebook_data, notebook_data),
                config = COALESCE(excluded.config, config),
                hunt_results = excluded.hunt_results,
                all_results = excluded.all_results,
                human_reviews = excluded.human_reviews,
                review_status = excluded.review_status,
                review_feedback = COALESCE(excluded.review_feedback, review_feedback),
                qc_done = excluded.qc_done,
                review_round = excluded.review_round,
                trainer_email = COALESCE(excluded.trainer_email, trainer_email),
                turns = excluded.turns,
                conversation_history = excluded.conversation_history,
                total_hunts = excluded.total_hunts,
                completed_hunts = excluded.completed_hunts,
                breaks_found = excluded.breaks_found,
                current_turn = excluded.current_turn,
                accumulated_hunt_count = excluded.accumulated_hunt_count,
                status = excluded.status,
                updated_at = excluded.updated_at
        """, (
            session_id,
            data.get("colab_url") or data.get("url"),
            _json_dumps(data.get("notebook_data") or data.get("notebook")),
            _json_dumps(data.get("config")),
            _json_dumps(data.get("hunt_results") or data.get("results", [])),
            _json_dumps(data.get("all_results", [])),
            _json_dumps(data.get("human_reviews", {})),
            data.get("review_status", "draft"),
            _json_dumps(data.get("review_feedback")),
            1 if data.get("qc_done") else 0,
            data.get("review_round", 0),
            data.get("trainer_email"),
            _json_dumps(data.get("turns", [])),
            _json_dumps(data.get("conversation_history", [])),
            data.get("total_hunts", 0),
            data.get("completed_hunts", 0),
            data.get("breaks_found", 0),
            data.get("current_turn", 1),
            data.get("accumulated_hunt_count", 0),
            data.get("status", "pending"),
            data.get("created_at", now),
            now,
        ))
        conn.commit()
    except Exception:
        logger.exception(f"Failed to save session {session_id} to SQLite")


def load_session(session_id: str) -> Optional[Dict[str, Any]]:
    """Load a session from SQLite. Returns None if not found."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if not row:
            return None
        return {
            "session_id": row["session_id"],
            "colab_url": row["colab_url"],
            "notebook": _json_loads(row["notebook_data"]),
            "config": _json_loads(row["config"]),
            "results": _json_loads(row["hunt_results"], []),
            "all_results": _json_loads(row["all_results"], []),
            "human_reviews": _json_loads(row["human_reviews"], {}),
            "review_status": row["review_status"] or "draft",
            "review_feedback": _json_loads(row["review_feedback"]),
            "qc_done": bool(row["qc_done"]),
            "review_round": row["review_round"] or 0,
            "trainer_email": row["trainer_email"],
            "turns": _json_loads(row["turns"], []),
            "conversation_history": _json_loads(row["conversation_history"], []),
            "total_hunts": row["total_hunts"] or 0,
            "completed_hunts": row["completed_hunts"] or 0,
            "breaks_found": row["breaks_found"] or 0,
            "current_turn": row["current_turn"] or 1,
            "accumulated_hunt_count": row["accumulated_hunt_count"] or 0,
            "status": row["status"] or "pending",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
    except Exception:
        logger.exception(f"Failed to load session {session_id} from SQLite")
        return None


def update_field(session_id: str, field: str, value: Any) -> None:
    """Update a single field for a session. Use for incremental updates."""
    allowed_fields = {
        "human_reviews", "review_status", "review_feedback", "qc_done",
        "review_round", "hunt_results", "all_results", "status",
        "total_hunts", "completed_hunts", "breaks_found", "config",
        "turns", "conversation_history", "current_turn", "trainer_email",
        "accumulated_hunt_count", "colab_url", "notebook_data",
    }
    if field not in allowed_fields:
        logger.warning(f"Attempted to update disallowed field: {field}")
        return
    conn = _get_conn()
    now = _now_iso()
    db_value = value
    if isinstance(value, (dict, list)):
        db_value = _json_dumps(value)
    elif field == "qc_done":
        db_value = 1 if value else 0
    try:
        conn.execute(
            f"UPDATE sessions SET {field} = ?, updated_at = ? WHERE session_id = ?",
            (db_value, now, session_id),
        )
        conn.commit()
    except Exception:
        logger.exception(f"Failed to update {field} for session {session_id}")


def delete_session(session_id: str) -> None:
    """Delete a session from SQLite."""
    conn = _get_conn()
    try:
        conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        conn.commit()
    except Exception:
        logger.exception(f"Failed to delete session {session_id} from SQLite")


def append_event(session_id: str, event_type: str, payload: Dict[str, Any]) -> None:
    """Append a hunt event (e.g. SSE event) to SQLite for audit/replay. Call after every SSE publish."""
    conn = _get_conn()
    now = _now_iso()
    try:
        conn.execute(
            "INSERT INTO hunt_events (session_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?)",
            (session_id, now, event_type, _json_dumps(payload)),
        )
        conn.commit()
    except Exception:
        logger.exception(f"Failed to append_event for session {session_id}")


def list_sessions(review_status: Optional[str] = None, limit: int = 100) -> list:
    """List sessions, optionally filtered by review_status."""
    conn = _get_conn()
    try:
        if review_status:
            rows = conn.execute(
                "SELECT session_id, review_status, trainer_email, status, created_at, updated_at "
                "FROM sessions WHERE review_status = ? ORDER BY updated_at DESC LIMIT ?",
                (review_status, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT session_id, review_status, trainer_email, status, created_at, updated_at "
                "FROM sessions ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]
    except Exception:
        logger.exception("Failed to list sessions from SQLite")
        return []
