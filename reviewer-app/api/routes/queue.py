"""Task queue: list sessions available for review. Requires allowlist."""
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query

from api.deps import require_reviewer
from config import get_task_identity_config
from services.redis_client import list_sessions_for_review, list_sessions
from services.queue_service import get_queue_with_summaries, get_queue_status_counts

router = APIRouter(prefix="/api", tags=["queue"])


@router.get("/queue")
async def get_queue(
    _reviewer: Annotated[str, Depends(require_reviewer)],
    summaries: bool = Query(False, description="Include at-a-glance summary per session"),
    all_sessions: bool = Query(False, description="If true, show all sessions; else only submitted/returned"),
    status: Optional[str] = Query(None, description="Filter by review_status (submitted, returned, approved, draft)"),
    q: Optional[str] = Query(None, description="Search by task ID or session ID"),
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    per_page: int = Query(50, ge=0, le=500, description="Items per page. 0 = all (no pagination)."),
):
    """
    List session IDs available for review.
    - Default: only submitted/returned.
    - all_sessions=true: all active sessions.
    - status=<value>: filter by specific review_status.
    - q=<search>: filter by task ID or session ID substring.
    - page/per_page: paginate results (default page=1, per_page=50). per_page=0 returns all.
    """
    if summaries or q:
        items = await get_queue_with_summaries(
            for_review_only=not all_sessions and not status,
            status_filter=status,
            search_query=q,
            reviewer_email=_reviewer,
            page=page,
            per_page=per_page,
        )
        session_ids = [x["session_id"] for x in items]
        counts_by_status = await get_queue_status_counts(reviewer_email=_reviewer)
        # total_count: fetch unfiltered count for pagination UI
        all_items_count = await get_queue_with_summaries(
            for_review_only=not all_sessions and not status,
            status_filter=status,
            search_query=q,
            reviewer_email=_reviewer,
            per_page=0,
        )
        return {
            "sessions": session_ids,
            "count": len(session_ids),
            "total_count": len(all_items_count),
            "page": page,
            "per_page": per_page,
            "summaries": items,
            "counts_by_status": counts_by_status,
        }
    if status:
        items = await get_queue_with_summaries(
            for_review_only=False,
            status_filter=status,
            reviewer_email=_reviewer,
            page=page,
            per_page=per_page,
        )
        session_ids = [x["session_id"] for x in items]
        counts_by_status = await get_queue_status_counts(reviewer_email=_reviewer)
        return {"sessions": session_ids, "count": len(session_ids), "counts_by_status": counts_by_status}
    session_ids = await list_sessions_for_review(reviewer_email=_reviewer) if not all_sessions else await list_sessions()
    return {"sessions": session_ids, "count": len(session_ids)}


@router.get("/task-identity-config")
async def get_task_identity(
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """Return the task identity config so the frontend knows what field/label to use."""
    cfg = get_task_identity_config()
    return {"display_id_label": cfg["display_id_label"]}
