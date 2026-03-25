"""
Single Redis connection pool shared by all modules.

Replaces the duplicate Redis clients in services/redis_session.py
and reviewer-app/services/redis_client.py.
"""
import os
import logging
from typing import Optional

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

_client: Optional[aioredis.Redis] = None
_blocking_client: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(
            REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5,
        )
        await _client.ping()
        logger.info(f"Redis connected: {REDIS_URL}")
    return _client


async def get_redis_blocking() -> aioredis.Redis:
    global _blocking_client
    if _blocking_client is None:
        _blocking_client = aioredis.from_url(
            REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=60,
        )
        await _blocking_client.ping()
        logger.info(f"Redis blocking client connected: {REDIS_URL}")
    return _blocking_client


async def close_redis():
    global _client, _blocking_client
    if _client:
        await _client.aclose()
        _client = None
    if _blocking_client:
        await _blocking_client.aclose()
        _blocking_client = None
    logger.info("Redis connections closed")
