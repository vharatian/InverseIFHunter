"""Audit log: list recent reviewer actions. Requires allowlist."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from api.deps import require_reviewer
from services.audit_store import get_audit

router = APIRouter(prefix="/api", tags=["audit"])


@router.get("/audit")
async def get_audit_route(
    _reviewer: Annotated[str, Depends(require_reviewer)],
    limit: int = Query(50, ge=1, le=200),
):
    """Return recent audit entries (feedback_saved, task_edited, agent_run). Newest first."""
    entries = await get_audit(limit=limit)
    return {"entries": entries, "count": len(entries)}
