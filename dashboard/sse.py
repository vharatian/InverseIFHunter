"""SSE endpoints and background file tailer for live dashboard/admin updates."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from pathlib import Path
from typing import AsyncIterator

from fastapi import Depends, Request
from sse_starlette.sse import EventSourceResponse

from auth import verify_admin
from events_bus import (
    CHANNEL_ADMINS,
    CHANNEL_CONFIG,
    CHANNEL_DB,
    CHANNEL_TEAM,
    CHANNEL_TELEMETRY,
    publish,
    subscribe,
)

logger = logging.getLogger(__name__)

SSE_PING_INTERVAL = int(os.environ.get("SSE_PING_INTERVAL", "15"))


async def _ping_loop(interval: int) -> AsyncIterator[dict]:
    while True:
        await asyncio.sleep(interval)
        yield {"event": "ping", "data": str(int(time.time()))}


async def _stream_channels(request: Request, channels: list) -> AsyncIterator[dict]:
    """Merge Redis pub/sub messages with periodic pings, cancel on disconnect."""
    last_ping = time.time()
    # Yield an initial ready event so the client can detect connection.
    yield {"event": "ready", "data": json.dumps({"channels": channels})}

    gen = subscribe(channels)
    try:
        while True:
            if await request.is_disconnected():
                break
            try:
                msg = await asyncio.wait_for(gen.__anext__(), timeout=SSE_PING_INTERVAL)
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": str(int(time.time()))}
                last_ping = time.time()
                continue
            except StopAsyncIteration:
                break
            yield {"event": msg["channel"], "data": msg["data"]}
            if time.time() - last_ping >= SSE_PING_INTERVAL:
                yield {"event": "ping", "data": str(int(time.time()))}
                last_ping = time.time()
    finally:
        with contextlib.suppress(Exception):
            await gen.aclose()


async def dashboard_stream(request: Request, _=Depends(verify_admin)):
    """Client-facing SSE for trainers dashboard UI."""
    channels = [
        CHANNEL_TELEMETRY,
        CHANNEL_CONFIG,
        CHANNEL_TEAM,
        CHANNEL_ADMINS,
        CHANNEL_DB,
    ]
    return EventSourceResponse(
        _stream_channels(request, channels),
        ping=SSE_PING_INTERVAL,
    )


async def admin_stream(request: Request, _=Depends(verify_admin)):
    """Admin panel SSE: configuration / team / db / admin registry updates."""
    channels = [CHANNEL_CONFIG, CHANNEL_TEAM, CHANNEL_ADMINS, CHANNEL_DB, CHANNEL_TELEMETRY]
    return EventSourceResponse(
        _stream_channels(request, channels),
        ping=SSE_PING_INTERVAL,
    )


# -------- JSONL tailer --------

_tailer_task: asyncio.Task | None = None


async def _tail_telemetry(log_path: Path) -> None:
    """Tail the telemetry JSONL file and publish new lines to Redis."""
    from_offset = 0
    if log_path.exists():
        try:
            from_offset = log_path.stat().st_size
        except OSError:
            from_offset = 0
    logger.info("telemetry tailer starting at offset %d of %s", from_offset, log_path)
    while True:
        try:
            if not log_path.exists():
                await asyncio.sleep(2)
                continue
            stat = log_path.stat()
            if stat.st_size < from_offset:
                # File rotated/truncated; resync.
                from_offset = 0
            if stat.st_size == from_offset:
                await asyncio.sleep(1)
                continue
            with open(log_path, "rb") as f:
                f.seek(from_offset)
                chunk = f.read(stat.st_size - from_offset)
                from_offset = stat.st_size
            lines = chunk.decode("utf-8", errors="replace").splitlines()
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except Exception:
                    continue
                await publish(CHANNEL_TELEMETRY, event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("telemetry tailer error: %s", exc)
            await asyncio.sleep(2)


def start_tailer(log_path: Path) -> None:
    """Idempotently start the background JSONL tailer."""
    global _tailer_task
    if _tailer_task and not _tailer_task.done():
        return
    loop = asyncio.get_event_loop()
    _tailer_task = loop.create_task(_tail_telemetry(log_path))


async def stop_tailer() -> None:
    global _tailer_task
    if _tailer_task:
        _tailer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _tailer_task
        _tailer_task = None
