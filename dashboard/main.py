"""
Model Hunter Dashboard

Separate FastAPI service with trainer analytics, criteria analysis,
and ML-ready insights.

Run: python dashboard/main.py
"""
import glob as _glob
import hashlib as _hashlib
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Optional, List
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware

from log_reader import get_log_reader
from auth import (
    is_auth_configured,
    verify_admin,
    verify_csrf,
    CSRF_COOKIE_NAME,
    _generate_csrf_token,
    COOKIE_SECURE,
    COOKIE_SAMESITE,
    COOKIE_MAX_AGE,
)
from sse import dashboard_stream, admin_stream, start_tailer, stop_tailer

try:
    _repo_root = str(Path(__file__).resolve().parent.parent)
    if _repo_root not in sys.path:
        sys.path.insert(0, _repo_root)
    from config_routing import ADMIN_PREFIX
except ImportError:
    ADMIN_PREFIX = "/admin"

from admin.routes.auth_routes import router as admin_auth_router
from admin.routes.team_routes import router as admin_team_router
from admin.routes.config_routes import router as admin_config_router
from admin.routes.tracking_routes import router as admin_tracking_router
from admin.routes.dashboard_admin_routes import router as admin_dashboard_router
from admin.routes.data_routes import router as admin_data_router


# Configuration
DASHBOARD_PORT = int(os.getenv("DASHBOARD_PORT", "8001"))
LOG_PATH = os.getenv("TELEMETRY_LOG_PATH", None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"Model Hunter Enhanced Dashboard starting on port {DASHBOARD_PORT}...")
    if not is_auth_configured():
        msg = (
            "ADMIN_PASSWORD is not set. The dashboard refuses to start without auth. "
            "Set ADMIN_PASSWORD (and SESSION_SECRET) before launch."
        )
        if os.environ.get("DASHBOARD_ALLOW_INSECURE") == "1":
            print(f"WARNING: {msg} (DASHBOARD_ALLOW_INSECURE=1; continuing)")
        else:
            raise RuntimeError(msg)
    log_reader = get_log_reader(LOG_PATH)
    print(f"   Reading logs from: {log_reader.log_path}")
    print(f"   Session storage: {log_reader.storage_path}")
    try:
        start_tailer(log_reader.log_path)
        print("   Telemetry tailer: started")
    except Exception as exc:
        print(f"   Telemetry tailer: not started ({exc})")
    try:
        from agentic_reviewer.config_loader import start_redis_reload_listener as _cfg_sub
        from agentic_reviewer.team_config import start_redis_reload_listener as _team_sub
        _cfg_sub()
        _team_sub()
        print("   Config/team Redis reload listeners: started")
    except Exception as exc:
        print(f"   Config/team Redis reload listeners: not started ({exc})")
    yield
    try:
        await stop_tailer()
    except Exception:
        pass
    print("Dashboard shutting down...")


app = FastAPI(
    title="Model Hunter Enhanced Dashboard",
    description="Monitoring dashboard with trainer analytics",
    version="2.0.0",
    lifespan=lifespan
)

_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("ALLOWED_ORIGINS", "").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS or ["http://localhost", "http://localhost:8001"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "x-csrf-token"],
)


_request_log = logging.getLogger("mth.request")
if not _request_log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(message)s"))
    _request_log.addHandler(_h)
    _request_log.setLevel(os.environ.get("MTH_LOG_LEVEL", "INFO").upper())
    _request_log.propagate = False


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    """Structured request/response logging with X-Request-Id propagation."""
    req_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    request.state.request_id = req_id
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        try:
            dur_ms = (time.perf_counter() - start) * 1000.0
            entry = {
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "req_id": req_id,
                "method": request.method,
                "path": request.url.path,
                "status": status,
                "dur_ms": round(dur_ms, 2),
                "client": (request.client.host if request.client else None),
            }
            _request_log.info(json.dumps(entry, separators=(",", ":")))
            if "response" in locals():
                response.headers["X-Request-Id"] = req_id
        except Exception:
            pass


@app.middleware("http")
async def csrf_middleware(request: Request, call_next):
    """Enforce CSRF double-submit on all mutating requests."""
    method = request.method.upper()
    if method not in ("GET", "HEAD", "OPTIONS"):
        try:
            verify_csrf(request)
        except Exception as exc:
            from fastapi.responses import JSONResponse
            status = getattr(exc, "status_code", 403)
            detail = getattr(exc, "detail", "CSRF token invalid")
            return JSONResponse({"detail": detail}, status_code=status)
    response = await call_next(request)
    # Ensure a CSRF cookie is always present so clients have a token to echo back.
    if not request.cookies.get(CSRF_COOKIE_NAME):
        response.set_cookie(
            key=CSRF_COOKIE_NAME,
            value=_generate_csrf_token(),
            max_age=COOKIE_MAX_AGE,
            httponly=False,
            samesite=COOKIE_SAMESITE,
            secure=COOKIE_SECURE,
        )
    return response


