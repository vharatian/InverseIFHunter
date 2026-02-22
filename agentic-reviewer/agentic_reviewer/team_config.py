"""
Team configuration — roles, pods, and permissions.

Reads config/team.yaml and provides lookup functions for both trainer and reviewer apps.
Config is loaded once and cached. All email comparisons are case-insensitive.
"""
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

logger = logging.getLogger(__name__)

_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
_TEAM_CONFIG_PATH = _CONFIG_DIR / "team.yaml"

_cache: Optional[Dict[str, Any]] = None


def _load() -> Dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache
    try:
        with open(_TEAM_CONFIG_PATH, "r") as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        logger.warning("team.yaml not found at %s — running without team config", _TEAM_CONFIG_PATH)
        data = {}
    except Exception as e:
        logger.error("Failed to load team.yaml: %s", e)
        data = {}
    _cache = data
    return _cache


def reload() -> Dict[str, Any]:
    """Force reload (for tests or hot-reload)."""
    global _cache
    _cache = None
    return _load()


def _norm(email: str) -> str:
    return str(email).strip().lower() if email else ""


# ── Role lookup ──────────────────────────────────────────────────

def get_role(email: str) -> Optional[str]:
    """Return the highest role for this email: super_admin > admin > reviewer > trainer, or None."""
    em = _norm(email)
    if not em:
        return None
    data = _load()

    for sa in data.get("super_admins") or []:
        if _norm(sa.get("email")) == em:
            return "super_admin"

    for admin in data.get("admins") or []:
        if _norm(admin.get("email")) == em:
            return "admin"

    for pod_id, pod in (data.get("pods") or {}).items():
        reviewer = pod.get("reviewer") or {}
        if _norm(reviewer.get("email")) == em:
            return "reviewer"
        for trainer_email in pod.get("trainers") or []:
            if _norm(trainer_email) == em:
                return "trainer"

    return None


def is_known_email(email: str) -> bool:
    """Return True if the email appears anywhere in team.yaml."""
    return get_role(email) is not None


# ── Pod lookup ───────────────────────────────────────────────────

def get_pod_for_email(email: str) -> Optional[str]:
    """Return the pod ID for any role (trainer's pod, reviewer's pod), or None."""
    em = _norm(email)
    if not em:
        return None
    data = _load()

    # Super admins and admins aren't in a single pod
    for sa in data.get("super_admins") or []:
        if _norm(sa.get("email")) == em:
            return None
    for admin in data.get("admins") or []:
        if _norm(admin.get("email")) == em:
            return None

    for pod_id, pod in (data.get("pods") or {}).items():
        reviewer = pod.get("reviewer") or {}
        if _norm(reviewer.get("email")) == em:
            return pod_id
        for trainer_email in pod.get("trainers") or []:
            if _norm(trainer_email) == em:
                return pod_id

    return None


def get_trainer_emails_in_pod(pod_id: str) -> List[str]:
    """Return normalized trainer emails for a pod."""
    data = _load()
    pod = (data.get("pods") or {}).get(pod_id)
    if not pod:
        return []
    return [_norm(e) for e in (pod.get("trainers") or []) if _norm(e)]


def get_reviewer_email_for_pod(pod_id: str) -> Optional[str]:
    """Return the reviewer email for a pod."""
    data = _load()
    pod = (data.get("pods") or {}).get(pod_id)
    if not pod:
        return None
    reviewer = pod.get("reviewer") or {}
    return _norm(reviewer.get("email")) or None


def get_pods_for_admin(email: str) -> List[str]:
    """Return pod IDs that an admin oversees."""
    em = _norm(email)
    if not em:
        return []
    data = _load()
    for admin in data.get("admins") or []:
        if _norm(admin.get("email")) == em:
            return list(admin.get("pods") or [])
    return []


def get_all_pod_ids() -> List[str]:
    """Return all pod IDs."""
    data = _load()
    return list((data.get("pods") or {}).keys())


def get_allowed_trainer_emails_for_role(email: str) -> Optional[List[str]]:
    """Return the set of trainer emails this person is allowed to see sessions for.
    Returns None to mean 'all sessions' (super_admin), or a list of emails."""
    role = get_role(email)
    if role == "super_admin":
        return None  # sees everything
    if role == "admin":
        pod_ids = get_pods_for_admin(email)
        emails = []
        for pid in pod_ids:
            emails.extend(get_trainer_emails_in_pod(pid))
        return emails
    if role == "reviewer":
        pod_id = get_pod_for_email(email)
        return get_trainer_emails_in_pod(pod_id) if pod_id else []
    # trainer or unknown — will be filtered to own email by caller
    return None
