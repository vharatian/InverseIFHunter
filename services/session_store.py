"""
services/session_store.py — skeleton facade over Redis + Postgres session stores.

Intent
------
Today, route/handler code reaches directly into ``services.redis_session`` and
``services.pg_session``. That keeps two concerns tangled:

  1. **Where** the data lives (hot cache vs durable store).
  2. **What** the trainer-facing concept is (phase, selection, trainer UI).

This module is the Phase-4 skeleton of a consolidated ``SessionStore`` that
owns both the cache and the durable snapshot. Routes will eventually call
``SessionStore`` exclusively and be oblivious to Redis/PG.

Scope for this change
---------------------
Intentionally **minimal** — we only land a tiny wrapper today so:

  - The public surface is visible and review-able.
  - Tests can stub ``SessionStore`` without touching Redis or PG.
  - Callers can migrate opportunistically without a big-bang rewrite.

Migration strategy (future PRs, not this one):

  * Add more methods as we encounter new call-sites (YAGNI).
  * Route changes replace ``redis_store.*`` / ``pg_session.*`` imports with
    ``Depends(get_session_store)``.
  * The module-level singleton remains only for background workers that run
    outside request context.

No behaviour changes today — every method here just delegates to the existing
module functions that already have the "primary-write-to-Redis, async-merge-to-PG"
semantics baked in.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from services import redis_session as _redis_store
from services import pg_session as _pg_store


class SessionStore:
    """Thin facade so routes / tests stop importing two stores directly.

    All methods are async and preserve the existing contracts of the
    underlying helpers (return shapes, exceptions, None-on-miss, etc).
    """

    # ── Meta (Redis-primary, PG fallback via helpers/shared) ──────────────

    async def get_meta(self, session_id: str) -> Dict[str, Any]:
        return await _redis_store.get_meta(session_id)

    async def set_meta_field(self, session_id: str, field: str, value: Any) -> None:
        await _redis_store.set_meta_field(session_id, field, value)

    # ── Trainer-UI (selection, active_phase, etc) ────────────────────────

    async def get_trainer_ui(self, session_id: str) -> Dict[str, Any]:
        return await _redis_store.get_trainer_ui(session_id)

    async def set_trainer_ui(self, session_id: str, data: Dict[str, Any]) -> None:
        await _redis_store.set_trainer_ui(session_id, data)

    # ── Durable snapshot (PG) ─────────────────────────────────────────────

    async def load_session_pg(self, session_id: str):
        return await _pg_store.load_session_pg(session_id)

    async def save_session_pg(self, session) -> None:  # type: ignore[no-untyped-def]
        await _pg_store.save_session_pg(session)

    async def get_session_metadata_pg(self, session_id: str) -> Dict[str, Any]:
        return await _pg_store.get_session_metadata_pg(session_id)

    async def merge_session_metadata_pg(self, session_id: str, patch: Dict[str, Any]) -> None:
        await _pg_store.merge_session_metadata_pg(session_id, patch)


# Module-level singleton. Safe because the class is stateless.
session_store = SessionStore()


def get_session_store(request: "Request") -> SessionStore:
    """FastAPI dependency — mirrors ``services.hunt_engine.get_hunt_engine``.

    Routes declare ``store: SessionStore = Depends(get_session_store)``.
    Tests override via::

        app.dependency_overrides[get_session_store] = lambda: fake_store
    """
    state_store: Optional[SessionStore] = getattr(
        request.app.state, "session_store", None
    )
    return state_store if state_store is not None else session_store


# Deferred import so workers / scripts can import SessionStore without
# pulling in FastAPI at module-load time.
try:
    from fastapi import Request  # noqa: E402,F401
except Exception:  # pragma: no cover
    Request = object  # type: ignore[assignment]
