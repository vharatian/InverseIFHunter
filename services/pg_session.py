"""
PostgreSQL session service — source of truth for all session data.

Provides the same key operations as redis_session.py but backed by PostgreSQL.
Redis remains as a cache layer on top of this.
"""
import json
import logging
from typing import Optional, Dict, Any, List

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from database import get_db
from models.db_models import SessionRow, HuntResultRow, TrainerRow
from models.schemas import HuntSession, HuntConfig, HuntStatus, ParsedNotebook, HuntResult

logger = logging.getLogger(__name__)


async def save_session_pg(session: HuntSession) -> None:
    async with get_db() as db:
        stmt = pg_insert(SessionRow).values(
            id=session.session_id,
            notebook_json=session.notebook.model_dump() if session.notebook else None,
            config=session.config.model_dump() if session.config else None,
            status=session.status.value if hasattr(session.status, "value") else str(session.status),
            human_reviews=session.human_reviews or {},
            conversation_history=[m for m in (session.conversation_history or [])],
            turns=[t.model_dump() if hasattr(t, "model_dump") else t for t in (session.turns or [])],
            total_hunts=session.total_hunts,
            completed_hunts=session.completed_hunts,
            breaks_found=session.breaks_found,
            passes_found=getattr(session, "passes_found", 0),
            accumulated_hunt_count=session.accumulated_hunt_count,
            current_turn=session.current_turn,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["id"],
            set_={
                "notebook_json": stmt.excluded.notebook_json,
                "config": stmt.excluded.config,
                "status": stmt.excluded.status,
                "human_reviews": stmt.excluded.human_reviews,
                "conversation_history": stmt.excluded.conversation_history,
                "turns": stmt.excluded.turns,
                "total_hunts": stmt.excluded.total_hunts,
                "completed_hunts": stmt.excluded.completed_hunts,
                "breaks_found": stmt.excluded.breaks_found,
                "passes_found": stmt.excluded.passes_found,
                "accumulated_hunt_count": stmt.excluded.accumulated_hunt_count,
                "current_turn": stmt.excluded.current_turn,
                "updated_at": text("now()"),
            },
        )
        await db.execute(stmt)


async def load_session_pg(session_id: str) -> Optional[HuntSession]:
    async with get_db() as db:
        result = await db.execute(
            select(SessionRow).where(SessionRow.id == session_id)
        )
        row = result.scalar_one_or_none()
        if not row:
            return None

        fields = {
            "session_id": row.id,
            "status": HuntStatus(row.status) if row.status else HuntStatus.PENDING,
            "human_reviews": row.human_reviews or {},
            "conversation_history": row.conversation_history or [],
            "total_hunts": row.total_hunts or 0,
            "completed_hunts": row.completed_hunts or 0,
            "breaks_found": row.breaks_found or 0,
            "passes_found": row.passes_found or 0,
            "accumulated_hunt_count": row.accumulated_hunt_count or 0,
            "current_turn": row.current_turn or 1,
        }

        if row.notebook_json:
            try:
                fields["notebook"] = ParsedNotebook(**row.notebook_json)
            except Exception:
                pass

        if row.config:
            try:
                fields["config"] = HuntConfig(**row.config)
            except Exception:
                pass

        if row.turns:
            fields["turns"] = row.turns

        result_rows = await db.execute(
            select(HuntResultRow)
            .where(HuntResultRow.session_id == session_id)
            .order_by(HuntResultRow.created_at)
        )
        hunt_results = []
        for r in result_rows.scalars():
            try:
                hr = HuntResult(
                    hunt_id=r.hunt_id,
                    model=r.model,
                    status=HuntStatus(r.status) if r.status else HuntStatus.PENDING,
                    response=r.response or "",
                    reasoning_trace=r.reasoning_trace or "",
                    judge_score=r.judge_score,
                    judge_output=r.judge_output or "",
                    judge_criteria=r.judge_criteria or {},
                    judge_explanation=r.judge_explanation or "",
                    error=r.error,
                    is_breaking=r.is_breaking or False,
                    sample_label=r.sample_label,
                )
                hunt_results.append(hr)
            except Exception:
                pass

        fields["results"] = hunt_results
        fields["all_results"] = hunt_results

        return HuntSession(**fields)


