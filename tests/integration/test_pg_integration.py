"""
Integration tests — verify PostgreSQL operations against real database.
Requires PostgreSQL running locally (docker-compose.dev.yml or brew service).
"""
import pytest

from services.pg_session import save_session_pg, load_session_pg, delete_session_pg
from models.schemas import HuntSession, HuntConfig, HuntStatus
from database import check_connection


@pytest.mark.asyncio
async def test_pg_connection():
    """Verify PostgreSQL is reachable."""
    assert await check_connection() is True


@pytest.mark.asyncio
async def test_session_roundtrip():
    """Save, load, verify, delete a session."""
    session = HuntSession(
        session_id="integration_test_001",
        config=HuntConfig(),
        status=HuntStatus.PENDING,
        total_hunts=10,
        completed_hunts=7,
        breaks_found=3,
        human_reviews={"row_1": {"quality": "PASS", "relevance": "FAIL"}},
    )

    await save_session_pg(session)
    loaded = await load_session_pg("integration_test_001")

    assert loaded is not None
    assert loaded.session_id == "integration_test_001"
    assert loaded.total_hunts == 10
    assert loaded.completed_hunts == 7
    assert loaded.breaks_found == 3
    assert "row_1" in loaded.human_reviews

    await delete_session_pg("integration_test_001")
    deleted = await load_session_pg("integration_test_001")
    assert deleted is None


@pytest.mark.asyncio
async def test_session_upsert():
    """Save twice — second save should update, not duplicate."""
    session = HuntSession(
        session_id="integration_test_upsert",
        config=HuntConfig(),
        status=HuntStatus.PENDING,
        total_hunts=5,
    )
    await save_session_pg(session)

    session.total_hunts = 15
    session.status = HuntStatus.COMPLETED
    await save_session_pg(session)

    loaded = await load_session_pg("integration_test_upsert")
    assert loaded is not None
    assert loaded.total_hunts == 15

    await delete_session_pg("integration_test_upsert")


@pytest.mark.asyncio
async def test_health_endpoints():
    """Verify health check functions work."""
    from resilience.health import health_live, health_ready

    live = await health_live()
    assert live["status"] == "ok"

    ready = await health_ready()
    assert ready["status"] in ("ready", "degraded")
    assert "postgresql" in ready["checks"]
    assert "redis" in ready["checks"]
