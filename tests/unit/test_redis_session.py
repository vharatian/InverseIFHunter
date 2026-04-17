"""Unit tests for session persistence invariants covered by the audit fixes.

These exercise restore round-trip, CAS atomicity, and advance-turn lock behavior.
They connect to the real Redis used by the app and are skipped if Redis is unreachable.
"""
import asyncio
import os
import uuid

import pytest


async def _redis_available() -> bool:
    try:
        from redis_client import get_redis
        r = await get_redis()
        await r.ping()
        return True
    except Exception:
        return False


@pytest.fixture(autouse=True)
async def _skip_without_redis():
    if not await _redis_available():
        pytest.skip("Redis not available for unit test")


def _make_session(session_id: str):
    from models.schemas import HuntSession, HuntConfig, HuntStatus, ParsedNotebook
    return HuntSession(
        session_id=session_id,
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


@pytest.mark.asyncio
async def test_restore_preserves_created_at_and_trainer_email():
    """save_full_session on restore must not clobber created_at and must copy trainer_email."""
    import services.redis_session as store

    sid = f"ut-{uuid.uuid4().hex[:8]}"
    session = _make_session(sid)

    # Fresh create — records created_at.
    await store.save_full_session(session)
    meta = await store.get_meta(sid)
    original_created_at = meta.get("created_at")
    assert isinstance(original_created_at, str) and original_created_at, "created_at must be set"

    # Simulate a restore from PG: pass created_at + trainer_email via workflow_metadata.
    # create_session would normally be called again and could clobber created_at; the
    # fix preserves the existing value (or the explicit one passed in).
    await store.save_full_session(
        session,
        workflow_metadata={
            "created_at": original_created_at,
            "trainer_email": "trainer@example.com",
            "review_status": "draft",
        },
    )
    meta2 = await store.get_meta(sid)
    assert meta2.get("created_at") == original_created_at, "created_at should survive restore"
    assert meta2.get("trainer_email") == "trainer@example.com", "trainer_email should be restored"

    await store.delete_all_session_keys(sid)


@pytest.mark.asyncio
async def test_cas_review_status_atomic_with_review_round():
    """CAS should transition status AND bump review_round in one Lua call."""
    import services.redis_session as store

    sid = f"ut-{uuid.uuid4().hex[:8]}"
    session = _make_session(sid)
    await store.save_full_session(session)

    round_before = await store.get_review_round(sid)

    ok, new = await store.cas_review_status(sid, "draft", "submitted", bump_review_round=True)
    assert ok is True
    assert new == "submitted"
    round_after = await store.get_review_round(sid)
    assert round_after == round_before + 1, "review_round must advance with CAS"

    # Second attempt with stale expected must fail and NOT bump the counter.
    ok2, actual = await store.cas_review_status(sid, "draft", "submitted", bump_review_round=True)
    assert ok2 is False
    assert actual == "submitted"
    round_still = await store.get_review_round(sid)
    assert round_still == round_after, "failed CAS must not bump review_round"

    await store.delete_all_session_keys(sid)


@pytest.mark.asyncio
async def test_advance_turn_lock_token_release():
    """The token-based unlock script must only delete when the token matches."""
    from redis_client import get_redis
    from routes.multiturn import _ADVANCE_UNLOCK_LUA

    r = await get_redis()
    sid = f"ut-{uuid.uuid4().hex[:8]}"
    lock_key = f"mh:lock:advance:{sid}"

    token_a = "tokA"
    token_b = "tokB"

    acquired = await r.set(lock_key, token_a, nx=True, ex=60)
    assert acquired is True

    # Foreign token must not delete the lock.
    res = await r.eval(_ADVANCE_UNLOCK_LUA, 1, lock_key, token_b)
    assert int(res) == 0
    still = await r.get(lock_key)
    assert still == token_a

    # Correct token deletes the lock.
    res2 = await r.eval(_ADVANCE_UNLOCK_LUA, 1, lock_key, token_a)
    assert int(res2) == 1
    gone = await r.get(lock_key)
    assert gone is None
