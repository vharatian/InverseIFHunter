"""
Team management service — read/write config/team.yaml.

Uses agentic_reviewer/team_config.py for reading (no duplication).
Writes back to the YAML file and reloads the cache on mutations.
"""
import fcntl
import logging
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

logger = logging.getLogger(__name__)

_CONFIG_DIR = Path(__file__).resolve().parent.parent.parent.parent / "config"
_TEAM_FILE = _CONFIG_DIR / "team.yaml"


def _load_raw() -> Dict[str, Any]:
    """Load raw team.yaml dict."""
    try:
        with open(_TEAM_FILE, "r") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        logger.warning("team.yaml not found at %s", _TEAM_FILE)
        return {}


def _ensure_agentic_path():
    root = str(Path(__file__).resolve().parent.parent.parent.parent)
    if root not in sys.path:
        sys.path.append(root)


def _save(data: Dict[str, Any]) -> None:
    """Write team.yaml atomically with exclusive lock, then reload cache."""
    tmp = _TEAM_FILE.with_suffix(".yaml.tmp")
    with open(tmp, "w") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        f.flush()
    tmp.replace(_TEAM_FILE)
    try:
        _ensure_agentic_path()
        from agentic_reviewer.team_config import reload
        reload()
    except Exception as e:
        logger.warning("team_config.reload() failed: %s", e)
    try:
        from events_bus import publish_sync
        publish_sync("team", {"file": "team.yaml"})
    except Exception as e:
        logger.debug("team publish skipped: %s", e)


def _norm(email: str) -> str:
    return email.strip().lower()


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_email(email: str) -> str:
    """Normalize and validate email. Raises ValueError on bad input."""
    em = _norm(email)
    if not _EMAIL_RE.match(em):
        raise ValueError(f"Invalid email: {email}")
    return em


