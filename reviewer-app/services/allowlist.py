"""
Reviewer allowlist: checks team.yaml roles first, falls back to global.yaml allowed_emails.

Allowed roles: super_admin, admin, reviewer.
"""
import logging
from typing import List

from config import get_reviewer_allowed_emails
from config.settings import ensure_agentic_path

logger = logging.getLogger(__name__)

ensure_agentic_path()
from agentic_reviewer.team_config import get_role  # noqa: E402


def is_reviewer_allowed(email_or_id: str) -> bool:
    """Return True if the email has reviewer-level access (reviewer, admin, or super_admin)."""
    if not email_or_id or not str(email_or_id).strip():
        return False
    normalized = str(email_or_id).strip().lower()

    role = get_role(normalized)
    if role in ("super_admin", "admin", "reviewer"):
        return True

    # Backward compat: check global.yaml reviewer.allowed_emails
    allowed: List[str] = get_reviewer_allowed_emails()
    return normalized in allowed


def get_allowlist() -> List[str]:
    """Return the current list of allowed reviewer emails (for admin/debug)."""
    return get_reviewer_allowed_emails()
