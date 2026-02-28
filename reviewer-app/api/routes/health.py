"""Health and readiness endpoints. No allowlist required."""
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from services import get_redis

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    """Liveness: app is running."""
    return {"status": "ok"}


@router.get("/ready")
async def ready():
    """Readiness: app and Redis are available."""
    try:
        r = await get_redis()
        await r.ping()
        return {"status": "ok", "redis": "connected"}
    except Exception as e:
        logger.exception("Readiness check failed")
        return JSONResponse(
            status_code=503,
            content={"status": "degraded", "redis": str(e)},
        )
