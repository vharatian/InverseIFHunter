"""Data management routes — session cleanup, wipe test data."""
import os
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from auth import verify_super_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/data", tags=["admin-data"])

DATABASE_URL = os.getenv("DATABASE_URL", "")


def _get_sync_url():
    """Convert async PG URL to sync for direct queries."""
    return DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")


@router.delete("/session/{session_id}")
async def delete_session(session_id: str, _=Depends(verify_super_admin)):
    """Delete a session from PostgreSQL (and associated hunt_results)."""
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")

    conn = await _get_conn()
    try:
        await _ensure_tables(conn)
        results_deleted = await conn.execute("DELETE FROM hunt_results WHERE session_id = $1", session_id)
        session_deleted = await conn.execute("DELETE FROM sessions WHERE id = $1", session_id)
        logger.info(f"Admin deleted session {session_id}: {session_deleted}, results: {results_deleted}")
        return {
            "deleted": True,
            "session_id": session_id,
            "session_rows": session_deleted,
            "result_rows": results_deleted,
        }
    finally:
        await conn.close()


class WipeRequest(BaseModel):
    confirm: str
    older_than_days: Optional[int] = None


@router.post("/wipe-sessions")
async def wipe_sessions(body: WipeRequest, _=Depends(verify_super_admin)):
    """Delete all non-submitted sessions from PostgreSQL. Requires confirm='yes'."""
    if body.confirm != "yes":
        raise HTTPException(400, "Set confirm='yes' to proceed")
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured")

    conn = await _get_conn()
    try:
        await _ensure_tables(conn)
        where = "WHERE status NOT IN ('submitted', 'approved')"
        if body.older_than_days:
            where += f" AND updated_at < NOW() - INTERVAL '{int(body.older_than_days)} days'"

        result_rows = await conn.execute(
            f"DELETE FROM hunt_results WHERE session_id IN (SELECT id FROM sessions {where})"
        )
        session_rows = await conn.execute(f"DELETE FROM sessions {where}")
        logger.info(f"Admin wiped sessions: {session_rows}, results: {result_rows}")
        return {"wiped": True, "sessions": session_rows, "results": result_rows}
    finally:
        await conn.close()


async def _get_conn():
    import asyncpg
    dsn = DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    return await asyncpg.connect(dsn)


async def _ensure_tables(conn):
    """Create sessions and hunt_results tables if they don't exist."""
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            notebook_json JSONB,
            config JSONB,
            status TEXT DEFAULT 'pending',
            human_reviews JSONB DEFAULT '{}'::jsonb,
            conversation_history JSONB DEFAULT '[]'::jsonb,
            turns JSONB DEFAULT '[]'::jsonb,
            total_hunts INTEGER DEFAULT 0,
            completed_hunts INTEGER DEFAULT 0,
            breaks_found INTEGER DEFAULT 0,
            passes_found INTEGER DEFAULT 0,
            accumulated_hunt_count INTEGER DEFAULT 0,
            current_turn INTEGER DEFAULT 1,
            metadata JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS hunt_results (
            id SERIAL PRIMARY KEY,
            session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
            hunt_id INTEGER,
            model TEXT,
            provider TEXT,
            status TEXT,
            prompt TEXT,
            response TEXT,
            reasoning_trace TEXT,
            judge_score FLOAT,
            judge_output TEXT,
            judge_explanation TEXT,
            judge_criteria JSONB DEFAULT '{}'::jsonb,
            scores JSONB DEFAULT '{}'::jsonb,
            error TEXT,
            is_breaking BOOLEAN DEFAULT FALSE,
            sample_label TEXT,
            duration_ms INTEGER,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)


@router.get("/stats")
async def data_stats(_=Depends(verify_super_admin)):
    """Quick counts for the data management panel."""
    if not DATABASE_URL:
        return {"total_sessions": 0, "total_results": 0}

    conn = await _get_conn()
    try:
        await _ensure_tables(conn)
        total = await conn.fetchval("SELECT COUNT(*) FROM sessions")
        submitted = await conn.fetchval("SELECT COUNT(*) FROM sessions WHERE status IN ('submitted', 'approved')")
        draft = await conn.fetchval("SELECT COUNT(*) FROM sessions WHERE status NOT IN ('submitted', 'approved')")
        results = await conn.fetchval("SELECT COUNT(*) FROM hunt_results")
        return {
            "total_sessions": total,
            "submitted_sessions": submitted,
            "draft_sessions": draft,
            "total_hunt_results": results,
        }
    finally:
        await conn.close()
