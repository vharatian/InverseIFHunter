"""
Health check endpoints (design spec §9.7) — three depth levels.
"""
import logging
import os
import time

logger = logging.getLogger(__name__)


async def check_postgres() -> dict:
    try:
        from database import engine
        from sqlalchemy import text
        start = time.monotonic()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        latency = round((time.monotonic() - start) * 1000, 1)
        return {"status": "ok", "latency_ms": latency}
    except Exception as e:
        return {"status": "error", "error": str(e)}


async def check_redis() -> dict:
    try:
        import redis.asyncio as aioredis
        url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        r = aioredis.from_url(url, socket_connect_timeout=2, socket_timeout=2)
        start = time.monotonic()
        await r.ping()
        latency = round((time.monotonic() - start) * 1000, 1)
        info = await r.info("memory")
        await r.aclose()
        return {
            "status": "ok",
            "latency_ms": latency,
            "memory_used_mb": round(info.get("used_memory", 0) / 1024 / 1024, 1),
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


async def health_live() -> dict:
    return {"status": "ok"}


async def health_ready() -> dict:
    pg = await check_postgres()
    rd = await check_redis()
    all_ok = pg["status"] == "ok" and rd["status"] == "ok"
    return {
        "status": "ready" if all_ok else "degraded",
        "checks": {"postgresql": pg, "redis": rd},
    }


async def health_deep() -> dict:
    from resilience.circuit_breaker import get_all_circuit_status
    pg = await check_postgres()
    rd = await check_redis()
    providers = get_all_circuit_status()
    all_ok = pg["status"] == "ok" and rd["status"] == "ok"
    return {
        "status": "healthy" if all_ok else "degraded",
        "checks": {
            "postgresql": pg,
            "redis": rd,
            "providers": providers,
        },
    }