# Monorepo: InverseIFHunter/static/js/updates | Docker (context ./dashboard): dashboard/static/js/updates
_dash_root = Path(__file__).resolve().parent
_updates_candidates = [
    _dash_root.parent / "static" / "js" / "updates",
    _dash_root / "static" / "js" / "updates",
]
_updates_js = next((p for p in _updates_candidates if p.is_dir()), None)
if _updates_js:
    app.mount(
        "/updates-assets",
        StaticFiles(directory=str(_updates_js)),
        name="updates-assets",
    )


_version_cache: dict = {"mtime": 0.0, "value": "", "checked_at": 0.0}
_VERSION_FILES_CACHE: list = []
_VERSION_FILES_REFRESH_SEC = 30


def _refresh_version_file_list() -> list:
    """Rebuild the watched-file list at most every _VERSION_FILES_REFRESH_SEC seconds."""
    global _VERSION_FILES_CACHE
    now = time.time()
    last = _version_cache.get("files_refreshed_at", 0.0)
    if _VERSION_FILES_CACHE and now - last < _VERSION_FILES_REFRESH_SEC:
        return _VERSION_FILES_CACHE
    dash_root = Path(__file__).resolve().parent
    repo_root = dash_root.parent
    patterns = [
        str(dash_root / "static" / "**" / "*.html"),
        str(dash_root / "static" / "**" / "*.js"),
        str(dash_root / "static" / "**" / "*.css"),
        str(dash_root / "**" / "*.py"),
        str(repo_root / "updates" / "*.md"),
    ]
    files: list = []
    for pat in patterns:
        files.extend(_glob.glob(pat, recursive=True))
    files.sort()
    _VERSION_FILES_CACHE = files
    _version_cache["files_refreshed_at"] = now
    return files


def _compute_dashboard_version_cached() -> str:
    """mtime-keyed soft-reload version; recomputes only when any watched file changed."""
    files = _refresh_version_file_list()
    max_mtime = 0.0
    for f in files:
        try:
            m = os.path.getmtime(f)
            if m > max_mtime:
                max_mtime = m
        except OSError:
            continue
    if max_mtime == _version_cache.get("mtime") and _version_cache.get("value"):
        return _version_cache["value"]
    content_hash = _hashlib.md5()
    for f in files:
        try:
            with open(f, "rb") as fh:
                content_hash.update(fh.read())
        except OSError:
            continue
    value = f"dash.{content_hash.hexdigest()[:10]}"
    _version_cache["mtime"] = max_mtime
    _version_cache["value"] = value
    _version_cache["checked_at"] = time.time()
    return value


@app.get("/api/version")
async def get_app_version():
    """Version for soft-reload detection (publicly readable; no secrets)."""
    version = _compute_dashboard_version_cached()
    return Response(
        content=json.dumps({"version": version}),
        media_type="application/json",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        },
    )


# ============== Protected Dashboard API ==============

from fastapi import APIRouter

api_router = APIRouter(prefix="/api", dependencies=[Depends(verify_admin)])


