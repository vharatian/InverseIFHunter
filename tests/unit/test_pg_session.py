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


@pytest.mark.asyncio
async def test_pg_metadata_roundtrip_preserves_created_at_and_trainer_email():
    """PG metadata snapshot should carry created_at + trainer_email so restore can rehydrate them."""
    import uuid
    import services.redis_session as store
    from services.pg_session import save_session_pg, get_session_metadata_pg, delete_session_pg
    from models.schemas import HuntSession, HuntConfig, HuntStatus, ParsedNotebook

    try:
        from redis_client import get_redis
        r = await get_redis()
        await r.ping()
    except Exception:
        pytest.skip("Redis not available")

    sid = f"pg-ut-{uuid.uuid4().hex[:8]}"
    session = HuntSession(
        session_id=sid,
        notebook=ParsedNotebook(
            prompt="p", response="r", criteria=[],
            judge_system_prompt="j", number_of_attempts_made=0,
        ),
        config=HuntConfig(),
        status=HuntStatus.PENDING,
        total_hunts=0,
        completed_hunts=0,
        breaks_found=0,
        results=[],
        all_results=[],
    )

    await store.save_full_session(session)
    await store.set_trainer_email(sid, "round-trip@example.com")
    meta_redis = await store.get_meta(sid)
    created_at = meta_redis.get("created_at")
    assert created_at, "fresh session must have created_at in Redis"

    await save_session_pg(session)

    pg_meta = await get_session_metadata_pg(sid)
    assert pg_meta.get("created_at") == created_at
    assert pg_meta.get("trainer_email") == "round-trip@example.com"

    await store.delete_all_session_keys(sid)
    await delete_session_pg(sid)
