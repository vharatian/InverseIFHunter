"""Reviewer-side LLM council: streams rule-by-rule QC results via SSE."""
import json
import logging
import re
import sys
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

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


class NotebookCouncilRequest(BaseModel):
    url: str


def _parse_judge_grades(llm_judge_text: str) -> dict[str, str]:
    """Extract per-criterion PASS/FAIL from LLM judge text like 'C1: PASS\nC2: FAIL'."""
    grades = {}
    for m in re.finditer(r"(C\d+)\s*[:：]\s*(PASS|FAIL)", llm_judge_text, re.IGNORECASE):
        grades[m.group(1).upper()] = m.group(2).upper().lower()
    return grades


def _parse_human_grades(human_judge_text: str) -> dict[str, str]:
    """Extract per-criterion grades from human judge text."""
    grades = {}
    for m in re.finditer(r"(C\d+)\s*[:：]\s*(PASS|FAIL)", human_judge_text, re.IGNORECASE):
        grades[m.group(1).upper()] = m.group(2).upper().lower()
    return grades


def _build_snapshot_from_notebook(preview_data: dict):
    """Build a TaskSnapshot directly from notebook preview data (no session needed)."""
    from agentic_reviewer.schemas import TaskSnapshot, SelectedHunt, HumanReview

    prompt = preview_data.get("prompt", "")
    ideal_response = preview_data.get("ideal_response", "")
    criteria = preview_data.get("criteria", [])
    slots = preview_data.get("slots", [])
    meta = preview_data.get("metadata", {})

    reference = ""
    if criteria:
        reference = "\n".join(f"{c['id']}: {c['description']}" for c in criteria)

    selected_hunts = []
    human_reviews = []
    for s in slots:
        hid = s["slot"]
        judge_grades = _parse_judge_grades(s.get("llm_judge", ""))
        selected_hunts.append(SelectedHunt(
            hunt_id=hid,
            model=s.get("model_name", "unknown"),
            response=s.get("model_response", ""),
            judge_score=None,
            judge_criteria=judge_grades,
            judge_explanation=s.get("llm_judge", ""),
            is_breaking=False,
        ))
        h_grades = _parse_human_grades(s.get("human_judge", ""))
        human_reviews.append(HumanReview(
            hunt_id=hid,
            grades=h_grades,
            explanation=s.get("human_judge", ""),
            submitted=True,
        ))

    return TaskSnapshot(
        checkpoint="final",
        session_id="notebook-preview",
        prompt=prompt,
        criteria=criteria,
        reference=reference,
        ideal_response=ideal_response,
        selected_hunts=selected_hunts,
        human_reviews=human_reviews,
        metadata={
            "turn": 1,
            "models_used": list({s.get("model_name", "") for s in slots if s.get("model_name")}),
            "task_metadata": meta,
        },
    )


@router.post("/notebook-council-stream")
async def notebook_council_stream(
    body: NotebookCouncilRequest,
    reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    Run LLM council QC against a notebook URL (no session required).
    Fetches the notebook, parses all slots, builds a snapshot, then streams council.

    Heavy work (fetch + parse) runs INSIDE the generator so SSE headers are sent
    immediately and the Elixir proxy timeout doesn't expire during the fetch.
    """
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")

    async def agen():
        yield ": " + (" " * 2040) + "\n\n"

        from api.routes.notebook_preview import _fetch_notebook_json, _extract_preview

        yield f"data: {json.dumps({'type': 'status', 'message': 'Fetching notebook...'})}\n\n"
        try:
            nb_json = await _fetch_notebook_json(url)
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': f'Could not fetch notebook: {e}'})}\n\n"
            return

        preview_data = _extract_preview(nb_json)
        if not preview_data.get("slots"):
            yield f"data: {json.dumps({'type': 'error', 'message': 'No hunt result slots found in notebook. Council needs slot data to run.'})}\n\n"
            return

        try:
            snapshot = _build_snapshot_from_notebook(preview_data)
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': f'Cannot build snapshot from notebook: {e}'})}\n\n"
            return

        from agentic_reviewer.stream import stream_review_events

        try:
            for chunk in stream_review_events(snapshot):
                yield chunk
        except Exception as e:
            logger.exception("Notebook council stream error")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        agen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