@api_router.get("/overview")
async def get_overview(
    hours: int = Query(default=24, ge=1, le=720),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """Get overview statistics."""
    log_reader = get_log_reader()
    return log_reader.get_overview(hours=hours, trainer_emails=trainer_emails)


@api_router.get("/events")
async def get_events(
    limit: int = Query(default=50, ge=1, le=200),
    event_type: Optional[str] = Query(default=None),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """Get recent events."""
    log_reader = get_log_reader()
    events = log_reader.get_recent_events(
        limit=limit, event_type=event_type, trainer_emails=trainer_emails
    )
    return {"count": len(events), "events": events}


@api_router.get("/timeline")
async def get_timeline(
    hours: int = Query(default=24, ge=1, le=168),
    bucket_minutes: int = Query(default=60, ge=5, le=360),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """Get event timeline."""
    log_reader = get_log_reader()
    return log_reader.get_timeline(
        hours=hours, bucket_minutes=bucket_minutes, trainer_emails=trainer_emails
    )


@api_router.get("/models")
async def get_model_stats(hours: int = Query(default=24, ge=1, le=168)):
    """Get model statistics."""
    log_reader = get_log_reader()
    return log_reader.get_model_stats(hours=hours)


@api_router.get("/sessions")
async def get_sessions(limit: int = Query(default=20, ge=1, le=100)):
    """Get recent sessions."""
    log_reader = get_log_reader()
    sessions = log_reader.get_session_list(limit=limit)
    return {"count": len(sessions), "sessions": sessions}


@api_router.get("/search")
async def search_events(
    q: str = Query(..., min_length=1),
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=100, ge=1, le=500)
):
    """Search events."""
    log_reader = get_log_reader()
    results = log_reader.search_events(query=q, hours=hours, limit=limit)
    return {"query": q, "count": len(results), "results": results}


@api_router.get("/costs")
async def get_costs(hours: int = Query(default=24, ge=1, le=720)):
    """Get cost summary."""
    log_reader = get_log_reader()
    return log_reader.get_cost_summary(hours=hours)


@api_router.get("/hunts")
async def get_detailed_hunts(
    hours: int = Query(default=24, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """Get detailed hunts."""
    log_reader = get_log_reader()
    hunts = log_reader.get_detailed_hunts(
        hours=hours, limit=limit, trainer_emails=trainer_emails
    )
    return {"count": len(hunts), "hunts": hunts}


@api_router.get("/calls")
async def get_detailed_calls(
    hours: int = Query(default=24, ge=1, le=720),
    limit: int = Query(default=100, ge=1, le=500),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """Get detailed API calls."""
    log_reader = get_log_reader()
    calls = log_reader.get_detailed_api_calls(
        hours=hours, limit=limit, trainer_emails=trainer_emails
    )
    return {"count": len(calls), "calls": calls}


@api_router.get("/breaks")
async def get_breaks(
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """Get breaks list."""
    log_reader = get_log_reader()
    breaks = log_reader.get_breaks_list(
        hours=hours, limit=limit, trainer_emails=trainer_emails
    )
    return {"count": len(breaks), "breaks": breaks}


@api_router.get("/failures")
async def get_failures(
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """Get failures list."""
    log_reader = get_log_reader()
    failures = log_reader.get_failures_list(
        hours=hours, limit=limit, trainer_emails=trainer_emails
    )
    return {"count": len(failures), "failures": failures}


# ============== NEW: Trainer Analytics ==============

@api_router.get("/trainers")
async def get_trainer_leaderboard(
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=20, ge=1, le=100)
):
    """
    Get trainer leaderboard ranked by breaks found.
    """
    log_reader = get_log_reader()
    return log_reader.get_trainer_leaderboard(hours=hours, limit=limit)


@api_router.get("/criteria")
async def get_criteria_analysis(hours: int = Query(default=168, ge=1, le=720)):
    """
    Get criteria difficulty analysis.
    """
    log_reader = get_log_reader()
    return log_reader.get_criteria_analysis(hours=hours)


@api_router.get("/weekday_activity")
async def get_weekday_activity(
    hours: int = Query(default=168, ge=1, le=720),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """Hunt results aggregated by weekday (trainer filter applies)."""
    log_reader = get_log_reader()
    return log_reader.get_weekday_hunt_activity(
        hours=hours, trainer_emails=trainer_emails
    )


@api_router.get("/activity_heatmap")
async def get_activity_heatmap(
    hours: int = Query(default=168, ge=1, le=720),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """Hunt results bucketed by weekday x hour-of-day (7x24 grid)."""
    log_reader = get_log_reader()
    return log_reader.get_activity_heatmap(
        hours=hours, trainer_emails=trainer_emails
    )


@api_router.get("/latency_distribution")
async def get_latency_distribution(
    hours: int = Query(default=24, ge=1, le=720),
    trainer_emails: Optional[List[str]] = Query(default=None),
):
    """API-call latency percentiles + log-spaced histogram."""
    log_reader = get_log_reader()
    return log_reader.get_latency_distribution(
        hours=hours, trainer_emails=trainer_emails
    )


@api_router.get("/realtime")
async def get_realtime_stats():
    """
    Get real-time stats (last 5 minutes).
    """
    log_reader = get_log_reader()
    return log_reader.get_realtime_stats()


@api_router.get("/health")
async def health_check():
    """Health check."""
    log_reader = get_log_reader()
    return {
        "status": "healthy",
        "service": "model-hunter-dashboard-v2",
        "log_exists": log_reader.log_path.exists(),
        "storage_exists": log_reader.storage_path.exists()
    }


app.include_router(api_router)


# Live streams (SSE)
app.get("/api/stream")(dashboard_stream)
app.get("/api/admin/stream")(admin_stream)


# ============== Admin Panel ==============

app.include_router(admin_auth_router)
app.include_router(admin_team_router)
app.include_router(admin_config_router)
app.include_router(admin_tracking_router)
app.include_router(admin_dashboard_router)
app.include_router(admin_data_router)

# Admin UI
admin_static_dir = Path(__file__).parent / "static" / "admin"


@app.get(ADMIN_PREFIX + "/")
async def admin_ui():
    """Serve admin panel UI."""
    admin_index = admin_static_dir / "index.html"
    if admin_index.exists():
        return FileResponse(str(admin_index))
    return {"message": "Admin UI not found."}


if admin_static_dir.exists():
    app.mount(ADMIN_PREFIX + "/static", StaticFiles(directory=str(admin_static_dir)), name="admin-static")


# ============== Static Files ==============

static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

# Shared static assets — parent repo's static_shared/ mounted at /static_shared.
_shared_static = Path(__file__).parent.parent / "static_shared"
if _shared_static.exists():
    app.mount("/static_shared", StaticFiles(directory=str(_shared_static)), name="static-shared")


@app.get("/")
async def root():
    """Serve dashboard."""
    index_path = static_dir / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return {"message": "Dashboard UI not found. API available at /api/overview"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=DASHBOARD_PORT, reload=True)
