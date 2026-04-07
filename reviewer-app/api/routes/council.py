"""Reviewer-side LLM council: streams rule-by-rule QC results via SSE."""
import json
import logging
import sys
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from api.deps import require_reviewer
from api.ih_pg import insert_reviewer_council_run
from services import get_session_dict
from services.audit_store import append_audit

logger = logging.getLogger(__name__)

_agentic_root = Path(__file__).resolve().parent.parent.parent.parent
if str(_agentic_root) not in sys.path:
    sys.path.insert(0, str(_agentic_root))

router = APIRouter(prefix="/api", tags=["council"])


@router.post("/tasks/{session_id}/council-stream")
async def council_stream(
    session_id: str,
    reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    Run LLM council QC against a submitted task.
    Streams SSE events: rule_start, council_model_*, rule_done, complete.
    Persists full rule payloads + complete summary to qc_runs after success.
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

    async def agen():
        yield ": " + (" " * 2040) + "\n\n"
        rule_dones: list = []
        complete_payload = None
        try:
            for chunk in stream_review_events(snapshot):
                yield chunk
                if not isinstance(chunk, str) or not chunk.startswith("data: "):
                    continue
                line = chunk[6:].strip()
                if not line or line.startswith(":"):
                    continue
                try:
                    payload = json.loads(line.split("\n", 1)[0])
                except json.JSONDecodeError:
                    continue
                t = payload.get("type")
                if t == "rule_done":
                    rule_dones.append(payload)
                elif t == "complete":
                    complete_payload = payload
        except Exception as e:
            logger.exception("Council stream error")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            return

        if complete_payload is not None:
            merged = {
                "complete": complete_payload,
                "rule_results": rule_dones,
                "reviewer_email": reviewer,
                "session_id": session_id,
            }
            rules_applied = [r.get("rule_id") for r in rule_dones if r.get("rule_id")]
            try:
                await insert_reviewer_council_run(session_id, merged, rules_applied)
                await append_audit(
                    session_id,
                    "council_complete",
                    reviewer,
                    {"passed": complete_payload.get("passed"), "rules": rules_applied},
                )
            except Exception:
                logger.exception("Failed to persist council run for session %s", session_id)
                yield (
                    "data: "
                    + json.dumps(
                        {
                            "type": "persist_warning",
                            "message": "Council finished but results could not be saved to the database.",
                        }
                    )
                    + "\n\n"
                )

    return StreamingResponse(
        agen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
