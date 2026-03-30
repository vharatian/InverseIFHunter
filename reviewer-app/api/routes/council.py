"""Reviewer-side LLM council: streams rule-by-rule QC results via SSE."""
import json
import logging
import sys
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from api.deps import require_reviewer
from services import get_session_dict

logger = logging.getLogger(__name__)

_agentic_root = Path(__file__).resolve().parent.parent.parent.parent
if str(_agentic_root) not in sys.path:
    sys.path.insert(0, str(_agentic_root))

router = APIRouter(prefix="/api", tags=["council"])


@router.post("/tasks/{session_id}/council-stream")
async def council_stream(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    Run LLM council QC against a submitted task.
    Streams SSE events: rule_start, council_model_*, rule_done, complete.
    """
    session_dict = await get_session_dict(session_id)
    if session_dict is None:
        raise HTTPException(status_code=404, detail="Session not found")

    try:
        from agentic_reviewer.snapshot_builder import build_snapshot
        snapshot = build_snapshot(session_dict, "final")
    except Exception as e:
        logger.warning("Snapshot build failed for council: %s", e)
        raise HTTPException(
            status_code=422,
            detail=f"Cannot build snapshot: {e}. Task may not have 4 human reviews.",
        )

    from agentic_reviewer.stream import stream_review_events

    def gen():
        yield ": " + (" " * 2040) + "\n\n"
        try:
            for chunk in stream_review_events(snapshot):
                yield chunk
        except Exception as e:
            logger.exception("Council stream error")
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
