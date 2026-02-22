"""Reviewer agent: run LLM review and store result. Requires allowlist."""
import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from api.deps import require_reviewer
from services import get_session_dict
from services.agent_store import get_agent_result, set_agent_result
from services.audit_store import append_audit
from services.review_agent import run_agent_sync

router = APIRouter(prefix="/api", tags=["agent"])


@router.post("/tasks/{session_id}/agent-run")
async def post_agent_run(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    Run the reviewer agent for this task: build snapshot, call LLM, store and return result.
    Runs LLM in thread pool so the event loop is not blocked.
    """
    session_dict = await get_session_dict(session_id)
    if session_dict is None:
        raise HTTPException(status_code=404, detail="Session not found")

    result = await asyncio.to_thread(run_agent_sync, session_dict)
    await set_agent_result(session_id, result)
    await append_audit(session_id, "agent_run", _reviewer, {"model": result.get("model_used"), "error": result.get("error")})
    return result


@router.get("/tasks/{session_id}/agent-result")
async def get_agent_result_route(
    session_id: str,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """Get last agent run result for this task, if any."""
    session_dict = await get_session_dict(session_id)
    if session_dict is None:
        raise HTTPException(status_code=404, detail="Session not found")

    result = await get_agent_result(session_id)
    if result is None:
        return {"run": False, "result": None}
    return {"run": True, "result": result}
