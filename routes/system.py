"""
System Routes

GET  /api/health             — health check
GET  /api/config             — safe config for frontend
GET  /api/version            — app version
GET  /maintenance            — maintenance page
POST /api/toggle-maintenance — toggle maintenance mode
GET  /                       — serve frontend
"""
import json
import logging
import os
from datetime import datetime
from pathlib import Path

# Resolve static paths relative to this package (works in Docker regardless of CWD)
_STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
_INDEX_HTML = _STATIC_DIR / "index.html"
_MAINTENANCE_HTML = _STATIC_DIR / "maintenance.html"

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

import services.redis_session as redis_store

# Rate limiter - from config.features
try:
    from services.rate_limiter import get_rate_limiter
    from config import is_rate_limiter_enabled
    _rate_limiter_enabled = is_rate_limiter_enabled()
except ImportError:
    _rate_limiter_enabled = False

logger = logging.getLogger(__name__)

router = APIRouter(tags=["system"])


# ============== Maintenance Mode ==============

MAINTENANCE_MODE = os.getenv("MAINTENANCE_MODE", "false").lower() == "true"
_maintenance_file = os.path.join(os.getcwd(), ".maintenance")


def is_maintenance_mode() -> bool:
    """Check if maintenance mode is enabled."""
    if os.getenv("MAINTENANCE_MODE", "").lower() == "true":
        return True
    return os.path.exists(_maintenance_file)


# ============== Health / Version ==============

@router.get("/api/health")
async def health_check():
    """Health check endpoint with system status."""
    health = {
        "status": "healthy",
        "service": "model-hunter",
        "timestamp": datetime.utcnow().isoformat() + "Z"
    }
    
    try:
        stats = await redis_store.get_stats()
        health["redis"] = {
            "status": stats["status"],
            "backend": stats["backend"],
            "active_sessions": stats["active_sessions"]
        }
    except Exception as e:
        health["redis"] = {"status": "error", "error": str(e)}
    
    if _rate_limiter_enabled:
        try:
            limiter = get_rate_limiter()
            health["rate_limiter"] = limiter.get_stats()
        except Exception as e:
            health["rate_limiter"] = {"status": "error", "error": str(e)}
    
    return health


@router.get("/api/config")
async def get_config():
    """Return safe config subset for frontend (app, hunt, features — no secrets)."""
    from config import get_app_config
    return get_app_config()


@router.post("/api/reload-config")
async def reload_config():
    """Reload global.yaml config cache. Called by admin panel after config changes."""
    try:
        from agentic_reviewer.config_loader import reload_config as _reload
        _reload()
        from agentic_reviewer.team_config import reload as _reload_team
        _reload_team()
        return {"ok": True, "message": "Config and team caches reloaded"}
    except Exception as e:
        logger.error("Config reload failed: %s", e)
        return JSONResponse(status_code=500, content={"detail": f"Reload failed: {e}"})


@router.get("/api/version")
async def get_version():
    """Get app version for soft-reload detection. Recomputes on every call to detect file changes after deploy."""
    from main import _compute_app_version
    version = _compute_app_version()
    return Response(
        content=json.dumps({"version": version}),
        media_type="application/json",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}
    )


# ============== Maintenance / Frontend ==============

@router.get("/maintenance")
async def maintenance_page():
    """Serve the maintenance/downtime page."""
    return FileResponse(str(_MAINTENANCE_HTML))


@router.post("/api/toggle-maintenance")
async def toggle_maintenance():
    """Toggle maintenance mode on/off (simple toggle, no auth needed)."""
    global MAINTENANCE_MODE
    
    if is_maintenance_mode():
        if os.path.exists(_maintenance_file):
            os.remove(_maintenance_file)
        return {"maintenance_mode": False, "message": "Maintenance mode disabled. Door is open!"}
    else:
        with open(_maintenance_file, 'w') as f:
            f.write("maintenance")
        return {"maintenance_mode": True, "message": "Maintenance mode enabled. Door is closed!"}


@router.get("/")
async def root(request: Request):
    """Serve the main frontend page or redirect to maintenance."""
    try:
        if is_maintenance_mode():
            return FileResponse(str(_MAINTENANCE_HTML))
        if not _INDEX_HTML.exists():
            logger.error("index.html not found at %s (static_dir=%s)", _INDEX_HTML, _STATIC_DIR)
            return JSONResponse(
                status_code=500,
                content={"detail": f"index.html not found at {_INDEX_HTML}"}
            )
        return FileResponse(str(_INDEX_HTML))
    except Exception as e:
        logger.exception("Error serving root: %s", e)
        raise
