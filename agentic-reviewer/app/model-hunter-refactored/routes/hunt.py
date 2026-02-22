"""
Hunt Routes

POST /api/start-hunt                   — start hunt (non-streaming)
GET  /api/hunt-stream/{session_id}     — SSE hunt progress stream
GET  /api/results/{session_id}         — get all accumulated results
GET  /api/breaking-results/{session_id} — get breaking (score 0) results
GET  /api/review-results/{session_id}  — get 4 results for human review
GET  /api/models                       — available models list
"""
import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from models.schemas import HuntConfig, HuntStatus
from services.hunt_engine import hunt_engine
from helpers.shared import _get_validated_session, _log_telemetry_safe, _telemetry_enabled
import services.redis_session as redis_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["hunt"])


class StartHuntRequest(BaseModel):
    session_id: str
    config: Optional[HuntConfig] = None


@router.post("/start-hunt")
async def start_hunt(request: StartHuntRequest):
    """Start a hunt (non-streaming, returns when complete)."""
    session = await _get_validated_session(request.session_id)
    
    if request.config:
        session.config = request.config
        session.total_hunts = request.config.parallel_workers
        await redis_store.set_config(request.session_id, request.config)
        await redis_store.set_meta_field(request.session_id, "total_hunts", request.config.parallel_workers)
    
    result_session = await hunt_engine.run_hunt(request.session_id)
    
    return {
        "success": True,
        "session_id": result_session.session_id,
        "status": result_session.status.value,
        "completed_hunts": result_session.completed_hunts,
        "breaks_found": result_session.breaks_found,
        "results": [r.model_dump() for r in result_session.results]
    }


@router.get("/hunt-stream/{session_id}")
async def hunt_stream(session_id: str, request: Request):
    """
    SSE endpoint for real-time hunt progress.

    Submits a hunt job to the Redis job queue (processed by hunt_worker).
    Subscribes to the Redis event stream for live updates.
    On reconnect (Last-Event-ID): replays missed events, no new job submitted.
    Hunt execution is fully decoupled — survives container restarts.
    """
    import services.event_stream as event_stream
    from services.hunt_worker import submit_hunt_job

    session = await _get_validated_session(session_id)

    last_event_id = request.headers.get("Last-Event-ID")
    is_reconnect = bool(last_event_id)

    async def event_generator():
        try:
            if is_reconnect:
                missed = await event_stream.replay(session_id, last_event_id)
                for eid, event in missed:
                    yield {
                        "id": eid,
                        "event": event.event_type,
                        "retry": 500,
                        "data": json.dumps({
                            "hunt_id": event.hunt_id,
                            **event.data
                        })
                    }
                    if event.event_type in ("complete", "error"):
                        return
            else:
                await submit_hunt_job(session_id)

            async for eid, event in event_stream.subscribe(session_id, last_event_id):
                if await request.is_disconnected():
                    break

                if event is None:
                    yield {"event": "ping", "data": "{}"}
                    continue

                yield {
                    "id": eid,
                    "event": event.event_type,
                    "retry": 500,
                    "data": json.dumps({
                        "hunt_id": event.hunt_id,
                        **event.data
                    })
                }

                if event.event_type in ("complete", "error"):
                    break

        except asyncio.CancelledError:
            pass

    return EventSourceResponse(event_generator())


# ============== Results ==============

@router.get("/results/{session_id}")
async def get_all_results(session_id: str):
    """Get ALL results for a session (for selection UI) - accumulated across all runs."""
    merged_results = await hunt_engine._get_all_accumulated_results_async(session_id)

    if not merged_results:
        return JSONResponse(
            content={"count": 0, "results": [], "accumulated_count": 0},
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"}
        )

    all_accumulated = await redis_store.get_all_results(session_id)

    if _telemetry_enabled:
        _log_telemetry_safe("results_viewed", {
            "session_id": session_id,
            "total_results": len(merged_results),
            "breaking_results": sum(1 for r in merged_results if r.judge_score == 0),
            "accumulated_count": len(all_accumulated)
        })

    return JSONResponse(
        content={
            "count": len(merged_results),
            "results": [r.model_dump() for r in merged_results],
            "accumulated_count": len(all_accumulated)
        },
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"}
    )


@router.get("/breaking-results/{session_id}")
async def get_breaking_results(session_id: str):
    """Get only the breaking (score 0) results."""
    results = await hunt_engine.get_breaking_results_async(session_id)
    return {
        "count": len(results),
        "results": [r.model_dump() for r in results]
    }


@router.get("/review-results/{session_id}")
async def get_review_results(session_id: str):
    """
    Get 4 selected responses for human review.
    Priority: 4 failed (score 0) OR 3 failed + 1 passed.
    """
    results = await hunt_engine.get_selected_for_review_async(session_id, target_count=4)
    return {
        "count": len(results),
        "results": [r.model_dump() for r in results],
        "summary": {
            "failed_count": len([r for r in results if r.judge_score == 0]),
            "passed_count": len([r for r in results if r.judge_score >= 1])
        }
    }


@router.get("/models")
async def get_available_models():
    """Get available models for hunting."""
    from services.openrouter_client import OpenRouterClient
    return {
        "models": OpenRouterClient.MODELS,
        "judge_models": ["gpt-5", "gpt-4o", "gpt-4-turbo"]
    }