def _pod_reviewers_list(pod: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Normalize `reviewers` (list, preferred) vs legacy `reviewer` (singular dict)."""
    revs = pod.get("reviewers")
    if isinstance(revs, list):
        return [r for r in revs if isinstance(r, dict) and r.get("email")]
    legacy = pod.get("reviewer")
    if isinstance(legacy, dict) and legacy.get("email"):
        return [legacy]
    return []


def _migrate_pod_shape(pod: Dict[str, Any]) -> None:
    """In-place: move legacy singular `reviewer` to `reviewers: [..]` and ensure
    `trainer_assignments` dict exists."""
    if "reviewers" not in pod:
        pod["reviewers"] = _pod_reviewers_list(pod)
    pod.pop("reviewer", None)
    if "trainer_assignments" not in pod or not isinstance(pod.get("trainer_assignments"), dict):
        pod["trainer_assignments"] = {}


def _all_emails(data: Dict[str, Any]) -> set:
    """Collect all emails in team.yaml for duplicate checking."""
    emails = set()
    for sa in data.get("super_admins") or []:
        emails.add(_norm(sa.get("email", "")))
    for admin in data.get("admins") or []:
        emails.add(_norm(admin.get("email", "")))
    for pod in (data.get("pods") or {}).values():
        for reviewer in _pod_reviewers_list(pod):
            if reviewer.get("email"):
                emails.add(_norm(reviewer["email"]))
        pod_lead = pod.get("pod_lead") or {}
        if pod_lead.get("email"):
            emails.add(_norm(pod_lead["email"]))
        for t in pod.get("trainers") or []:
            emails.add(_norm(t))
    emails.discard("")
    return emails


def get_team() -> Dict[str, Any]:
    """Return structured team data for the admin UI."""
    data = _load_raw()
    pods = []
    for pod_id, pod in (data.get("pods") or {}).items():
        reviewers = _pod_reviewers_list(pod)
        raw_assign = pod.get("trainer_assignments") or {}
        trainer_assignments: Dict[str, List[str]] = {}
        if isinstance(raw_assign, dict):
            for t, revs in raw_assign.items():
                tn = _norm(t)
                if not tn:
                    continue
                if isinstance(revs, list):
                    trainer_assignments[tn] = [_norm(r) for r in revs if _norm(r)]
                elif isinstance(revs, str) and revs.strip():
                    trainer_assignments[tn] = [_norm(revs)]
        pods.append({
            "pod_id": pod_id,
            "name": pod.get("name", pod_id),
            "pod_lead": pod.get("pod_lead"),
            "reviewers": reviewers,
            "trainers": [_norm(t) for t in (pod.get("trainers") or [])],
            "trainer_assignments": trainer_assignments,
        })
    return {
        "super_admins": data.get("super_admins") or [],
        "admins": data.get("admins") or [],
        "pods": pods,
    }


def add_trainer(pod_id: str, email: str) -> None:
    """Add a trainer to a pod. Raises ValueError on bad input or duplicates."""
    em = _validate_email(email)
    data = _load_raw()
    pods = data.get("pods") or {}
    if pod_id not in pods:
        raise ValueError(f"Pod '{pod_id}' not found")
    if em in _all_emails(data):
        raise ValueError(f"Email '{em}' already exists in team config")
    _migrate_pod_shape(pods[pod_id])
    pods[pod_id].setdefault("trainers", []).append(em)
    _save(data)


def remove_trainer(pod_id: str, email: str) -> None:
    """Remove a trainer from a pod. Also drops their reviewer assignment. Raises ValueError if not found."""
    em = _validate_email(email)
    data = _load_raw()
    pods = data.get("pods") or {}
    if pod_id not in pods:
        raise ValueError(f"Pod '{pod_id}' not found")
    _migrate_pod_shape(pods[pod_id])
    trainers = pods[pod_id].get("trainers") or []
    normalized = [_norm(t) for t in trainers]
    if em not in normalized:
        raise ValueError(f"Trainer '{em}' not in pod '{pod_id}'")
    idx = normalized.index(em)
    trainers.pop(idx)
    pods[pod_id]["trainers"] = trainers
    assignments = pods[pod_id].get("trainer_assignments") or {}
    for key in list(assignments.keys()):
        if _norm(key) == em:
            del assignments[key]
    pods[pod_id]["trainer_assignments"] = assignments
    _save(data)


def add_reviewer(pod_id: str, email: str, name: str = "") -> None:
    """Add a reviewer to a pod (multi-reviewer). Raises ValueError if email is already in use."""
    em = _validate_email(email)
    data = _load_raw()
    pods = data.get("pods") or {}
    if pod_id not in pods:
        raise ValueError(f"Pod '{pod_id}' not found")
    if em in _all_emails(data):
        raise ValueError(f"Email '{em}' already exists in team config")
    _migrate_pod_shape(pods[pod_id])
    pods[pod_id]["reviewers"].append({"email": em, "name": name or em.split("@")[0]})
    _save(data)


def remove_reviewer(pod_id: str, email: str) -> None:
    """Remove a specific reviewer from a pod and scrub them from all trainer_assignments.
    Raises ValueError if not found."""
    em = _validate_email(email)
    data = _load_raw()
    pods = data.get("pods") or {}
    if pod_id not in pods:
        raise ValueError(f"Pod '{pod_id}' not found")
    _migrate_pod_shape(pods[pod_id])
    revs = pods[pod_id].get("reviewers") or []
    new_revs = [r for r in revs if _norm(r.get("email", "")) != em]
    if len(new_revs) == len(revs):
        raise ValueError(f"Reviewer '{em}' not in pod '{pod_id}'")
    pods[pod_id]["reviewers"] = new_revs
    assignments = pods[pod_id].get("trainer_assignments") or {}
    for t, rlist in list(assignments.items()):
        if not isinstance(rlist, list):
            continue
        cleaned = [r for r in rlist if _norm(r) != em]
        if cleaned:
            assignments[t] = cleaned
        else:
            del assignments[t]
    pods[pod_id]["trainer_assignments"] = assignments
    _save(data)


def set_trainer_reviewers(pod_id: str, trainer_email: str, reviewer_emails: List[str]) -> None:
    """Replace a trainer's reviewer assignments with the given list.
    Empty list clears the mapping (trainer unassigned).
    All reviewers MUST already be reviewers of this pod."""
    t_em = _validate_email(trainer_email)
    data = _load_raw()
    pods = data.get("pods") or {}
    if pod_id not in pods:
        raise ValueError(f"Pod '{pod_id}' not found")
    pod = pods[pod_id]
    _migrate_pod_shape(pod)
    pod_trainers = {_norm(t) for t in (pod.get("trainers") or [])}
    if t_em not in pod_trainers:
        raise ValueError(f"Trainer '{t_em}' is not in pod '{pod_id}'")
    pod_reviewer_emails = {_norm(r.get("email", "")) for r in (pod.get("reviewers") or [])}
    pod_reviewer_emails.discard("")
    cleaned: List[str] = []
    seen = set()
    for r in reviewer_emails or []:
        rn = _validate_email(r)
        if rn in seen:
            continue
        if rn not in pod_reviewer_emails:
            raise ValueError(f"'{rn}' is not a reviewer of pod '{pod_id}'")
        cleaned.append(rn)
        seen.add(rn)
    assignments = pod.get("trainer_assignments") or {}
    if cleaned:
        assignments[t_em] = cleaned
    else:
        assignments.pop(t_em, None)
    pod["trainer_assignments"] = assignments
    _save(data)


def set_pod_lead(pod_id: str, email: str, name: str = "") -> None:
    """Set pod lead. Same person may lead multiple pods — no global uniqueness check."""
    em = _validate_email(email)
    data = _load_raw()
    pods = data.get("pods") or {}
    if pod_id not in pods:
        raise ValueError(f"Pod '{pod_id}' not found")
    pods[pod_id]["pod_lead"] = {"email": em, "name": name or em.split("@")[0]}
    _save(data)


def remove_pod_lead(pod_id: str) -> None:
    """Clear pod lead for a pod."""
    data = _load_raw()
    pods = data.get("pods") or {}
    if pod_id not in pods:
        raise ValueError(f"Pod '{pod_id}' not found")
    pods[pod_id]["pod_lead"] = None
    _save(data)


def add_super_admin(email: str, name: str = "") -> None:
    """Append to team.yaml super_admins (trainer/reviewer apps). Not dashboard cookie auth."""
    em = _validate_email(email)
    data = _load_raw()
    if em in _all_emails(data):
        raise ValueError(f"Email '{em}' already exists in team config")
    data.setdefault("super_admins", []).append(
        {"email": em, "name": name or em.split("@")[0]}
    )
    _save(data)


def remove_super_admin(email: str) -> None:
    """Remove a super admin. Raises ValueError if not found."""
    em = _validate_email(email)
    data = _load_raw()
    sas = data.get("super_admins") or []
    new_sas = [a for a in sas if _norm(a.get("email", "")) != em]
    if len(new_sas) == len(sas):
        raise ValueError(f"Super admin '{em}' not found")
    data["super_admins"] = new_sas
    _save(data)


def add_admin(email: str, name: str = "", pods: Optional[List[str]] = None) -> None:
    """Add an admin entry. Raises ValueError on bad input."""
    em = _validate_email(email)
    data = _load_raw()
    if em in _all_emails(data):
        raise ValueError(f"Email '{em}' already exists in team config")
    valid_pods = list((data.get("pods") or {}).keys())
    for p in (pods or []):
        if p not in valid_pods:
            raise ValueError(f"Pod '{p}' not found")
    entry = {"email": em, "name": name or em.split("@")[0]}
    if pods:
        entry["pods"] = pods
    data.setdefault("admins", []).append(entry)
    _save(data)


def remove_admin(email: str) -> None:
    """Remove an admin. Raises ValueError if not found."""
    em = _validate_email(email)
    data = _load_raw()
    admins = data.get("admins") or []
    new_admins = [a for a in admins if _norm(a.get("email", "")) != em]
    if len(new_admins) == len(admins):
        raise ValueError(f"Admin '{em}' not found")
    data["admins"] = new_admins
    _save(data)


def create_pod(pod_id: str, name: str) -> None:
    """Create a new empty pod. Raises ValueError if pod_id exists."""
    data = _load_raw()
    pods = data.setdefault("pods", {})
    if pod_id in pods:
        raise ValueError(f"Pod '{pod_id}' already exists")
    pods[pod_id] = {
        "name": name,
        "pod_lead": None,
        "reviewers": [],
        "trainers": [],
        "trainer_assignments": {},
    }
    _save(data)


def remove_pod(pod_id: str) -> None:
    """Remove a pod. Must be empty (no trainers, no reviewers, no pod lead). Raises ValueError otherwise."""
    data = _load_raw()
    pods = data.get("pods") or {}
    if pod_id not in pods:
        raise ValueError(f"Pod '{pod_id}' not found")
    pod = pods[pod_id]
    if pod.get("trainers"):
        raise ValueError(f"Pod '{pod_id}' still has trainers — remove them first")
    if _pod_reviewers_list(pod):
        raise ValueError(f"Pod '{pod_id}' still has reviewers — remove them first")
    if pod.get("pod_lead") and (pod.get("pod_lead") or {}).get("email"):
        raise ValueError(f"Pod '{pod_id}' still has a pod lead — remove them first")
    del pods[pod_id]
    _save(data)
