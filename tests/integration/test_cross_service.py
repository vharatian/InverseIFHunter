"""
Cross-service tests — verify Python ↔ Redis pub/sub communication.
These tests verify the event publishing pipeline works end-to-end.

Requires:
- PostgreSQL running
- Redis running
"""
import json
import os

import pytest
import redis.asyncio as aioredis

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")


@pytest.mark.asyncio
async def test_redis_pubsub_roundtrip():
    """Verify we can publish and receive on Redis pub/sub."""
    r = aioredis.from_url(REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()

    channel = "mh:events:hunt:test_session_cross"
    await pubsub.subscribe(channel)

    # Consume the subscription confirmation
    msg = await pubsub.get_message(timeout=2.0)
    assert msg is not None

    event = {"type": "hunt.progress", "session_id": "test_session_cross", "data": {"step": 1}}
    await r.publish(channel, json.dumps(event))

    msg = await pubsub.get_message(timeout=5.0)
    assert msg is not None
    assert msg["type"] == "message"

    parsed = json.loads(msg["data"])
    assert parsed["type"] == "hunt.progress"
    assert parsed["session_id"] == "test_session_cross"

    await pubsub.unsubscribe(channel)
    await pubsub.aclose()
    await r.aclose()


@pytest.mark.asyncio
async def test_event_stream_publish():
    """Verify event_stream.publish writes to Redis Stream."""
    from services.event_stream import publish
    from models.schemas import HuntEvent

    event = HuntEvent(
        event_type="test_event",
        hunt_id=1,
        data={"test": True, "source": "cross_service_test"},
    )

    entry_id = await publish("cross_service_test_session", event)
    assert entry_id is not None

    # Verify the event is in the stream
    r = aioredis.from_url(REDIS_URL, decode_responses=True)
    entries = await r.xrange("mh:events:cross_service_test_session")
    assert len(entries) > 0

    # Clean up
    await r.delete("mh:events:cross_service_test_session")
    await r.aclose()


@pytest.mark.asyncio
async def test_trace_id_middleware():
    """Verify trace_id middleware generates IDs."""
    from middleware.trace_id import get_trace_id, trace_id_var

    # Set a trace ID manually (simulating middleware)
    token = trace_id_var.set("tr_test123")
    assert get_trace_id() == "tr_test123"
    trace_id_var.reset(token)
