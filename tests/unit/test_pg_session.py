"""Test PostgreSQL session service roundtrip."""
import pytest
import asyncio
from models.schemas import HuntSession, HuntConfig, HuntStatus
from services.pg_session import save_session_pg, load_session_pg, delete_session_pg


@pytest.fixture
def sample_session():
    return HuntSession(
        session_id="test_pg_001",
        config=HuntConfig(),
        status=HuntStatus.PENDING,
        total_hunts=5,
        completed_hunts=3,
        breaks_found=1,
        human_reviews={"row_1": {"criteria": {"quality": "PASS"}}},
    )


@pytest.mark.asyncio
async def test_save_and_load_roundtrip(sample_session):
    await save_session_pg(sample_session)
    loaded = await load_session_pg("test_pg_001")
    assert loaded is not None
    assert loaded.session_id == "test_pg_001"
    assert loaded.total_hunts == 5
    assert loaded.completed_hunts == 3
    assert loaded.breaks_found == 1
    assert loaded.human_reviews.get("row_1") is not None
    await delete_session_pg("test_pg_001")


@pytest.mark.asyncio
async def test_load_nonexistent():
    loaded = await load_session_pg("nonexistent_session_xyz")
    assert loaded is None
