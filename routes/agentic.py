"""
Agentic Reviewer — Pre-flight and Final QA routes.

Calls agentic_reviewer (lives in parent agentic-reviewer folder).
"""
import sys
import json
from pathlib import Path

# Add agentic-reviewer root to path so we can import agentic_reviewer
_agentic_root = Path(__file__).resolve().parent.parent.parent.parent
if str(_agentic_root) not in sys.path:
    sys.path.insert(0, str(_agentic_root))

import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from helpers.shared import _get_validated_session
from services.hunt_engine import hunt_engine
from routes.agentic_stream import build_content_checked, build_rationale

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["agentic"])


class FinalReviewRequest(BaseModel):
    selected_hunt_ids: list[int]
    human_reviews: dict  # { "hunt_id": { "grades": {...}, "explanation": str, "submitted": bool } }


from agentic_reviewer.stream import (
    build_council_issue as _build_council_issue_shared,
    stream_review_events as _stream_review_events_shared,
)


def _build_council_issue(rule_id, snapshot, votes, params):
    """Delegate to shared module."""
    return _build_council_issue_shared(rule_id, snapshot, votes, params)


def _stream_review_events(snapshot):
    """Delegate to shared module."""
    yield from _stream_review_events_shared(snapshot)


@router.post("/review-final-stream/{session_id}")
async def review_final_stream(session_id: str, req: FinalReviewRequest):
    """
    Run agentic final QA with Server-Sent Events for live UI.
    Streams rule_start, rule_done, then complete.
    """
    if not req.selected_hunt_ids or len(req.selected_hunt_ids) != 4:
        raise HTTPException(
            status_code=400,
            detail="Final review requires selected_hunt_ids with exactly 4 IDs",
        )
    if not req.human_reviews or len(req.human_reviews) < 4:
        raise HTTPException(
            status_code=400,
            detail="Final review requires human_reviews for all 4 selected hunts",
        )

    try:
        from agentic_reviewer import build_snapshot
    except ImportError as e:
        logger.exception("Failed to import agentic_reviewer")
        raise HTTPException(
            status_code=500,
            detail=f"Agentic reviewer not available: {e}",
        )

    session = await _get_validated_session(session_id)
    all_results = await hunt_engine.export_results_async(session_id)

    human_reviews_for_agentic = {}
    for hid in req.selected_hunt_ids:
        key = str(hid)
        if key in req.human_reviews:
            r = req.human_reviews[key]
            grading_basis = r.get("grading_basis") or r.get("grades") or {}
            grades = {k: str(v).lower() for k, v in grading_basis.items()}
            human_reviews_for_agentic[key] = {
                "grades": grades,
                "explanation": str(r.get("explanation", "")),
                "submitted": True,
            }

    session_dict = {
        "session_id": session.session_id,
        "notebook": session.notebook.model_dump() if session.notebook else {},
        "config": session.config.model_dump() if session.config else {},
        "all_results": all_results,
        "current_turn": getattr(session, "current_turn", 1),
        "human_reviews": human_reviews_for_agentic,
    }

    snapshot = build_snapshot(session_dict, "final")

    def gen():
        # 2KB padding (SSE comment) to prevent proxy/browser buffering
        yield ": " + (" " * 2040) + "\n\n"
        try:
            for chunk in _stream_review_events(snapshot):
                yield chunk
        except Exception as e:
            logger.exception("Stream error")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
