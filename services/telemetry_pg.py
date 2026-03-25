"""
PostgreSQL telemetry writer — replaces SQLite hunt_events table.

Writes to the telemetry_events table created in Phase 0.
All operations are fire-and-forget — failures are logged but never raise.
"""
import json
import logging
from typing import Any, Dict, Optional

from sqlalchemy import text

from database import async_session_factory

logger = logging.getLogger(__name__)


async def append_telemetry_event(
    session_id: str,
    event_type: str,
    payload: Optional[Dict[str, Any]] = None,
    trainer_email: Optional[str] = None,
) -> None:
    try:
        async with async_session_factory() as db:
            await db.execute(
                text("""
                    INSERT INTO telemetry_events (event_type, session_id, trainer_email, payload)
                    VALUES (:event_type, :session_id, :trainer_email, CAST(:payload AS jsonb))
                """),
                {
                    "event_type": event_type,
                    "session_id": session_id,
                    "trainer_email": trainer_email,
                    "payload": json.dumps(payload or {}, default=str),
                },
            )
            await db.commit()
    except Exception as e:
        logger.debug("telemetry_pg append failed (non-fatal): %s", e)
