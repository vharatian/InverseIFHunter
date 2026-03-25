"""
One-time data migration: SQLite + JSON files + trainers.json → PostgreSQL.

Usage:
    cd mth/InverseIFHunter
    python scripts/migrate_to_pg.py

Idempotent: uses INSERT ... ON CONFLICT DO UPDATE (upsert) for trainers/sessions;
hunt_results for each session are replaced (delete + insert) so re-runs do not duplicate rows.
"""
import asyncio
import json
import logging
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text

from database import async_session_factory

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

STORAGE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".storage")
DB_PATH = os.path.join(STORAGE_DIR, "sessions.db")
TRAINERS_PATH = os.path.join(STORAGE_DIR, "trainers.json")


def load_sqlite_sessions() -> list[dict]:
    if not os.path.exists(DB_PATH):
        logger.warning(f"SQLite DB not found at {DB_PATH}")
        return []
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM sessions").fetchall()
    sessions = [dict(row) for row in rows]
    conn.close()
    logger.info(f"Loaded {len(sessions)} sessions from SQLite")
    return sessions


def load_json_sessions() -> dict[str, dict]:
    result = {}
    if not os.path.exists(STORAGE_DIR):
        return result
    for f in os.listdir(STORAGE_DIR):
        if f.endswith(".json") and f != "trainers.json":
            path = os.path.join(STORAGE_DIR, f)
            try:
                with open(path) as fh:
                    data = json.load(fh)
                    sid = f.replace(".json", "")
                    result[sid] = data
            except Exception as e:
                logger.warning(f"Failed to read {path}: {e}")
    logger.info(f"Loaded {len(result)} sessions from JSON files")
    return result


def load_trainers() -> list[dict]:
    if not os.path.exists(TRAINERS_PATH):
        logger.warning(f"Trainers file not found at {TRAINERS_PATH}")
        return []
    with open(TRAINERS_PATH) as f:
        data = json.load(f)
    trainers = data if isinstance(data, list) else list(data.values())
    logger.info(f"Loaded {len(trainers)} trainers")
    return trainers


def _safe_json(val):
    if val is None:
        return None
    if isinstance(val, str):
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return val
    return val


def _jsonb_str(val) -> str | None:
    """Serialize for CAST(:x AS jsonb); None → SQL NULL."""
    if val is None:
        return None
    return json.dumps(val)


def _session_row_from_disk_json(sid: str, j: dict) -> dict:
    """Build a SQLite-shaped row dict from a legacy on-disk JSON session backup."""
    sd = j.get("session_data") or {}
    status = sd.get("status", "pending")
    if hasattr(status, "value"):
        status = status.value
    return {
        "session_id": sid,
        "colab_url": j.get("url") or j.get("colab_url"),
        "notebook_data": sd.get("notebook"),
        "config": sd.get("config"),
        "hunt_results": sd.get("results", []),
        "all_results": sd.get("all_results", []),
        "human_reviews": sd.get("human_reviews", {}),
        "review_status": sd.get("review_status", "draft"),
        "review_feedback": sd.get("review_feedback"),
        "qc_done": sd.get("qc_done", 0),
        "review_round": sd.get("review_round", 0),
        "trainer_email": j.get("trainer_email") or sd.get("trainer_email"),
        "turns": sd.get("turns", []),
        "conversation_history": sd.get("conversation_history", []),
        "total_hunts": sd.get("total_hunts", 0),
        "completed_hunts": sd.get("completed_hunts", 0),
        "breaks_found": sd.get("breaks_found", 0),
        "passes_found": sd.get("passes_found", 0),
        "current_turn": sd.get("current_turn", 1),
        "accumulated_hunt_count": sd.get("accumulated_hunt_count", 0),
        "status": str(status).strip().lower() if status is not None else "pending",
    }


def _merge_passes_from_disk(s: dict, json_sessions: dict[str, dict]) -> None:
    """SQLite schema omits passes_found; pull from disk JSON session_data when present."""
    sid = s.get("session_id")
    if not sid or sid not in json_sessions:
        return
    sd = json_sessions[sid].get("session_data") or {}
    if "passes_found" in sd:
        s["passes_found"] = sd.get("passes_found", 0)


def _session_metadata(s: dict) -> dict:
    return {
        k: v
        for k, v in {
            "review_status": s.get("review_status"),
            "review_feedback": _safe_json(s.get("review_feedback")),
            "qc_done": bool(s.get("qc_done")) if s.get("qc_done") is not None else None,
            "review_round": s.get("review_round"),
            "colab_url": s.get("colab_url"),
        }.items()
        if v is not None
    }


