"""Redis pub/sub event bus for cross-process dashboard/admin sync.

Channels:
  - mth:telemetry  — new telemetry event appended to events.jsonl
  - mth:config     — global.yaml mutated
  - mth:team       — team.yaml mutated
  - mth:admins     — dashboard_admins.json mutated (admins or test accounts)
  - mth:db         — Postgres row mutated via admin panel

Message envelope:
  {"ts": <iso-utc>, "channel": "config", "payload": {...}}

Degrades silently when Redis is unavailable.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Dict, Optional

logger = logging.getLogger(__name__)

CHANNEL_TELEMETRY = "mth:telemetry"
CHANNEL_CONFIG = "mth:config"
CHANNEL_TEAM = "mth:team"
CHANNEL_ADMINS = "mth:admins"
CHANNEL_DB = "mth:db"

_CHANNEL_MAP = {
    "telemetry": CHANNEL_TELEMETRY,
    "config": CHANNEL_CONFIG,
    "team": CHANNEL_TEAM,
    "admins": CHANNEL_ADMINS,
    "db": CHANNEL_DB,
}

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")


def _resolve_channel(name: str) -> str:
    if name.startswith("mth:"):
        return name
    return _CHANNEL_MAP.get(name, f"mth:{name}")


def _build_envelope(channel: str, payload: Any) -> str:
    return json.dumps(
        {
            "ts": datetime.now(timezone.utc).isoformat(),
            "channel": channel.replace("mth:", ""),
            "payload": payload,
        },
        default=str,
    )


# -------- Async publisher (FastAPI request handlers) --------

_async_client = None


async def _get_async():
    global _async_client
    if _async_client is False:
        return None
    if _async_client is not None:
        return _async_client
    try:
        import redis.asyncio as aioredis
        client = aioredis.from_url(
            REDIS_URL, encoding="utf-8", decode_responses=True,
            socket_connect_timeout=2, socket_timeout=2,
        )
        await client.ping()
        _async_client = client
        return client
    except Exception as exc:
        logger.warning("events_bus: async Redis unavailable: %s", exc)
        _async_client = False
        return None


async def publish(channel: str, payload: Any) -> None:
    ch = _resolve_channel(channel)
    client = await _get_async()
    if not client:
        return
    try:
        await client.publish(ch, _build_envelope(ch, payload))
    except Exception as exc:
        logger.debug("events_bus publish failed on %s: %s", ch, exc)


# -------- Sync publisher (for non-async contexts) --------

_sync_client = None


def _get_sync():
    global _sync_client
    if _sync_client is False:
        return None
    if _sync_client is not None:
        return _sync_client
    try:
        import redis
        client = redis.Redis.from_url(
            REDIS_URL, decode_responses=True,
            socket_connect_timeout=2, socket_timeout=2,
        )
        client.ping()
        _sync_client = client
        return client
    except Exception as exc:
        logger.warning("events_bus: sync Redis unavailable: %s", exc)
        _sync_client = False
        return None


def publish_sync(channel: str, payload: Any) -> None:
    ch = _resolve_channel(channel)
    client = _get_sync()
    if not client:
        return
    try:
        client.publish(ch, _build_envelope(ch, payload))
    except Exception as exc:
        logger.debug("events_bus sync publish failed on %s: %s", ch, exc)


# -------- Async subscriber helper for SSE --------

async def subscribe(channels: list) -> AsyncIterator[Dict[str, Any]]:
    """Yield decoded message envelopes from the given channels.

    Each yielded dict has shape {"channel": <short>, "data": <str>} where
    data is the raw JSON envelope string.
    """
    client = await _get_async()
    if not client:
        # Degrade: never yields; caller should still send periodic keepalives.
        while True:
            await asyncio.sleep(30)

    resolved = [_resolve_channel(c) for c in channels]
    pubsub = client.pubsub()
    try:
        await pubsub.subscribe(*resolved)
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            ch = message.get("channel") or ""
            data = message.get("data") or ""
            yield {"channel": ch.replace("mth:", ""), "data": data}
    finally:
        try:
            await pubsub.unsubscribe(*resolved)
            await pubsub.aclose()
        except Exception:
            pass
