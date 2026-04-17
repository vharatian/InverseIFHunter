"""
Team configuration — roles, pods, and permissions.

Reads config/team.yaml and provides lookup functions for both trainer and reviewer apps.
Config is loaded once and cached. All email comparisons are case-insensitive.
"""
import fcntl
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

logger = logging.getLogger(__name__)

_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
_TEAM_CONFIG_PATH = _CONFIG_DIR / "team.yaml"

_cache: Optional[Dict[str, Any]] = None
_cache_mtime: float = 0.0


def _file_changed() -> bool:
    """Check if team.yaml was modified since last load."""
    try:
        return _TEAM_CONFIG_PATH.stat().st_mtime != _cache_mtime
    except OSError:
        return False


def _load() -> Dict[str, Any]:
    global _cache, _cache_mtime
    if _cache is not None and not _file_changed():
        return _cache
    try:
        with open(_TEAM_CONFIG_PATH, "r") as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_SH)
            data = yaml.safe_load(f) or {}
        _cache_mtime = _TEAM_CONFIG_PATH.stat().st_mtime
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


_pubsub_thread = None


def start_redis_reload_listener() -> None:
    """Subscribe to `mth:team` and invalidate the team config on publish.

    Safe to call multiple times. No-op when Redis is unavailable.
    """
    global _pubsub_thread
    if _pubsub_thread is not None:
        return
    try:
        import os
        import threading
        import redis as _redis
    except Exception:
        return

    url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

    def _runner() -> None:
        try:
            client = _redis.Redis.from_url(url, decode_responses=True,
                                           socket_connect_timeout=2,
                                           socket_timeout=2)
            client.ping()
            pubsub = client.pubsub(ignore_subscribe_messages=True)
            pubsub.subscribe("mth:team")
            logger.info("team_config: listening on mth:team for live reload")
            for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    reload()
                    logger.info("team_config: reloaded via mth:team event")
                except Exception as exc:
                    logger.warning("team_config reload failed: %s", exc)
        except Exception as exc:
            logger.warning("team_config redis listener stopped: %s", exc)

    t = threading.Thread(target=_runner, name="mth-team-reload", daemon=True)
    t.start()
    _pubsub_thread = t


def _norm(email: str) -> str:
    return str(email).strip().lower() if email else ""


def _pod_reviewers(pod: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return normalized list of reviewers for a pod.
    Back-compat: treats legacy singular `reviewer: {email,name}` as a one-item list."""
    revs = pod.get("reviewers")
    if isinstance(revs, list):
        return [r for r in revs if isinstance(r, dict) and r.get("email")]
    legacy = pod.get("reviewer")
    if isinstance(legacy, dict) and legacy.get("email"):
        return [legacy]
    return []


# ── Role lookup ──────────────────────────────────────────────────

def get_role(email: str) -> Optional[str]:
    """Return the highest role for this email:
    super_admin > admin > pod_lead > reviewer > trainer, or None."""
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
        lead = pod.get("pod_lead") or {}
        if _norm(lead.get("email")) == em:
            return "pod_lead"
        for rev in _pod_reviewers(pod):
            if _norm(rev.get("email")) == em:
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
        lead = pod.get("pod_lead") or {}
        if _norm(lead.get("email")) == em:
            return pod_id
        for rev in _pod_reviewers(pod):
            if _norm(rev.get("email")) == em:
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


def get_reviewer_emails_for_pod(pod_id: str) -> List[str]:
    """Return all reviewer emails for a pod."""
    data = _load()
    pod = (data.get("pods") or {}).get(pod_id)
    if not pod:
        return []
    return [_norm(r.get("email")) for r in _pod_reviewers(pod) if _norm(r.get("email"))]


def get_reviewer_email_for_pod(pod_id: str) -> Optional[str]:
    """Back-compat: return first reviewer email for a pod, or None."""
    emails = get_reviewer_emails_for_pod(pod_id)
    return emails[0] if emails else None


def get_pod_lead_email_for_pod(pod_id: str) -> Optional[str]:
    """Return the pod lead email for a pod, if set."""
    data = _load()
    pod = (data.get("pods") or {}).get(pod_id)
    if not pod:
        return None
    lead = pod.get("pod_lead") or {}
    return _norm(lead.get("email")) or None


def get_trainer_assignments(pod_id: str) -> Dict[str, List[str]]:
    """Return {trainer_email: [reviewer_email, ...]} mapping for a pod (normalized)."""
    data = _load()
    pod = (data.get("pods") or {}).get(pod_id)
    if not pod:
        return {}
    raw = pod.get("trainer_assignments") or {}
    out: Dict[str, List[str]] = {}
    if not isinstance(raw, dict):
        return {}
    for t, revs in raw.items():
        tn = _norm(t)
        if not tn:
            continue
        if isinstance(revs, list):
            out[tn] = [_norm(r) for r in revs if _norm(r)]
        elif isinstance(revs, str) and revs.strip():
            out[tn] = [_norm(revs)]
    return out


def get_mapped_reviewers_for_trainer(trainer_email: str) -> List[str]:
    """Return the list of reviewer emails mapped to this trainer. Empty if unassigned."""
    em = _norm(trainer_email)
    if not em:
        return []
    pod_id = get_pod_for_email(em)
    if not pod_id:
        return []
    mapping = get_trainer_assignments(pod_id)
    return list(mapping.get(em) or [])


def get_trainers_mapped_to_reviewer(reviewer_email: str) -> List[str]:
    """Return the list of trainer emails that have this reviewer in their assignment."""
    em = _norm(reviewer_email)
    if not em:
        return []
    pod_id = get_pod_for_email(em)
    if not pod_id:
        return []
    mapping = get_trainer_assignments(pod_id)
    return [t for t, revs in mapping.items() if em in (revs or [])]


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
    Returns None to mean 'all sessions' (super_admin), or a list of emails.

    - super_admin: None (sees everything)
    - admin: union of trainers across their assigned pods
    - pod_lead: all trainers in their pod
    - reviewer: ONLY trainers explicitly mapped to them via trainer_assignments
      (empty list = sees nothing until super-admin assigns)
    - trainer/unknown: None (caller filters to own email)
    """
    role = get_role(email)
    if role == "super_admin":
        return None
    if role == "admin":
        pod_ids = get_pods_for_admin(email)
        emails: List[str] = []
        for pid in pod_ids:
            emails.extend(get_trainer_emails_in_pod(pid))
        return emails
    if role == "pod_lead":
        pod_id = get_pod_for_email(email)
        return get_trainer_emails_in_pod(pod_id) if pod_id else []
    if role == "reviewer":
        return get_trainers_mapped_to_reviewer(email)
    return None
