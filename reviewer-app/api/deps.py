"""
FastAPI dependencies: allowlist check for reviewer routes.

Expects identity via header X-Reviewer-Email (or X-Reviewer-Id). If allowlist is empty, no one is allowed.
"""
import logging
from typing import Annotated

from fastapi import Header, HTTPException

from services import is_reviewer_allowed

logger = logging.getLogger(__name__)


async def require_reviewer(
    x_reviewer_email: Annotated[str | None, Header(alias="X-Reviewer-Email")] = None,
    x_reviewer_id: Annotated[str | None, Header(alias="X-Reviewer-Id")] = None,
) -> str:
    """
    Dependency: require the request to be from an allowed reviewer.
    Identity is taken from X-Reviewer-Email or X-Reviewer-Id header.
    Returns the normalized identity string; raises 403 if not allowed.
    """
    identity = x_reviewer_email or x_reviewer_id
    if not identity or not str(identity).strip():
        raise HTTPException(
            status_code=403,
            detail="Missing reviewer identity: set X-Reviewer-Email or X-Reviewer-Id header",
        )
    if not is_reviewer_allowed(identity):
        logger.warning("Rejected reviewer access for identity: %s", identity[:50])
        raise HTTPException(
            status_code=403,
            detail="Not an allowed reviewer. Contact admin to be added to the allowlist.",
        )
    return str(identity).strip().lower()
