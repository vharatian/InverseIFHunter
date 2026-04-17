"""Redis-backed sliding-window rate limiter for auth endpoints.

Degrades open (logs + allows) if Redis is unreachable so the admin panel
remains usable in degraded environments.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

LOGIN_LIMIT = int(os.environ.get("LOGIN_RATE_LIMIT", "5"))
LOGIN_WINDOW_SECONDS = int(os.environ.get("LOGIN_RATE_WINDOW_SECONDS", "60"))

_redis_ref = None  # cached aioredis client
_fallback: dict[str, list[float]] = {}
_fallback_lock = asyncio.Lock()


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _get_redis():
    global _redis_ref
    if _redis_ref is not None:
        return _redis_ref
    try:
        import redis.asyncio as aioredis

        url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
        client = aioredis.from_url(
            url,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
        await client.ping()
        _redis_ref = client
        return client
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Rate-limit Redis unavailable, using in-memory fallback: %s", exc)
        _redis_ref = False  # sentinel
        return None


async def _in_memory_allow(bucket: str, limit: int, window: int) -> tuple[bool, int]:
    now = time.time()
    cutoff = now - window
    async with _fallback_lock:
        hits = [t for t in _fallback.get(bucket, []) if t >= cutoff]
        if len(hits) >= limit:
            return False, int(cutoff + window - now)
        hits.append(now)
        _fallback[bucket] = hits
        return True, 0


async def enforce(request: Request, bucket: str,
                  limit: Optional[int] = None,
                  window_seconds: Optional[int] = None) -> None:
    """Raise 429 if the IP exceeded the rate for the given bucket."""
    limit = limit or LOGIN_LIMIT
    window = window_seconds or LOGIN_WINDOW_SECONDS
    key = f"ratelimit:{bucket}:{_client_ip(request)}"
    redis_client = await _get_redis()
    if not redis_client:
        ok, retry_after = await _in_memory_allow(key, limit, window)
        if not ok:
            raise HTTPException(
                status_code=429,
                detail="Too many attempts. Try again later.",
                headers={"Retry-After": str(max(1, retry_after))},
            )
        return

    try:
        pipe = redis_client.pipeline()
        now = time.time()
        cutoff = now - window
        pipe.zremrangebyscore(key, 0, cutoff)
        pipe.zadd(key, {f"{now}:{os.getpid()}": now})
        pipe.zcard(key)
        pipe.expire(key, window + 5)
        _, _, count, _ = await pipe.execute()
        if count > limit:
            raise HTTPException(
                status_code=429,
                detail="Too many attempts. Try again later.",
                headers={"Retry-After": str(window)},
            )
    except HTTPException:
        raise
    except Exception as exc:  # pragma: no cover - degrade open
        logger.warning("Rate-limit check failed, allowing: %s", exc)