async def append_result_pg(session_id: str, result) -> None:
    """Write a single hunt result to PostgreSQL. Fire-and-forget — never raises."""
    try:
        async with get_db() as db:
            await db.execute(
                text("""
                    INSERT INTO hunt_results (
                        session_id, hunt_id, model, provider, status,
                        prompt, response, reasoning_trace,
                        judge_score, judge_output, judge_explanation,
                        judge_criteria, scores, error,
                        is_breaking, sample_label, duration_ms
                    ) VALUES (
                        :session_id, :hunt_id, :model, :provider, :status,
                        :prompt, :response, :reasoning_trace,
                        :judge_score, :judge_output, :judge_explanation,
                        CAST(:judge_criteria AS jsonb), CAST(:scores AS jsonb), :error,
                        :is_breaking, :sample_label, :duration_ms
                    )
                """),
                {
                    "session_id": session_id,
                    "hunt_id": getattr(result, "hunt_id", 0),
                    "model": getattr(result, "model", "unknown"),
                    "provider": getattr(result, "provider", "unknown"),
                    "status": result.status.value if hasattr(result.status, "value") else str(getattr(result, "status", "pending")),
                    "prompt": getattr(result, "prompt", None),
                    "response": getattr(result, "response", None),
                    "reasoning_trace": getattr(result, "reasoning_trace", None),
                    "judge_score": getattr(result, "judge_score", None),
                    "judge_output": getattr(result, "judge_output", None),
                    "judge_explanation": getattr(result, "judge_explanation", None),
                    "judge_criteria": json.dumps(getattr(result, "judge_criteria", {}) or {}, default=str),
                    "scores": json.dumps(getattr(result, "scores", {}) or {}, default=str),
                    "error": getattr(result, "error", None),
                    "is_breaking": getattr(result, "is_breaking", False),
                    "sample_label": str(result.sample_label) if getattr(result, "sample_label", None) else None,
                    "duration_ms": getattr(result, "duration_ms", None),
                },
            )
    except Exception as e:
        logger.error(f"append_result_pg failed for session {session_id}: {e}")


async def delete_session_pg(session_id: str) -> bool:
    async with get_db() as db:
        result = await db.execute(
            text("DELETE FROM sessions WHERE id = :sid"),
            {"sid": session_id},
        )
        return result.rowcount > 0


async def session_exists_pg(session_id: str) -> bool:
    async with get_db() as db:
        result = await db.execute(
            text("SELECT 1 FROM sessions WHERE id = :sid LIMIT 1"),
            {"sid": session_id},
        )
        return result.scalar() is not None


async def get_session_metadata_pg(session_id: str) -> Dict[str, Any]:
    """Load JSONB `metadata` column (colab URL, original notebook JSON, filename, trainer hints)."""
    async with get_db() as db:
        result = await db.execute(
            select(SessionRow.metadata_).where(SessionRow.id == session_id)
        )
        row = result.scalar_one_or_none()
        if row is None or not isinstance(row, dict):
            return {}
        return dict(row)


async def merge_session_metadata_pg(session_id: str, patch: Dict[str, Any]) -> None:
    """Deep-merge `patch` into sessions.metadata (upsert row if missing)."""
    if not patch:
        return
    payload = json.dumps(patch, default=str)
    async with get_db() as db:
        await db.execute(
            text("""
                INSERT INTO sessions (id, metadata, status)
                VALUES (:sid, CAST(:patch AS jsonb), 'pending')
                ON CONFLICT (id) DO UPDATE SET
                    metadata = COALESCE(sessions.metadata, '{}'::jsonb) || CAST(:patch AS jsonb),
                    updated_at = now()
            """),
            {"sid": session_id, "patch": payload},
        )
