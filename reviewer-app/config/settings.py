"""
Reviewer app settings.

Reads from agentic_reviewer config (global.yaml) and reviewer section.
Uses same Redis URL and session TTL as trainer app.
Call ensure_agentic_path() from main before first use if running from reviewer-app/.
"""
import os
import sys
from pathlib import Path
from typing import List

_AGENTIC_ROOT: Path = Path(__file__).resolve().parent.parent.parent


def ensure_agentic_path() -> None:
    """Add agentic-reviewer root to sys.path so agentic_reviewer can be imported."""
    if str(_AGENTIC_ROOT) not in sys.path:
        sys.path.insert(0, str(_AGENTIC_ROOT))


def get_redis_url() -> str:
    """Redis URL from global config or env. Same as trainer app."""
    ensure_agentic_path()
    try:
        from agentic_reviewer.config_loader import get_config_value
        url = get_config_value("secrets.redis_url")
        if url:
            return url
    except Exception:
        pass
    return os.getenv("REDIS_URL", "redis://localhost:6379/0")


def get_session_ttl() -> int:
    """Session TTL in seconds from global config."""
    ensure_agentic_path()
    try:
        from agentic_reviewer.config_loader import get_config_value
        ttl = get_config_value("session.ttl_seconds")
        if ttl is not None:
            return int(ttl)
    except Exception:
        pass
    return 14400


def get_reviewer_allowed_emails() -> List[str]:
    """
    List of emails allowed to use the reviewer app (from config/global.yaml reviewer.allowed_emails).
    Returns normalized (strip, lower) non-empty strings.
    """
    ensure_agentic_path()
    try:
        from agentic_reviewer.config_loader import get_config
        cfg = get_config()
        reviewer = getattr(cfg, "reviewer", None)
        if reviewer is None:
            return []
        raw = getattr(reviewer, "allowed_emails", None)
        if not raw:
            return []
        if isinstance(raw, list):
            return [str(e).strip().lower() for e in raw if str(e).strip()]
        return []
    except Exception:
        return []


def get_reviewer_agent_config() -> dict:
    """
    Reviewer-side agent config: model, max_tokens, timeout.
    From config/global.yaml reviewer.agent.
    """
    ensure_agentic_path()
    try:
        from agentic_reviewer.config_loader import get_config
        cfg = get_config()
        reviewer = getattr(cfg, "reviewer", None)
        if reviewer is None:
            return _default_agent_config()
        agent = getattr(reviewer, "agent", None)
        if not agent:
            return _default_agent_config()
        return {
            "model": getattr(agent, "model", None) or "anthropic/claude-sonnet-4",
            "max_tokens": int(getattr(agent, "max_tokens", None) or 2048),
            "timeout": float(getattr(agent, "timeout", None) or 120),
        }
    except Exception:
        return _default_agent_config()


def _default_agent_config() -> dict:
    return {"model": "anthropic/claude-sonnet-4", "max_tokens": 2048, "timeout": 120.0}


def get_task_identity_config() -> dict:
    """
    Task identity config: which metadata field is the primary visible task ID.
    From config/global.yaml task_identity.
    Returns: { display_id_field, display_id_label, fallback_fields }
    """
    ensure_agentic_path()
    default = {
        "display_id_field": "Task ID",
        "display_id_label": "Task ID",
        "fallback_fields": ["TaskID", "task_id"],
    }
    try:
        from agentic_reviewer.config_loader import get_config
        cfg = get_config()
        ti = getattr(cfg, "task_identity", None)
        if ti is None:
            return default
        field = getattr(ti, "display_id_field", None) or default["display_id_field"]
        label = getattr(ti, "display_id_label", None) or default["display_id_label"]
        fallbacks = getattr(ti, "fallback_fields", None) or default["fallback_fields"]
        if not isinstance(fallbacks, list):
            fallbacks = list(fallbacks) if fallbacks else default["fallback_fields"]
        return {
            "display_id_field": str(field),
            "display_id_label": str(label),
            "fallback_fields": [str(f) for f in fallbacks],
        }
    except Exception:
        return default
