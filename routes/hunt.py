"""
Hunt Routes

GET  /api/hunt-stream/{session_id}     — SSE hunt progress stream
GET  /api/results/{session_id}         — get all accumulated results
GET  /api/review-results/{session_id}  — get 4 results for human review
"""
import asyncio
import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from services.hunt_engine import hunt_engine
from helpers.shared import _get_validated_session, _log_telemetry_safe, _telemetry_enabled
import services.redis_session as redis_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["hunt"])


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
            "breaking_results": sum(1 for r in merged_results if r.sample_label == "BREAK"),
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