async def migrate():
    logger.info("Starting migration to PostgreSQL...")

    trainers = load_trainers()
    async with async_session_factory() as db:
        for t in trainers:
            email = t.get("email") or t.get("trainer_email")
            if not email:
                continue
            stmt = text("""
                INSERT INTO trainers (email, display_name, team, role)
                VALUES (:email, :name, :team, :role)
                ON CONFLICT (email) DO UPDATE SET
                    display_name = EXCLUDED.display_name,
                    team = EXCLUDED.team,
                    role = EXCLUDED.role,
                    updated_at = now()
            """)
            await db.execute(
                stmt,
                {
                    "email": email,
                    "name": t.get("display_name") or t.get("name"),
                    "team": t.get("team"),
                    "role": t.get("role", "trainer"),
                },
            )
        await db.commit()
        logger.info(f"Processed {len(trainers)} trainer records")

    sqlite_sessions = load_sqlite_sessions()
    json_sessions = load_json_sessions()
    sqlite_ids = {s.get("session_id") for s in sqlite_sessions if s.get("session_id")}

    disk_only_rows: list[dict] = []
    for sid, data in json_sessions.items():
        if sid not in sqlite_ids:
            disk_only_rows.append(_session_row_from_disk_json(sid, data))

    all_session_rows = list(sqlite_sessions)
    for s in sqlite_sessions:
        _merge_passes_from_disk(s, json_sessions)
    all_session_rows.extend(disk_only_rows)
    if disk_only_rows:
        logger.info(f"Added {len(disk_only_rows)} sessions from JSON only (not in SQLite)")

    async with async_session_factory() as db:
        res = await db.execute(text("SELECT id, email FROM trainers"))
        trainer_by_email = {row[1]: row[0] for row in res.fetchall()}

        migrated = 0
        stmt = text("""
            INSERT INTO sessions (
                id, trainer_id, notebook_json, config, status, metadata,
                human_reviews, conversation_history, turns,
                total_hunts, completed_hunts, breaks_found, passes_found,
                accumulated_hunt_count, current_turn
            ) VALUES (
                :id, :trainer_id,
                CAST(:notebook AS jsonb), CAST(:config AS jsonb),
                :status, CAST(:metadata AS jsonb),
                CAST(:reviews AS jsonb), CAST(:history AS jsonb), CAST(:turns AS jsonb),
                :total, :completed, :breaks, :passes, :accumulated, :turn
            )
            ON CONFLICT (id) DO UPDATE SET
                trainer_id = COALESCE(EXCLUDED.trainer_id, sessions.trainer_id),
                notebook_json = EXCLUDED.notebook_json,
                config = EXCLUDED.config,
                status = EXCLUDED.status,
                metadata = EXCLUDED.metadata,
                human_reviews = EXCLUDED.human_reviews,
                conversation_history = EXCLUDED.conversation_history,
                turns = EXCLUDED.turns,
                total_hunts = EXCLUDED.total_hunts,
                completed_hunts = EXCLUDED.completed_hunts,
                breaks_found = EXCLUDED.breaks_found,
                passes_found = EXCLUDED.passes_found,
                accumulated_hunt_count = EXCLUDED.accumulated_hunt_count,
                current_turn = EXCLUDED.current_turn,
                updated_at = now()
        """)
        del_results = text("DELETE FROM hunt_results WHERE session_id = :sid")

        for s in all_session_rows:
            sid = s.get("session_id")
            if not sid:
                continue

            notebook = _safe_json(s.get("notebook_data"))
            config = _safe_json(s.get("config"))
            results = _safe_json(s.get("hunt_results")) or []
            all_results = _safe_json(s.get("all_results")) or []
            human_reviews = _safe_json(s.get("human_reviews")) or {}
            turns = _safe_json(s.get("turns")) or []
            history = _safe_json(s.get("conversation_history")) or []
            meta = _session_metadata(s)
            trainer_email = s.get("trainer_email")
            trainer_id = trainer_by_email.get(trainer_email) if trainer_email else None

            await db.execute(
                stmt,
                {
                    "id": sid,
                    "trainer_id": trainer_id,
                    "notebook": _jsonb_str(notebook),
                    "config": _jsonb_str(config),
                    "status": s.get("status") or "pending",
                    "metadata": _jsonb_str(meta) if meta else "{}",
                    "reviews": _jsonb_str(human_reviews),
                    "history": _jsonb_str(history),
                    "turns": _jsonb_str(turns),
                    "total": s.get("total_hunts") or 0,
                    "completed": s.get("completed_hunts") or 0,
                    "breaks": s.get("breaks_found") or 0,
                    "passes": s.get("passes_found") or 0,
                    "accumulated": s.get("accumulated_hunt_count") or 0,
                    "turn": s.get("current_turn") or 1,
                },
            )

            await db.execute(del_results, {"sid": sid})

            combined = all_results if all_results else results
            for r in combined or []:
                if isinstance(r, str):
                    try:
                        r = json.loads(r)
                    except Exception:
                        continue
                if not isinstance(r, dict):
                    continue
                r_stmt = text("""
                    INSERT INTO hunt_results (session_id, model, provider, prompt, response, scores, judge_criteria, duration_ms)
                    VALUES (:sid, :model, :provider, :prompt, :response, CAST(:scores AS jsonb), CAST(:criteria AS jsonb), :dur)
                """)
                await db.execute(
                    r_stmt,
                    {
                        "sid": sid,
                        "model": r.get("model") or "unknown",
                        "provider": r.get("provider") or "unknown",
                        "prompt": r.get("prompt"),
                        "response": r.get("response"),
                        "scores": _jsonb_str(r.get("scores") or {}) or "{}",
                        "criteria": _jsonb_str(r.get("judge_criteria") or {}) or "{}",
                        "dur": r.get("duration_ms"),
                    },
                )

            migrated += 1

        await db.commit()
        logger.info(f"Migrated {migrated} sessions (SQLite + JSON-only)")

    async with async_session_factory() as db:
        sess_count = (await db.execute(text("SELECT count(*) FROM sessions"))).scalar()
        trainer_count = (await db.execute(text("SELECT count(*) FROM trainers"))).scalar()
        result_count = (await db.execute(text("SELECT count(*) FROM hunt_results"))).scalar()
        logger.info(
            f"Migration complete: {sess_count} sessions, {trainer_count} trainers, {result_count} hunt results"
        )


if __name__ == "__main__":
    asyncio.run(migrate())
