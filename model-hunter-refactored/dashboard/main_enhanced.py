"""
Model Hunter Enhanced Dashboard

Separate FastAPI service with trainer analytics, criteria analysis,
and ML-ready insights.

Run: python dashboard/main_enhanced.py
"""
import os
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from log_reader_enhanced import get_log_reader, EnhancedLogReader


# Configuration
DASHBOARD_PORT = int(os.getenv("DASHBOARD_PORT", "8001"))
LOG_PATH = os.getenv("TELEMETRY_LOG_PATH", None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"📊 Model Hunter Enhanced Dashboard starting on port {DASHBOARD_PORT}...")
    log_reader = get_log_reader(LOG_PATH)
    print(f"   Reading logs from: {log_reader.log_path}")
    print(f"   Session storage: {log_reader.storage_path}")
    yield
    print("📊 Dashboard shutting down...")


app = FastAPI(
    title="Model Hunter Enhanced Dashboard",
    description="Monitoring dashboard with trainer analytics",
    version="2.0.0",
    lifespan=lifespan
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============== Original Endpoints ==============

@app.get("/api/overview")
async def get_overview(hours: int = Query(default=24, ge=1, le=720)):
    """Get overview statistics."""
    log_reader = get_log_reader()
    return log_reader.get_overview(hours=hours)


@app.get("/api/events")
async def get_events(
    limit: int = Query(default=50, ge=1, le=200),
    event_type: Optional[str] = Query(default=None)
):
    """Get recent events."""
    log_reader = get_log_reader()
    events = log_reader.get_recent_events(limit=limit, event_type=event_type)
    return {"count": len(events), "events": events}


@app.get("/api/timeline")
async def get_timeline(
    hours: int = Query(default=24, ge=1, le=168),
    bucket_minutes: int = Query(default=60, ge=5, le=360)
):
    """Get event timeline."""
    log_reader = get_log_reader()
    return log_reader.get_timeline(hours=hours, bucket_minutes=bucket_minutes)


@app.get("/api/models")
async def get_model_stats(hours: int = Query(default=24, ge=1, le=168)):
    """Get model statistics."""
    log_reader = get_log_reader()
    return log_reader.get_model_stats(hours=hours)


@app.get("/api/sessions")
async def get_sessions(limit: int = Query(default=20, ge=1, le=100)):
    """Get recent sessions."""
    log_reader = get_log_reader()
    sessions = log_reader.get_session_list(limit=limit)
    return {"count": len(sessions), "sessions": sessions}


@app.get("/api/search")
async def search_events(
    q: str = Query(..., min_length=1),
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=100, ge=1, le=500)
):
    """Search events."""
    log_reader = get_log_reader()
    results = log_reader.search_events(query=q, hours=hours, limit=limit)
    return {"query": q, "count": len(results), "results": results}


@app.get("/api/costs")
async def get_costs(hours: int = Query(default=24, ge=1, le=720)):
    """Get cost summary."""
    log_reader = get_log_reader()
    return log_reader.get_cost_summary(hours=hours)


@app.get("/api/hunts")
async def get_detailed_hunts(
    hours: int = Query(default=24, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200)
):
    """Get detailed hunts."""
    log_reader = get_log_reader()
    hunts = log_reader.get_detailed_hunts(hours=hours, limit=limit)
    return {"count": len(hunts), "hunts": hunts}


@app.get("/api/calls")
async def get_detailed_calls(
    hours: int = Query(default=24, ge=1, le=720),
    limit: int = Query(default=100, ge=1, le=500)
):
    """Get detailed API calls."""
    log_reader = get_log_reader()
    calls = log_reader.get_detailed_api_calls(hours=hours, limit=limit)
    return {"count": len(calls), "calls": calls}


@app.get("/api/breaks")
async def get_breaks(
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200)
):
    """Get breaks list."""
    log_reader = get_log_reader()
    breaks = log_reader.get_breaks_list(hours=hours, limit=limit)
    return {"count": len(breaks), "breaks": breaks}


@app.get("/api/failures")
async def get_failures(
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200)
):
    """Get failures list."""
    log_reader = get_log_reader()
    failures = log_reader.get_failures_list(hours=hours, limit=limit)
    return {"count": len(failures), "failures": failures}


# ============== NEW: Trainer Analytics ==============

@app.get("/api/trainers")
async def get_trainer_leaderboard(
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=20, ge=1, le=100)
):
    """
    Get trainer leaderboard ranked by breaks found.
    """
    log_reader = get_log_reader()
    return log_reader.get_trainer_leaderboard(hours=hours, limit=limit)


@app.get("/api/criteria")
async def get_criteria_analysis(hours: int = Query(default=168, ge=1, le=720)):
    """
    Get criteria difficulty analysis.
    """
    log_reader = get_log_reader()
    return log_reader.get_criteria_analysis(hours=hours)


@app.get("/api/heatmap")
async def get_activity_heatmap(hours: int = Query(default=168, ge=1, le=720)):
    """
    Get activity heatmap (hour x day of week).
    """
    log_reader = get_log_reader()
    return log_reader.get_activity_heatmap(hours=hours)


@app.get("/api/realtime")
async def get_realtime_stats():
    """
    Get real-time stats (last 5 minutes).
    """
    log_reader = get_log_reader()
    return log_reader.get_realtime_stats()


@app.get("/api/health")
async def health_check():
    """Health check."""
    log_reader = get_log_reader()
    return {
        "status": "healthy",
        "service": "model-hunter-dashboard-v2",
        "log_exists": log_reader.log_path.exists(),
        "storage_exists": log_reader.storage_path.exists()
    }


# ============== Static Files ==============

static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def root():
    """Serve dashboard."""
    index_path = static_dir / "index_enhanced.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    # Fallback to original
    index_path = static_dir / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return {"message": "Dashboard UI not found. API available at /api/overview"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main_enhanced:app", host="0.0.0.0", port=DASHBOARD_PORT, reload=True)
