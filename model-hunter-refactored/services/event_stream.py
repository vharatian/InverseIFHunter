"""
Event Stream — Redis Streams for SSE Hunt Progress

Replaces the in-memory asyncio.Queue pattern for SSE events.
Hunt progress events are published to a Redis Stream per session.
Any app instance can subscribe and serve the SSE connection.

Key per session:  mh:events:{session_id}

Features:
- Persistent events (survive process restart)
- Replay from any point via Last-Event-ID (XRANGE)
- Auto-trim old events (MAXLEN ~200 per session)
- Blocking subscribe (XREAD BLOCK) — efficient, no polling
- TTL on stream keys (auto-cleanup after session expires)

Usage:
    # Publisher (hunt_engine)
    await publish(session_id, event)

    # Subscriber (SSE endpoint)
    async for event_id, event in subscribe(session_id):
        yield event

    # Replay missed events
    events = await replay(session_id, last_event_id)
"""
import json
import logging
from typing import AsyncGenerator, Tuple, Optional, List, Dict, Any

from models.schemas import HuntEvent
from services.redis_session import get_redis, get_redis_blocking

logger = logging.getLogger(__name__)

KEY_PREFIX = "mh:events"
STREAM_MAXLEN = 200       # Keep last 200 events per session
STREAM_TTL = 4 * 60 * 60  # 4 hours (matches session TTL)
BLOCK_TIMEOUT_MS = 30000  # Block for 30s waiting for new events


def _stream_key(session_id: str) -> str:
    return f"{KEY_PREFIX}:{session_id}"


async def publish(session_id: str, event: HuntEvent) -> str:
    """
    Publish a hunt event to the session's Redis Stream.
    Returns the stream entry ID (used as SSE event id).
    """
    r = await get_redis()
    key = _stream_key(session_id)

    data = {
        "event_type": event.event_type,
        "hunt_id": str(event.hunt_id) if event.hunt_id is not None else "",
        "data": json.dumps(event.data, default=str),
    }

    # XADD with approximate maxlen trim
    entry_id = await r.xadd(key, data, maxlen=STREAM_MAXLEN, approximate=True)

    # Set TTL on first event (refresh on subsequent)
    await r.expire(key, STREAM_TTL)

    return entry_id


async def subscribe(
    session_id: str,
    last_event_id: Optional[str] = None
) -> AsyncGenerator[Tuple[str, HuntEvent], None]:
    """
    Subscribe to hunt events for a session.
    Yields (event_id, HuntEvent) tuples.

    If last_event_id is provided, starts reading AFTER that ID (for reconnect).
    Otherwise starts from the latest event ($).

    Blocks efficiently using XREAD BLOCK.
    Uses a dedicated Redis connection with long socket timeout.
    """
    r = await get_redis_blocking()
    key = _stream_key(session_id)

    # Start position: after last_event_id or from now ($)
    cursor = last_event_id if last_event_id else "$"

    while True:
        try:
            # XREAD BLOCK — waits for new events efficiently
            result = await r.xread(
                {key: cursor},
                count=10,
                block=BLOCK_TIMEOUT_MS
            )

            if not result:
                # Timeout — yield nothing, loop will re-block
                # This is normal, allows checking for client disconnect
                yield None, None
                continue

            for stream_name, entries in result:
                for entry_id, fields in entries:
                    cursor = entry_id  # Advance cursor

                    event = _parse_event(fields)
                    if event:
                        yield entry_id, event

                        # Stop on terminal events
                        if event.event_type in ("complete", "error"):
                            return

        except Exception as e:
            logger.error(f"Event stream subscribe error for {session_id}: {e}")
            return


async def replay(
    session_id: str,
    last_event_id: str
) -> List[Tuple[str, HuntEvent]]:
    """
    Replay all events AFTER last_event_id.
    Used when a client reconnects with Last-Event-ID.
    Returns list of (event_id, HuntEvent) tuples.
    """
    r = await get_redis()
    key = _stream_key(session_id)

    # XRANGE from (exclusive) last_event_id to end
    # Redis XRANGE is inclusive, so we use the ID + 1ms trick
    # or just use XRANGE with the ID and skip the first if it matches
    entries = await r.xrange(key, min=last_event_id, max="+")

    events = []
    for entry_id, fields in entries:
        # Skip the exact last_event_id (we want events AFTER it)
        if entry_id == last_event_id:
            continue

        event = _parse_event(fields)
        if event:
            events.append((entry_id, event))

    return events


async def delete_stream(session_id: str) -> None:
    """Delete the event stream for a session (cleanup)."""
    r = await get_redis()
    await r.delete(_stream_key(session_id))


async def stream_length(session_id: str) -> int:
    """Get the number of events in a session's stream."""
    r = await get_redis()
    return await r.xlen(_stream_key(session_id))


def _parse_event(fields: Dict[str, str]) -> Optional[HuntEvent]:
    """Parse a Redis Stream entry into a HuntEvent."""
    try:
        event_type = fields.get("event_type", "")
        hunt_id_str = fields.get("hunt_id", "")
        data_str = fields.get("data", "{}")

        hunt_id = int(hunt_id_str) if hunt_id_str else None
        data = json.loads(data_str)

        return HuntEvent(
            event_type=event_type,
            hunt_id=hunt_id,
            data=data
        )
    except Exception as e:
        logger.error(f"Failed to parse event: {e}, fields={fields}")
        return None
