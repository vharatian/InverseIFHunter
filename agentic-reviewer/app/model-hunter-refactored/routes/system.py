"""
System Routes

GET  /api/health                  — health check
GET  /api/version                 — app version
GET  /api/admin/status            — admin dashboard
GET  /api/admin/active-hunts      — active hunts count
GET  /maintenance                 — maintenance page
POST /api/toggle-maintenance      — toggle maintenance mode
GET  /                            — serve frontend
"""
import json
import logging
import os
from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response

from models.schemas import HuntStatus
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


@router.get("/api/version")
async def get_version():
    """Get app version for soft-reload detection."""
    # Import APP_VERSION from main module (set during startup)
    from main import APP_VERSION
    return Response(
        content=json.dumps({"version": APP_VERSION}),
        media_type="application/json",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}
    )


# ============== Admin ==============

@router.get("/api/admin/status")
async def admin_status():
    """Detailed admin status endpoint with all system metrics."""
    status = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "sessions": {}
    }

    try:
        stats = await redis_store.get_stats()
        redis_sessions = await redis_store.list_sessions()
        status["sessions"] = {
            **stats,
            "session_count": len(redis_sessions),
            "session_ids": redis_sessions[:10]
        }
    except Exception as e:
        status["sessions"] = {"error": str(e)}
    
    if _rate_limiter_enabled:
        try:
            limiter = get_rate_limiter()
            status["rate_limiter"] = limiter.get_stats()
        except Exception as e:
            status["rate_limiter"] = {"error": str(e)}
    
    return status


@router.get("/api/admin/active-hunts")
async def get_active_hunts():
    """
    Return count of sessions with status RUNNING.
    Used by deploy script to wait for active hunts to finish.
    """
    active_count = 0
    active_sessions = []

    all_session_ids = await redis_store.list_sessions()
    for sid in all_session_ids:
        status = await redis_store.get_status(sid)
        if status == HuntStatus.RUNNING:
            meta = await redis_store.get_meta(sid)
            active_count += 1
            active_sessions.append({
                "session_id": sid,
                "current_turn": int(meta.get("current_turn", 1)),
                "completed_hunts": int(meta.get("completed_hunts", 0)),
                "total_hunts": int(meta.get("total_hunts", 0)),
            })
    
    return {
        "count": active_count,
        "sessions": active_sessions,
    }


# ============== Maintenance / Frontend ==============

@router.get("/maintenance")
async def maintenance_page():
    """Serve the maintenance/downtime page."""
    return FileResponse("static/maintenance.html")


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


@router.get("/evaluation-results")
async def evaluation_results_page():
    """Serve the quality check evaluation results page (full slot-by-slot comparison)."""
    return FileResponse("static/evaluation-results.html")


@router.get("/")
async def root(request: Request):
    """Serve the main frontend page or redirect to maintenance."""
    if is_maintenance_mode():
        return FileResponse("static/maintenance.html")
    
    return FileResponse("static/index.html")
