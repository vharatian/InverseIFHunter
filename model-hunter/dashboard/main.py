"""
Model Hunter Dashboard

Separate FastAPI service for monitoring Model Hunter usage.
Reads telemetry logs and provides aggregated metrics via API.

Run on a different port (8001) from the main app (8000):
    python dashboard/main.py
"""
import os
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from log_reader import get_log_reader, LogReader


# Configuration
DASHBOARD_PORT = int(os.getenv("DASHBOARD_PORT", "8001"))
LOG_PATH = os.getenv("TELEMETRY_LOG_PATH", None)  # Defaults to .telemetry/events.jsonl


# Lifespan handler
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    print(f"📊 Model Hunter Dashboard starting on port {DASHBOARD_PORT}...")
    log_reader = get_log_reader(LOG_PATH)
    print(f"   Reading logs from: {log_reader.log_path}")
    yield
    # Shutdown
    print("📊 Dashboard shutting down...")


# Create FastAPI app
app = FastAPI(
    title="Model Hunter Dashboard",
    description="Monitoring dashboard for Model Hunter usage",
    version="1.0.0",
    lifespan=lifespan
)


# ============== API Endpoints ==============


@app.get("/api/overview")
async def get_overview(hours: int = Query(default=24, ge=1, le=168)):
    """
    Get overview statistics for the dashboard.
    
    Args:
        hours: Time window in hours (default 24, max 168/1 week)
    """
    log_reader = get_log_reader()
    return log_reader.get_overview(hours=hours)


@app.get("/api/events")
async def get_events(
    limit: int = Query(default=50, ge=1, le=200),
    event_type: Optional[str] = Query(default=None)
):
    """
    Get recent events for the live feed.
    
    Args:
        limit: Maximum number of events (default 50, max 200)
        event_type: Filter by event type (e.g., "api_call_start", "hunt_complete")
    """
    log_reader = get_log_reader()
    events = log_reader.get_recent_events(limit=limit, event_type=event_type)
    return {"count": len(events), "events": events}


@app.get("/api/timeline")
async def get_timeline(
    hours: int = Query(default=24, ge=1, le=168),
    bucket_minutes: int = Query(default=60, ge=5, le=360)
):
    """
    Get event counts over time for charts.
    
    Args:
        hours: Time window in hours
        bucket_minutes: Size of each time bucket in minutes
    """
    log_reader = get_log_reader()
    return log_reader.get_timeline(hours=hours, bucket_minutes=bucket_minutes)


@app.get("/api/models")
async def get_model_stats(hours: int = Query(default=24, ge=1, le=168)):
    """
    Get model usage statistics.
    
    Args:
        hours: Time window in hours
    """
    log_reader = get_log_reader()
    return log_reader.get_model_stats(hours=hours)


@app.get("/api/sessions")
async def get_sessions(limit: int = Query(default=20, ge=1, le=100)):
    """
    Get list of recent sessions.
    
    Args:
        limit: Maximum number of sessions
    """
    log_reader = get_log_reader()
    sessions = log_reader.get_session_list(limit=limit)
    return {"count": len(sessions), "sessions": sessions}


@app.get("/api/search")
async def search_events(
    q: str = Query(..., min_length=1, description="Search query"),
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=100, ge=1, le=500)
):
    """
    Search across all events.
    
    Searches: session IDs, notebooks, models, errors, responses, reasoning, criteria.
    
    Args:
        q: Search query (required)
        hours: Time window in hours (default 7 days, max 30 days)
        limit: Maximum results
    """
    log_reader = get_log_reader()
    results = log_reader.search_events(query=q, hours=hours, limit=limit)
    return {
        "query": q,
        "count": len(results),
        "results": results
    }


@app.get("/api/costs")
async def get_costs(hours: int = Query(default=24, ge=1, le=720)):
    """
    Get cost summary for API usage.
    
    Args:
        hours: Time window in hours
    """
    log_reader = get_log_reader()
    return log_reader.get_cost_summary(hours=hours)


@app.get("/api/hunts")
async def get_detailed_hunts(
    hours: int = Query(default=24, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200)
):
    """Get detailed list of hunt results."""
    log_reader = get_log_reader()
    hunts = log_reader.get_detailed_hunts(hours=hours, limit=limit)
    return {"count": len(hunts), "hunts": hunts}


@app.get("/api/calls")
async def get_detailed_calls(
    hours: int = Query(default=24, ge=1, le=720),
    limit: int = Query(default=100, ge=1, le=500)
):
    """Get detailed list of API calls with costs."""
    log_reader = get_log_reader()
    calls = log_reader.get_detailed_api_calls(hours=hours, limit=limit)
    return {"count": len(calls), "calls": calls}


@app.get("/api/breaks")
async def get_breaks(
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200)
):
    """Get list of breaking responses (score 0)."""
    log_reader = get_log_reader()
    breaks = log_reader.get_breaks_list(hours=hours, limit=limit)
    return {"count": len(breaks), "breaks": breaks}


@app.get("/api/failures")
async def get_failures(
    hours: int = Query(default=168, ge=1, le=720),
    limit: int = Query(default=50, ge=1, le=200)
):
    """Get list of failures (API errors and hunt errors)."""
    log_reader = get_log_reader()
    failures = log_reader.get_failures_list(hours=hours, limit=limit)
    return {"count": len(failures), "failures": failures}


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    log_reader = get_log_reader()
    log_exists = log_reader.log_path.exists()
    return {
        "status": "healthy",
        "service": "model-hunter-dashboard",
        "log_file": str(log_reader.log_path),
        "log_exists": log_exists
    }


# ============== Static Files & Frontend ==============


# Mount static files
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def root():
    """Serve the dashboard page."""
    index_path = static_dir / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return {"message": "Dashboard UI not found. API is available at /api/overview"}


# ============== Run with uvicorn ==============


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=DASHBOARD_PORT,
        reload=True
    )
