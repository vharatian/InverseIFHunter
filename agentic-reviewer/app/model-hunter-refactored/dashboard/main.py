"""
Model Hunter Admin Intelligence Dashboard

Password-protected analytics dashboard with:
- Pre-computed analytics cache (60s refresh)
- Trainer timing and activity tracking
- ML break predictions
- Criteria, judge, prompt, and cost analytics
- Data Lab ML-ready exports
- Real-time SSE live feed
"""
import os
import sys
import json
import asyncio
from datetime import datetime, timedelta
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, Request, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from auth import (
    is_auth_configured, verify_password, create_session_token,
    set_auth_cookie, clear_auth_cookie, verify_admin, verify_super_admin,
    is_approved_admin, add_admin, remove_admin, get_admin_list, get_current_user,
    get_test_accounts_full, add_test_account, remove_test_account,
)
from analytics_cache import AnalyticsCacheManager

# Optional SSE import
try:
    from sse_starlette.sse import EventSourceResponse
    _sse_available = True
except ImportError:
    _sse_available = False


# ============== App Setup ==============

cache_manager = AnalyticsCacheManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start analytics cache on startup, stop on shutdown."""
    if not is_auth_configured():
        print("WARNING: ADMIN_PASSWORD not set. Dashboard authentication disabled!")
        print("Set the ADMIN_PASSWORD environment variable to enable auth.")
    await cache_manager.start(app)
    yield
    await cache_manager.stop()


app = FastAPI(title="Model Hunter Admin Dashboard", lifespan=lifespan)

# Static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")


# ============== Auth Endpoints (No auth required) ==============

class LoginRequest(BaseModel):
    password: str


class EmailLoginRequest(BaseModel):
    email: str


@app.post("/api/login")
async def login(request: LoginRequest, response: Response):
    """Authenticate with super admin password."""
    if not is_auth_configured():
        token = create_session_token(email="super_admin", is_super=True)
        resp = JSONResponse({"success": True, "is_super": True})
        set_auth_cookie(resp, token)
        return resp

    if verify_password(request.password):
        token = create_session_token(email="super_admin", is_super=True)
        resp = JSONResponse({"success": True, "is_super": True})
        set_auth_cookie(resp, token)
        return resp

    raise HTTPException(status_code=401, detail="Invalid password")


@app.post("/api/login-email")
async def login_email(request: EmailLoginRequest):
    """Authenticate with pre-approved Turing email. One-time login, cookie persists."""
    email = request.email.strip().lower()
    if not is_approved_admin(email):
        raise HTTPException(status_code=403, detail="Access not granted. Please contact your admin.")

    token = create_session_token(email=email, is_super=False)
    resp = JSONResponse({"success": True, "is_super": False, "email": email})
    set_auth_cookie(resp, token)
    return resp


@app.post("/api/logout")
async def logout():
    resp = JSONResponse({"success": True})
    clear_auth_cookie(resp)
    return resp


# ============== Admin Management (Super Admin Only) ==============

class AddAdminRequest(BaseModel):
    email: str
    name: str = ""


@app.get("/api/admins", dependencies=[Depends(verify_super_admin)])
async def list_admins():
    """List all approved dashboard admins."""
    return get_admin_list()


@app.post("/api/admins", dependencies=[Depends(verify_super_admin)])
async def add_admin_endpoint(request: AddAdminRequest):
    """Add an admin by email. Super admin only."""
    added = add_admin(request.email, request.name)
    if added:
        return {"success": True, "message": f"{request.email} has been granted access."}
    return {"success": True, "message": f"{request.email} already has access."}


@app.delete("/api/admins/{email}", dependencies=[Depends(verify_super_admin)])
async def remove_admin_endpoint(email: str):
    """Remove an admin by email. Super admin only."""
    removed = remove_admin(email)
    if removed:
        return {"success": True, "message": f"Access revoked for {email}."}
    raise HTTPException(status_code=404, detail=f"{email} not found in admin list.")


@app.get("/api/me", dependencies=[Depends(verify_admin)])
async def get_me(request: Request):
    """Get current user info."""
    user = get_current_user(request)
    if user:
        return {"email": user.get("email", ""), "is_super": user.get("is_super", False)}
    return {"email": "", "is_super": False}


# ============== Test Account Management (Super Admin Only) ==============

class TestAccountRequest(BaseModel):
    email: str
    name: str = ""


@app.get("/api/test-accounts", dependencies=[Depends(verify_super_admin)])
async def list_test_accounts():
    """List all test accounts (excluded from analytics and ML exports)."""
    return get_test_accounts_full()


@app.post("/api/test-accounts", dependencies=[Depends(verify_super_admin)])
async def add_test_account_endpoint(request: TestAccountRequest):
    """Add a test account. Super admin only."""
    added = add_test_account(request.email, request.name)
    if added:
        return {"success": True, "message": f"{request.email} added to test accounts. Their data will be excluded from analytics."}
    return {"success": True, "message": f"{request.email} is already a test account."}


@app.delete("/api/test-accounts/{email}", dependencies=[Depends(verify_super_admin)])
async def remove_test_account_endpoint(email: str):
    """Remove a test account. Super admin only."""
    removed = remove_test_account(email)
    if removed:
        return {"success": True, "message": f"{email} removed from test accounts. Their data will be included in analytics going forward."}
    raise HTTPException(status_code=404, detail=f"{email} not found in test accounts.")


@app.get("/api/health")
async def health():
    snap = cache_manager.get_snapshot()
    return {
        "status": "ok",
        "cache_ready": snap is not None,
        "total_events": snap.total_events if snap else 0,
        "last_refresh": snap.timestamp if snap else None,
        "compute_time_ms": snap.compute_time_ms if snap else None,
    }


# ============== Page Routes ==============

@app.get("/")
async def root(request: Request):
    """Serve login page or dashboard based on auth state."""
    from auth import get_session_token, verify_session_token

    token = get_session_token(request)
    if not is_auth_configured() or (token and verify_session_token(token)):
        return FileResponse(os.path.join(static_dir, "index.html"))
    return FileResponse(os.path.join(static_dir, "login.html"))


# ============== Protected API Endpoints ==============

def _get_snap():
    """Get analytics snapshot or raise 503."""
    snap = cache_manager.get_snapshot()
    if snap is None:
        raise HTTPException(503, "Analytics not ready yet. Please wait ~60 seconds.")
    return snap


# --- Command Center ---

@app.get("/api/overview", dependencies=[Depends(verify_admin)])
async def get_overview():
    snap = _get_snap()
    return snap.overview


@app.get("/api/anomalies", dependencies=[Depends(verify_admin)])
async def get_anomalies():
    snap = _get_snap()
    return snap.anomalies


# --- Trainers ---

@app.get("/api/trainers", dependencies=[Depends(verify_admin)])
async def get_trainers():
    snap = _get_snap()
    trainers = list(snap.trainer_timing.values())
    trainers.sort(key=lambda t: t.get("breaks_per_hour", 0), reverse=True)
    return trainers


@app.get("/api/trainer/{email}", dependencies=[Depends(verify_admin)])
async def get_trainer_detail(email: str):
    snap = _get_snap()
    trainer = snap.trainer_timing.get(email)
    if not trainer:
        raise HTTPException(404, "Trainer not found")
    return trainer


@app.get("/api/online-trainers", dependencies=[Depends(verify_admin)])
async def get_online_trainers():
    snap = _get_snap()
    online = [t for t in snap.trainer_timing.values() if t.get("status") in ("online", "idle")]
    return online


# --- Intelligence ---

@app.get("/api/criteria", dependencies=[Depends(verify_admin)])
async def get_criteria():
    snap = _get_snap()
    return snap.criteria


@app.get("/api/judge", dependencies=[Depends(verify_admin)])
async def get_judge():
    snap = _get_snap()
    return snap.judge


@app.get("/api/prompts", dependencies=[Depends(verify_admin)])
async def get_prompts():
    snap = _get_snap()
    return snap.prompts


@app.get("/api/ml-info", dependencies=[Depends(verify_admin)])
async def get_ml_info():
    if cache_manager._ml:
        return cache_manager._ml.get_model_info()
    return {"loaded": False, "message": "ML model not available"}


class WhatIfRequest(BaseModel):
    base_features: dict
    changes: dict


@app.post("/api/what-if", dependencies=[Depends(verify_admin)])
async def what_if(request: WhatIfRequest):
    if not cache_manager._ml or not cache_manager._ml.is_loaded():
        raise HTTPException(503, "ML model not loaded")
    return cache_manager._ml.what_if(request.base_features, request.changes)


# --- Sessions ---

@app.get("/api/sessions", dependencies=[Depends(verify_admin)])
async def get_sessions(limit: int = Query(50, ge=1, le=200)):
    """Get recent sessions from storage."""
    reader = cache_manager.get_reader()
    sessions = []

    import glob
    storage_path = reader.storage_path
    if storage_path.exists():
        files = sorted(storage_path.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        for f in files[:limit]:
            if f.name == "trainers.json":
                continue
            try:
                with open(f, "r") as fh:
                    data = json.load(fh)
                sessions.append({
                    "session_id": f.stem,
                    "filename": data.get("filename", ""),
                    "trainer_email": data.get("trainer_email", ""),
                    "trainer_name": data.get("trainer_name", ""),
                    "trainer_id": data.get("trainer_id", ""),
                    "created_at": data.get("created_at", ""),
                    "last_accessed": data.get("last_accessed", ""),
                    "url": data.get("url", ""),
                })
            except Exception:
                continue

    return sessions


@app.get("/api/session-replay/{session_id}", dependencies=[Depends(verify_admin)])
async def get_session_replay(session_id: str):
    """Get chronological event timeline for a session."""
    reader = cache_manager.get_reader()
    events = []
    for e in reader.get_all_events():
        data = e.get("data", {})
        if data.get("session_id") == session_id:
            events.append({
                "type": e.get("type"),
                "timestamp": e.get("ts", ""),
                "data": data,
            })

    # Sort chronologically
    events.sort(key=lambda x: x.get("timestamp", ""))
    return events


# --- Models ---

@app.get("/api/models", dependencies=[Depends(verify_admin)])
async def get_models():
    snap = _get_snap()
    return snap.models


# --- Costs ---

@app.get("/api/costs", dependencies=[Depends(verify_admin)])
async def get_costs():
    snap = _get_snap()
    return snap.costs


# --- Data Lab ---

@app.get("/api/export-profiles", dependencies=[Depends(verify_admin)])
async def get_export_profiles():
    from data_export import get_profiles
    return get_profiles()


@app.get("/api/export/{profile_id}", dependencies=[Depends(verify_admin)])
async def export_dataset(
    profile_id: str,
    fmt: str = Query("csv", pattern="^(csv|json|parquet)$"),
    days: int = Query(30, ge=1, le=365)
):
    from data_export import build_dataset, export_to_format

    snap = _get_snap()
    reader = cache_manager.get_reader()
    since = datetime.utcnow() - timedelta(days=days)

    # Filter out test account events from export (same logic as analytics cache)
    all_events = reader.get_all_events()
    excluded_emails = snap.excluded_emails
    excluded_sessions = snap.excluded_sessions
    if excluded_emails or excluded_sessions:
        all_events = [
            e for e in all_events
            if e.get("data", {}).get("trainer_email", "").lower() not in excluded_emails
            and e.get("data", {}).get("session_id", "") not in excluded_sessions
        ]

    # Filter session-to-email mapping
    filtered_s2e = {
        sid: email for sid, email in reader._session_to_email.items()
        if email.lower() not in excluded_emails
    }

    rows = build_dataset(
        profile_id,
        all_events,
        snap.trainer_timing,
        filtered_s2e,
        since=since
    )

    if rows is None:
        raise HTTPException(404, f"Unknown export profile: {profile_id}")

    if not rows:
        raise HTTPException(404, "No data available for this profile and date range")

    data_bytes, content_type, ext = export_to_format(rows, fmt)
    filename = f"model_hunter_{profile_id}_{datetime.utcnow().strftime('%Y%m%d')}.{ext}"

    return Response(
        content=data_bytes,
        media_type=content_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@app.get("/api/export-preview/{profile_id}", dependencies=[Depends(verify_admin)])
async def export_preview(profile_id: str, days: int = Query(30, ge=1, le=365)):
    from data_export import build_dataset

    snap = _get_snap()
    reader = cache_manager.get_reader()
    since = datetime.utcnow() - timedelta(days=days)

    # Filter out test accounts (same as export endpoint)
    all_events = reader.get_all_events()
    excluded_emails = snap.excluded_emails
    excluded_sessions = snap.excluded_sessions
    if excluded_emails or excluded_sessions:
        all_events = [
            e for e in all_events
            if e.get("data", {}).get("trainer_email", "").lower() not in excluded_emails
            and e.get("data", {}).get("session_id", "") not in excluded_sessions
        ]
    filtered_s2e = {
        sid: email for sid, email in reader._session_to_email.items()
        if email.lower() not in excluded_emails
    }

    rows = build_dataset(
        profile_id,
        all_events,
        snap.trainer_timing,
        filtered_s2e,
        since=since
    )

    if rows is None:
        raise HTTPException(404, f"Unknown export profile: {profile_id}")

    return {
        "total_rows": len(rows),
        "preview": rows[:10],
        "columns": list(rows[0].keys()) if rows else [],
    }


# --- System ---

@app.get("/api/system", dependencies=[Depends(verify_admin)])
async def get_system_status():
    snap = _get_snap()
    reader = cache_manager.get_reader()

    # Provider health from recent API calls
    provider_health = {}
    cutoff = datetime.utcnow() - timedelta(hours=1)
    recent = reader.get_events_since(cutoff)

    from collections import defaultdict
    provider_stats = defaultdict(lambda: {"total": 0, "errors": 0, "latencies": []})
    for e in recent:
        if e.get("type") == "api_call_end":
            data = e.get("data", {})
            provider = data.get("provider", "unknown")
            provider_stats[provider]["total"] += 1
            if not data.get("success", True):
                provider_stats[provider]["errors"] += 1
            lat = data.get("latency_ms")
            if lat:
                provider_stats[provider]["latencies"].append(lat)

    for provider, stats in provider_stats.items():
        lats = sorted(stats["latencies"])
        error_rate = stats["errors"] / max(stats["total"], 1)
        status = "ok"
        if error_rate > 0.1:
            status = "degraded"
        if error_rate > 0.3:
            status = "down"

        provider_health[provider] = {
            "status": status,
            "total_calls": stats["total"],
            "error_rate": round(error_rate * 100, 1),
            "p50_latency": lats[len(lats) // 2] if lats else 0,
            "p95_latency": lats[int(len(lats) * 0.95)] if lats else 0,
        }

    return {
        "provider_health": provider_health,
        "cache_age_seconds": _cache_age_seconds(snap),
        "total_events": snap.total_events,
        "compute_time_ms": snap.compute_time_ms,
        "anomalies": snap.anomalies,
    }


def _cache_age_seconds(snap) -> int:
    try:
        ts = datetime.fromisoformat(snap.timestamp.rstrip("Z"))
        return int((datetime.utcnow() - ts).total_seconds())
    except Exception:
        return -1


# --- Live Feed (SSE) ---

@app.get("/api/live-feed", dependencies=[Depends(verify_admin)])
async def live_feed():
    """SSE endpoint for real-time event streaming."""
    if not _sse_available:
        raise HTTPException(501, "SSE not available")

    async def event_generator():
        reader = cache_manager.get_reader()
        last_count = len(reader.get_all_events())

        while True:
            await asyncio.sleep(5)
            current_events = reader.get_all_events()
            if len(current_events) > last_count:
                new_events = current_events[last_count:]
                for e in new_events[-15:]:  # Max 15 events per batch
                    yield {
                        "event": "new_event",
                        "data": json.dumps({
                            "type": e.get("type"),
                            "timestamp": e.get("ts", ""),
                            "data": e.get("data", {}),
                        }, default=str)
                    }
                last_count = len(current_events)

    return EventSourceResponse(event_generator())


# ============== Run ==============

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("DASHBOARD_PORT", "8001"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")
