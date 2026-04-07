"""Resolve session_id from pasted Colab/Drive URL or return matches for disambiguation."""
import re
import sys
from pathlib import Path
from typing import Annotated, Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query

from api.deps import require_reviewer

_agentic_root = Path(__file__).resolve().parent.parent.parent.parent
if str(_agentic_root) not in sys.path:
    sys.path.insert(0, str(_agentic_root))

from services.pg_session import (  # noqa: E402
    find_sessions_by_colab_url_pg,
    find_sessions_by_file_id_pg,
)

router = APIRouter(prefix="/api", tags=["session_lookup"])

_SESSION_ID_RE = re.compile(r"^[a-f0-9]{8}$", re.IGNORECASE)


def _extract_google_file_id(raw: str) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None
    m = re.search(r"/file/d/([a-zA-Z0-9_-]+)", s)
    if m:
        return m.group(1)
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", s)
    if m:
        return m.group(1)
    if "colab.research.google.com" in s:
        m = re.search(r"/drive/([a-zA-Z0-9_-]+)", s)
        if m:
            return m.group(1)
    for pattern in (
        r"/drive/([^/?#&]+)",
        r"[?&]id=([^/?#&]+)",
        r"/open\?id=([^/?#&]+)",
    ):
        m = re.search(pattern, s)
        if m:
            return m.group(1)
    return None


def _dedupe_matches(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for r in rows:
        sid = r.get("session_id")
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(r)
    return out


@router.get("/session-lookup")
async def session_lookup(
    q: Annotated[str, Query(description="8-char session id, or Colab/Drive URL")],
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
    """
    If `q` is a session id, return a single match for direct load.
    If `q` is a URL, find sessions by Drive file_id in metadata, then by stored colab/url.
    """
    raw = (q or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Query parameter q is required")

    if _SESSION_ID_RE.match(raw):
        sid = raw.strip().lower()
        return {
            "query_type": "session_id",
            "matches": [{"session_id": sid, "hunt_status": "unknown", "review_status": "unknown"}],
        }

    file_id = _extract_google_file_id(raw)
    matches: List[Dict[str, Any]] = []
    if file_id:
        matches = await find_sessions_by_file_id_pg(file_id)
    if not matches:
        matches = await find_sessions_by_colab_url_pg(raw)

    matches = _dedupe_matches(matches)
    return {"query_type": "url", "file_id": file_id, "matches": matches}
