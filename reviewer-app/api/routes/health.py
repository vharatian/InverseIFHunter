"""Health, readiness, and version endpoints. No allowlist required."""
import logging
import sys
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from services import get_redis

logger = logging.getLogger(__name__)

_repo_root = str(Path(__file__).resolve().parents[3])
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

router = APIRouter(tags=["health"])


@router.get("/api/version")
async def version():
    """Return app version hash. Polled by the UI to detect code changes."""
    try:
        from main import APP_VERSION
        return {"version": APP_VERSION}
    except Exception:
        return {"version": "unknown"}


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
